package dev.codereader.analysis

import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor

/** Lists the project files a usage search may look into. */
object ProjectSources {
    private const val MAX_FILES = 4000
    private const val MAX_FILE_BYTES = 1_000_000L

    // Build output, dependencies and caches: never where hand-written callers live.
    private val SKIPPED_DIRECTORIES = setOf(
        "node_modules", "bin", "obj", "build", "dist", "out", "target", "packages", "vendor",
        "Library", "Temp", "Logs", "venv", "__pycache__",
    )

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
