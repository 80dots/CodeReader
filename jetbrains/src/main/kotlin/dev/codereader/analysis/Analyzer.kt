package dev.codereader.analysis

import dev.codereader.ai.AiProvider
import dev.codereader.ai.AiRequest
import dev.codereader.ai.Prompts
import dev.codereader.model.MethodView
import dev.codereader.model.PanelState
import dev.codereader.model.Summary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Everything learned about a file so far; filled in step by step while the analysis runs. */
data class Analysis(
    val stage: String? = null,
    val truncated: Boolean = false,
    val summary: Summary? = null,
    val methods: List<MethodView> = emptyList(),
    val storyPending: Boolean = false,
    val usageSearchPending: Boolean = false,
    val purposePending: Boolean = false,
    val usageError: String? = null,
)

class Analyzer(
    private val provider: AiProvider,
    private val language: String,
    /** Finds the usages of the listed methods; runs beside the story requests. */
    private val findUsages: suspend (List<MethodView>) -> CollectedUsages,
    /** Called whenever the analysis gained something new to show. */
    private val onUpdate: (Analysis) -> Unit,
) {
    private val lock = Any()
    private var analysis = Analysis()

    private fun update(change: (Analysis) -> Analysis) {
        val snapshot = synchronized(lock) {
            analysis = change(analysis)
            analysis
        }
        onUpdate(snapshot)
    }

    /**
     * Explains a file. Throws when the summary or the method stories cannot be
     * written; a failure while explaining usages only sets `usageError`.
     */
    suspend fun analyze(displayPath: String, languageId: String, extension: String, text: String): Analysis {
        val truncated = text.length > MAX_SOURCE_CHARS
        val file = Prompts.SourceFile(
            displayPath = displayPath,
            languageId = languageId,
            source = if (truncated) text.take(MAX_SOURCE_CHARS) else text,
            truncated = truncated,
        )
        val system = Prompts.system(language)
        // Story requests running at once (the usage request runs beside them).
        val storySlots = Semaphore(STORY_CONCURRENCY)

        update { it.copy(stage = PanelState.STAGE_SYMBOLS, truncated = truncated, storyPending = true) }

        coroutineScope {
            val whole = this
            coroutineScope {
                // The summary does not depend on the method list, so it starts right away.
                launch {
                    val summary = storySlots.withPermit {
                        Prompts.readSummary(provider.run(AiRequest(system, Prompts.summary(file), Prompts.SUMMARY_ONLY_SCHEMA)))
                    }
                    update { it.copy(summary = summary) }
                }

                val listed = storySlots.withPermit {
                    Prompts.readMethodList(provider.run(AiRequest(system, Prompts.methodList(file), Prompts.METHOD_LIST_SCHEMA)))
                }.take(Prompts.MAX_METHODS)
                val methods = locate(text, extension, listed)
                update {
                    it.copy(stage = PanelState.STAGE_WRITING, methods = methods, usageSearchPending = methods.isNotEmpty())
                }
                if (methods.isNotEmpty()) {
                    // Outlives the story requests: `storyPending` clears as soon as those are done.
                    whole.launch { explainUsages(system, displayPath, methods) }
                }

                // Small requests side by side: stories fill in batch by batch instead of after one long wait.
                for (batch in methods.chunked(METHODS_PER_REQUEST)) {
                    launch {
                        val told = storySlots.withPermit {
                            val refs = batch.map { Prompts.MethodRef(it.id, it.name, it.container, it.line) }
                            Prompts.readMethods(provider.run(AiRequest(system, Prompts.methods(file, refs), Prompts.METHODS_ONLY_SCHEMA)))
                        }.associateBy { it.id }
                        update { current ->
                            current.copy(methods = current.methods.map { method ->
                                told[method.id]?.let { method.copy(explanation = it.explanation) } ?: method
                            })
                        }
                    }
                }
            }
            update { it.copy(storyPending = false) }
        }

        update { it.copy(stage = null) }
        return synchronized(lock) { analysis }
    }

    private suspend fun explainUsages(system: String, displayPath: String, methods: List<MethodView>) {
        try {
            val collected = findUsages(methods)
            update { current ->
                current.copy(
                    usageSearchPending = false,
                    purposePending = collected.promptItems.isNotEmpty(),
                    methods = current.methods.map { method ->
                        collected.byMethod[method.id]?.let { method.copy(usages = it.items, usageTotal = it.total) } ?: method
                    },
                )
            }
            if (collected.promptItems.isEmpty()) {
                return
            }

            val purposes = Prompts.readPurposes(
                provider.run(
                    AiRequest(
                        system,
                        Prompts.purposes(displayPath, collected.promptItems, approximate = true),
                        Prompts.PURPOSE_SCHEMA,
                    ),
                ),
            )
            update { current ->
                current.copy(
                    purposePending = false,
                    methods = current.methods.map { method ->
                        // An empty purpose is the AI saying "this is not really a use of the method".
                        val kept = method.usages.filter { purposes[it.id] != "" }
                        method.copy(
                            usages = kept.map { it.copy(purpose = purposes[it.id]) },
                            usageTotal = method.usageTotal - (method.usages.size - kept.size),
                        )
                    },
                )
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            update { it.copy(usageSearchPending = false, purposePending = false, usageError = error.message ?: error.toString()) }
        }
    }

    /** Gives every listed method an id and its position in the text. */
    private fun locate(text: String, extension: String, listed: List<Prompts.ListedMethod>): List<MethodView> {
        val lines = text.lines()
        val heuristics = CodeHeuristics(extension)
        // Overloads share a name: each one takes the next declaration not yet claimed.
        val claimed = mutableSetOf<Int>()
        return listed.mapIndexed { index, method ->
            val name = method.name.substringAfterLast('.')
            val pattern = Regex("""(?<![\w$])${Regex.escape(name)}(?![\w$])""")
            val candidates = lines.withIndex().mapNotNull { (lineIndex, line) ->
                if (lineIndex in claimed || heuristics.isComment(line)) {
                    return@mapNotNull null
                }
                pattern.find(line)?.let { lineIndex to it.range.first }
            }
            // Prefer a line that reads like a declaration; otherwise settle for the first mention.
            val position = candidates.firstOrNull { (lineIndex, column) ->
                heuristics.isDeclaration(lines[lineIndex], name, column)
            } ?: candidates.firstOrNull()
            position?.let { claimed += it.first }
            MethodView(
                id = "m${index + 1}",
                name = method.name,
                container = method.container,
                line = position?.first,
                character = position?.second,
            )
        }
    }

    companion object {
        /** Longer files are cut here so one request stays a reasonable size. */
        private const val MAX_SOURCE_CHARS = 80_000
        private const val METHODS_PER_REQUEST = 6
        private const val STORY_CONCURRENCY = 3
    }
}
