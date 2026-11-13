package com.ssafy.vomi

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.dependencies
import org.gradle.kotlin.dsl.getByType

internal fun Project.configureAndroidCompose(extension: CommonExtension) {
    pluginManager.apply("org.jetbrains.kotlin.plugin.compose")
    extension.buildFeatures.compose = true
    val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
    dependencies {
        add("implementation", platform(libs.findLibrary("androidx-compose-bom").get()))
        add("implementation", libs.findLibrary("androidx-compose-ui").get())
        add("implementation", libs.findLibrary("androidx-compose-ui-tooling-preview").get())
        add("debugImplementation", libs.findLibrary("androidx-compose-ui-tooling").get())
    }
}
