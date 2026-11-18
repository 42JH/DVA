import java.util.Properties

plugins {
    alias(libs.plugins.vomi.android.application)
    alias(libs.plugins.vomi.android.application.compose)
    alias(libs.plugins.vomi.hilt)
}

val testCredentials = Properties().apply {
    val settings = rootProject.file("android-test.properties")
    if (settings.exists()) settings.inputStream().use { load(it) }
}
fun String.buildConfigValue() = "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.ssafy.vomi"
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "com.ssafy.vomi"
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        listOf("KICK_TEST_ACCOUNT_1_TOKEN", "KICK_TEST_ACCOUNT_2_TOKEN").forEach { key ->
            val value = providers.environmentVariable(key).getOrElse(testCredentials.getProperty(key, ""))
            getByName("debug") { buildConfigField("String", key, value.buildConfigValue()) }
            getByName("release") { buildConfigField("String", key, "\"\"") }
        }
    }
}

dependencies {
    implementation(projects.feature.login.api)
    implementation(projects.feature.login.impl)
    implementation(projects.feature.call.api)
    implementation(projects.feature.call.impl)
    implementation(projects.feature.home.api)
    implementation(projects.feature.home.impl)
    implementation(projects.core.data)
    implementation(projects.core.common)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.retrofit)
    implementation(projects.core.network)
    implementation(projects.core.designsystem)
    implementation(projects.core.navigation)
    implementation(projects.core.notifications)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.hilt.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
}
