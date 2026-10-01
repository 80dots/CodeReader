package dev.codereader.model

// Mirrors src/shared/protocol.ts: the panel UI is shared with the VS Code extension,
// so the JSON written from these classes must keep the same field names.

data class FileInfo(
    val uri: String,
    val displayPath: String,
    val fileName: String,
    val languageId: String,
)

data class Summary(
    val oneLine: String,
    val story: String,
    val keyPoints: List<String>,
)

/** A run of whole lines in a file; both ends are 0-based and included. */
data class LineRange(val startLine: Int, val endLine: Int)

data class Step(
    val text: String,
    /** The lines of code this step describes, when the AI could point at them. */
    val range: LineRange? = null,
)

data class MethodExplanation(
    val role: String,
    val story: String,
    val steps: List<Step>,
)

data class UsageItem(
    val id: String,
    val uri: String,
    val displayPath: String,
    /** 0-based position of the usage. */
    val line: Int,
    val character: Int,
    val caller: String?,
    val preview: String,
    val purpose: String? = null,
)

data class MethodView(
    val id: String,
    val name: String,
    val container: String?,
    /** 0-based position of the method name, when it could be found in the text. */
    val line: Int?,
    val character: Int?,
    /** The whole method, body included. */
    val range: LineRange? = null,
    val explanation: MethodExplanation? = null,
    val usages: List<UsageItem> = emptyList(),
    val usageTotal: Int = 0,
)

data class VariableExplanation(
    /** What the variable holds or remembers. */
    val role: String,
    /** How the code in this file uses it. */
    val story: String,
)

/** A variable defined outside any method: a global, a constant, or a field of a class. */
data class VariableView(
    val id: String,
    val name: String,
    val container: String?,
    /** 0-based position of the variable's name, when it could be found in the text. */
    val line: Int?,
    val character: Int?,
    /** The whole declaration. */
    val range: LineRange? = null,
    val explanation: VariableExplanation? = null,
)

/** Something a class inherits from: a base class or an interface it implements. */
data class ParentView(
    val name: String,
    /** Where the parent is defined, when it was found inside the project. */
    val uri: String? = null,
    val line: Int? = null,
    val character: Int? = null,
    val explanation: String? = null,
)

/** A class that inherits from something. */
data class ClassView(
    val id: String,
    val name: String,
    /** 0-based position of the class name, when it could be found in the text. */
    val line: Int?,
    val character: Int?,
    val role: String? = null,
    val parents: List<ParentView> = emptyList(),
)

data class PanelError(
    val kind: String,
    val message: String,
    val detail: String?,
)

data class PanelState(
    val file: FileInfo? = null,
    val status: String = STATUS_IDLE,
    val stage: String? = null,
    val stale: Boolean = false,
    val truncated: Boolean = false,
    val summary: Summary? = null,
    val classes: List<ClassView> = emptyList(),
    val variables: List<VariableView> = emptyList(),
    val methods: List<MethodView> = emptyList(),
    val storyPending: Boolean = false,
    val usageSearchPending: Boolean = false,
    val purposePending: Boolean = false,
    val error: PanelError? = null,
    val usageError: String? = null,
    val usageApproximate: Boolean = false,
    /** When the shown explanation was written (ISO time), if it came from the saved copy on disk. */
    val savedAt: String? = null,
    val provider: String = "claude",
    val mode: String = "manual",
) {
    companion object {
        const val STATUS_IDLE = "idle"
        const val STATUS_RUNNING = "running"
        const val STATUS_DONE = "done"
        const val STATUS_ERROR = "error"

        const val STAGE_SYMBOLS = "symbols"
        const val STAGE_WRITING = "writing"
    }
}
