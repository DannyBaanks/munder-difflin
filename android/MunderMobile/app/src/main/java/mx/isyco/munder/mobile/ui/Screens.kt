package mx.isyco.munder.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import mx.isyco.munder.mobile.Agent
import mx.isyco.munder.mobile.OfficeStore
import mx.isyco.munder.mobile.PanelPending
import mx.isyco.munder.mobile.TaskItem

// ── emparejar ──

@Composable
fun PairView(store: OfficeStore) {
    var address by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("Android") }
    val busy by store.busy.collectAsState()
    val pairError by store.pairError.collectAsState()
    Column(modifier = Modifier.fillMaxSize().background(Px.cream50()).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PixelLabel("Munder Mobile", sizeSp = 12, color = Px.ink900())
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Portrait("michael", scale = 3f)
            Bubble { Text("¡Hola! Empareja este celular con tu oficina y la manejas desde aquí.") }
        }
        PixelCard {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Emparejar este celular", fontWeight = FontWeight.Bold)
                Text("En la computadora corre `munder link celular`: te dice su dirección. En casa usa la de tu red; fuera de casa, la de Tailscale (con Tailscale prendido en el móvil). Emparejas una vez y la app aprende las dos.", fontSize = 12.sp, color = Px.ink500())
                PixelLabel("Dirección de la computadora")
                PixelTextField(address, { address = it }, "192.168.1.64 o 100.101.4.7")
                PixelLabel("Nombre de este celular")
                PixelTextField(name, { name = it }, "Android")
                PixelButton(if (busy) "Conectando…" else "Emparejar", enabled = !busy && address.isBlank().not(), onClick = { store.pair(address, name) })
                if (pairError != null) Text(pairError!!, fontSize = 12.sp, color = Px.coral())
            }
        }
    }
}

@Composable
fun CodeView(store: OfficeStore, code: String) {
    val pairError by store.pairError.collectAsState()
    Column(modifier = Modifier.fillMaxSize().background(Px.cream50()).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PixelLabel("Confirma el código", sizeSp = 12, color = Px.ink900())
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Portrait("dwight", scale = 3f)
            Bubble { Text("Seguridad primero. Compara este número con el de la computadora.") }
        }
        PixelCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("${code.take(3)} ${code.takeLast(3)}", fontFamily = PixelFont, fontSize = 28.sp)
                Text("Acéptalo en la computadora solo si allá sale este MISMO número:", fontSize = 12.sp, color = Px.ink500())
                Text("• Munder → Configuración → Munder Link → Solicitudes → Aceptar\n• o en una terminal: `munder link aceptar $code`", fontSize = 12.sp)
                if (pairError != null) Text(pairError!!, fontSize = 12.sp, color = Px.coral())
                else Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp))
                    Text("Esperando que lo aceptes…", fontSize = 12.sp, color = Px.ink500())
                }
                PixelButton("Empezar de nuevo", kind = PixelKind.GHOST, onClick = { store.forget() })
            }
        }
    }
}

// ── marco ──

@Composable
fun Screen(
    store: OfficeStore,
    title: String,
    subtitle: String? = null,
    switcher: Boolean = false,
    content: @Composable () -> Unit,
) {
    val online by store.online.collectAsState()
    val offlineReason by store.offlineReason.collectAsState()
    val peers by store.peers.collectAsState()
    val overview by store.overview.collectAsState()
    val viewing by store.viewing.collectAsState()
    val office by store.office.collectAsState()
    var menu by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxSize().background(Px.cream50()).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(if (online) Px.mint() else Px.coral())
            if (switcher && !peers.isNullOrEmpty()) {
                Box {
                    Row(modifier = Modifier.border(1.dp, Px.ink100()).padding(8.dp).clickable { menu = true }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PixelLabel(title, sizeSp = 12, color = Px.ink900())
                        Text("▾", color = Px.ink900())
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("${overview?.office?.name ?: office?.name ?: "Esta oficina"} · esta") }, onClick = { store.view(null); menu = false })
                        for (p in peers!!) {
                            DropdownMenuItem(text = { Text(if (p.online) p.name else "${p.name} · sin conexión") }, onClick = { store.view(p.officeId); menu = false })
                        }
                    }
                }
            } else {
                PixelLabel(title, sizeSp = 12, color = Px.ink900())
            }
        }
        if (subtitle != null) Text(subtitle, fontSize = 12.sp, color = Px.ink500())
        if (!online) {
            Text(offlineReason ?: "Sin conexión", fontSize = 12.sp, modifier = Modifier.fillMaxWidth().background(Px.coralLight()).border(1.dp, Px.coral()).padding(10.dp))
        }
        content()
        Spacer(modifier = Modifier.height(24.dp))
    }
}

