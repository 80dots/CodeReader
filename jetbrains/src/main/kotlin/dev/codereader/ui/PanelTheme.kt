package dev.codereader.ui

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color

/**
 * Translates the IDE's current colors into the CSS variables the shared panel UI
 * reads. The UI was first written for VS Code, hence the `--vscode-*` names.
 */
object PanelTheme {
    fun bodyClass(): String = if (JBColor.isBright()) "vscode-light" else "vscode-dark"

    fun variables(): Map<String, String> {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val panel = UIUtil.getPanelBackground()
        val foreground = UIUtil.getLabelForeground()
        return linkedMapOf(
            "--vscode-sideBar-background" to css(panel),
            "--vscode-foreground" to css(foreground),
            "--vscode-editor-background" to css(scheme.defaultBackground),
            "--vscode-editor-foreground" to css(scheme.defaultForeground),
            "--vscode-editorWidget-background" to css(panel),
            "--vscode-button-background" to css(JBUI.CurrentTheme.Button.defaultButtonColorStart()),
            "--vscode-button-foreground" to css(JBColor.namedColor("Button.default.foreground", Color.WHITE)),
            "--vscode-button-secondaryBackground" to css(JBUI.CurrentTheme.Button.buttonColorStart()),
            "--vscode-button-secondaryForeground" to css(JBColor.namedColor("Button.foreground", foreground)),
            "--vscode-descriptionForeground" to css(UIUtil.getContextHelpForeground()),
            "--vscode-list-hoverBackground" to css(JBUI.CurrentTheme.List.Hover.background(true)),
            "--vscode-errorForeground" to css(UIUtil.getErrorForeground()),
            "--vscode-widget-border" to css(JBColor.border()),
            "--vscode-focusBorder" to css(JBUI.CurrentTheme.Focus.focusColor()),
            "--vscode-textLink-foreground" to css(JBUI.CurrentTheme.Link.Foreground.ENABLED),
            "--vscode-font-family" to "'${UIUtil.getLabelFont().family}', 'Segoe UI', 'Malgun Gothic'",
            "--vscode-editor-font-family" to "'${scheme.editorFontName}', Consolas",
        )
    }

    private fun css(color: Color): String =
        if (color.alpha == 255) {
            "#%02x%02x%02x".format(color.red, color.green, color.blue)
        } else {
            "rgba(${color.red}, ${color.green}, ${color.blue}, ${"%.3f".format(java.util.Locale.ROOT, color.alpha / 255.0)})"
        }
}
