package dev.codereader.analysis

import dev.codereader.ai.AiProvider
import dev.codereader.ai.AiRequest
import dev.codereader.ai.Prompts
import dev.codereader.model.ClassView
import dev.codereader.model.LineRange
import dev.codereader.model.MethodExplanation
import dev.codereader.model.MethodView
import dev.codereader.model.PanelState
import dev.codereader.model.ParentView
import dev.codereader.model.Step
import dev.codereader.model.Summary
import dev.codereader.model.VariableExplanation
import dev.codereader.model.VariableView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Everything learned about a file so far; filled in step by step while the analysis runs. */
data class Analysis(
    val stage: String? = null,
    val truncated: Boolean = false,
    val summary: Summary? = null,
    val classes: List<ClassView> = emptyList(),
    val variables: List<VariableView> = emptyList(),
    val methods: List<MethodView> = emptyList(),
    val storyPending: Boolean = false,
    val usageSearchPending: Boolean = false,
    val purposePending: Boolean = false,
    val usageError: String? = null,
)

/** Where a class's parent is defined, and its own source to explain it from. */
data class ParentSource(
    val uri: String,
    val displayPath: String,
    /** 0-based position of the parent's name in its declaration. */
    val line: Int,
    val character: Int,
    /** Null when the parent is defined in the file being explained: the AI already has that. */
    val source: String?,
)

