plugins {
    alias(libs.plugins.vomi.android.feature.impl)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.feature.home.impl" }
dependencies {
    implementation(projects.feature.home.api)
    implementation(projects.core.domain)
}
