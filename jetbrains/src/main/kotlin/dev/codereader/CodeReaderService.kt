package dev.codereader

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import dev.codereader.ai.AiException
import dev.codereader.ai.AiProvider
import dev.codereader.ai.ClaudeCliProvider
import dev.codereader.ai.CodexCliProvider
import dev.codereader.ai.ProviderOptions
import dev.codereader.analysis.Analysis
import dev.codereader.analysis.Analyzer
import dev.codereader.analysis.ProjectSources
import dev.codereader.analysis.SourceText
import dev.codereader.analysis.UsageScanner
import dev.codereader.model.FileInfo
import dev.codereader.model.PanelError
import dev.codereader.model.PanelState
import dev.codereader.settings.CodeReaderSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** Owns what the panel shows: follows the selected editor and runs explanations. */
@Service(Service.Level.PROJECT)
class CodeReaderService(private val project: Project, private val scope: CoroutineScope) : Disposable {

    private class CacheEntry(
        /** Identifies the file content and the settings the explanation was written with. */
        val fingerprint: String,
        val analysis: Analysis,
    )

    private val listeners = CopyOnWriteArrayList<(PanelState) -> Unit>()
    private val cache = ConcurrentHashMap<String, CacheEntry>()
    private val lock = Any()

    private var file: VirtualFile? = null
    private var job: Job? = null
    private var autoJob: Job? = null

    /** Identity of the run whose results may still be shown; replaced when a run starts or stops. */
    private var currentRun: Any? = null

    @Volatile
    var state: PanelState = withSettings(PanelState())
        private set

