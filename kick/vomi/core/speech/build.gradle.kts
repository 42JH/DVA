plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.speech" }
dependencies {
    api(projects.core.model)
    implementation(libs.kotlinx.coroutines.android)
}