class Analyzer(
    private val provider: AiProvider,
    private val language: String,
    /** Finds the usages of the listed methods; runs beside the story requests. */
    private val findUsages: suspend (List<MethodView>) -> CollectedUsages,
    /** Looks for the declaration of a class or interface by name; null when the project has none. */
    private val findParent: suspend (String) -> ParentSource?,
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
     * Explains a file. Throws when the summary or the stories cannot be
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
        val lines = text.lines()
        // Story requests running at once (the usage request runs beside them).
        val storySlots = Semaphore(STORY_CONCURRENCY)
        suspend fun ask(prompt: String, schema: String) = storySlots.withPermit { provider.run(AiRequest(system, prompt, schema)) }

        update { it.copy(stage = PanelState.STAGE_SYMBOLS, truncated = truncated, storyPending = true) }

        coroutineScope {
            val whole = this
            coroutineScope {
                // The summary does not depend on the outline, so it starts right away.
                launch {
                    val summary = Prompts.readSummary(ask(Prompts.summary(file), Prompts.SUMMARY_SCHEMA))
                    update { it.copy(summary = summary) }
                }

                val outline = Prompts.readOutline(ask(Prompts.outline(file), Prompts.OUTLINE_SCHEMA))
                val methods = locateMethods(lines, extension, outline.methods.take(Prompts.MAX_METHODS))
                val variables = locateVariables(lines, outline.variables.take(Prompts.MAX_VARIABLES))
                val classes = locateClasses(lines, outline.classes)
                update {
                    it.copy(
                        stage = PanelState.STAGE_WRITING,
                        classes = classes,
                        variables = variables,
                        methods = methods,
                        usageSearchPending = methods.isNotEmpty(),
                    )
                }
                if (methods.isNotEmpty()) {
                    // Outlives the story requests: `storyPending` clears as soon as those are done.
                    whole.launch { explainUsages(system, displayPath, methods) }
                }

                // Small requests side by side: stories fill in batch by batch instead of after one long wait.
                if (classes.isNotEmpty()) {
                    launch { explainClasses(file, classes, ::ask) }
                }
                explainMethods(this, file, methods, lines.size, ::ask)
                explainVariables(this, file, variables, ::ask)
            }
            update { it.copy(storyPending = false) }
        }

        update { it.copy(stage = null) }
        return synchronized(lock) { analysis }
    }

    private suspend fun explainClasses(
        file: Prompts.SourceFile,
        classes: List<ClassView>,
        ask: suspend (String, String) -> com.google.gson.JsonElement,
    ) {
        // The parents' own source lets the AI explain what is really inherited instead of guessing from a name.
        val sources = classes.flatMap { it.parents }.map { it.name }.distinct().associateWith { findParent(it) }
        update { current ->
            current.copy(classes = current.classes.map { item ->
                item.copy(parents = item.parents.map { parent ->
                    sources[parent.name]?.let { parent.copy(uri = it.uri, line = it.line, character = it.character) } ?: parent
                })
            })
        }

        val refs = classes.map { item ->
            Prompts.ClassRef(item.id, item.name, item.line, item.parents.map { parent ->
                Prompts.ParentRef(parent.name, sources[parent.name]?.displayPath, sources[parent.name]?.source)
            })
        }
        val told = Prompts.readClasses(ask(Prompts.classes(file, refs), Prompts.CLASSES_SCHEMA)).associateBy { it.id }
        update { current ->
            current.copy(classes = current.classes.map { item ->
                val answer = told[item.id] ?: return@map item
                item.copy(
                    role = answer.role,
                    parents = item.parents.map { parent ->
                        parent.copy(explanation = answer.parents.firstOrNull { it.name == parent.name }?.explanation)
                    },
                )
            })
        }
    }

    private fun explainMethods(
        scope: CoroutineScope,
        file: Prompts.SourceFile,
        methods: List<MethodView>,
        lineCount: Int,
        ask: suspend (String, String) -> com.google.gson.JsonElement,
    ) {
        for (batch in methods.chunked(METHODS_PER_REQUEST)) {
            scope.launch {
                val refs = batch.map { Prompts.MethodRef(it.id, it.name, it.container, it.line, it.range) }
                val told = Prompts.readMethods(ask(Prompts.methods(file, refs), Prompts.METHODS_SCHEMA)).associateBy { it.id }
                update { current ->
                    current.copy(methods = current.methods.map { method ->
                        val answer = told[method.id] ?: return@map method
                        method.copy(
                            explanation = MethodExplanation(
                                role = answer.role,
                                story = answer.story,
                                steps = answer.steps.map { Step(it.text, checkedRange(it.startLine, it.endLine, method.range, lineCount)) },
                            ),
                        )
                    })
                }
            }
        }
    }

    private fun explainVariables(
        scope: CoroutineScope,
        file: Prompts.SourceFile,
        variables: List<VariableView>,
        ask: suspend (String, String) -> com.google.gson.JsonElement,
    ) {
        for (batch in variables.chunked(VARIABLES_PER_REQUEST)) {
            scope.launch {
                val refs = batch.map { Prompts.VariableRef(it.id, it.name, it.container, it.line) }
                val told = Prompts.readVariables(ask(Prompts.variables(file, refs), Prompts.VARIABLES_SCHEMA)).associateBy { it.id }
                update { current ->
                    current.copy(variables = current.variables.map { variable ->
                        told[variable.id]?.let { variable.copy(explanation = VariableExplanation(it.role, it.story)) } ?: variable
                    })
                }
            }
        }
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
    private fun locateMethods(lines: List<String>, extension: String, listed: List<Prompts.ListedMember>): List<MethodView> {
        val heuristics = CodeHeuristics(extension)
        // Overloads share a name: each one takes the next declaration not yet claimed.
        val claimed = mutableSetOf<Int>()
        return listed.mapIndexed { index, method ->
            val name = method.name.substringAfterLast('.')
            val candidates = mentions(lines, name).filter { (line, _) -> line !in claimed && !heuristics.isComment(lines[line]) }
            // The AI says which lines the method spans; trust that only if the name really is in there.
            val told = checkedRange(method.startLine, method.endLine, null, lines.size)
            val inside = candidates.filter { (line, _) -> told != null && line in told.startLine..told.endLine }
            val declares = { candidate: Pair<Int, Int> -> heuristics.isDeclaration(lines[candidate.first], name, candidate.second) }
            // Prefer a line that reads like a declaration; otherwise settle for the first mention.
            val position = inside.firstOrNull(declares) ?: inside.firstOrNull()
                ?: candidates.firstOrNull(declares) ?: candidates.firstOrNull()
            position?.let { claimed += it.first }
            MethodView(
                id = "m${index + 1}",
                name = method.name,
                container = method.container,
                line = position?.first,
                character = position?.second,
                range = told.takeIf { inside.isNotEmpty() },
            )
        }
    }

    private fun locateVariables(lines: List<String>, listed: List<Prompts.ListedMember>): List<VariableView> =
        listed.mapIndexed { index, variable ->
            val name = variable.name.substringAfterLast('.')
            val candidates = mentions(lines, name)
            val told = checkedRange(variable.startLine, variable.endLine, null, lines.size)
            val inside = candidates.firstOrNull { (line, _) -> told != null && line in told.startLine..told.endLine }
            val position = inside ?: candidates.firstOrNull()
            VariableView(
                id = "v${index + 1}",
                name = variable.name,
                container = variable.container,
                line = position?.first,
                character = position?.second,
                range = told.takeIf { inside != null },
            )
        }

    private fun locateClasses(lines: List<String>, listed: List<Prompts.ListedClass>): List<ClassView> =
        listed.mapIndexed { index, item ->
            val candidates = mentions(lines, item.name)
            val position = candidates.firstOrNull { (line, _) -> line == item.line?.minus(1) } ?: candidates.firstOrNull()
            ClassView(
                id = "c${index + 1}",
                name = item.name,
                line = position?.first,
                character = position?.second,
                parents = item.parents.distinct().map { ParentView(name = it) },
            )
        }

    /** Every place a name is written as a whole word: (line, column), both 0-based. */
    private fun mentions(lines: List<String>, name: String): List<Pair<Int, Int>> {
        val pattern = Regex("""(?<![\w$])${Regex.escape(name)}(?![\w$])""")
        return lines.withIndex().mapNotNull { (index, line) -> pattern.find(line)?.let { index to it.range.first } }
    }

    /**
     * Turns the AI's 1-based line numbers into a range, or null when they fall outside
     * `bounds` (or the file): a wrong highlight is worse than none.
     */
    private fun checkedRange(startLine: Int?, endLine: Int?, bounds: LineRange?, lineCount: Int): LineRange? {
        if (startLine == null || endLine == null) {
            return null
        }
        val range = LineRange(startLine - 1, endLine - 1)
        val first = bounds?.startLine ?: 0
        val last = bounds?.endLine ?: (lineCount - 1)
        return range.takeIf { it.startLine <= it.endLine && it.startLine >= first && it.endLine <= last }
    }

    companion object {
        /** Longer files are cut here so one request stays a reasonable size. */
        private const val MAX_SOURCE_CHARS = 80_000
        private const val METHODS_PER_REQUEST = 6
        private const val VARIABLES_PER_REQUEST = 15
        private const val STORY_CONCURRENCY = 3
    }
}