@Composable
fun SectionTitle(text: String) {
    PixelLabel(text, sizeSp = 8)
}

// ── Oficina ──

@Composable
fun OfficeTab(store: OfficeStore) {
    val overview by store.overview.collectAsState()
    val online by store.online.collectAsState()
    val office by store.office.collectAsState()
    val viewing by store.viewing.collectAsState()
    val recipient by store.recipient.collectAsState()
    val busy by store.busy.collectAsState()
    var draft by remember { mutableStateOf("") }
    val o = overview
    val c = o?.capacity
    val q = o?.questions?.size ?: 0
    val remote = o?.remote == true
    val agents = o?.agents ?: emptyList()
    val target = agents.firstOrNull { it.id == recipient && it.god != true }
    val to = if (remote) "su Michael" else (target?.name ?: "Michael")
    Screen(store, o?.office?.name ?: office?.name ?: "Oficina", subtitle = o?.let { "${it.office.host ?: ""} · ${it.office.fingerprint ?: ""}" }, switcher = true) {
        if (o == null) {
            Text(if (online) "Cargando…" else "Sin datos todavía", color = Px.ink500())
        } else {
            // 6 baldosas, igual que el LazyVGrid de 2 columnas en iOS.
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { Tile("Michael", stateName[c?.michaelState] ?: c?.michaelState ?: "—") }
                    Box(Modifier.weight(1f)) { Tile("Workers libres", c?.workersIdle?.toString() ?: "—", c?.workersTotal?.let { "de $it" }) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { Tile("Preguntas", "$q", if (q > 0) "para ti" else null, alert = q > 0) }
                    Box(Modifier.weight(1f)) { Tile("Tareas abiertas", c?.tasksOpen?.toString() ?: "—") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { Tile("RAM libre", c?.ramFreeGb?.let { "$it" } ?: "—", c?.ramTotalGb?.let { "de $it GB" }) }
                    Box(Modifier.weight(1f)) { Tile("Carga CPU", c?.load1?.let { "$it" } ?: "—", c?.cpus?.let { "$it CPUs" }) }
                }
            }
            if (o.hive == false) Text("No encuentro el hive de esta oficina. Abre Munder en la computadora.", fontSize = 12.sp, color = Px.coral())
            if (o.limited == true) Text("Esa oficina tiene un Munder más viejo: solo manda sus números. Actualízala para ver su equipo y su tablero.", fontSize = 12.sp, color = Px.coral())
            SectionTitle("Pídele algo a $to")
            PixelCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (remote) Text("En ${o.office.name} todo entra por su Michael: él reparte el trabajo a su equipo.", fontSize = 12.sp, color = Px.ink500())
                    PixelEditor(draft, { draft = it }, if (remote) "Qué debe hacer su Michael…" else "Escribe lo que necesitas…")
                    PixelButton("Enviar a $to", enabled = !busy && draft.isNotBlank(), onClick = {
                        val t = draft.trim()
                        store.ask(t)
                        draft = ""
                    })
                }
            }
            SectionTitle("Equipo · ${agents.size}")
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val sorted = agents.sortedBy { if (it.god == true) 0 else 1 }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        sorted.filterIndexed { i, _ -> i % 2 == 0 }.forEach { a ->
                            AgentCardRow(store, a, remote, recipient)
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        sorted.filterIndexed { i, _ -> i % 2 == 1 }.forEach { a ->
                            AgentCardRow(store, a, remote, recipient)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun Tile(label: String, value: String, extra: String? = null, alert: Boolean = false) {
    Column(modifier = Modifier.fillMaxWidth().background(if (alert) Px.coralLight() else Px.paper100()).border(1.dp, if (alert) Px.coral() else Px.ink100()).padding(10.dp)) {
        PixelLabel(label, sizeSp = 7)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = if (alert) Px.coral() else Px.ink900())
            if (extra != null) Text(extra, fontSize = 12.sp, color = Px.ink500())
        }
    }
}

@Composable
fun AgentCardRow(store: OfficeStore, agent: Agent, remote: Boolean, recipient: String) {
    val names = rememberCastNames()
    val boss = agent.god == true
    val chosen = recipient == (if (boss) "god" else agent.id)
    val border = if (chosen || boss) 2.dp else 1.dp
    val borderColor = if (chosen) Px.ink900() else if (boss) Px.lemon() else Px.ink100()
    Row(
        modifier = Modifier.fillMaxWidth()
            .background(if (boss) Px.lemonLight() else Px.paper100())
            .border(border, borderColor)
            .clickable(enabled = !remote) { store.setRecipient(if (boss) "god" else agent.id) }
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Portrait(Cast.of(agent, names), scale = 2f)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PixelLabel(agent.name, sizeSp = 8, color = Px.ink900())
            Chip(if (boss) "jefe" else if (agent.onHold == true) "contigo" else stateName[agent.status] ?: (agent.status ?: "—"), dot = stateColor(agent.status))
            if (agent.role != null) Text(agent.role, fontSize = 11.sp, color = Px.ink500())
        }
    }
}

