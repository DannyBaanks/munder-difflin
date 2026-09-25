import Foundation
import CryptoKit
import Combine

/// Everything the screens show and do, in one place.
@MainActor
public final class OfficeStore: ObservableObject {
    public enum Phase: Equatable {
        case unpaired
        case waiting(code: String)
        case paired
    }

    @Published public private(set) var phase: Phase = .unpaired
    @Published public private(set) var office: PairedOffice?
    @Published public private(set) var overview: Overview?
    @Published public private(set) var peers: [Peer]?
    @Published public private(set) var online = true
    @Published public private(set) var offlineReason: String?
    @Published public var pairError: String?
    @Published public var toast: String?
    @Published public var busy = false
    /// nil = the office this phone is paired with; otherwise a paired office's id, seen through it.
    @Published public private(set) var viewing: String?
    /// The agent the composer writes to ("god" = Michael). Only for this office.
    @Published public var recipient = "god"

    private var client: RemoteClient?
    private let defaults: UserDefaults

    private enum K {
        static let office = "munder.office"
        static let pendingCode = "munder.pendingCode"
        static let sessionKey = "session-key"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        guard let data = defaults.data(forKey: K.office),
              let office = try? JSONDecoder().decode(PairedOffice.self, from: data),
              let raw = Keychain.load(account: K.sessionKey) else { return }
        adopt(office, key: SymmetricKey(data: raw))
        if let code = defaults.string(forKey: K.pendingCode) { phase = .waiting(code: code) } else { phase = .paired }
    }

    private func adopt(_ office: PairedOffice, key: SymmetricKey) {
        let c = RemoteClient(office: office, key: key)
        c.onOfficeChanged = { [weak self] next in
            Task { @MainActor in self?.persist(next) }
        }
        client = c
        self.office = office
    }

    private func persist(_ office: PairedOffice) {
        self.office = office
        if let data = try? JSONEncoder().encode(office) { defaults.set(data, forKey: K.office) }
    }

    // MARK: pairing

    public func pair(address input: String, deviceName: String) async {
        pairError = nil
        guard let address = Address.normalize(input) else {
            pairError = "Escribe la dirección de tu computadora, por ejemplo 192.168.1.64 o 100.101.4.7."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let name = deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? "iPhone" : deviceName
            let r = try await RemoteClient.pair(address: address, deviceName: name)
            try Keychain.save(r.key.withUnsafeBytes { Data($0) }, account: K.sessionKey)
            persist(r.office)
            defaults.set(r.code, forKey: K.pendingCode)
            adopt(r.office, key: r.key)
            phase = .waiting(code: r.code)
        } catch {
            pairError = error.localizedDescription
        }
    }

