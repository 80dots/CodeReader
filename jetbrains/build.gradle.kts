import java.util.Properties

plugins {
    kotlin("jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.codereader"
version = providers.gradleProperty("pluginVersion").get()

// local.properties (not committed) may set idePath to an installed JetBrains IDE,
// which saves downloading one just to compile against it.
val localProperties = Properties().apply {
    val file = file("local.properties")
    if (file.exists()) {
        file.inputStream().use(::load)
    }
}
val localIdePath: String? = localProperties.getProperty("idePath") ?: System.getenv("CODE_READER_IDE_PATH")

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        if (localIdePath != null) {
            local(localIdePath)
        } else {
            rider(providers.gradleProperty("platformVersion").get())
        }
        // The embedded browser the panel is shown in.
        bundledPlugin("com.intellij.modules.jcef")
    }
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    buildSearchableOptions = false
    instrumentCode = false
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "262"
            untilBuild = provider { null }
        }
    }
}

// The panel UI is the same React build the VS Code extension ships.
val webviewAssets = layout.projectDirectory.dir("../dist/webview/assets")

tasks {
    processResources {
        from(webviewAssets) {
            include("index.js", "index.css")
            into("webview")
        }
        doFirst {
            check(webviewAssets.file("index.js").asFile.exists()) {
                "The panel UI is not built yet. Run `npm run build` in the repository root first."
            }
        }
    }
    test {
        useJUnitPlatform()
    }
}
