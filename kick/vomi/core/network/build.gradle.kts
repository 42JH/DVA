plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
    alias(libs.plugins.kotlinx.serialization)
}
android {
    namespace = "com.ssafy.vomi.core.network"
    buildFeatures { buildConfig = true }
}
dependencies {
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    implementation(projects.core.common)
    implementation(projects.core.model)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlin.serialization)
    implementation(libs.okhttp.logging.interceptor)
}

android.testOptions.unitTests.all { test ->
    val simulationUrl = providers.environmentVariable("KICK_SIMULATION_URL").getOrElse("")
    test.inputs.property("kickSimulationUrl", simulationUrl)
    if (simulationUrl.isNotBlank()) {
        test.outputs.upToDateWhen { false }
        test.outputs.doNotCacheIf("Local HTTP contract simulation") { true }
    }
}
