plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.datastore" }
dependencies {
    implementation(projects.core.common)
    implementation(projects.core.model)
    api(projects.core.datastoreProto)
    api(libs.androidx.datastore)
    implementation(libs.androidx.datastore.preferences)
}
