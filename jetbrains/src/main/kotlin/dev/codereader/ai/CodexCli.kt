package dev.codereader.ai

import com.google.gson.JsonElement
import java.io.File
import java.util.UUID

/**
 * Runs Codex in headless mode (`codex exec`).
 *
 * NOTE: written from the Codex CLI documentation and not yet run against a real
 * installation. Check the flags with `codex exec --help` once Codex is installed.
 */
class CodexCliProvider(private val options: ProviderOptions) : AiProvider {

    override suspend fun run(request: AiRequest): JsonElement {
        val id = UUID.randomUUID().toString()
        val tempDir = File(System.getProperty("java.io.tmpdir"))
        val schemaFile = File(tempDir, "code-reader-$id.schema.json")
        val outputFile = File(tempDir, "code-reader-$id.out.json")
        schemaFile.writeText(request.schema, Charsets.UTF_8)

        val args = mutableListOf(
            "exec",
            // Read-only sandbox: Codex may look but can never change files.
            "--sandbox", "read-only",
            "--skip-git-repo-check",
            "--output-schema", schemaFile.absolutePath,
            "--output-last-message", outputFile.absolutePath,
        )
        if (options.model.isNotBlank()) {
            args += listOf("--model", options.model)
        }
        // "-" makes Codex read the prompt from stdin.
        args += "-"

        try {
            val result = runCli(
                CliRun(
                    label = "Codex",
                    command = options.command,
                    args = args,
                    stdin = "${request.system}\n\n${request.prompt}",
                    workDir = options.workDir,
                    timeoutMs = options.timeoutMs,
                ),
            )
            val answer = if (outputFile.isFile) outputFile.readText(Charsets.UTF_8) else ""
            if (result.code != 0 || answer.isBlank()) {
                throw AiException(
                    AiException.FAILED,
                    "Codex가 대답을 돌려주지 않았어요. 터미널에서 codex를 실행해 로그인되어 있는지 확인해 주세요.",
                    result.stderr.ifBlank { result.stdout }.trim().take(2000).ifEmpty { "exit code ${result.code}" },
                )
            }
            return try {
                parseLooseJson(answer)
            } catch (_: Exception) {
                throw AiException(AiException.FAILED, "Codex의 대답을 읽지 못했어요.", answer.take(2000))
            }
        } finally {
            schemaFile.delete()
            outputFile.delete()
        }
    }
}