// ── Preguntas ──

@Composable
fun QuestionsTab(store: OfficeStore) {
    val overview by store.overview.collectAsState()
    val viewing by store.viewing.collectAsState()
    val questions = overview?.questions ?: emptyList()
    Screen(store, "Preguntas", subtitle = if (viewing != null) overview?.let { "de ${it.office.name}" } else null) {
        if (questions.isEmpty()) Text("Nada pendiente. Michael no te está esperando 🎉", color = Px.ink500())
        for (t in questions) QuestionCard(store, t)
    }
}

@Composable
fun QuestionCard(store: OfficeStore, task: TaskItem) {
    val busy by store.busy.collectAsState()
    val overview by store.overview.collectAsState()
    var draft by remember(task.id) { mutableStateOf("") }
    val names = rememberCastNames()
    PixelCard {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(task.title ?: task.id, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (task.assignee != null) Text(task.assignee, fontSize = 12.sp, color = Px.ink500())
                if (task.fromOffice != null) Chip("de ${task.fromOffice}")
                val whenAgo = When.ago(task.question?.askedAt)
                if (whenAgo != null) Text(whenAgo, fontSize = 12.sp, color = Px.ink500())
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Portrait(Cast.forAssignee(task.assignee, overview?.agents, names), scale = 2f)
                Bubble { Text(task.question?.q ?: "") }
            }
            if (overview?.remote == true) {
                Text("Contéstala desde el celular emparejado con esa oficina, o pásale la respuesta a su Michael desde Oficina.", fontSize = 12.sp, color = Px.ink500())
            } else {
                PixelEditor(draft, { draft = it }, "Tu respuesta…")
                PixelButton("Responder", enabled = !busy && draft.isNotBlank(), onClick = {
                    store.answer(task, draft.trim())
                    draft = ""
                })
            }
        }
    }
}

// ── Tablero ──

@Composable
fun BoardTab(store: OfficeStore) {
    val overview by store.overview.collectAsState()
    val viewing by store.viewing.collectAsState()
    var filter by remember { mutableStateOf("blocked") }
    val order = listOf(Triple("blocked", "Bloqueadas", null), Triple("doing", "En curso", null), Triple("todo", "Por hacer", null), Triple("done", "Hechas", null))
    val tasks = overview?.tasks ?: emptyList()
    Screen(store, "Tablero", subtitle = if (viewing != null) overview?.let { "de ${it.office.name}" } else null) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((key, label, _) in order) {
                val n = tasks.count { (it.status ?: "todo") == key }
                val on = filter == key
                Column(
                    modifier = Modifier.weight(1f).background(if (on) Px.ink900() else Px.paper100()).border(1.dp, if (on) Px.ink900() else Px.ink300()).clickable { filter = key }.padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("$n", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = if (on) Px.cream50() else if (key == "blocked") Px.coral() else Px.ink900())
                    PixelLabel(label, sizeSp = 6, color = if (on) Px.cream50() else Px.ink700())
                }
            }
        }
        val list = tasks.filter { (it.status ?: "todo") == filter }
        if (list.isEmpty()) Text("Vacío", color = Px.ink500())
        for (t in list) TaskCard(store, t)
    }
}

