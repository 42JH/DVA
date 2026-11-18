plugins {
    alias(libs.plugins.vomi.android.feature.impl)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.feature.login.impl" }
dependencies {
    implementation(projects.feature.login.api)
    implementation(projects.core.data)
    implementation(projects.core.common)
    implementation(libs.retrofit)
    implementation(libs.androidx.hilt.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
