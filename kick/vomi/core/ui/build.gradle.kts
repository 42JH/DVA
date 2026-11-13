plugins {
    alias(libs.plugins.vomi.android.library.compose)
}
android { namespace = "com.ssafy.vomi.core.ui" }
dependencies {
    api(projects.core.designsystem)
    implementation(projects.core.model)
    implementation(libs.androidx.lifecycle.runtime.compose)
}
