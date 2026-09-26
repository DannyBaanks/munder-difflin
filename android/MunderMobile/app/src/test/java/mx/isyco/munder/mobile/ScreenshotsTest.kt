package mx.isyco.munder.mobile

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import mx.isyco.munder.mobile.ui.BoardTab
import mx.isyco.munder.mobile.ui.LinkTab
import mx.isyco.munder.mobile.ui.LockView
import mx.isyco.munder.mobile.ui.MainTabs
import mx.isyco.munder.mobile.ui.OfficeTab
import mx.isyco.munder.mobile.ui.PairView
import mx.isyco.munder.mobile.ui.PanelTab
import mx.isyco.munder.mobile.ui.QuestionsTab
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Las pantallas reales con la oficina de ejemplo incluida (sin red): lo mismo
 * que el job `screenshots` de ios.yml fotografía en el simulador, pero en JVM
 * con Roborazzi — los runners hospedados no tienen KVM ni HVF y el emulador
 * nunca termina el boot ahí.
 *
 * Una prueba por captura (Compose solo deja un setContent por prueba).
 * Solo graba (`recordRoborazziDebug`): como en iOS, las capturas son evidencia
 * del PR, no una compuerta pixel por pixel.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [30], qualifiers = "w411dp-h914dp")
class ScreenshotsTest {

    @get:Rule
    val compose = createComposeRule()

    private fun res(name: String): String =
        File("src/test/resources/$name").readText()

    /** La misma oficina de ejemplo que iOS (`-MunderDemo`), sin red ni Keystore. */
    private fun demoStore(): OfficeStore =
        OfficeStore(null).also {
            it.loadDemo(res("overview.json"), res("demo-peers.json"), res("demo-panel.json"))
        }

    private fun shoot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        RuntimeEnvironment.setQualifiers(if (dark) "+night" else "+notnight")
        compose.setContent { content() }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")
    }

    @Test fun pairLight() =
        shoot("pair-light", dark = false) { PairView(OfficeStore(null)) }

    @Test fun officeLight() =
        shoot("office-light", dark = false) { OfficeTab(demoStore()) }

    @Test fun officeDark() =
        shoot("office-dark", dark = true) { OfficeTab(demoStore()) }

    @Test fun questionsLight() =
        shoot("questions-light", dark = false) { QuestionsTab(demoStore()) }

    @Test fun questionsDark() =
        shoot("questions-dark", dark = true) { QuestionsTab(demoStore()) }

    @Test fun boardLight() =
        shoot("board-light", dark = false) { BoardTab(demoStore()) }

    @Test fun boardDark() =
        shoot("board-dark", dark = true) { BoardTab(demoStore()) }

    @Test fun linkLight() =
        shoot("link-light", dark = false) { LinkTab(demoStore()) }

    @Test fun linkDark() =
        shoot("link-dark", dark = true) { LinkTab(demoStore()) }

    @Test fun panelLight() =
        shoot("panel-light", dark = false) { PanelTab(demoStore()) }

    @Test fun panelDark() =
        shoot("panel-dark", dark = true) { PanelTab(demoStore()) }

    @Test fun lockedLight() =
        shoot("locked-light", dark = false) { LockView(onUnlock = {}, checking = false) }

    @Test fun lockedDark() =
        shoot("locked-dark", dark = true) { LockView(onUnlock = {}, checking = false) }

    // Que MainTabs con cada pestaña inicial no truene (el CI de iOS usa -MunderTab N).
    @Test fun tab0() = shoot("tab-0", dark = false) { MainTabs(demoStore(), initialTab = 0) }
    @Test fun tab1() = shoot("tab-1", dark = false) { MainTabs(demoStore(), initialTab = 1) }
    @Test fun tab2() = shoot("tab-2", dark = false) { MainTabs(demoStore(), initialTab = 2) }
    @Test fun tab3() = shoot("tab-3", dark = false) { MainTabs(demoStore(), initialTab = 3) }
    @Test fun tab4() = shoot("tab-4", dark = false) { MainTabs(demoStore(), initialTab = 4) }
}