@Composable
fun TaskCard(store: OfficeStore, task: TaskItem) {
    var open by remember(task.id) { mutableStateOf(false) }
    val overview by store.overview.collectAsState()
    val names = rememberCastNames()
    val stripe = when (task.status) {
        "blocked" -> Px.coral()
        "doing" -> Px.lemon()
        "todo" -> Px.sky()
        else -> Px.mint()
    }
    Row(modifier = Modifier.fillMaxWidth().background(Px.shadow()).padding(end = 3.dp, bottom = 3.dp)) {
        Box(modifier = Modifier.width(4.dp).background(stripe))
        Column(
            modifier = Modifier.fillMaxWidth().background(Px.paper100()).border(1.dp, Px.ink300()).clickable { open = !open }.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (task.assignee != null) Portrait(Cast.forAssignee(task.assignee, overview?.agents, names), scale = 1.5f)
                Column {
                    Text(task.title ?: task.id, fontWeight = FontWeight.Bold, color = Px.ink900())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(task.assignee ?: "sin asignar", fontSize = 12.sp, color = Px.ink500())
                        if (task.question != null) Chip("pregunta", fill = Px.coralLight())
                        val whenAgo = When.ago(task.createdAt)
                        if (whenAgo != null) Text(whenAgo, fontSize = 12.sp, color = Px.ink500())
                    }
                }
            }
            if (open) {
                if (task.description != null) {
                    PixelLabel("Descripción", sizeSp = 7)
                    Text(task.description, color = Px.ink900())
                }
                if (task.result != null) {
                    PixelLabel("Resultado", sizeSp = 7)
                    Text(task.result, color = Px.ink900())
                }
                PixelLabel("ID", sizeSp = 7)
                Text(task.id, fontSize = 12.sp, color = Px.ink700())
            }
        }
    }
}

// ── Enlace ──

@Composable
fun LinkTab(store: OfficeStore) {
    val peers by store.peers.collectAsState()
    val office by store.office.collectAsState()
    val busy by store.busy.collectAsState()
    var target by remember { mutableStateOf("") }
    var draft by remember { mutableStateOf("") }
    var newAddress by remember { mutableStateOf("") }
    val online = (peers ?: emptyList()).filter { it.online }
    Screen(store, "Enlace") {
        SectionTitle("Oficinas enlazadas")
        PixelCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (peers == null) Text("Buscando…", color = Px.ink500())
                else if (peers!!.isEmpty()) Text("Ninguna todavía. En la computadora: munder link conectar", color = Px.ink500())
                for (p in peers ?: emptyList()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Portrait("michael", scale = 1.5f)
                        Column {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                StatusDot(if (p.online) Px.mint() else Px.coral())
                                PixelLabel(p.name, sizeSp = 8, color = Px.ink900())
                            }
                            Text(if (p.online) "Michael ${stateName[p.capacity?.michaelState] ?: "—"} · ${p.capacity?.workersIdle ?: 0}/${p.capacity?.workersTotal ?: 0} libres" else "sin conexión", fontSize = 12.sp, color = Px.ink500())
                        }
                        Spacer(Modifier.weight(1f))
                        if (p.latencyMs != null && p.online) Chip("${p.latencyMs} ms")
                    }
                }
            }
        }
        if (online.isNotEmpty()) {
            SectionTitle("Delegar a otra oficina")
            PixelCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PixelEditor(draft, { draft = it }, "Qué debe hacer su Michael…")
                    PixelButton("Delegar", enabled = !busy && draft.isNotBlank(), onClick = {
                        val to = if (target.isEmpty()) online.first().officeId else target
                        store.delegate(to, draft.trim())
                        draft = ""
                    })
                }
            }
        }
        SectionTitle("Este celular")
        PixelCard {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val o = office
                if (o != null) {
                    PixelLabel(o.deviceName, sizeSp = 8, color = Px.ink900())
                    Text("huella ${o.deviceId}", fontSize = 12.sp, color = Px.ink500())
                    PixelLabel("Direcciones de ${o.name}", sizeSp = 7)
                    for ((i, a) in o.addresses.withIndex()) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(a, fontSize = 12.sp)
                            Chip(o.via[a] ?: "manual")
                            if (i == 0) Chip("la última que contestó")
                            Spacer(Modifier.weight(1f))
                            if (o.addresses.size > 1) Text("✕", modifier = Modifier.clickable { store.removeAddress(a) }, color = Px.ink500())
                        }
                    }
                    Text("La app prueba cada dirección, empezando por la que contestó la última vez: en casa entra por tu red; fuera, por Tailscale.", fontSize = 12.sp, color = Px.ink500())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.weight(1f)) { PixelTextField(newAddress, { newAddress = it }, "Agregar dirección (p. ej. la de Tailscale)") }
                        Box(Modifier.size(width = 110.dp, height = 48.dp)) {
                            PixelButton("Agregar", kind = PixelKind.GHOST, enabled = newAddress.isNotBlank(), onClick = {
                                store.addAddress(newAddress)
                                newAddress = ""
                            })
                        }
                    }
                }
                Text("Para quitarle el acceso de verdad, olvídalo también en la computadora (Munder Link → Celulares).", fontSize = 12.sp, color = Px.ink500())
                PixelButton("Olvidar en este celular", kind = PixelKind.DANGER, onClick = { store.forgetAuthorized() })
            }
        }
    }
}

