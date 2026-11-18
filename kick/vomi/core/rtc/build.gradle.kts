plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.rtc" }
dependencies {
    api(projects.core.model)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.livekit.android)
}
