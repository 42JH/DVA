plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.data" }
dependencies {
    implementation(projects.core.domain)
    implementation(projects.core.model)
    implementation(projects.core.common)
    implementation(projects.core.network)
    implementation(projects.core.database)
    implementation(projects.core.datastore)
    implementation(libs.kotlinx.coroutines.android)
}
