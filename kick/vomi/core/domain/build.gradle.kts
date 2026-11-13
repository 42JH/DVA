plugins {
    alias(libs.plugins.vomi.jvm.library)
    alias(libs.plugins.vomi.hilt)
}
dependencies {
    api(projects.core.model)
    implementation(projects.core.common)
    implementation(libs.kotlinx.coroutines.core)
}
