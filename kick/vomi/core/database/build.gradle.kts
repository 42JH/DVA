plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.android.room)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.database" }
dependencies {
    implementation(projects.core.model)
}
