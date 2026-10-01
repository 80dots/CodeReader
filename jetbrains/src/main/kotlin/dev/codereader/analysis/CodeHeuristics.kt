package dev.codereader.analysis

/**
 * Text-only guesses about code structure, used where the IDE gives a plugin no
 * language-aware answer (Rider keeps C# analysis in its separate backend).
 * They cover common C-like, Kotlin, Python and similar layouts and are deliberately
 * conservative: when unsure, a line counts as a use rather than a declaration.
 *
 * @param extension file extension without the dot; decides which declaration style applies.
 */
class CodeHeuristics(extension: String) {
    /** Languages where every method declaration starts with a keyword such as `fun` or `def`. */
    private val keywordOnly = extension.lowercase() in KEYWORD_LANGUAGES

    fun isComment(line: String): Boolean {
        val trimmed = line.trimStart()
        return COMMENT_STARTS.any { trimmed.startsWith(it) }
    }

    /** Lines that only bring a name into a file are not real uses of it. */
    fun isImport(line: String): Boolean {
        val trimmed = line.trimStart()
        return trimmed.startsWith("import ") || trimmed.startsWith("from ") || trimmed.startsWith("#include") ||
            (trimmed.startsWith("using ") && !trimmed.contains("("))
    }

    /** Whether `name`, found at `column` of `line`, is being declared there rather than used. */
    fun isDeclaration(line: String, name: String, column: Int): Boolean {
        val before = line.substring(0, column).trimEnd()
        val after = line.substring(column + name.length).trimStart()
        if (!after.startsWith("(") && !after.startsWith("<")) {
            return false
        }
        val lastWord = before.takeLastWhile { it.isLetterOrDigit() || it == '_' }
        if (lastWord in DECLARATION_KEYWORDS) {
            return true
        }
        if (keywordOnly) {
            // Go methods put a receiver between the keyword and the name: `func (s *Server) Run(`.
            return before.trimStart().startsWith("func ") && before.endsWith(")")
        }
        if (before.isEmpty()) {
            // `Name(...) {` opens a body; `Name(...);` and a bare `Name(...)` are calls.
            return line.substringBefore("//").trimEnd().endsWith("{")
        }
        if (lastWord in CALL_KEYWORDS || before.contains('=') || before.contains('(')) {
            return false
        }
        val last = before.last()
        if (last.isLetterOrDigit() || last == '_') {
            // A type or modifier stands right before the name: `public void Name(`.
            return true
        }
        // `Task<int> Name(`, `int[] Name(`, `int? Name(`, `char* Name(`: the symbol hugs the type.
        // With a space before it (`a > Name(b)`, `x ? Name() : y`) it is an operator instead.
        return last in ">]?*" && before.length >= 2 && !before[before.length - 2].isWhitespace()
    }

    /**
     * Name of the method whose body most likely contains line `index`: the nearest
     * declaration above that is indented less.
     */
    fun enclosingMethod(lines: List<String>, index: Int): String? {
        var limit = indentOf(lines[index])
        for (i in index - 1 downTo maxOf(0, index - MAX_LINES_UP)) {
            val line = lines[i]
            val trimmed = line.trim()
            // Brace-only lines sit at the same depth as the declaration they belong to.
            if (trimmed.isEmpty() || trimmed.all { it in "{}()[];," } || isComment(line)) {
                continue
            }
            val indent = indentOf(line)
            if (indent >= limit) {
                continue
            }
            limit = indent

            ARROW_VALUE.find(line)?.let { return it.groupValues[1] }
            for (match in CALL_LIKE.findAll(line)) {
                val candidate = match.groupValues[1]
                if (candidate !in CONTROL_WORDS && isDeclaration(line, candidate, match.groups[1]!!.range.first)) {
                    return candidate
                }
            }
            if (limit == 0) {
                return null
            }
        }
        return null
    }

    private fun indentOf(line: String): Int {
        var width = 0
        for (char in line) {
            when (char) {
                ' ' -> width += 1
                '\t' -> width += 4
                else -> return width
            }
        }
        return width
    }

    companion object {
        private const val MAX_LINES_UP = 400

        private val KEYWORD_LANGUAGES = setOf("kt", "kts", "py", "rb", "go", "rs", "swift", "php", "lua", "scala")
        private val COMMENT_STARTS = listOf("//", "*", "/*", "#", "'''", "\"\"\"", "--")
        private val DECLARATION_KEYWORDS = setOf("def", "fun", "function", "func", "fn", "sub")

        /** Words that may stand right before a call but never before a declared name. */
        private val CALL_KEYWORDS = setOf(
            "return", "await", "new", "throw", "yield", "else", "in", "case", "typeof", "is", "as",
            "not", "and", "or", "do", "out", "ref",
        )

        private val CONTROL_WORDS = setOf(
            "if", "for", "foreach", "while", "switch", "catch", "using", "lock", "when", "return", "sizeof",
            "typeof", "nameof", "await", "new", "throw", "else", "do", "try", "fixed", "function", "super",
            "base", "this",
        )

        private val CALL_LIKE = Regex("""([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(""")
        private val ARROW_VALUE =
            Regex("""([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>""")
    }
}