    /// Poll `hello` until a human accepts the code on the computer.
    public func waitForAccept() async {
        while case .waiting = phase, !Task.isCancelled {
            do {
                let hello: Hello = try await requireClient().call("hello")
                client?.learn(hello.addresses ?? [])
                defaults.removeObject(forKey: K.pendingCode)
                phase = .paired
                toast = "¡Listo! Celular emparejado"
                await refresh()
                return
            } catch let e as RemoteError where e.code == "unknown_device" {
                pairError = "La computadora ya no tiene esta solicitud (caduca a los 10 minutos, o se rechazó). Empieza de nuevo."
                return
            } catch {
                // waiting / not reachable yet: keep polling
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    /// `-MunderDemo`: show the bundled demo office (for simulator screenshots). No network, no Keychain.
    public func loadDemo(overview: Data, peers: Data) {
        client = nil
        office = PairedOffice(officeId: "fa801f7ab6693f03", name: "michael-victus", boxPub: "", deviceId: "9ed00cd88840bed1",
                              deviceName: "iPhone de Danny", addresses: ["192.168.1.64:47831", "100.101.4.7:47831"],
                              via: ["192.168.1.64:47831": "lan", "100.101.4.7:47831": "tailscale"])
        self.overview = try? RemoteClient.decoder.decode(Overview.self, from: overview)
        self.peers = (try? RemoteClient.decoder.decode(PeersReply.self, from: peers))?.peers
        online = true
        phase = .paired
    }

    public func forget() {
        viewing = nil
        recipient = "god"
        Keychain.delete(account: K.sessionKey)
        defaults.removeObject(forKey: K.office)
        defaults.removeObject(forKey: K.pendingCode)
        client = nil
        office = nil
        overview = nil
        peers = nil
        pairError = nil
        phase = .unpaired
    }

    // MARK: the office

    /// Switch the whole app to another office (nil = this one).
    public func view(office id: String?) async {
        guard id != viewing else { return }
        viewing = id
        recipient = "god"
        overview = nil
        await refresh()
    }

    public func refresh() async {
        guard phase == .paired, let c = client else { return }
        let want = viewing
        do {
            let next = try await c.call("overview", args: want.map { ["office": $0] } ?? [:], as: Overview.self)
            guard want == viewing else { return } // switched while this was in flight
            overview = next
            online = true
            offlineReason = nil
        } catch let e as RemoteError {
            online = false
            switch e.code {
            case "unknown_device": offlineReason = "La oficina ya no reconoce este celular (lo olvidaron en la computadora). Olvídala aquí y vuelve a emparejar."
            case "stale": offlineReason = "La hora del celular y la de la computadora no coinciden. Activa la hora automática en los dos."
            default: offlineReason = e.localizedDescription
            }
        } catch {
            online = false
            offlineReason = error.localizedDescription
        }
    }

    /// Ask the office where else it can be reached (its Tailscale IP, a new LAN IP).
    public func refreshAddresses() async {
        guard phase == .paired, let c = client else { return }
        if let hello: Hello = try? await c.call("hello") { c.learn(hello.addresses ?? []) }
    }

    public func refreshPeers() async {
        guard let c = client else { return } // demo mode keeps its bundled peers
        if let r: PeersReply = try? await c.call("peers") { peers = r.peers } else if peers == nil { peers = [] }
    }

    public func answer(_ task: TaskItem, text: String) async -> Bool {
        guard let q = task.question?.q else { return false }
        return await send { c in
            let _: AnswerReply = try await c.call("answer", args: ["task_id": task.id, "q": q, "text": text])
            return "Respuesta enviada a Michael"
        }
    }

    /// This office: to Michael or one agent. Another office: a task for ITS Michael.
    public func ask(_ text: String) async -> Bool {
        if let peer = viewing { return await delegate(to: peer, text: text) }
        let to = recipient
        return await send { c in
            var args: [String: Any] = ["text": text]
            if to != "god" { args["agent"] = to }
            let r: MessageReply = try await c.call("ask", args: args)
            return "Enviado a \(r.name ?? "Michael")"
        }
    }

    public func delegate(to peer: String, text: String) async -> Bool {
        await send { c in
            let r: DelegateReply = try await c.call("delegate", args: ["office": peer, "text": text])
            return "Delegada a \(r.office)"
        }
    }

    /// Add an address by hand (say, the Tailscale IP) and prove it reaches THIS office.
    public func addAddress(_ input: String) async {
        guard let c = client, let office = office, let address = Address.normalize(input) else {
            toast = "Esa dirección no se entiende"
            return
        }
        let probe = RemoteClient(office: PairedOffice(officeId: office.officeId, name: office.name, boxPub: office.boxPub,
                                                      deviceId: office.deviceId, deviceName: office.deviceName, addresses: [address]),
                                 key: sessionKey() ?? SymmetricKey(size: .bits256))
        do {
            let _: Hello = try await probe.call("hello")
            c.add(address: address, via: Address.looksTailscale(address) ? "tailscale" : "manual")
            toast = "Dirección agregada"
        } catch {
            toast = "Esa dirección no contestó como tu oficina: \(error.localizedDescription)"
        }
    }

    public func removeAddress(_ address: String) {
        guard let c = client, (office?.addresses.count ?? 0) > 1 else { return }
        c.remove(address: address)
    }

    private func sessionKey() -> SymmetricKey? {
        Keychain.load(account: K.sessionKey).map { SymmetricKey(data: $0) }
    }

    private func requireClient() throws -> RemoteClient {
        guard let c = client else { throw RemoteError.notPaired }
        return c
    }

    /// Run one action; the toast says what happened, success or the office's own words.
    private func send(_ work: (RemoteClient) async throws -> String) async -> Bool {
        guard let c = client else { return false }
        busy = true
        defer { busy = false }
        do {
            toast = try await work(c)
            await refresh()
            return true
        } catch {
            toast = error.localizedDescription
            if (error as? RemoteError)?.code == "question_changed" { await refresh() }
            return false
        }
    }
}
