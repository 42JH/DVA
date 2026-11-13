plugins {
    alias(libs.plugins.vomi.android.application)
    alias(libs.plugins.vomi.android.application.compose)
    alias(libs.plugins.vomi.hilt)
}
android {
    namespace = "com.ssafy.vomi"
    defaultConfig {
        applicationId = "com.ssafy.vomi"
        versionCode = 1
        versionName = "1.0"
    }
}
dependencies {
    implementation(projects.feature.home.api)
    implementation(projects.feature.home.impl)
    implementation(projects.core.data)
    implementation(projects.core.designsystem)
    implementation(projects.core.navigation)
    implementation(projects.core.notifications)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
}
