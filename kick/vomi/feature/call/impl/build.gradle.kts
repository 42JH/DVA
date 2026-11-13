plugins {
    alias(libs.plugins.vomi.android.feature.impl)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.feature.call.impl" }
dependencies {
    implementation(projects.feature.call.api)
    implementation(libs.androidx.hilt.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
}