// ── Panel ──
// El estrato Panel: los botones del panel de escritorio, sobre los mismos
// motores y el mismo sello. El código de emparejar NO abre esto — un humano
// concede la máquina en la computadora — así que la pestaña es una puerta
// cerrada hasta entonces, que es lo honesto en vez de un error.

@Composable
fun PanelTab(store: OfficeStore) {
    val panel by store.panel.collectAsState()
    val denied by store.panelDenied.collectAsState()
    val granted = panel != null
    Screen(store, "Panel", subtitle = panel?.link?.name) {
        if (denied != null && !granted) {
            PixelCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PixelLabel("Esta compu todavía no", sizeSp = 10, color = Px.ink900())
                    Text(denied!!, fontSize = 12.sp, color = Px.ink500())
                    Text("En la computadora, con Michael a la vista:\n\nmunder link panel <este celular>\n\nPara quitarlo: munder link panel <este celular> --quitar", fontSize = 11.sp, color = Px.ink900(), modifier = Modifier.fillMaxWidth().background(Px.cream100()).border(1.dp, Px.ink100()).padding(8.dp))
                    Text("Con esto, este celular puede apagar tu Munder. Piénsalo antes de concederlo.", fontSize = 12.sp, color = Px.ink500())
                    PixelButton("Comprobar otra vez", onClick = { store.refreshPanel() })
                }
            }
        } else if (panel != null) {
            val s = panel!!
            if (s.app != null) {
                SectionTitle("Munder")
                PixelCard {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusDot(if (s.app.running == true) Px.mint() else Px.coral())
                            Text(if (s.app.running == true) "Abierto${s.app.version?.let { " · $it" } ?: ""}" else "Cerrado", color = Px.ink900())
                        }
                        if (s.platform != null) Chip(s.platform)
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.weight(1f)) { PixelButton(if (s.app.running == true) "Cerrar" else "Abrir", onClick = { store.panelAction(if (s.app.running == true) "app.close" else "app.open") }) }
                            Box(Modifier.weight(1f)) { PixelButton("Reiniciar", kind = PixelKind.GHOST, onClick = { store.panelAction("app.restart") }) }
                        }
                    }
                }
            }
            if (s.link != null) {
                SectionTitle("Enlace")
                PixelCard {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusDot(if (s.link.on == true) Px.mint() else Px.coral())
                            Text(if (s.link.on == true) "Encendido${s.link.fingerprint?.let { " · $it" } ?: ""}" else "Apagado", color = Px.ink900())
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PixelButton(if (s.link.on == true) "Apagar" else "Encender", onClick = { store.panelAction(if (s.link.on == true) "link.off" else "link.on") })
                        }
                        for (q in s.link.pending ?: emptyList()) {
                            PixelButton("Aceptar ${q.code}", kind = PixelKind.GHOST, onClick = { store.panelAction("link.accept", mapOf("code" to q.code)) })
                        }
                        val phones = s.link.phones ?: emptyList()
                        if (phones.isNotEmpty()) {
                            PixelLabel("Celulares", sizeSp = 8, color = Px.ink500())
                            for (p in phones) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(if (p.authority == "machine") "🛡" else "📱")
                                    Text(p.name, fontSize = 12.sp, color = Px.ink900())
                                    Spacer(Modifier.weight(1f))
                                    Chip(if (p.authority == "machine") "maneja la compu" else "solo la oficina")
                                }
                            }
                        }
                    }
                }
            }
            if (s.gpt?.available == true) {
                SectionTitle("GPT")
                PixelCard {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusDot(if (s.gpt.running == true) Px.mint() else Px.coral())
                            Text(if (s.gpt.running == true) "Encendido${s.gpt.grants?.let { " · $it permisos" } ?: ""}" else "Apagado", color = Px.ink900())
                        }
                        PixelButton(if (s.gpt.on == true) "Apagar" else "Encender", onClick = { store.panelAction(if (s.gpt.on == true) "gpt.off" else "gpt.on") })
                        for (q in s.gpt.pending ?: emptyList()) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(q.name, fontSize = 12.sp, color = Px.ink500())
                                Spacer(Modifier.weight(1f))
                                PixelButton("Sí", kind = PixelKind.GHOST, onClick = { store.panelAction("gpt.approve", mapOf("code" to q.code)) })
                                PixelButton("No", kind = PixelKind.DANGER, onClick = { store.panelAction("gpt.deny", mapOf("code" to q.code)) })
                            }
                        }
                    }
                }
            }
            if (s.reviver?.configured == true) {
                SectionTitle("Revividor")
                PixelCard {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusDot(if (s.reviver.running == true) Px.mint() else Px.coral())
                            Text(if (s.reviver.running == true) "Vigilando${s.reviver.watchdog?.let { " · $it" } ?: ""}" else "Instalado, sin vigilar", color = Px.ink900())
                        }
                        PixelButton(if (s.reviver.running == true) "Desinstalar" else "Activar", onClick = { store.panelAction(if (s.reviver.running == true) "reviver.disable" else "reviver.enable") })
                    }
                }
            }
            Text("Dos botones no se pueden desde aquí: crear el acceso directo del Panel, y conceder más permisos — un celular no se amplía su propia autoridad.", fontSize = 12.sp, color = Px.ink500())
        } else {
            Text("Buscando el panel de la computadora…", color = Px.ink500())
        }
    }
}

