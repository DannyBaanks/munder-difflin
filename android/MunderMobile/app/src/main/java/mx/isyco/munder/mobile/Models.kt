package mx.isyco.munder.mobile

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Lo que contesta lib-remote.cjs, con .convertFromSnakeCase en Swift y
 * @SerialName snake_case aquí. Todo lo que la oficina puede omitir es
 * opcional: una oficina vieja o un hive raro jamás debe tumbar la pantalla.
 *
 * Espejo exacto de Sources/Models.swift.
 */

@Serializable
data class OfficeAddress(
    val address: String,
    val via: String? = null,
)

@Serializable
data class Hello(
    @SerialName("office_id") val officeId: String,
    val name: String,
    val device: String? = null,
    val version: String? = null,
    val addresses: List<OfficeAddress>? = null,
)

@Serializable
data class Capacity(
    @SerialName("ram_total_gb") val ramTotalGb: Double? = null,
    @SerialName("ram_free_gb") val ramFreeGb: Double? = null,
    val cpus: Int? = null,
    val load1: Double? = null,
    @SerialName("workers_total") val workersTotal: Int? = null,
    @SerialName("workers_idle") val workersIdle: Int? = null,
    @SerialName("michael_state") val michaelState: String? = null,
    @SerialName("tasks_open") val tasksOpen: Int? = null,
)

@Serializable
data class OfficeInfo(
    @SerialName("office_id") val officeId: String,
    val name: String,
    val fingerprint: String? = null,
    val host: String? = null,
    val version: String? = null,
)

@Serializable
data class Agent(
    val id: String,
    val name: String,
    val role: String? = null,
    val status: String? = null,
    val god: Boolean? = null,
    @SerialName("on_hold") val onHold: Boolean? = null,
)

@Serializable
data class Question(
    val q: String,
    @SerialName("asked_at") val askedAt: String? = null,
)

@Serializable
data class TaskItem(
    val id: String,
    val title: String? = null,
    val status: String? = null,
    val assignee: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    val description: String? = null,
    val result: String? = null,
    val question: Question? = null,
    @SerialName("from_office") val fromOffice: String? = null,
)

@Serializable
data class Overview(
    val office: OfficeInfo,
    val capacity: Capacity,
    val agents: List<Agent> = emptyList(),
    val tasks: List<TaskItem> = emptyList(),
    val questions: List<TaskItem> = emptyList(),
    val hive: Boolean? = null,
    /** Otra oficina vista a través del enlace: solo lectura, el trabajo va a su Michael. */
    val remote: Boolean? = null,
    /** Esa oficina trae un Munder más viejo: solo números, sin equipo ni tablero. */
    val limited: Boolean? = null,
)

@Serializable
data class Peer(
    @SerialName("office_id") val officeId: String,
    val name: String,
    val fingerprint: String? = null,
    val online: Boolean = false,
    @SerialName("latency_ms") val latencyMs: Int? = null,
    val capacity: Capacity? = null,
    val error: String? = null,
)

@Serializable
data class PeersReply(val peers: List<Peer> = emptyList())

@Serializable
data class AnswerReply(@SerialName("task_id") val taskId: String? = null)

@Serializable
data class MessageReply(
    @SerialName("message_id") val messageId: String? = null,
    val to: String? = null,
    val name: String? = null,
)

@Serializable
data class DelegateReply(
    val office: String = "",
    @SerialName("task_id") val taskId: String? = null,
)

// ── El estrato Panel ─────────────────────────────────────────────
// `panel.state` es lo que contesta tools/munder/lib-panel.cjs `state()`:
// el host, no la oficina. Cada hoja es opcional porque el panel lee una
// máquina real que puede estar medio dormida.

@Serializable
data class PanelApp(
    val running: Boolean? = null,
    val pid: Int? = null,
    val version: String? = null,
)

