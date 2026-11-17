pluginManagement {
    includeBuild("build-logic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("https://jitpack.io")
            content { includeGroup("com.github.davidliu") }
        }
    }
}

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")
rootProject.name = "vomi"

include(":app")
include(":core:common")
include(":core:model")
include(":core:domain")
include(":core:data")
include(":core:network")
include(":core:rtc")
include(":core:database")
include(":core:datastore")
include(":core:datastore-proto")
include(":core:designsystem")
include(":core:ui")
include(":core:navigation")
include(":core:notifications")
include(":feature:home:api")
include(":feature:home:impl")

include(":feature:call:api")
include(":feature:call:impl")

include(":feature:login:api")
include(":feature:login:impl")
