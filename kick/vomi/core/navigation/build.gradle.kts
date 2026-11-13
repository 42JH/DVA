plugins {
    alias(libs.plugins.vomi.android.library.compose)
}
android { namespace = "com.ssafy.vomi.core.navigation" }
dependencies {
    api(libs.androidx.navigation3.runtime)
    api(libs.kotlinx.serialization.json)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
}
