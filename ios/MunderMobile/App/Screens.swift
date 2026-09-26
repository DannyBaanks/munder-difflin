import SwiftUI
import UIKit
import MunderMobileCore

// MARK: - pairing

struct PairView: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var address = ""
    @State private var name = "iPhone"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PixelLabel("Munder Mobile", size: 12, color: Px.ink900).padding(.top, 8)
                HStack(alignment: .bottom, spacing: 12) {
                    Portrait(name: "michael", scale: 3)
                    Bubble { Text("¡Hola! Empareja este celular con tu oficina y la manejas desde aquí.") }
                        .padding(.bottom, 20)
                }
                PixelCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Emparejar este celular").font(.headline)
                        Text("En la computadora corre `munder link celular`: te dice su dirección. En casa usa la de tu red; fuera de casa, la de Tailscale (con Tailscale prendido en el iPhone). Emparejas una vez y la app aprende las dos.")
                            .font(.footnote).foregroundColor(Px.ink500)
                        PixelLabel("Dirección de la computadora")
                        TextField("192.168.1.64 o 100.101.4.7", text: $address)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .pixelField()
                        PixelLabel("Nombre de este celular")
                        TextField("iPhone", text: $name).pixelField()
                        Button(store.busy ? "Conectando…" : "Emparejar") {
                            Task { await store.pair(address: address, deviceName: name) }
                        }
                        .buttonStyle(PixelButtonStyle())
                        .disabled(store.busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
                        if let e = store.pairError { Text(e).font(.footnote).foregroundColor(Px.coral) }
                    }
                }
            }
            .padding(16)
        }
    }
}

struct CodeView: View {
    @EnvironmentObject private var store: OfficeStore
    let code: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PixelLabel("Confirma el código", size: 12, color: Px.ink900).padding(.top, 8)
                HStack(alignment: .bottom, spacing: 12) {
                    Portrait(name: "dwight", scale: 3)
                    Bubble { Text("Seguridad primero. Compara este número con el de la computadora.") }
                        .padding(.bottom, 20)
                }
                PixelCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("\(String(code.prefix(3))) \(String(code.suffix(3)))")
                            .font(Px.font(28)).kerning(4)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .accessibilityLabel("Código \(code.map { String($0) }.joined(separator: " "))")
                        Text("Acéptalo en la computadora solo si allá sale este MISMO número:").font(.footnote).foregroundColor(Px.ink500)
                        Text("• Munder → Configuración → Munder Link → Solicitudes → Aceptar\n• o en una terminal: `munder link aceptar \(code)`")
                            .font(.footnote)
                        if let e = store.pairError {
                            Text(e).font(.footnote).foregroundColor(Px.coral)
                        } else {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Esperando que lo aceptes…").font(.footnote).foregroundColor(Px.ink500)
                            }
                        }
                        Button("Empezar de nuevo") { store.forget() }.buttonStyle(PixelButtonStyle(kind: .ghost))
                    }
                }
            }
            .padding(16)
        }
        .task { await store.waitForAccept() }
    }
}

// MARK: - main

struct MainView: View {
    @EnvironmentObject private var store: OfficeStore
    @Environment(\.scenePhase) private var scenePhase
    /// `-MunderTab N` on launch opens tab N (CI screenshots). 4 = Panel.
    @State private var tab = UserDefaults.standard.integer(forKey: "MunderTab")

