package mx.isyco.munder.mobile

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * El móvil ofrece exactamente las acciones remotas del host.
 * `panelRemoteBlocked` aquí y PANEL_OFF allá son la misma lista:
 * un botón que existe en el móvil pero el host rehúsa es un botón que siempre falla.
 */
class PanelBlockedTest {

    @Test
    fun blockedMatchesHost() {
        val repo = findRepo()
        val libRemote = File(repo, "tools/munder/lib-remote.cjs").readText()
        // `const PANEL_OFF = Object.freeze(['a', 'b']);` — comillas simples o dobles.
        val m = Regex("""PANEL_OFF\s*=\s*Object\.freeze\(\[([^\]]+)\]\)""").find(libRemote)
            ?: throw AssertionError("no se encontró PANEL_OFF en lib-remote.cjs")
        val fromHost = Regex("""['"]([^'"]+)['"]""").findAll(m.groupValues[1]).map { it.groupValues[1] }.sorted().toList()

        // La lista viva está en OfficeStore.kt (companion panelRemoteBlocked).
        val storeKt = File(repo, "android/MunderMobile/app/src/main/java/mx/isyco/munder/mobile/OfficeStore.kt").readText()
        val sm = Regex("""panelRemoteBlocked[^=]*=\s*setOf\(([^)]+)\)""").find(storeKt)
            ?: throw AssertionError("no se encontró panelRemoteBlocked en OfficeStore.kt")
        val fromApp = Regex(""""([^"]+)"""").findAll(sm.groupValues[1]).map { it.groupValues[1] }.sorted().toList()

        println("lib-remote PANEL_OFF: ${fromHost.joinToString(" ")}")
        println("OfficeStore Kotlin : ${fromApp.joinToString(" ")}")
        assertEquals(fromHost, fromApp)
    }

    @Test
    fun overviewDecodes() {
        val repo = findRepo()
        val json = Json { ignoreUnknownKeys = true; isLenient = true }
        val text = File(repo, "android/MunderMobile/app/src/test/resources/overview.json").readText()
        val o = json.decodeFromString<Overview>(text)
        assertEquals("michael-victus", o.office.name)
        assertTrue(o.agents.isNotEmpty())
    }

    @Test
    fun addressNormalize_matchesIos() {
        assertEquals("192.168.1.64:47831", Address.normalize("192.168.1.64"))
        assertEquals("192.168.1.64:47831", Address.normalize("http://192.168.1.64:47831/app/"))
        assertEquals("100.101.4.7:47831", Address.normalize("100.101.4.7"))
        assertTrue(Address.looksTailscale("100.101.4.7:47831"))
        assertTrue(!Address.looksTailscale("192.168.1.64:47831"))
    }

    private fun findRepo(): File {
        var d = File(System.getProperty("user.dir"))
        repeat(8) {
            if (File(d, "tools/munder/lib-remote.cjs").exists()) return d
            d = d.parentFile ?: return d
        }
        return d
    }
}
