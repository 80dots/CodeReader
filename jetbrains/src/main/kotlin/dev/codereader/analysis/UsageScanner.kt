package dev.codereader.analysis

import dev.codereader.ai.Prompts
import dev.codereader.model.MethodView
import dev.codereader.model.UsageItem

/** One file the scanner may look into. The text is loaded lazily: most files are never read. */
class SourceText(val uri: String, val displayPath: String, val load: () -> String?)

data class CollectedUsages(
    /** Usages per method id. */
    val byMethod: Map<String, MethodUsages>,
    /** What the AI needs to explain each usage. */
    val promptItems: List<Prompts.PurposeItem>,
)

data class MethodUsages(val items: List<UsageItem>, val total: Int)

/**
 * Finds where methods are used by looking for their names in the project's files.
 * This is a text search, so it can confuse methods that share a name; the AI is
 * asked to weed those out when it explains each usage.
 */
class UsageScanner(extension: String, private val maxPerMethod: Int) {
    private val heuristics = CodeHeuristics(extension)

    /**
     * @param current the file being explained; `methods` positions refer to it.
     * @param others other files of the same language, searched after `current`.
     */
    fun scan(current: SourceText, others: List<SourceText>, methods: List<MethodView>): CollectedUsages {
        val found = methods.associate { it.id to mutableListOf<Found>() }
        val totals = methods.associate { it.id to intArrayOf(0) }
        val patterns = methods.associate { it.id to usagePattern(it.name) }
        var declarations = emptyMap<String, String>()

        for (source in listOf(current) + others) {
            val text = source.load() ?: continue
            val isCurrent = source === current
            val wanted = methods.filter { text.contains(it.name) }
            if (wanted.isEmpty() && !isCurrent) {
                continue
            }
            val lines = text.lines()
            if (isCurrent) {
                declarations = methods.associate { method ->
                    method.id to (method.line?.let { lines.getOrNull(it) }?.trim()?.let(::clip) ?: method.name)
                }
            }

            for ((index, line) in lines.withIndex()) {
                if (heuristics.isComment(line) || heuristics.isImport(line)) {
                    continue
                }
                for (method in wanted) {
                    if (!line.contains(method.name)) {
                        continue
                    }
                    val match = patterns.getValue(method.id).find(line) ?: continue
                    val column = match.groups[1]!!.range.first
                    val ownDeclaration = isCurrent && index == method.line
                    if (ownDeclaration || heuristics.isDeclaration(line, method.name, column)) {
                        continue
                    }
                    totals.getValue(method.id)[0]++
                    val list = found.getValue(method.id)
                    if (list.size < maxPerMethod) {
                        list += Found(
                            UsageItem(
                                id = "",
                                uri = source.uri,
                                displayPath = source.displayPath,
                                line = index,
                                character = column,
                                caller = heuristics.enclosingMethod(lines, index),
                                preview = clip(line.trim()),
                            ),
                            snippetAround(lines, index),
                        )
                    }
                }
            }
        }

        // Ids are handed out afterwards so they follow the order methods appear in the file.
        var counter = 0
        val promptItems = mutableListOf<Prompts.PurposeItem>()
        val byMethod = methods.associate { method ->
            val items = found.getValue(method.id).map { entry ->
                val item = entry.item.copy(id = "u${++counter}")
                promptItems += Prompts.PurposeItem(
                    id = item.id,
                    method = if (method.container.isNullOrEmpty()) method.name else "${method.container}.${method.name}",
                    declaration = declarations[method.id] ?: method.name,
                    displayPath = item.displayPath,
                    caller = item.caller,
                    snippet = entry.snippet,
                )
                item
            }
            method.id to MethodUsages(items, totals.getValue(method.id)[0])
        }
        return CollectedUsages(byMethod, promptItems)
    }

    private class Found(val item: UsageItem, val snippet: String)

    /**
     * The name followed by a call's opening parenthesis, or handed over as a value
     * (`button.onClick += Name;`, `Register(Name)`).
     */
    private fun usagePattern(name: String): Regex {
        val quoted = Regex.escape(name)
        return Regex(
            """(?<![\w$])($quoted)(?![\w$])(?:\s*(?:<[^<>()]*>)?\s*\(|(?<=[+\-]=\s{0,2}$quoted)\s*[;,)]|(?<=[(,]\s{0,2}$quoted)\s*[,)])""",
        )
    }

    private fun snippetAround(lines: List<String>, index: Int): String {
        val first = maxOf(0, index - CONTEXT_LINES)
        val last = minOf(lines.lastIndex, index + CONTEXT_LINES)
        return (first..last).joinToString("\n") { i -> (if (i == index) ">> " else "   ") + clip(lines[i]) }
    }

    private fun clip(text: String): String =
        if (text.length > MAX_LINE_LENGTH) text.take(MAX_LINE_LENGTH) + "…" else text

    companion object {
        private const val CONTEXT_LINES = 3
        private const val MAX_LINE_LENGTH = 200
    }
}
