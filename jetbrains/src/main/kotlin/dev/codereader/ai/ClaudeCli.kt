package dev.codereader.ai

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** Runs Claude Code in headless mode (`claude -p`). */
class ClaudeCliProvider(private val options: ProviderOptions) : AiProvider {

    override suspend fun run(request: AiRequest): JsonElement {
        val args = mutableListOf(
            "-p",
            "--output-format", "json",
            "--json-schema", request.schema,
            "--system-prompt", request.system,
            // No tools: the CLI only writes text and can never touch files or run commands.
            "--tools", "",
            // Keeps the user's CLAUDE.md, hooks, plugins and MCP servers out of the answer.
            "--safe-mode",
            "--strict-mcp-config",
            "--no-session-persistence",
        )
        if (options.model.isNotBlank()) {
            args += listOf("--model", options.model)
        }

        val result = runCli(
            CliRun(
                label = "Claude",
                command = options.command,
                args = args,
                stdin = request.prompt,
                workDir = options.workDir,
                timeoutMs = options.timeoutMs,
            ),
        )

        val output: JsonObject = try {
            JsonParser.parseString(result.stdout).asJsonObject
        } catch (_: Exception) {
            throw AiException(
                AiException.FAILED,
                "Claude가 대답을 돌려주지 않았어요. 터미널에서 claude를 실행해 로그인되어 있는지 확인해 주세요.",
                result.stderr.ifBlank { result.stdout }.trim().take(2000).ifEmpty { "exit code ${result.code}" },
            )
        }
        val text = output.get("result")?.takeIf { it.isJsonPrimitive }?.asString
        if (output.get("is_error")?.takeIf { it.isJsonPrimitive }?.asBoolean == true) {
            throw AiException(AiException.FAILED, "Claude가 설명을 만들다가 문제가 생겼어요.", text)
        }
        val structured = output.get("structured_output")
        if (structured != null && !structured.isJsonNull) {
            return structured
        }
        return try {
            parseLooseJson(text.orEmpty())
        } catch (_: Exception) {
            throw AiException(AiException.FAILED, "Claude의 대답을 읽지 못했어요.", text?.take(2000))
        }
    }
}
