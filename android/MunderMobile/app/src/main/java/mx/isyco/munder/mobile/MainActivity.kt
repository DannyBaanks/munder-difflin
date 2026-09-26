package mx.isyco.munder.mobile

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import mx.isyco.munder.mobile.ui.CodeView
import mx.isyco.munder.mobile.ui.LockView
import mx.isyco.munder.mobile.ui.MainTabs
import mx.isyco.munder.mobile.ui.PairView
import mx.isyco.munder.mobile.ui.Portrait
import mx.isyco.munder.mobile.ui.Px

/**
 * Raíz Android, espejo de App/MunderMobileApp.swift + RootView.
 *
 * - Sin emparejar → PairView. Esperando → CodeView. Emparejado → 5 pestañas.
 * - Nada de la oficina se dibuja bajo el bloqueo (ni siquiera para el
 *   lector de pantalla ni el conmutador).
 * - `-MunderDemo -MunderTab N` abre la oficina de ejemplo sin red (capturas CI).
 */
class MainActivity : FragmentActivity() {
    private lateinit var store: OfficeStore
    private lateinit var lock: AppLock

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val secure = SecureStore(this)
        store = ViewModelProvider(this, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = OfficeStore(secure) as T
        })[OfficeStore::class.java]

        val extras = intent.extras
        // Demo por extras del lanzador (el CI los pasa con `am start --ez`): sin red, sin Keystore.
        val demo = extras?.getBoolean("MunderDemo") == true ||
            intent.getStringExtra("MunderDemo") != null
        val demoTab = extras?.getInt("MunderTab", 0) ?: 0
        val demoLocked = extras?.getBoolean("MunderDemoLocked") == true

        lock = if (demoLocked) {
            AppLock(enabled = true).also { it.lockNow() }
        } else {
            AppLock(enabled = !demo)
        }
        if (demo) lock.unlockForDemo()
        if (demoLocked) lock.lockNow()

        // La puerta de actuar es el mismo candado que la de ver.
        store.authorize = { action -> lock.authorize(this, action) }

        if (demo) {
            try {
                val overview = assets.open("Media/Demo/overview.json").bufferedReader().readText()
                val peers = assets.open("Media/Demo/demo-peers.json").bufferedReader().readText()
                val panel = try {
                    assets.open("Media/Demo/demo-panel.json").bufferedReader().readText()
                } catch (e: Exception) {
                    null
                }
                store.loadDemo(overview, peers, panel)
            } catch (e: Exception) { }
        }

        setContent {
            val dark = androidx.compose.foundation.isSystemInDarkTheme()
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                val phase by store.phase.collectAsState()
                val toast by store.toast.collectAsState()
                var lockTick by remember { mutableStateOf(0) }

                // Refresco como MainView.task: direcciones + peers una vez, overview cada 5 s.
                LaunchedEffect(phase) {
                    if (phase is OfficeStore.Phase.Paired && !demo) {
                        store.refreshAddresses()
                        store.refreshPeers()
                        while (true) {
                            store.refresh()
                            delay(5000)
                        }
                    }
                }
                // CodeView espera a que el humano acepte.
                LaunchedEffect(phase) {
                    if (phase is OfficeStore.Phase.Waiting) store.waitForAccept()
                }
                // Toast de 2.6 s igual que iOS.
                LaunchedEffect(toast) {
                    if (toast != null) {
                        delay(2600)
                        store.toastShown()
                    }
                }

                val showLock = lock.locked && phase is OfficeStore.Phase.Paired
                // El conmutador fotografía la pantalla al salir: se observa el ciclo
                // de vida de verdad para taparla (leer isResumed una vez no se actualiza).
                val lifecycleState by lifecycle.currentStateAsState()
                val inBackground = lifecycleState < androidx.lifecycle.Lifecycle.State.RESUMED
                Box(modifier = Modifier.fillMaxSize().background(Px.cream50())) {
                    if (showLock) {
                        LockView(onUnlock = {
                            lifecycleScope.launch { lock.unlock(this@MainActivity); lockTick++ }
                        }, checking = lock.checking)
                    } else {
                        when (val ph = phase) {
                            is OfficeStore.Phase.Unpaired -> PairView(store)
                            is OfficeStore.Phase.Waiting -> CodeView(store, ph.code)
                            is OfficeStore.Phase.Paired -> MainTabs(store, initialTab = if (demo) demoTab else 0)
                        }
                    }
                    if (lock.enabled && phase is OfficeStore.Phase.Paired && inBackground) {
                        // El conmutador fotografía la pantalla al salir: la tapa.
                        Box(modifier = Modifier.fillMaxSize().background(Px.cream50()), contentAlignment = Alignment.Center) {
                            Portrait("michael", scale = 3f)
                        }
                    }
                    if (toast != null) {
                        Box(modifier = Modifier.fillMaxSize().padding(bottom = 90.dp, start = 16.dp, end = 16.dp), contentAlignment = Alignment.BottomCenter) {
                            Text(toast!!, color = Color(0xFFFFFDF5), modifier = Modifier.background(Color(0xFF1A1320)).padding(horizontal = 14.dp, vertical = 10.dp))
                        }
                    }
                }
            }
        }

        // Al aparecer el emparejamiento aceptado, pide el dueño una vez.
        lifecycleScope.launch {
            store.phase.collect { ph ->
                if (ph is OfficeStore.Phase.Paired && lock.locked && !demo && !demoLocked) {
                    lock.unlock(this@MainActivity)
                }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        lock.didEnterBackground()
    }

    override fun onResume() {
        super.onResume()
        if (lock.willEnterForeground() && lock.locked) {
            lifecycleScope.launch { lock.unlock(this@MainActivity) }
        }
    }
}