    init {
        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = follow(event.newFile)
            },
        )
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            CodeReaderSettings.TOPIC,
            CodeReaderSettings.ChangeListener { setState { withSettings(it) } },
        )
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    if (FileDocumentManager.getInstance().getFile(event.document) == file) {
                        markStale()
                    }
                }
            },
            this,
        )
        follow(FileEditorManager.getInstance(project).selectedFiles.firstOrNull())
    }

    /** Registers a listener for state changes; the returned function removes it again. */
    fun addListener(listener: (PanelState) -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    /** Explains the current file. With `force`, a cached explanation is written again. */
    fun explain(force: Boolean) {
        val target = file ?: return
        val text = textOf(target) ?: return
        val settings = CodeReaderSettings.getInstance().snapshot()
        val fingerprint = fingerprint(text, settings)
        val cached = cache[target.url]
        if (!force && cached?.fingerprint == fingerprint) {
            showCached(target, cached, stale = false)
            return
        }

        stop()
        val run = Any()
        val info = fileInfo(target)
        synchronized(lock) { currentRun = run }
        setState {
            withSettings(PanelState(file = info, status = PanelState.STATUS_RUNNING, stage = PanelState.STAGE_SYMBOLS, usageApproximate = true))
        }

        val extension = target.extension.orEmpty()
        job = scope.launch {
            try {
                val analyzer = Analyzer(
                    provider = createProvider(settings),
                    language = settings.language,
                    findUsages = { methods ->
                        withContext(Dispatchers.IO) {
                            UsageScanner(extension, settings.maxUsagesPerMethod).scan(
                                current = SourceText(target.url, info.displayPath) { text },
                                others = ProjectSources.sameLanguageFiles(project, target),
                                methods = methods,
                            )
                        }
                    },
                    onUpdate = { partial -> setStateIfCurrent(run) { view(it, partial) } },
                )
                val analysis = analyzer.analyze(info.displayPath, info.languageId, extension, text)
                cache[target.url] = CacheEntry(fingerprint, analysis)
                val stale = textOf(target)?.let { fingerprint(it, settings) != fingerprint } ?: false
                setStateIfCurrent(run) { view(it, analysis).copy(status = PanelState.STATUS_DONE, stale = stale) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: AiException) {
                showError(run, info, PanelError(error.kind, error.message.orEmpty(), error.detail))
            } catch (error: Exception) {
                showError(run, info, PanelError(AiException.FAILED, "설명을 만들다가 문제가 생겼어요.", error.message ?: error.toString()))
            }
        }
    }

    /** Stops the explanation in progress and returns to what was shown before. */
    fun cancel() {
        if (job?.isActive == true) {
            stop()
            file?.let(::showFile)
        }
    }

    fun reveal(uri: String, line: Int, character: Int) {
        val target = VirtualFileManager.getInstance().findFileByUrl(uri) ?: return
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) {
                OpenFileDescriptor(project, target, line, character).navigate(true)
            }
        }
    }

    override fun dispose() {
        stop()
        listeners.clear()
    }

    private fun follow(selected: VirtualFile?) {
        if (selected == file) {
            return
        }
        if (selected != null && (selected.isDirectory || selected.fileType.isBinary)) {
            return
        }
        stop()
        file = selected
        if (selected == null) {
            setState { withSettings(PanelState()) }
            return
        }
        showFile(selected)
        if (state.status == PanelState.STATUS_IDLE && state.mode == CodeReaderSettings.MODE_AUTO) {
            // Skimming through tabs should not start an explanation for every one of them.
            autoJob = scope.launch {
                delay(AUTO_DELAY_MS)
                explain(force = false)
            }
        }
    }

    private fun showFile(target: VirtualFile) {
        val cached = cache[target.url]
        if (cached != null) {
            val settings = CodeReaderSettings.getInstance().snapshot()
            val stale = textOf(target)?.let { fingerprint(it, settings) != cached.fingerprint } ?: false
            showCached(target, cached, stale)
        } else {
            setState { withSettings(PanelState(file = fileInfo(target))) }
        }
    }

    private fun showCached(target: VirtualFile, entry: CacheEntry, stale: Boolean) {
        setState {
            view(withSettings(PanelState(file = fileInfo(target), usageApproximate = true)), entry.analysis)
                .copy(status = PanelState.STATUS_DONE, stale = stale)
        }
    }

    private fun showError(run: Any, info: FileInfo, error: PanelError) {
        // Stops the sibling requests that may still be running.
        job?.cancel()
        setStateIfCurrent(run) { withSettings(PanelState(file = info, status = PanelState.STATUS_ERROR, error = error)) }
    }

    private fun markStale() {
        if (state.status == PanelState.STATUS_DONE && !state.stale) {
            setState { it.copy(stale = true) }
        }
    }

    private fun stop() {
        synchronized(lock) { currentRun = null }
        autoJob?.cancel()
        job?.cancel()
        job = null
    }

    private fun setState(change: (PanelState) -> PanelState) {
        val snapshot = synchronized(lock) {
            state = change(state)
            state
        }
        listeners.forEach { it(snapshot) }
    }

    private fun setStateIfCurrent(run: Any, change: (PanelState) -> PanelState) {
        val snapshot = synchronized(lock) {
            if (currentRun !== run) {
                return
            }
            state = change(state)
            state
        }
        listeners.forEach { it(snapshot) }
    }

    private fun view(base: PanelState, analysis: Analysis): PanelState = base.copy(
        stage = analysis.stage,
        truncated = analysis.truncated,
        summary = analysis.summary,
        methods = analysis.methods,
        storyPending = analysis.storyPending,
        usageSearchPending = analysis.usageSearchPending,
        purposePending = analysis.purposePending,
        usageError = analysis.usageError,
    )

    private fun withSettings(base: PanelState): PanelState {
        val settings = CodeReaderSettings.getInstance().snapshot()
        return base.copy(provider = settings.provider, mode = settings.mode)
    }

    private fun fileInfo(target: VirtualFile): FileInfo = FileInfo(
        uri = target.url,
        displayPath = ProjectSources.displayPath(project, target),
        fileName = target.name,
        languageId = target.fileType.name,
    )

    /** The text as shown in the editor, including changes not saved yet. */
    private fun textOf(target: VirtualFile): String? = runReadActionBlocking {
        if (target.isValid) FileDocumentManager.getInstance().getDocument(target)?.text else null
    }

    private fun createProvider(settings: CodeReaderSettings.Snapshot): AiProvider {
        val options = ProviderOptions(
            command = settings.command,
            model = settings.model,
            // Kept away from the project so the CLI does not pick up its settings or instructions.
            workDir = File(PathManager.getSystemPath(), "code-reader").path,
            timeoutMs = settings.timeoutMs,
        )
        return if (settings.provider == CodeReaderSettings.PROVIDER_CODEX) CodexCliProvider(options) else ClaudeCliProvider(options)
    }

    private fun fingerprint(text: String, settings: CodeReaderSettings.Snapshot): String {
        val digest = MessageDigest.getInstance("SHA-1")
        val key = listOf(settings.provider, settings.model, settings.language, settings.maxUsagesPerMethod).joinToString("\n")
        digest.update(key.toByteArray())
        digest.update('\n'.code.toByte())
        digest.update(text.toByteArray())
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val AUTO_DELAY_MS = 800L
    }
}
