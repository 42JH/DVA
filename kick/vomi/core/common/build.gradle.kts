plugins {
    alias(libs.plugins.vomi.jvm.library)
    alias(libs.plugins.vomi.hilt)
}
dependencies {
    implementation(libs.kotlinx.coroutines.core)
}
