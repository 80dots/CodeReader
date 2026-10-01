package dev.codereader.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.listCellRenderer.textListCellRenderer
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

class CodeReaderConfigurable : BoundConfigurable("Code Reader") {

    override fun createPanel(): DialogPanel {
        val options = CodeReaderSettings.getInstance().state
        return panel {
            row("설명을 만들 AI:") {
                comboBox(
                    listOf(CodeReaderSettings.PROVIDER_CLAUDE, CodeReaderSettings.PROVIDER_CODEX),
                    textListCellRenderer("") { if (it == CodeReaderSettings.PROVIDER_CODEX) "Codex CLI (codex exec)" else "Claude Code CLI (claude -p)" },
                ).bindItem({ options.provider ?: CodeReaderSettings.PROVIDER_CLAUDE }, { options.provider = it })
            }
            row("설명을 만드는 때:") {
                comboBox(
                    listOf(CodeReaderSettings.MODE_MANUAL, CodeReaderSettings.MODE_AUTO),
                    textListCellRenderer("") { if (it == CodeReaderSettings.MODE_AUTO) "파일을 전환할 때마다 자동으로" else "버튼을 눌렀을 때만" },
                ).bindItem({ options.mode ?: CodeReaderSettings.MODE_MANUAL }, { options.mode = it })
                    .comment("자동으로 설정하면 AI 사용량이 늘어납니다.")
            }
            row("설명 언어:") {
                textField().columns(20)
                    .bindText({ options.language.orEmpty() }, { options.language = it })
                    .comment("예: 한국어, English, 日本語")
            }
            row("메서드당 사용처 최대 개수:") {
                intTextField(0..30).bindIntText({ options.maxUsagesPerMethod }, { options.maxUsagesPerMethod = it })
            }
            row("AI 응답 대기 시간(초):") {
                intTextField(30..3600).bindIntText({ options.timeoutSeconds }, { options.timeoutSeconds = it })
            }
            group("Claude") {
                row("실행 파일 경로:") {
                    textField().columns(30)
                        .bindText({ options.claudePath.orEmpty() }, { options.claudePath = it })
                        .comment("PATH에 있으면 claude 그대로 두세요.")
                }
                row("모델:") {
                    textField().columns(20)
                        .bindText({ options.claudeModel.orEmpty() }, { options.claudeModel = it })
                        .comment("예: sonnet, opus, haiku")
                }
            }
            group("Codex") {
                row("실행 파일 경로:") {
                    textField().columns(30)
                        .bindText({ options.codexPath.orEmpty() }, { options.codexPath = it })
                        .comment("PATH에 있으면 codex 그대로 두세요.")
                }
                row("모델:") {
                    textField().columns(20)
                        .bindText({ options.codexModel.orEmpty() }, { options.codexModel = it })
                        .comment("비워 두면 Codex CLI의 기본 모델을 사용합니다.")
                }
            }
        }
    }

    override fun apply() {
        super.apply()
        ApplicationManager.getApplication().messageBus.syncPublisher(CodeReaderSettings.TOPIC).settingsChanged()
    }
}
