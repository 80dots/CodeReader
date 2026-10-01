package dev.codereader.ai

import com.google.gson.JsonElement
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException

data class CliRun(
    /** Name shown in error messages, e.g. "Claude". */
    val label: String,
    val command: String,
    val args: List<String>,
    /** Sent on stdin so long prompts never hit command-line limits or quoting problems. */
    val stdin: String,
    val workDir: String,
    val timeoutMs: Long,
)

data class CliResult(val stdout: String, val stderr: String, val code: Int)

suspend fun runCli(run: CliRun): CliResult = withContext(Dispatchers.IO) {
    val executable = resolveExecutable(run.command)
        ?: throw AiException(
            AiException.CLI_NOT_FOUND,
            "${run.label} CLI를 찾지 못했어요. 설치되어 있는지, 설정의 실행 파일 경로가 맞는지 확인해 주세요.",
            run.command,
        )

    File(run.workDir).mkdirs()
    val process = try {
        // GeneralCommandLine quotes arguments correctly on Windows (the JSON schema is full of quotes).
        GeneralCommandLine(executable)
            .withParameters(run.args)
            .withWorkDirectory(run.workDir)
            .withCharset(Charsets.UTF_8)
            .createProcess()
    } catch (error: Exception) {
        throw AiException(AiException.FAILED, "${run.label} CLI를 실행하지 못했어요.", error.message)
    }

    coroutineScope {
        val stdout = async { process.inputStream.bufferedReader(Charsets.UTF_8).readText() }
        val stderr = async { process.errorStream.bufferedReader(Charsets.UTF_8).readText() }
        launch {
            try {
                process.outputStream.use { it.write(run.stdin.toByteArray(Charsets.UTF_8)) }
            } catch (_: IOException) {
                // The process exited before reading everything; that shows up in its exit code.
            }
        }

        val code = try {
            withTimeoutOrNull(run.timeoutMs) { runInterruptible { process.waitFor() } }
        } finally {
            // Also reached on cancellation; ending the process is what lets the readers above finish.
            if (process.isAlive) {
                killTree(process)
            }
        }
        if (code == null) {
            throw AiException(AiException.TIMEOUT, "${run.label}의 대답이 너무 오래 걸려서 기다리기를 멈췄어요.")
        }
        CliResult(stdout.await(), stderr.await(), code)
    }
}

private fun killTree(process: Process) {
    process.toHandle().descendants().forEach { it.destroyForcibly() }
    process.destroyForcibly()
}

/** Finds the executable on PATH the way a shell would; null when it does not exist. */
internal fun resolveExecutable(command: String): String? {
    val extensions = if (isWindows()) listOf("", ".exe", ".cmd", ".bat") else listOf("")
    val hasDirectory = command.contains('/') || command.contains('\\')
    val directories = if (hasDirectory) {
        listOf("")
    } else {
        (System.getenv("PATH") ?: "").split(File.pathSeparator).filter { it.isNotBlank() }
    }
    for (directory in directories) {
        for (extension in extensions) {
            val candidate = if (directory.isEmpty()) File(command + extension) else File(directory, command + extension)
            if (candidate.isFile) {
                return candidate.absolutePath
            }
        }
    }
    return null
}

private fun isWindows(): Boolean = System.getProperty("os.name").startsWith("Windows", ignoreCase = true)

/** Parses JSON that may be wrapped in a Markdown code fence. */
internal fun parseLooseJson(text: String): JsonElement {
    val trimmed = text.trim()
    val fenced = Regex("^```(?:json)?\\s*([\\s\\S]*?)\\s*```$").find(trimmed)
    return JsonParser.parseString(fenced?.groupValues?.get(1) ?: trimmed)
}
