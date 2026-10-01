package dev.codereader.analysis

import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import dev.codereader.ai.Prompts

/** Lists the project files a usage search may look into. */
object ProjectSources {
    private const val MAX_FILES = 4000
    private const val MAX_FILE_BYTES = 1_000_000L

    // Build output, dependencies and caches: never where hand-written callers live.
    private val SKIPPED_DIRECTORIES = setOf(
        "node_modules", "bin", "obj", "build", "dist", "out", "target", "packages", "vendor",
        "Library", "Temp", "Logs", "venv", "__pycache__",
    )

    /** Enough of a parent to see what it offers without sending whole files to the AI. */
    private const val MAX_PARENT_LINES = 60

    /**
     * Looks for the declaration of a class, interface or similar by name: first in the
     * file being explained, then in the project's other files of the same language.
     * A text search, like the usage search; the first declaration with that name wins.
     */
    fun findTypeDeclaration(project: Project, current: VirtualFile, currentText: String, name: String): ParentSource? {
        val simpleName = name.substringAfterLast('.').substringBefore('<').trim()
        if (simpleName.isEmpty()) {
            return null
        }
        val declaration = Regex(
            """\b(?:class|interface|struct|record|trait|protocol|object|enum)\s+(${Regex.escape(simpleName)})(?![\w$])""",
        )
        fun search(text: String): Pair<Int, Int>? {
            for ((index, line) in text.lines().withIndex()) {
                val match = declaration.find(line) ?: continue
                return index to match.groups[1]!!.range.first
            }
            return null
        }

        search(currentText)?.let { (line, character) ->
            return ParentSource(current.url, displayPath(project, current), line, character, source = null)
        }
        for (candidate in sameLanguageFiles(project, current)) {
            val text = candidate.load() ?: continue
            if (!text.contains(simpleName)) {
                continue
            }
            val (line, character) = search(text) ?: continue
            val excerpt = text.lines().drop(line).take(MAX_PARENT_LINES).joinToString("\n")
            return ParentSource(candidate.uri, candidate.displayPath, line, character, Prompts.numberLines(excerpt, line + 1))
        }
        return null
    }

    fun displayPath(project: Project, file: VirtualFile): String {
        val root = project.guessProjectDir()
        return root?.let { VfsUtilCore.getRelativePath(file, it) } ?: file.presentableUrl
    }

    /** Other files with the same extension as `current`, anywhere under the project directory. */
    fun sameLanguageFiles(project: Project, current: VirtualFile): List<SourceText> {
        val root = project.guessProjectDir() ?: return emptyList()
        val extension = current.extension ?: return emptyList()
        val files = mutableListOf<VirtualFile>()

        runReadActionBlocking {
            val index = ProjectFileIndex.getInstance(project)
            VfsUtilCore.visitChildrenRecursively(root, object : VirtualFileVisitor<Unit>() {
                override fun visitFile(file: VirtualFile): Boolean {
                    if (files.size >= MAX_FILES) {
                        return false
                    }
                    if (file.isDirectory) {
                        return !file.name.startsWith(".") && file.name !in SKIPPED_DIRECTORIES && !index.isExcluded(file)
                    }
                    if (file != current && file.extension.equals(extension, ignoreCase = true) && file.length <= MAX_FILE_BYTES) {
                        files += file
                    }
                    return true
                }
            })
        }

        return files.map { file ->
            SourceText(file.url, displayPath(project, file)) { runCatching { VfsUtilCore.loadText(file) }.getOrNull() }
        }
    }
}
