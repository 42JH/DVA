import com.android.build.api.dsl.LibraryExtension
import com.ssafy.vomi.configureAndroidCompose
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.getByType

class AndroidLibraryComposeConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("vomi.android.library")
        configureAndroidCompose(extensions.getByType<LibraryExtension>())
    }
}
