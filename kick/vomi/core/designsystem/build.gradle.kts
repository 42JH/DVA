plugins {
    alias(libs.plugins.vomi.android.library.compose)
}

android { namespace = "com.ssafy.vomi.core.designsystem" }

dependencies {
    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.runtime)
    api(libs.androidx.compose.ui)
    api(libs.androidx.compose.foundation)
    api(libs.androidx.compose.animation)
    implementation(libs.androidx.activity.compose)
}
