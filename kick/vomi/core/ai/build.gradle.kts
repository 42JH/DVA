plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.ai" }
dependencies {
    api(projects.core.model)
    implementation(libs.mlkit.genai.prompt)
    implementation(libs.kotlinx.coroutines.android)
}
