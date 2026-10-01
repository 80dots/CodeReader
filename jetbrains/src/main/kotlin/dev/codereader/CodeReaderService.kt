package dev.codereader

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.TextEditor
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
import dev.codereader.model.LineRange
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
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** Owns what the panel shows: follows the selected editor and runs explanations. */
@Service(Service.Level.PROJECT)
class CodeReaderService(private val project: Project, private val scope: CoroutineScope) : Disposable {

    /** An explanation that has been written, as kept in memory and on disk. */
    private class CacheEntry(
        /** Identifies the file content the explanation was written for. */
        val contentHash: String,
        val analysis: Analysis,
        /** ISO time the explanation was written. */
        val savedAt: String,
        /** Written by an editor that could only search usages by name (see PanelState). */
        val usageApproximate: Boolean,
    )

    private val listeners = CopyOnWriteArrayList<(PanelState) -> Unit>()
    private val cache = ConcurrentHashMap<String, CacheEntry>()
    private val lock = Any()

    private var file: VirtualFile? = null
    private var job: Job? = null
    private var autoJob: Job? = null

    /** Marks for the code that the explanation under the pointer is about; touched on the UI thread only. */
    private val highlights = mutableListOf<RangeHighlighter>()

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
        val contentHash = ExplanationStore.contentHash(text)
        if (!force) {
            val cached = cache[target.url] ?: loadSaved(target)
            if (cached?.contentHash == contentHash) {
                showCached(target, cached, stale = false)
                return
            }
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
                    findParent = { name ->
                        withContext(Dispatchers.IO) { ProjectSources.findTypeDeclaration(project, target, text, name) }
                    },
                    onUpdate = { partial -> setStateIfCurrent(run) { view(it, partial) } },
                )
                val analysis = analyzer.analyze(info.displayPath, info.languageId, extension, text)
                val entry = CacheEntry(contentHash, analysis, Instant.now().toString(), usageApproximate = true)
                cache[target.url] = entry
                val stale = textOf(target)?.let { ExplanationStore.contentHash(it) != contentHash } ?: false
                setStateIfCurrent(run) { view(it, analysis).copy(status = PanelState.STATUS_DONE, stale = stale) }
                withContext(Dispatchers.IO) { save(target, entry, settings) }
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

    /** Highlights lines of a file in every editor showing it, scrolling them into view if needed. */
    fun highlight(uri: String, range: LineRange) {
        // After an edit the remembered line numbers may point at the wrong code.
        val outdated = state.stale && uri == state.file?.uri
        val target = VirtualFileManager.getInstance().findFileByUrl(uri)
        ApplicationManager.getApplication().invokeLater {
            removeHighlights()
            if (outdated || target == null || project.isDisposed) {
                return@invokeLater
            }
            for (fileEditor in FileEditorManager.getInstance(project).getEditors(target)) {
                val editor = (fileEditor as? TextEditor)?.editor ?: continue
                val document = editor.document
                val lastLine = minOf(range.endLine, document.lineCount - 1)
                if (range.startLine > lastLine) {
                    continue
                }
                val background = editor.colorsScheme.getAttributes(EditorColors.IDENTIFIER_UNDER_CARET_ATTRIBUTES)?.backgroundColor
                    ?: editor.colorsScheme.getColor(EditorColors.CARET_ROW_COLOR)
                val highlighter = editor.markupModel.addRangeHighlighter(
                    document.getLineStartOffset(range.startLine),
                    document.getLineEndOffset(lastLine),
                    HighlighterLayer.SELECTION - 1,
                    TextAttributes().apply { backgroundColor = background },
                    HighlighterTargetArea.LINES_IN_RANGE,
                )
                highlighter.setErrorStripeMarkColor(background)
                highlights += highlighter
                editor.scrollingModel.scrollTo(LogicalPosition(range.startLine, 0), ScrollType.MAKE_VISIBLE)
            }
        }
    }

    fun clearHighlight() {
        ApplicationManager.getApplication().invokeLater(::removeHighlights)
    }

    /** Must run on the UI thread, like every change to an editor's markup. */
    private fun removeHighlights() {
        highlights.forEach { if (it.isValid) it.dispose() }
        highlights.clear()
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
                // A saved explanation may have been found in the meantime; that one is shown instead.
                if (state.status == PanelState.STATUS_IDLE) {
                    explain(force = false)
                }
            }
        }
    }

    /** Shows what is already known about a file: the explanation from memory or from disk, or the start screen. */
    private fun showFile(target: VirtualFile) {
        val cached = cache[target.url]
        if (cached != null) {
            showCached(target, cached, isStale(target, cached))
            return
        }
        setState { withSettings(PanelState(file = fileInfo(target))) }
        scope.launch(Dispatchers.IO) {
            val saved = loadSaved(target) ?: return@launch
            // Reading the disk takes a moment; the user may have moved on or started a new explanation.
            if (file == target && state.status == PanelState.STATUS_IDLE) {
                showCached(target, saved, isStale(target, saved))
            }
        }
    }

    private fun isStale(target: VirtualFile, entry: CacheEntry): Boolean =
        textOf(target)?.let { ExplanationStore.contentHash(it) != entry.contentHash } ?: false

    private fun showCached(target: VirtualFile, entry: CacheEntry, stale: Boolean) {
        setState {
            view(withSettings(PanelState(file = fileInfo(target))), entry.analysis).copy(
                status = PanelState.STATUS_DONE,
                stale = stale,
                savedAt = entry.savedAt.ifEmpty { null },
                usageApproximate = entry.usageApproximate,
            )
        }
    }

    /** Reads the explanation saved on disk for a file, remembering it for next time. */
    private fun loadSaved(target: VirtualFile): CacheEntry? {
        if (!target.isInLocalFileSystem) {
            return null
        }
        val saved = ExplanationStore.load(target.path) ?: return null
        // An explanation written in this session while the disk was being read is newer.
        return cache.getOrPut(target.url) {
            CacheEntry(saved.contentHash, saved.analysis, saved.savedAt, saved.usageApproximate)
        }
    }

    private fun save(target: VirtualFile, entry: CacheEntry, settings: CodeReaderSettings.Snapshot) {
        // Only files on disk have a stable identity to save an explanation under.
        if (!target.isInLocalFileSystem) {
            return
        }
        try {
            ExplanationStore.save(
                target.path,
                ExplanationStore.Saved(
                    contentHash = entry.contentHash,
                    savedAt = entry.savedAt,
                    provider = settings.provider,
                    language = settings.language,
                    usageApproximate = entry.usageApproximate,
                    analysis = entry.analysis,
                ),
            )
        } catch (error: Exception) {
            // The explanation is still shown and kept in memory; only the copy for next time is missing.
            thisLogger().warn("Code Reader could not save the explanation", error)
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
        clearHighlight()
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
        classes = analysis.classes,
        variables = analysis.variables,
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

    companion object {
        private const val AUTO_DELAY_MS = 800L
    }
}
