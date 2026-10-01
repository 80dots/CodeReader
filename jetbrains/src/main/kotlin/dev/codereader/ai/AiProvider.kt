package dev.codereader.ai

import com.google.gson.JsonElement

data class AiRequest(
    val system: String,
    val prompt: String,
    /** JSON Schema (as JSON text) the answer must follow. */
    val schema: String,
)

interface AiProvider {
    /** Runs one headless request and returns the parsed JSON answer. Cancelling the coroutine stops the CLI. */
    suspend fun run(request: AiRequest): JsonElement
}

data class ProviderOptions(
    /** Executable path or command name. */
    val command: String,
    val model: String,
    /** Working directory for the CLI; kept away from the user's project. */
    val workDir: String,
    val timeoutMs: Long,
)

class AiException(
    /** One of the error kinds the panel understands: cli-not-found, timeout, failed. */
    val kind: String,
    message: String,
    val detail: String? = null,
) : Exception(message) {
    companion object {
        const val CLI_NOT_FOUND = "cli-not-found"
        const val TIMEOUT = "timeout"
        const val FAILED = "failed"
    }
}
