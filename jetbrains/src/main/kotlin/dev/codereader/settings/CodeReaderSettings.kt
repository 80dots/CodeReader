package dev.codereader.settings

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.util.messages.Topic

/** Same options as the VS Code extension's `codeReader.*` settings. */
@Service(Service.Level.APP)
@State(name = "CodeReaderSettings", storages = [Storage("codeReader.xml")])
class CodeReaderSettings : SimplePersistentStateComponent<CodeReaderSettings.Options>(Options()) {

    class Options : BaseState() {
        var provider by string(PROVIDER_CLAUDE)
        var mode by string(MODE_MANUAL)
        var language by string("한국어")
        var maxUsagesPerMethod by property(8)
        var timeoutSeconds by property(180)
        var claudePath by string("claude")
        var claudeModel by string("sonnet")
        var codexPath by string("codex")
        var codexModel by string("")
    }

    /** The options with defaults filled in, safe to hand to a background run. */
    data class Snapshot(
        val provider: String,
        val mode: String,
        val language: String,
        val maxUsagesPerMethod: Int,
        val timeoutMs: Long,
        val command: String,
        val model: String,
    )

    fun snapshot(): Snapshot {
        val provider = if (state.provider == PROVIDER_CODEX) PROVIDER_CODEX else PROVIDER_CLAUDE
        val isCodex = provider == PROVIDER_CODEX
        return Snapshot(
            provider = provider,
            mode = if (state.mode == MODE_AUTO) MODE_AUTO else MODE_MANUAL,
            language = state.language?.trim().orEmpty().ifEmpty { "한국어" },
            maxUsagesPerMethod = state.maxUsagesPerMethod.coerceIn(0, 30),
            timeoutMs = state.timeoutSeconds.coerceAtLeast(30) * 1000L,
            command = (if (isCodex) state.codexPath else state.claudePath)?.trim().orEmpty().ifEmpty { provider },
            model = (if (isCodex) state.codexModel else state.claudeModel)?.trim().orEmpty(),
        )
    }

    fun interface ChangeListener {
        fun settingsChanged()
    }

    companion object {
        const val PROVIDER_CLAUDE = "claude"
        const val PROVIDER_CODEX = "codex"
        const val MODE_MANUAL = "manual"
        const val MODE_AUTO = "auto"

        val TOPIC: Topic<ChangeListener> = Topic.create("Code Reader settings", ChangeListener::class.java)

        fun getInstance(): CodeReaderSettings = service()
    }
}