    var body: some View {
        TabView(selection: $tab) {
            OfficeTab().tabItem { Label { Text("Oficina") } icon: { Image(uiImage: PixelIcon.image(PixelIcon.office)) } }.tag(0)
            QuestionsTab().tabItem { Label { Text("Preguntas") } icon: { Image(uiImage: PixelIcon.image(PixelIcon.ask)) } }
                .badge(store.overview?.questions.count ?? 0).tag(1)
            BoardTab().tabItem { Label { Text("Tablero") } icon: { Image(uiImage: PixelIcon.image(PixelIcon.board)) } }.tag(2)
            LinkTab().tabItem { Label { Text("Enlace") } icon: { Image(uiImage: PixelIcon.image(PixelIcon.link)) } }.tag(3)
            // The Panel stratum, tab 4: same `-MunderTab N` numbering as the rest.
            PanelTab().tabItem { Label { Text("Panel") } icon: { Image(uiImage: PixelIcon.image(PixelIcon.panel)) } }.tag(4)
        }
        .tint(Px.ink900)
        .task {
            await store.refreshAddresses()
            await store.refreshPeers()
            while !Task.isCancelled {
                await store.refresh()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { Task { await store.refresh() } }
        }
    }
}

/// Header + offline banner + scrolling body, shared by the five tabs.
struct Screen<Content: View>: View {
    @EnvironmentObject private var store: OfficeStore
    @EnvironmentObject private var lock: AppLock
    let title: String
    var subtitle: String?
    /// The title becomes a menu of offices: this one first, then every paired one.
    var switcher = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    StatusDot(color: store.online ? Px.mint : Px.coral)
                    if switcher, let peers = store.peers, !peers.isEmpty {
                        Menu {
                            Button { Task { await store.view(office: nil) } } label: {
                                MenuRow(text: "\(store.office?.name ?? "Esta oficina") · esta", on: store.viewing == nil)
                            }
                            ForEach(peers) { p in
                                Button { Task { await store.view(office: p.officeId) } } label: {
                                    MenuRow(text: p.online ? p.name : "\(p.name) · sin conexión", on: store.viewing == p.officeId)
                                }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                PixelLabel(title, size: 12, color: Px.ink900).lineLimit(1)
                                Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundColor(Px.ink900)
                            }
                            .padding(.vertical, 6).padding(.horizontal, 8)
                            .overlay(Rectangle().strokeBorder(Px.ink100, lineWidth: 1))
                        }
                        .accessibilityLabel("Cambiar de oficina")
                    } else {
                        PixelLabel(title, size: 12, color: Px.ink900)
                    }
                }
                .padding(.top, 8)
                if let subtitle { Text(subtitle).font(.system(size: 12, design: .monospaced)).foregroundColor(Px.ink500) }
                if lock.unprotected {
                    Text("Tu iPhone no tiene código: cualquiera que lo tome puede usar tu oficina. Ponle uno en Ajustes → Face ID y código.")
                        .font(.footnote).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Px.lemonLight).overlay(Rectangle().strokeBorder(Px.lemon, lineWidth: 1))
                }
                if !store.online {
                    Text(store.offlineReason ?? "Sin conexión")
                        .font(.footnote).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Px.coralLight).overlay(Rectangle().strokeBorder(Px.coral, lineWidth: 1))
                }
                content()
            }
            .padding(16)
            .padding(.bottom, 24)
        }
        .refreshable { await store.refresh() }
        .background(Px.cream50.ignoresSafeArea())
    }
}

/// A menu entry with a check on the office being shown.
struct MenuRow: View {
    let text: String
    let on: Bool
    var body: some View {
        if on { Label(text, systemImage: "checkmark") } else { Text(text) }
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View { PixelLabel(text).padding(.top, 8) }
}

// MARK: - Oficina

struct OfficeTab: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var draft = ""

