plugins {
    alias(libs.plugins.vomi.android.feature.impl)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.feature.home.impl" }
dependencies {
    implementation(libs.androidx.hilt.lifecycle.viewmodel.compose)
    implementation(libs.coil.compose)
    implementation(projects.feature.home.api)
    implementation(projects.core.data)
    implementation(projects.core.common)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
