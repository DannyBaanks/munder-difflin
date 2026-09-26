package mx.isyco.munder.mobile

import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

/**
 * Todo lo que muestran y hacen las pantallas, en un solo lugar.
 * Espejo de Sources/OfficeStore.swift: misma Phase, mismos ops, mismos
 * toasts en español, mismo panelRemoteBlocked.
 *
 * `secure` nulo = sin persistencia (tests y capturas): la llave y la oficina
 * viven solo en memoria. La app real siempre lo pasa.
 */
class OfficeStore(
    private val secure: SecureStore?,
) : ViewModel() {

    sealed interface Phase {
        data object Unpaired : Phase
        data class Waiting(val code: String) : Phase
        data object Paired : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Unpaired)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private val _office = MutableStateFlow<PairedOffice?>(null)
    val office: StateFlow<PairedOffice?> = _office.asStateFlow()

    private val _overview = MutableStateFlow<Overview?>(null)
    val overview: StateFlow<Overview?> = _overview.asStateFlow()

    private val _peers = MutableStateFlow<List<Peer>?>(null)
    val peers: StateFlow<List<Peer>?> = _peers.asStateFlow()

    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val _offlineReason = MutableStateFlow<String?>(null)
    val offlineReason: StateFlow<String?> = _offlineReason.asStateFlow()

    private val _pairError = MutableStateFlow<String?>(null)
    val pairError: StateFlow<String?> = _pairError.asStateFlow()

    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    /** nil = la oficina emparejada; si no, el id de otra oficina vista a través de ella. */
    private val _viewing = MutableStateFlow<String?>(null)
    val viewing: StateFlow<String?> = _viewing.asStateFlow()

    private val _panel = MutableStateFlow<PanelState?>(null)
    val panel: StateFlow<PanelState?> = _panel.asStateFlow()

    private val _panelDenied = MutableStateFlow<String?>(null)
    val panelDenied: StateFlow<String?> = _panelDenied.asStateFlow()

    /** A quién le escribe el redactor ("god" = Michael). Solo de esta oficina. */
    private val _recipient = MutableStateFlow("god")
    val recipient: StateFlow<String> = _recipient.asStateFlow()
    fun setRecipient(id: String) { _recipient.value = id }

    var authorize: suspend (SensitiveAction) -> Boolean = { true }

    private var client: RemoteClient? = null
    private var pollJob: Job? = null

    init {
        // Restaura el emparejamiento, igual que init(defaults:) en Swift.
        try {
            val officeJson = secure?.loadOffice()
            val raw = secure?.loadSessionKey()
            if (officeJson != null && raw != null) {
                val office = MunderJson.decodeFromString<PairedOffice>(officeJson)
                adopt(office, raw)
                val pending = secure?.loadPendingCode()
                _phase.value = if (pending != null) Phase.Waiting(pending) else Phase.Paired
            }
        } catch (e: Exception) {
            // Prefs rotas: arranca sin emparejar, como teléfono nuevo.
        }
    }

    private fun adopt(office: PairedOffice, key: ByteArray) {
        val c = RemoteClient(office, key)
        c.onOfficeChanged = { next ->
            try {
                secure?.saveOffice(MunderJson.encodeToString(next))
            } catch (e: Exception) { }
            _office.value = next.copy()
        }
        client = c
        _office.value = office
    }

    private fun persist(office: PairedOffice) {
        _office.value = office
        try {
            secure?.saveOffice(MunderJson.encodeToString(office))
        } catch (e: Exception) { }
    }

    // ── emparejar ──

    fun pair(addressInput: String, deviceName: String) {
        viewModelScope.launch {
            _pairError.value = null
            val address = Address.normalize(addressInput)
            if (address == null) {
                _pairError.value = "Escribe la dirección de tu computadora, por ejemplo 192.168.1.64 o 100.101.4.7."
                return@launch
            }
            _busy.value = true
            try {
                val name = deviceName.trim().ifEmpty { "Android" }
                val r = pairOffice(address, name)
                secure?.saveSessionKey(r.key)
                persist(r.office)
                secure?.savePendingCode(r.code)
                adopt(r.office, r.key)
                _phase.value = Phase.Waiting(r.code)
            } catch (e: RemoteError) {
                _pairError.value = e.message
            } catch (e: Exception) {
                _pairError.value = e.message ?: "No se pudo emparejar"
            } finally {
                _busy.value = false
            }
        }
    }

    /** Pregunta `hello` hasta que un humano acepta el código en la compu. */
    fun waitForAccept() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                val ph = _phase.value
                if (ph !is Phase.Waiting) break
                try {
                    val hello: Hello = client()?.call("hello") ?: break
                    client()?.learn(hello.addresses ?: emptyList())
                    secure?.clearPendingCode()
                    _phase.value = Phase.Paired
                    _toast.value = "¡Listo! Celular emparejado"
                    refresh()
                    break
                } catch (e: RemoteError) {
                    if (e.code == "unknown_device") {
                        _pairError.value = "La computadora ya no tiene esta solicitud (caduca a los 10 minutos, o se rechazó). Empieza de nuevo."
                        break
                    }
                    // waiting / sin alcance todavía: sigue preguntando
                } catch (e: Exception) { }
                delay(2000)
            }
        }
    }

    /** Demo sin red para capturas: misma oficina de ejemplo que iOS. */
    fun loadDemo(overviewJson: String, peersJson: String, panelJson: String? = null) {
        client = null
        _office.value = PairedOffice(
            officeId = "fa801f7ab6693f03",
            name = "michael-victus",
            boxPub = "",
            deviceId = "9ed00cd88840bed1",
            deviceName = "Android de Danny",
            addresses = mutableListOf("192.168.1.64:47831", "100.101.4.7:47831"),
            via = mutableMapOf("192.168.1.64:47831" to "lan", "100.101.4.7:47831" to "tailscale"),
        )
        try {
            _overview.value = MunderJson.decodeFromString<Overview>(overviewJson)
        } catch (e: Exception) { }
        try {
            _peers.value = MunderJson.decodeFromString<PeersReply>(peersJson).peers
        } catch (e: Exception) { }
        if (panelJson != null) {
            try {
                _panel.value = MunderJson.decodeFromString<PanelState>(panelJson)
            } catch (e: Exception) { }
        }
        _online.value = true
        _phase.value = Phase.Paired
    }

    fun forget() {
        _viewing.value = null
        _recipient.value = "god"
        secure?.deleteSessionKey()
        secure?.clearOffice()
        client = null
        _office.value = null
        _overview.value = null
        _peers.value = null
        _pairError.value = null
        _panel.value = null
        _panelDenied.value = null
        _phase.value = Phase.Unpaired
    }

    // ── la oficina ──

    fun view(officeId: String?) {
        if (officeId == _viewing.value) return
        viewModelScope.launch {
            _viewing.value = officeId
            _recipient.value = "god"
            _overview.value = null
            refresh()
        }
    }

    fun refresh() {
        viewModelScope.launch {
            val c = client ?: return@launch
            if (_phase.value !is Phase.Paired) return@launch
            val want = _viewing.value
            try {
                val args = if (want != null) mapOf("office" to want) else emptyMap()
                val next: Overview = c.call("overview", args)
                if (want != _viewing.value) return@launch // cambió mientras volaba
                _overview.value = next
                _online.value = true
                _offlineReason.value = null
            } catch (e: RemoteError) {
                _online.value = false
                _offlineReason.value = when (e.code) {
                    "unknown_device" -> "La oficina ya no reconoce este celular (lo olvidaron en la computadora). Olvídala aquí y vuelve a emparejar."
                    "stale" -> "La hora del celular y la de la computadora no coinciden. Activa la hora automática en los dos."
                    else -> e.message
                }
            } catch (e: Exception) {
                _online.value = false
                _offlineReason.value = e.message
            }
        }
    }

    fun refreshAddresses() {
        viewModelScope.launch {
            val c = client ?: return@launch
            if (_phase.value !is Phase.Paired) return@launch
            try {
                val hello: Hello = c.call("hello")
                c.learn(hello.addresses ?: emptyList())
            } catch (e: Exception) { }
        }
    }

    fun refreshPeers() {
        viewModelScope.launch {
            val c = client ?: return@launch // en demo se quedan los incluidos
            try {
                val r: PeersReply = c.call("peers")
                _peers.value = r.peers
            } catch (e: Exception) {
                if (_peers.value == null) _peers.value = emptyList()
            }
        }
    }

    // ── el estrato Panel ──

    fun refreshPanel() {
        viewModelScope.launch {
            val c = client ?: return@launch
            if (_phase.value !is Phase.Paired) return@launch
            try {
                _panel.value = c.call("panel.state")
                _panelDenied.value = null
            } catch (e: RemoteError) {
                if (e.code == "no_authority") {
                    _panel.value = null
                    _panelDenied.value = e.message
                }
                // La oficina alcanza pero el panel no: se queda el último estado.
            } catch (e: Exception) { }
        }
    }

    fun panelAction(action: String, args: Map<String, String> = emptyMap(), activity: FragmentActivity? = null) {
        if (panelRemoteBlocked.contains(action)) return
        viewModelScope.launch {
            _busy.value = true
            try {
                if (!authorize(SensitiveAction.PANEL)) return@launch
                val c = client ?: return@launch
                val r: PanelActionReply = c.call("panel.action", mapOf("action" to action, "args" to args))
                _toast.value = if (r.text.isEmpty()) (if (r.ok) "Listo" else "No se pudo") else r.text
                refreshPanel()
            } catch (e: Exception) {
                _toast.value = e.message
            } finally {
                _busy.value = false
            }
        }
    }

    /**
     * Dos botones son solo de escritorio por diseño (ver PANEL_OFF en lib-remote.cjs):
     * el móvil no instala un acceso directo del escritorio ni amplía su propia autoridad.
     */
    companion object {
        val panelRemoteBlocked: Set<String> = setOf("shortcut.install", "link.phoneAuthority")
    }

    fun answer(task: TaskItem, text: String) {
        viewModelScope.launch {
            val q = task.question?.q ?: return@launch
            if (!authorize(SensitiveAction.ANSWER)) return@launch
            _busy.value = true
            try {
                val c = client ?: return@launch
                c.callRaw("answer", mapOf("task_id" to task.id, "q" to q, "text" to text))
                _toast.value = "Respuesta enviada a Michael"
                refresh()
            } catch (e: Exception) {
                _toast.value = e.message
                if ((e as? RemoteError)?.code == "question_changed") refresh()
            } finally {
                _busy.value = false
            }
        }
    }

    /** Esta oficina: a Michael o a un agente. Otra oficina: tarea para SU Michael. */
    fun ask(text: String) {
        val peer = _viewing.value
        if (peer != null) {
            delegate(peer, text)
            return
        }
        viewModelScope.launch {
            if (!authorize(SensitiveAction.ASK)) return@launch
            val to = _recipient.value
            _busy.value = true
            try {
                val c = client ?: return@launch
                val args = mutableMapOf<String, Any?>("text" to text)
                if (to != "god") args["agent"] = to
                val r: MessageReply = c.call("ask", args)
                _toast.value = "Enviado a ${r.name ?: "Michael"}"
                _busy.value = false
                refresh()
            } catch (e: Exception) {
                _toast.value = e.message
                _busy.value = false
            }
        }
    }

    fun delegate(peer: String, text: String) {
        viewModelScope.launch {
            if (!authorize(SensitiveAction.DELEGATE)) return@launch
            _busy.value = true
            try {
                val c = client ?: return@launch
                val r: DelegateReply = c.call("delegate", mapOf("office" to peer, "text" to text))
                _toast.value = "Delegada a ${r.office}"
                refresh()
            } catch (e: Exception) {
                _toast.value = e.message
            } finally {
                _busy.value = false
            }
        }
    }

    /** Agrega una dirección a mano (p. ej. la de Tailscale) y prueba que sí llega a ESTA oficina. */
    fun addAddress(input: String) {
        viewModelScope.launch {
            val c = client ?: return@launch
            val office = _office.value ?: return@launch
            val address = Address.normalize(input)
            if (address == null) {
                _toast.value = "Esa dirección no se entiende"
                return@launch
            }
            if (!authorize(SensitiveAction.ADD_ADDRESS)) return@launch
            val key = secure?.loadSessionKey() ?: return@launch
            val probe = RemoteClient(
                PairedOffice(office.officeId, office.name, office.boxPub, office.deviceId, office.deviceName, mutableListOf(address)),
                key,
            )
            try {
                probe.call<Hello>("hello")
                c.add(address, if (Address.looksTailscale(address)) "tailscale" else "manual")
                _toast.value = "Dirección agregada"
            } catch (e: Exception) {
                _toast.value = "Esa dirección no contestó como tu oficina: ${e.message}"
            }
        }
    }

    fun removeAddress(address: String) {
        viewModelScope.launch {
            if ((_office.value?.addresses?.size ?: 0) <= 1) return@launch
            if (!authorize(SensitiveAction.REMOVE_ADDRESS)) return@launch
            client?.remove(address)
        }
    }

    /** Olvida una oficina emparejada, tras comprobar que eres el dueño. */
    fun forgetAuthorized() {
        viewModelScope.launch {
            if (!authorize(SensitiveAction.FORGET)) return@launch
            forget()
        }
    }

    fun toastShown() {
        _toast.value = null
    }

    private fun client(): RemoteClient? = client

    private suspend fun authorize(action: SensitiveAction): Boolean = authorize(action)
}