    var body: some View {
        let o = store.overview
        let c = o?.capacity
        let q = o?.questions.count ?? 0
        let remote = o?.remote == true
        let agents = o?.agents ?? []
        let target = agents.first { $0.id == store.recipient && $0.god != true }
        let to = remote ? "su Michael" : (target?.name ?? "Michael")
        Screen(title: o?.office.name ?? store.office?.name ?? "Oficina",
               subtitle: o.map { "\($0.office.host ?? "") · \($0.office.fingerprint ?? "")" }, switcher: true) {
            if o == nil {
                Text(store.online ? "Cargando…" : "Sin datos todavía").foregroundColor(Px.ink500).frame(maxWidth: .infinity).padding(.vertical, 24)
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    Tile(label: "Michael", value: stateName[c?.michaelState ?? ""] ?? c?.michaelState ?? "—")
                    Tile(label: "Workers libres", value: c?.workersIdle.map(String.init) ?? "—", extra: c?.workersTotal.map { "de \($0)" })
                    Tile(label: "Preguntas", value: "\(q)", extra: q > 0 ? "para ti" : nil, alert: q > 0)
                    Tile(label: "Tareas abiertas", value: c?.tasksOpen.map(String.init) ?? "—")
                    Tile(label: "RAM libre", value: c?.ramFreeGb.map { String(format: "%g", $0) } ?? "—", extra: c?.ramTotalGb.map { "de \(String(format: "%g", $0)) GB" })
                    Tile(label: "Carga CPU", value: c?.load1.map { String(format: "%g", $0) } ?? "—", extra: c?.cpus.map { "\($0) CPUs" })
                }
                if o?.hive == false {
                    Text("No encuentro el hive de esta oficina. Abre Munder en la computadora.").font(.footnote).foregroundColor(Px.coral)
                }
                if o?.limited == true {
                    Text("Esa oficina tiene un Munder más viejo: solo manda sus números. Actualízala para ver su equipo y su tablero.")
                        .font(.footnote).foregroundColor(Px.coral)
                }
                SectionTitle(text: "Pídele algo a \(to)")
                PixelCard {
                    VStack(alignment: .leading, spacing: 10) {
                        if remote {
                            Text("En \(o?.office.name ?? "esa oficina") todo entra por su Michael: él reparte el trabajo a su equipo.")
                                .font(.footnote).foregroundColor(Px.ink500)
                        } else {
                            Picker("Para", selection: $store.recipient) {
                                Text("Michael (jefe)").tag("god")
                                ForEach(agents.filter { $0.god != true }) { Text($0.name).tag($0.id) }
                            }
                            .pickerStyle(.menu).pixelField()
                        }
                        PixelEditor(placeholder: remote ? "Qué debe hacer su Michael…" : "Escribe lo que necesitas…", text: $draft)
                        Button("Enviar a \(to)") {
                            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task { if await store.ask(text) { draft = "" } }
                        }
                        .buttonStyle(PixelButtonStyle())
                        .disabled(store.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                SectionTitle(text: "Equipo · \(agents.count)")
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    ForEach(agents.sorted { ($0.god == true ? 0 : 1) < ($1.god == true ? 0 : 1) }) { a in
                        if remote {
                            AgentCard(agent: a)
                        } else {
                            // Tap a card to write to that agent.
                            Button { store.recipient = a.god == true ? "god" : a.id } label: {
                                AgentCard(agent: a, chosen: store.recipient == (a.god == true ? "god" : a.id))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Escribirle a \(a.name)")
                        }
                    }
                }
            }
        }
    }
}

struct Tile: View {
    let label: String
    let value: String
    var extra: String?
    var alert = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            PixelLabel(label, size: 7)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value).font(.system(size: 20, weight: .semibold)).foregroundColor(alert ? Px.coral : Px.ink900)
                if let extra { Text(extra).font(.system(size: 12)).foregroundColor(Px.ink500) }
            }
            .lineLimit(1).minimumScaleFactor(0.6)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alert ? Px.coralLight : Px.paper100)
        .overlay(Rectangle().strokeBorder(alert ? Px.coral : Px.ink100, lineWidth: 1))
    }
}

