package dev.codereader

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.intellij.openapi.vfs.VfsUtilCore
import dev.codereader.analysis.Analysis
import dev.codereader.model.ClassView
import dev.codereader.model.MethodView
import dev.codereader.model.ParentView
import dev.codereader.model.Step
import dev.codereader.model.Summary
import dev.codereader.model.UsageItem
import dev.codereader.model.VariableView
import java.io.File
import java.security.MessageDigest

/**
 * Explanations are kept as one JSON file per explained source file, under the
 * user's home directory, so they survive restarts and are shared by every editor
 * that has Code Reader (the VS Code extension reads and writes the same files; see
 * src/store.ts for the format).
 *
 * Because editors spell file URLs differently, the stored copy holds plain file
 * paths: every `uri` field of the panel data is written as `path`.
 */
object ExplanationStore {
    private const val SCHEMA_VERSION = 1
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    class Saved(
        /** SHA-1 of the file's text when it was explained, with line endings read as "\n". */
        val contentHash: String,
        /** ISO time the explanation was written. */
        val savedAt: String,
        val provider: String,
        val language: String,
        val usageApproximate: Boolean,
        val analysis: Analysis,
    )

    fun contentHash(text: String): String = sha1(text.replace("\r\n", "\n"))

    /** @param path absolute path of the explained file, with forward slashes. */
    fun save(path: String, saved: Saved) {
        val record = JsonObject().apply {
            addProperty("schemaVersion", SCHEMA_VERSION)
            addProperty("path", path)
            addProperty("contentHash", saved.contentHash)
            addProperty("savedAt", saved.savedAt)
            addProperty("provider", saved.provider)
            addProperty("language", saved.language)
            addProperty("usageApproximate", saved.usageApproximate)
            addProperty("truncated", saved.analysis.truncated)
            saved.analysis.summary?.let { add("summary", gson.toJsonTree(it)) }
            add("classes", urlsToPaths(gson.toJsonTree(saved.analysis.classes)))
            add("variables", gson.toJsonTree(saved.analysis.variables))
            add("methods", urlsToPaths(gson.toJsonTree(saved.analysis.methods)))
        }
        val file = recordFile(path)
        file.parentFile.mkdirs()
        file.writeText(gson.toJson(record), Charsets.UTF_8)
    }

    fun load(path: String): Saved? {
        val record = try {
            JsonParser.parseString(recordFile(path).readText(Charsets.UTF_8)).asJsonObject
        } catch (_: Exception) {
            return null // Never saved, or not readable: the same to the panel.
        }
        return try {
            if (record.get("schemaVersion")?.asInt != SCHEMA_VERSION) {
                return null
            }
            Saved(
                contentHash = record.get("contentHash").asString,
                savedAt = record.text("savedAt"),
                provider = record.text("provider"),
                language = record.text("language"),
                usageApproximate = record.get("usageApproximate")?.asBoolean ?: false,
                analysis = Analysis(
                    truncated = record.get("truncated")?.asBoolean ?: false,
                    summary = record.get("summary")?.takeIf { it.isJsonObject }?.let { summary(it.asJsonObject) },
                    classes = record.list("classes") { classView(gson.fromJson(pathsToUrls(it), ClassView::class.java)) },
                    variables = record.list("variables") { gson.fromJson(it, VariableView::class.java) },
                    methods = record.list("methods") { methodView(gson.fromJson(pathsToUrls(it), MethodView::class.java)) },
                ),
            )
        } catch (_: Exception) {
            null // Written by hand or by a version this one cannot read.
        }
    }

    // Gson fills objects without running constructors, so a list missing from the file
    // arrives as null even though its type says it cannot be. These put that right.

    private fun summary(json: JsonObject) = Summary(
        oneLine = json.text("oneLine"),
        story = json.text("story"),
        keyPoints = json.list("keyPoints") { it.asString },
    )

    @Suppress("USELESS_CAST", "UNNECESSARY_SAFE_CALL")
    private fun classView(item: ClassView) = item.copy(parents = (item.parents as List<ParentView>?).orEmpty())

    @Suppress("USELESS_CAST", "UNNECESSARY_SAFE_CALL")
    private fun methodView(method: MethodView) = method.copy(
        usages = (method.usages as List<UsageItem>?).orEmpty(),
        explanation = method.explanation?.let { it.copy(steps = (it.steps as List<Step>?).orEmpty()) },
    )

    private fun JsonObject.text(name: String): String = get(name)?.takeIf { it.isJsonPrimitive }?.asString.orEmpty()

    private fun <T> JsonObject.list(name: String, read: (JsonElement) -> T): List<T> =
        get(name)?.takeIf { it.isJsonArray }?.asJsonArray?.map(read).orEmpty()

    private fun recordFile(path: String): File {
        // Windows paths differ only in case between editors; one file must still map to one record.
        val windows = System.getProperty("os.name").startsWith("Windows", ignoreCase = true)
        val identity = path.replace('\\', '/').let { if (windows) it.lowercase() else it }
        return File(File(System.getProperty("user.home"), ".code-reader/explanations"), "${sha1(identity)}.json")
    }

    private fun sha1(text: String): String =
        MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun urlsToPaths(json: JsonElement) = renameKey(json, "uri", "path") { VfsUtilCore.urlToPath(it) }

    private fun pathsToUrls(json: JsonElement) = renameKey(json, "path", "uri") { VfsUtilCore.pathToUrl(it) }

    /** Copies a JSON value, renaming one key wherever it holds a string and converting that string. */
    private fun renameKey(json: JsonElement, from: String, to: String, convert: (String) -> String): JsonElement = when {
        json.isJsonArray -> JsonArray().apply { json.asJsonArray.forEach { add(renameKey(it, from, to, convert)) } }
        json.isJsonObject -> JsonObject().apply {
            for ((key, value) in json.asJsonObject.entrySet()) {
                if (key == from && value.isJsonPrimitive && value.asJsonPrimitive.isString) {
                    add(to, JsonPrimitive(convert(value.asString)))
                } else {
                    add(key, renameKey(value, from, to, convert))
                }
            }
        }
        else -> json
    }
}