@Composable
fun MainTabs(store: OfficeStore, initialTab: Int = 0) {
    var tab by remember { mutableStateOf(initialTab.coerceIn(0, 4)) }
    val questions by store.overview.collectAsState()
    val qCount = questions?.questions?.size ?: 0
    Column(modifier = Modifier.fillMaxSize().background(Px.cream50())) {
        Box(Modifier.weight(1f)) {
            when (tab) {
                0 -> OfficeTab(store)
                1 -> QuestionsTab(store)
                2 -> BoardTab(store)
                3 -> LinkTab(store)
                else -> PanelTab(store)
            }
        }
        Row(modifier = Modifier.fillMaxWidth().background(Px.paper100()).border(1.dp, Px.ink100())) {
            TabBtn("Oficina", 0, tab, { tab = 0 }, null, Modifier.weight(1f))
            TabBtn("Preguntas", 1, tab, { tab = 1 }, if (qCount > 0) "$qCount" else null, Modifier.weight(1f))
            TabBtn("Tablero", 2, tab, { tab = 2 }, null, Modifier.weight(1f))
            TabBtn("Enlace", 3, tab, { tab = 3 }, null, Modifier.weight(1f))
            TabBtn("Panel", 4, tab, { tab = 4 }, null, Modifier.weight(1f))
        }
    }
}

@Composable
fun TabBtn(label: String, idx: Int, current: Int, onClick: () -> Unit, badge: String?, modifier: Modifier = Modifier) {
    val on = idx == current
    Column(
        modifier = modifier.background(if (on) Px.ink900() else Px.paper100()).clickable { onClick() }.padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when (idx) {
            0 -> PixelIcon.Draw(PixelIcon.office, tint = if (on) Px.cream50() else Px.ink900())
            1 -> PixelIcon.Draw(PixelIcon.ask, tint = if (on) Px.cream50() else Px.ink900())
            2 -> PixelIcon.Draw(PixelIcon.board, tint = if (on) Px.cream50() else Px.ink900())
            3 -> PixelIcon.Draw(PixelIcon.link, tint = if (on) Px.cream50() else Px.ink900())
            else -> PixelIcon.Draw(PixelIcon.panel, tint = if (on) Px.cream50() else Px.ink900())
        }
        PixelLabel(label, sizeSp = 6, color = if (on) Px.cream50() else Px.ink700())
        if (badge != null) Text(badge, fontSize = 10.sp, color = Px.coral())
    }
}

// ── bloqueo ──

@Composable
fun LockView(onUnlock: () -> Unit, checking: Boolean) {
    Column(modifier = Modifier.fillMaxSize().background(Px.cream50()).padding(16.dp), verticalArrangement = Arrangement.Center) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Portrait("dwight", scale = 3f)
            Bubble { Text("Esta oficina es privada. Confirma que eres tú.") }
        }
        Spacer(Modifier.height(16.dp))
        PixelCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                PixelLabel("Munder bloqueado", sizeSp = 10, color = Px.ink900())
                Text("Usa tu huella o el PIN de tu Android. Munder no ve ni guarda ninguno de los dos: Android solo le dice sí o no.", fontSize = 12.sp, color = Px.ink500())
                PixelButton(if (checking) "Comprobando…" else "Desbloquear", enabled = !checking, onClick = onUnlock)
            }
        }
    }
}