struct AgentCard: View {
    let agent: Agent
    var chosen = false
    var body: some View {
        let boss = agent.god == true
        HStack(alignment: .top, spacing: 8) {
            Portrait(name: Cast.of(agent), scale: 2)
            VStack(alignment: .leading, spacing: 6) {
                PixelLabel(agent.name, size: 8, color: Px.ink900).lineLimit(1)
                Chip(text: boss ? "jefe" : agent.onHold == true ? "contigo" : stateName[agent.status ?? ""] ?? (agent.status ?? "—"),
                     fill: agent.status == "working" ? Px.lemonLight : agent.status == "blocked" ? Px.coralLight : Px.cream200,
                     dot: stateColor(agent.status))
                if let role = agent.role { Text(role).font(.system(size: 11)).foregroundColor(Px.ink500).lineLimit(2) }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(boss ? Px.lemonLight : Px.paper100)
        .overlay(Rectangle().strokeBorder(chosen ? Px.ink900 : boss ? Px.lemon : Px.ink100, lineWidth: chosen || boss ? 2 : 1))
    }
}

// MARK: - Preguntas

struct QuestionsTab: View {
    @EnvironmentObject private var store: OfficeStore
    var body: some View {
        let questions = store.overview?.questions ?? []
        Screen(title: "Preguntas", subtitle: store.viewing != nil ? store.overview.map { "de \($0.office.name)" } : nil) {
            if questions.isEmpty {
                Text("Nada pendiente. Michael no te está esperando 🎉").foregroundColor(Px.ink500).frame(maxWidth: .infinity).padding(.vertical, 24)
            }
            ForEach(questions) { QuestionCard(task: $0) }
        }
    }
}

struct QuestionCard: View {
    @EnvironmentObject private var store: OfficeStore
    let task: TaskItem
    @State private var draft = ""

    var body: some View {
        PixelCard {
            VStack(alignment: .leading, spacing: 10) {
                Text(task.title ?? task.id).font(.headline)
                HStack(spacing: 10) {
                    if let a = task.assignee { Text(a) }
                    if let from = task.fromOffice { Chip(text: "de \(from)") }
                    if let when = When.ago(task.question?.askedAt) { Text(when) }
                }
                .font(.caption).foregroundColor(Px.ink500)
                HStack(alignment: .top, spacing: 10) {
                    Portrait(name: Cast.forAssignee(task.assignee, in: store.overview?.agents), scale: 2)
                    Bubble { Text(markdown(task.question?.q ?? "")) }
                }
                if store.overview?.remote == true {
                    Text("Contéstala desde el celular emparejado con esa oficina, o pásale la respuesta a su Michael desde Oficina.")
                        .font(.footnote).foregroundColor(Px.ink500)
                } else {
                    PixelEditor(placeholder: "Tu respuesta…", text: $draft)
                    Button("Responder") {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { if await store.answer(task, text: text) { draft = "" } }
                    }
                    .buttonStyle(PixelButtonStyle())
                    .disabled(store.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

// MARK: - Tablero

struct BoardTab: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var filter = "blocked"
    private let order: [(String, String, Color)] = [("blocked", "Bloqueadas", Px.coral), ("doing", "En curso", Px.lemon),
                                                   ("todo", "Por hacer", Px.sky), ("done", "Hechas", Px.mint)]

    var body: some View {
        let tasks = store.overview?.tasks ?? []
        Screen(title: "Tablero", subtitle: store.viewing != nil ? store.overview.map { "de \($0.office.name)" } : nil) {
            HStack(spacing: 6) {
                ForEach(order, id: \.0) { item in
                    let key = item.0
                    let label = item.1
                    let n = tasks.filter { ($0.status ?? "todo") == key }.count
                    let on = filter == key
                    Button { filter = key } label: {
                        VStack(spacing: 6) {
                            Text("\(n)").font(.system(size: 18, weight: .semibold)).foregroundColor(on ? Px.cream50 : key == "blocked" ? Px.coral : Px.ink900)
                            PixelLabel(label, size: 6, color: on ? Px.cream50 : Px.ink700).lineLimit(1).minimumScaleFactor(0.5)
                        }
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .background(on ? Px.ink900 : Px.paper100)
                        .overlay(Rectangle().strokeBorder(on ? Px.ink900 : Px.ink300, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(label): \(n)")
                }
            }
            let list = tasks.filter { ($0.status ?? "todo") == filter }
            if list.isEmpty { Text("Vacío").foregroundColor(Px.ink500).frame(maxWidth: .infinity).padding(.vertical, 24) }
            ForEach(list) { TaskCard(task: $0, stripe: order.first { $0.0 == filter }?.2 ?? Px.ink300) }
        }
    }
}

struct TaskCard: View {
    @EnvironmentObject private var store: OfficeStore
    let task: TaskItem
    let stripe: Color
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 10) {
                    if task.assignee != nil {
                        Portrait(name: Cast.forAssignee(task.assignee, in: store.overview?.agents), scale: 1.5)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title ?? task.id).font(.headline).foregroundColor(Px.ink900).multilineTextAlignment(.leading)
                        HStack(spacing: 8) {
                            Text(task.assignee ?? "sin asignar")
                            if task.question != nil { Chip(text: "pregunta", fill: Px.coralLight) }
                            if let when = When.ago(task.createdAt) { Text(when) }
                        }
                        .font(.caption).foregroundColor(Px.ink500)
                    }
                    Spacer(minLength: 0)
                }
                if open {
                    if let d = task.description {
                        PixelLabel("Descripción", size: 7)
                        Text(d).font(.subheadline).foregroundColor(Px.ink900)
                    }
                    if let r = task.result {
                        PixelLabel("Resultado", size: 7)
                        Text(r).font(.subheadline).foregroundColor(Px.ink900)
                    }
                    PixelLabel("ID", size: 7)
                    Text(task.id).font(.caption.monospaced()).foregroundColor(Px.ink700)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Px.paper100)
            .overlay(alignment: .leading) { Rectangle().fill(stripe).frame(width: 4) }
            .overlay(Rectangle().strokeBorder(Px.ink300, lineWidth: 1))
            .background(Rectangle().fill(Px.shadow).offset(x: 3, y: 3))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Enlace

struct LinkTab: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var target = ""
    @State private var draft = ""
    @State private var newAddress = ""
    @State private var confirmForget = false

    var body: some View {
        let peers = store.peers
        let online = (peers ?? []).filter(\.online)
        Screen(title: "Enlace") {
            SectionTitle(text: "Oficinas enlazadas")
            PixelCard {
                VStack(alignment: .leading, spacing: 12) {
                    if peers == nil { Text("Buscando…").foregroundColor(Px.ink500) }
                    else if peers?.isEmpty == true { Text("Ninguna todavía. En la computadora: munder link conectar").foregroundColor(Px.ink500) }
                    ForEach(peers ?? []) { p in
                        HStack(spacing: 10) {
                            Portrait(name: "michael", scale: 1.5)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    StatusDot(color: p.online ? Px.mint : Px.coral)
                                    PixelLabel(p.name, size: 8, color: Px.ink900)
                                }
                                Text(p.online
                                     ? "Michael \(stateName[p.capacity?.michaelState ?? ""] ?? "—") · \(p.capacity?.workersIdle ?? 0)/\(p.capacity?.workersTotal ?? 0) libres"
                                     : "sin conexión")
                                    .font(.caption).foregroundColor(Px.ink500)
                            }
                            Spacer()
                            if let ms = p.latencyMs, p.online { Chip(text: "\(ms) ms") }
                        }
                    }
                }
            }
            if !online.isEmpty {
                SectionTitle(text: "Delegar a otra oficina")
                PixelCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Picker("Oficina", selection: $target) {
                            ForEach(online) { Text($0.name).tag($0.officeId) }
                        }
                        .pickerStyle(.menu).pixelField()
                        PixelEditor(placeholder: "Qué debe hacer su Michael…", text: $draft)
                        Button("Delegar") {
                            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            let to = target.isEmpty ? (online.first?.officeId ?? "") : target
                            Task { if await store.delegate(to: to, text: text) { draft = "" } }
                        }
                        .buttonStyle(PixelButtonStyle())
                        .disabled(store.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            SectionTitle(text: "Este celular")
            PixelCard {
                VStack(alignment: .leading, spacing: 10) {
                    if let o = store.office {
                        PixelLabel(o.deviceName, size: 8, color: Px.ink900)
                        Text("huella \(o.deviceId)").font(.caption.monospaced()).foregroundColor(Px.ink500)
                        PixelLabel("Direcciones de \(o.name)", size: 7)
                        ForEach(Array(o.addresses.enumerated()), id: \.element) { pair in
                            let i = pair.offset
                            let a = pair.element
                            HStack {
                                Text(a).font(.footnote.monospaced())
                                Chip(text: o.via[a] ?? "manual", fill: o.via[a] == "tailscale" ? Px.lemonLight : Px.cream200)
                                if i == 0 { Chip(text: "la última que contestó") }
                                Spacer()
                                if o.addresses.count > 1 {
                                    Button { Task { await store.removeAddress(a) } } label: { Image(systemName: "xmark") }.foregroundColor(Px.ink500)
                                }
                            }
                        }
                        Text("La app prueba cada dirección, empezando por la que contestó la última vez: en casa entra por tu red; fuera, por Tailscale.")
                            .font(.caption).foregroundColor(Px.ink500)
                        HStack {
                            TextField("Agregar dirección (p. ej. la de Tailscale)", text: $newAddress)
                                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().pixelField()
                            Button("Agregar") {
                                let a = newAddress
                                Task { await store.addAddress(a); newAddress = "" }
                            }
                            .buttonStyle(PixelButtonStyle(kind: .ghost)).frame(width: 110)
                            .disabled(newAddress.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                    Text("Para quitarle el acceso de verdad, olvídalo también en la computadora (Munder Link → Celulares).")
                        .font(.caption).foregroundColor(Px.ink500)
                    Button("Olvidar en este celular") { confirmForget = true }
                        .buttonStyle(PixelButtonStyle(kind: .danger))
                        .confirmationDialog("¿Olvidar la oficina en este celular?", isPresented: $confirmForget, titleVisibility: .visible) {
                            Button("Olvidar", role: .destructive) { Task { await store.forgetAuthorized() } }
                        }
                }
            }
        }
        .task { await store.refreshPeers() }
    }
}

/// The Panel stratum: the buttons the desktop panel has, on the same engines,
/// over the same seal. The pairing code does NOT open this — a human grants the
/// machine on the computer — so the tab is a locked door until then, which is
/// the honest thing to show rather than an error.
struct PanelTab: View {
    @EnvironmentObject private var store: OfficeStore
    @State private var busy: String?

    private var granted: Bool { store.panel != nil }

    var body: some View {
        Screen(title: "Panel", subtitle: store.panel?.link?.name) {
            if let denied = store.panelDenied, !granted {
                PixelCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Image(systemName: "lock.fill").foregroundColor(Px.ink900)
                            PixelLabel("Esta compu todavía no", size: 10, color: Px.ink900)
                        }
                        Text(denied)
                            .font(.footnote).foregroundColor(Px.ink500)
                        Text("En la computadora, con Michael a la vista:\n\nmunder link panel <este celular>\n\nPara quitarlo: munder link panel <este celular> --quitar")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(Px.ink900)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Px.cream100)
                            .overlay(Rectangle().strokeBorder(Px.ink100, lineWidth: 1))
                        Text("Con esto, este celular puede apagar tu Munder. Piénsalo antes de concederlo.")
                            .font(.caption).foregroundColor(Px.ink500)
                        Button("Comprobar otra vez") { Task { await store.refreshPanel() } }
                            .buttonStyle(PixelButtonStyle())
                    }
                }
            } else if let s = store.panel {
                if let app = s.app {
                    SectionTitle(text: "Munder")
                    PixelCard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 8) {
                                StatusDot(color: app.running == true ? Px.mint : Px.coral)
                                Text(app.running == true ? "Abierto\(app.version.map { " · \($0)" } ?? "")" : "Cerrado")
                                    .font(.subheadline).foregroundColor(Px.ink900)
                            }
                            if s.platform != nil { Chip(text: s.platform ?? "") }
                            HStack(spacing: 10) {
                                Button(app.running == true ? "Cerrar" : "Abrir") {
                                    press(app.running == true ? "app.close" : "app.open")
                                }
                                .buttonStyle(PixelButtonStyle())
                                Button("Reiniciar") { press("app.restart") }
                                    .buttonStyle(PixelButtonStyle(kind: .ghost))
                            }
                        }
                    }
                }

                if let link = s.link {
                    SectionTitle(text: "Enlace")
                    PixelCard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 8) {
                                StatusDot(color: link.on == true ? Px.mint : Px.coral)
                                Text(link.on == true ? "Encendido\(link.fingerprint.map { " · \($0)" } ?? "")" : "Apagado")
                                    .font(.subheadline).foregroundColor(Px.ink900)
                            }
                            HStack(spacing: 10) {
                                Button(link.on == true ? "Apagar" : "Encender") { press(link.on == true ? "link.off" : "link.on") }
                                    .buttonStyle(PixelButtonStyle())
                                ForEach(link.pending ?? []) { q in
                                    Button("Aceptar \(q.code)") { accept(q) }
                                        .buttonStyle(PixelButtonStyle(kind: .ghost))
                                }
                            }
                            if let phones = link.phones, !phones.isEmpty {
                                Divider().overlay(Px.ink100)
                                PixelLabel("Celulares", size: 8, color: Px.ink500)
                                ForEach(phones) { p in
                                    HStack(spacing: 8) {
                                        Image(systemName: p.authority == "machine" ? "checkmark.shield.fill" : "iphone")
                                            .foregroundColor(p.authority == "machine" ? Px.ink900 : Px.ink500)
                                        Text(p.name).font(.caption).foregroundColor(Px.ink900)
                                        Spacer()
                                        Chip(text: p.authority == "machine" ? "maneja la compu" : "solo la oficina")
                                    }
                                }
                            }
                        }
                    }
                }

                if let gpt = s.gpt, gpt.available == true {
                    SectionTitle(text: "GPT")
                    PixelCard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 8) {
                                StatusDot(color: gpt.running == true ? Px.mint : Px.coral)
                                Text(gpt.running == true ? "Encendido\(gpt.grants.map { " · \($0) permisos" } ?? "")" : "Apagado")
                                    .font(.subheadline).foregroundColor(Px.ink900)
                            }
                            HStack(spacing: 10) {
                                Button(gpt.on == true ? "Apagar" : "Encender") { press(gpt.on == true ? "gpt.off" : "gpt.on") }
                                    .buttonStyle(PixelButtonStyle())
                            }
                            if let pending = gpt.pending, !pending.isEmpty {
                                Divider().overlay(Px.ink100)
                                PixelLabel("Pide tu OK", size: 8, color: Px.ink500)
                                ForEach(pending) { q in
                                    HStack(spacing: 8) {
                                        Text(q.client ?? "alguien").font(.caption).foregroundColor(Px.ink500)
                                        Spacer()
                                        Button("Sí") { approve(q, yes: true) }.buttonStyle(PixelButtonStyle(kind: .ghost))
                                        Button("No") { approve(q, yes: false) }.buttonStyle(PixelButtonStyle(kind: .danger))
                                    }
                                }
                            }
                        }
                    }
                }

                if let r = s.reviver, r.configured == true {
                    SectionTitle(text: "Revividor")
                    PixelCard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 8) {
                                StatusDot(color: r.running == true ? Px.mint : Px.coral)
                                Text(r.running == true ? "Vigilando\(r.watchdog.map { " · \($0)" } ?? "")" : "Instalado, sin vigilar")
                                    .font(.subheadline).foregroundColor(Px.ink900)
                            }
                            HStack(spacing: 10) {
                                Button(r.running == true ? "Desinstalar" : "Activar") { press(r.running == true ? "reviver.disable" : "reviver.enable") }
                                    .buttonStyle(PixelButtonStyle())
                            }
                        }
                    }
                }

                Text("Dos botones no se pueden desde aquí: crear el acceso directo del Panel, y conceder más permisos — un celular no se amplía su propia autoridad.")
                    .font(.caption).foregroundColor(Px.ink500)
            } else {
                Text("Buscando el panel de la computadora…").foregroundColor(Px.ink500)
            }
        }
        .task { await store.refreshPanel() }
    }

    private func press(_ action: String) {
        guard !OfficeStore.panelRemoteBlocked.contains(action) else { return }
        busy = action
        Task { await store.panelAction(action); busy = nil; await store.refreshPanel() }
    }

    private func accept(_ q: PanelPending) {
        Task { await store.panelAction("link.accept", args: ["code": q.code]); await store.refreshPanel() }
    }

    private func approve(_ q: PanelPending, yes: Bool) {
        Task { await store.panelAction(yes ? "gpt.approve" : "gpt.deny", args: ["code": q.code]); await store.refreshPanel() }
    }
}
