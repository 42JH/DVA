plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
    alias(libs.plugins.kotlinx.serialization)
}
android { namespace = "com.ssafy.vomi.core.network" }
dependencies {
    implementation(projects.core.common)
    implementation(projects.core.model)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlin.serialization)
    implementation(libs.okhttp.logging.interceptor)
}
