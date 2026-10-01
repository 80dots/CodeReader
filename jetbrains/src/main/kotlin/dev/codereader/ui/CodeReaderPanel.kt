package dev.codereader.ui

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import dev.codereader.CodeReaderService
import dev.codereader.model.PanelState
import dev.codereader.settings.CodeReaderConfigurable
import javax.swing.JComponent

/**
 * Hosts the panel UI (the React build shared with the VS Code extension) in an
 * embedded browser and passes messages between it and [CodeReaderService].
 */
class CodeReaderPanel(private val project: Project, parent: Disposable) : Disposable {
    private val service = project.service<CodeReaderService>()
    private val gson = Gson()
    private val browser = JBCefBrowser()
    // Must exist before the page loads so the page can call back into the IDE.
    private val toHost = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val removeListener: () -> Unit

    /** True once the page's script has started and asked for its first state. */
    @Volatile
    private var ready = false

    val component: JComponent get() = browser.component

    init {
        Disposer.register(parent, this)
        Disposer.register(this, browser)
        Disposer.register(browser, toHost)

        toHost.addHandler { message ->
            onMessage(message)
            null
        }
        removeListener = service.addListener(::post)

        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        bus.subscribe(LafManagerListener.TOPIC, LafManagerListener { applyTheme() })
        bus.subscribe(EditorColorsManager.TOPIC, EditorColorsListener { applyTheme() })

        browser.loadHTML(html())
    }

    override fun dispose() {
        removeListener()
    }

    private fun onMessage(json: String) {
        val message = runCatching { JsonParser.parseString(json).asJsonObject }.getOrNull() ?: return
        when (message.text("type")) {
            "ready" -> {
                ready = true
                post(service.state)
            }
            "explain" -> service.explain(force = true)
            "cancel" -> service.cancel()
            "reveal" -> service.reveal(message.text("uri"), message.int("line"), message.int("character"))
            "openSettings" -> ApplicationManager.getApplication().invokeLater {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, CodeReaderConfigurable::class.java)
            }
        }
    }

    private fun post(state: PanelState) {
        if (ready) {
            val message = gson.toJson(mapOf("type" to "state", "state" to state))
            execute("window.postMessage($message, '*');")
        }
    }

    private fun applyTheme() {
        val assignments = PanelTheme.variables().entries.joinToString("") { (name, value) ->
            "document.documentElement.style.setProperty(${gson.toJson(name)}, ${gson.toJson(value)});"
        }
        execute("$assignments document.body.className = ${gson.toJson(PanelTheme.bodyClass())};")
    }

    private fun execute(script: String) {
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }

    private fun html(): String {
        val variables = PanelTheme.variables().entries.joinToString("") { (name, value) -> "$name: $value;" }
        // The UI talks to its host through VS Code's webview API, so the page gets a stand-in for it.
        val bridge = """
            window.acquireVsCodeApi = function () {
              return {
                postMessage: function (message) {
                  var payload = JSON.stringify(message);
                  ${toHost.inject("payload")}
                }
              };
            };
        """.trimIndent()
        // Styles and script are inlined: the page is loaded from memory, with nothing to fetch them from.
        return listOf(
            "<!doctype html>",
            "<html lang=\"ko\">",
            "<head>",
            "<meta charset=\"UTF-8\" />",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
            "<style>:root { $variables }</style>",
            "<style>${resource("index.css")}</style>",
            "<script>$bridge</script>",
            "</head>",
            "<body class=\"${PanelTheme.bodyClass()}\">",
            "<div id=\"root\"></div>",
            "<script type=\"module\">${resource("index.js").replace("</script", "<\\/script")}</script>",
            "</body>",
            "</html>",
        ).joinToString("\n")
    }

    private fun resource(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/webview/$name")) { "missing bundled resource webview/$name" }
            .use { it.readBytes().toString(Charsets.UTF_8) }

    private fun JsonObject.text(name: String): String = get(name)?.takeIf { it.isJsonPrimitive }?.asString.orEmpty()

    private fun JsonObject.int(name: String): Int = get(name)?.takeIf { it.isJsonPrimitive }?.asInt ?: 0
}
