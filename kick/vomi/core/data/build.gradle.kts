plugins {
    alias(libs.plugins.vomi.android.library)
    alias(libs.plugins.vomi.hilt)
}
android { namespace = "com.ssafy.vomi.core.data" }
dependencies {
    implementation(libs.retrofit)
    testImplementation(libs.okhttp.logging.interceptor)
    testImplementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    api(projects.core.model)
    implementation(projects.core.common)
    implementation(projects.core.network)
    implementation(projects.core.database)
    implementation(projects.core.datastore)
    implementation(libs.kotlinx.coroutines.android)
}

android.testOptions.unitTests.all { test ->
    val runLive = providers.environmentVariable("VOMI_RUN_AUTH_LIVE_TESTS").getOrElse("0")
    test.inputs.property("runAuthLiveTests", runLive)
    val runCallLive = providers.environmentVariable("VOMI_RUN_CALL_LIVE_TESTS").getOrElse("0")
    val simulationUrl = providers.environmentVariable("KICK_SIMULATION_URL").getOrElse("")
    test.inputs.property("runCallLiveTests", runCallLive)
    test.inputs.property("kickSimulationUrl", simulationUrl)
    if (runLive == "1" || runCallLive == "1" || simulationUrl.isNotBlank()) {
        test.outputs.upToDateWhen { false }
        test.outputs.doNotCacheIf("Opt-in API integration checks") { true }
    }
}
