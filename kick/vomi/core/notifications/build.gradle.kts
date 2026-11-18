plugins {
    alias(libs.plugins.vomi.android.library)
}
android { namespace = "com.ssafy.vomi.core.notifications" }
dependencies {
    implementation(projects.core.common)
    implementation(projects.core.model)
}