@Serializable
data class PanelPeer(
    val name: String,
    val online: Boolean? = null,
    @SerialName("latency_ms") val latencyMs: Int? = null,
    @SerialName("workers_idle") val workersIdle: Int? = null,
    @SerialName("workers_total") val workersTotal: Int? = null,
    val reason: String? = null,
)

@Serializable
data class PanelPending(
    val name: String,
    val kind: String? = null,
    val code: String,
)

@Serializable
data class PanelPhone(
    val id: String,
    val name: String,
    val since: String? = null,
    /** "office" con el código de emparejar, "machine" tras `munder link panel <celular>`. */
    val authority: String? = null,
)

@Serializable
data class PanelUrl(
    val url: String,
    val via: String? = null,
)

@Serializable
data class PanelLink(
    val on: Boolean? = null,
    val name: String? = null,
    val fingerprint: String? = null,
    val peers: List<PanelPeer>? = null,
    val pending: List<PanelPending>? = null,
    val phones: List<PanelPhone>? = null,
    val urls: List<PanelUrl>? = null,
    val error: String? = null,
)

@Serializable
data class PanelGpt(
    val available: Boolean? = null,
    val on: Boolean? = null,
    val running: Boolean? = null,
    val profile: String? = null,
    @SerialName("public_url") val publicUrl: String? = null,
    val grants: Int? = null,
    val pending: List<PanelPending>? = null,
)

@Serializable
data class PanelReviver(
    val configured: Boolean? = null,
    val running: Boolean? = null,
    val healthy: Boolean? = null,
    val watchdog: String? = null,
)

@Serializable
data class PanelState(
    val app: PanelApp? = null,
    val link: PanelLink? = null,
    val gpt: PanelGpt? = null,
    val reviver: PanelReviver? = null,
    val platform: String? = null,
    val launcher: String? = null,
) {
    fun authorityOf(phoneId: String): String? =
        link?.phones?.firstOrNull { it.id == phoneId }?.authority
}

/** `panel.action` contesta con las palabras del botón, en español, del panel
 *  de escritorio. Se muestran tal cual: el móvil no parafrasea al host. */
@Serializable
data class PanelActionReply(
    val action: String = "",
    val ok: Boolean = false,
    val text: String = "",
)

/** La oficina con la que está emparejado el móvil. No es secreto: la llave va en el Keystore. */
@Serializable
data class PairedOffice(
    @SerialName("office_id") var officeId: String,
    var name: String,
    @SerialName("box_pub") var boxPub: String,
    @SerialName("device_id") var deviceId: String,
    @SerialName("device_name") var deviceName: String,
    /** host:puerto, la que contestó última primero. */
    var addresses: MutableList<String> = mutableListOf(),
    /** De dónde salió cada dirección ("lan", "tailscale" o "manual"). */
    var via: MutableMap<String, String> = mutableMapOf(),
)

/** "192.168.1.64", "http://100.1.2.3:47831/app/", "victus.tail1234.ts.net" → host:puerto. */
object Address {
    const val DEFAULT_PORT = 47831

    fun normalize(input: String): String? {
        var s = input.trim()
        val scheme = s.indexOf("://")
        if (scheme >= 0) s = s.substring(scheme + 3)
        val slash = s.indexOf('/')
        if (slash >= 0) s = s.substring(0, slash)
        if (s.isEmpty() || s.length > 200 || s.contains(' ')) return null
        if (s.startsWith("[")) return if (s.contains("]:")) s else "$s:$DEFAULT_PORT"
        return if (s.contains(':')) s else "$s:$DEFAULT_PORT"
    }

    /** Rango CGNAT de Tailscale 100.64.0.0/10, o nombre MagicDNS. */
    fun looksTailscale(hostPort: String): Boolean {
        val host = hostPort.split(':').firstOrNull() ?: hostPort
        if (host.endsWith(".ts.net")) return true
        val parts = host.split('.').mapNotNull { it.toIntOrNull() }
        return parts.size == 4 && parts[0] == 100 && parts[1] in 64..127
    }
}
