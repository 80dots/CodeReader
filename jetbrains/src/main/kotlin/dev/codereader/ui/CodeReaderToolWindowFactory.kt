package dev.codereader.ui

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import dev.codereader.CodeReaderService
import dev.codereader.settings.CodeReaderConfigurable
import javax.swing.SwingConstants

class CodeReaderToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val component = if (JBCefApp.isSupported()) {
            CodeReaderPanel(project, toolWindow.disposable).component
        } else {
            JBLabel("이 IDE는 내장 브라우저(JCEF)를 지원하지 않아 Code Reader 패널을 표시할 수 없어요.", SwingConstants.CENTER)
        }
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(component, "", false))
        toolWindow.setTitleActions(listOf(RefreshAction(), SettingsAction()))
    }

    private class RefreshAction : DumbAwareAction("다시 설명하기", null, AllIcons.Actions.Refresh) {
        override fun actionPerformed(event: AnActionEvent) {
            event.project?.service<CodeReaderService>()?.explain(force = true)
        }
    }

    private class SettingsAction : DumbAwareAction("설정 열기", null, AllIcons.General.Settings) {
        override fun actionPerformed(event: AnActionEvent) {
            ShowSettingsUtil.getInstance().showSettingsDialog(event.project, CodeReaderConfigurable::class.java)
        }
    }

    companion object {
        const val ID = "Code Reader"
    }
}

/** "이 코드 설명하기" in the Tools menu and the editor's context menu. */
class ExplainAction : AnAction(), DumbAware {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
            .getToolWindow(CodeReaderToolWindowFactory.ID) ?: return
        toolWindow.activate { project.service<CodeReaderService>().explain(force = false) }
    }
}
