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

data class MethodExplanation(
    val role: String,
    val story: String,
    val steps: List<String>,
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
    val explanation: MethodExplanation? = null,
    val usages: List<UsageItem> = emptyList(),
    val usageTotal: Int = 0,
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
    val methods: List<MethodView> = emptyList(),
    val storyPending: Boolean = false,
    val usageSearchPending: Boolean = false,
    val purposePending: Boolean = false,
    val error: PanelError? = null,
    val usageError: String? = null,
    val usageApproximate: Boolean = false,
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
