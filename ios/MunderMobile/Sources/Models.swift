import Foundation

// What lib-remote.cjs answers, decoded with .convertFromSnakeCase. Everything the
// office may leave out is optional: an older office or an odd hive must never
// make the whole screen fail to decode.

public struct OfficeAddress: Codable, Hashable {
    public let address: String
    public let via: String?
}

public struct Hello: Decodable {
    public let officeId: String
    public let name: String
    public let device: String?
    public let version: String?
    public let addresses: [OfficeAddress]?
}

public struct Capacity: Decodable, Hashable {
    public let ramTotalGb: Double?
    public let ramFreeGb: Double?
    public let cpus: Int?
    public let load1: Double?
    public let workersTotal: Int?
    public let workersIdle: Int?
    public let michaelState: String?
    public let tasksOpen: Int?
}

public struct OfficeInfo: Decodable, Hashable {
    public let officeId: String
    public let name: String
    public let fingerprint: String?
    public let host: String?
    public let version: String?
}

public struct Agent: Decodable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let role: String?
    public let status: String?
    public let god: Bool?
    public let onHold: Bool?
}

public struct Question: Decodable, Hashable {
    public let q: String
    public let askedAt: String?
}

public struct TaskItem: Decodable, Hashable, Identifiable {
    public let id: String
    public let title: String?
    public let status: String?
    public let assignee: String?
    public let createdAt: String?
    public let description: String?
    public let result: String?
    public let question: Question?
    public let fromOffice: String?
}

public struct Overview: Decodable {
    public let office: OfficeInfo
    public let capacity: Capacity
    public let agents: [Agent]
    public let tasks: [TaskItem]
    public let questions: [TaskItem]
    public let hive: Bool?
    /// Another office, seen through this one's link: read-only, work goes to its Michael.
    public let remote: Bool?
    /// That office runs an older Munder: numbers only, no team or board.
    public let limited: Bool?
}

public struct Peer: Decodable, Hashable, Identifiable {
    public var id: String { officeId }
    public let officeId: String
    public let name: String
    public let fingerprint: String?
    public let online: Bool
    public let latencyMs: Int?
    public let capacity: Capacity?
    public let error: String?
}

public struct PeersReply: Decodable { public let peers: [Peer] }
public struct AnswerReply: Decodable { public let taskId: String? }
public struct MessageReply: Decodable {
    public let messageId: String?
    public let to: String?
    public let name: String?
}
public struct DelegateReply: Decodable {
    public let office: String
    public let taskId: String?
}

// MARK: - the Panel stratum
//
// `panel.state` is what tools/munder/lib-panel.cjs `state()` answers: the host,
// not the office. Every leaf is optional because the panel reads a real machine
// that may be half-asleep: no GPT gateway, no reviver, no link.

public struct PanelApp: Decodable, Hashable {
    public let running: Bool?
    public let pid: Int?
    public let version: String?
}

public struct PanelPeer: Decodable, Hashable, Identifiable {
    public var id: String { name }
    public let name: String
    public let online: Bool?
    public let latencyMs: Int?
    public let workersIdle: Int?
    public let workersTotal: Int?
    public let reason: String?
}

public struct PanelPending: Decodable, Hashable, Identifiable {
    public var id: String { code }
    public let name: String
    public let kind: String?
    public let code: String
}

public struct PanelPhone: Decodable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let since: String?
    /// "office" from the pairing code, "machine" after `munder link panel <celular>`.
    public let authority: String?
}

public struct PanelUrl: Decodable, Hashable, Identifiable {
    public var id: String { url }
    public let url: String
    public let via: String?
}

public struct PanelLink: Decodable, Hashable {
    public let on: Bool?
    public let name: String?
    public let fingerprint: String?
    public let peers: [PanelPeer]?
    public let pending: [PanelPending]?
    public let phones: [PanelPhone]?
    public let urls: [PanelUrl]?
    public let error: String?
}

public struct PanelGrant: Decodable, Hashable, Identifiable {
    public var id: String { String(describing: client) }
    public let client: String?
    public let scope: String?
}

public struct PanelGpt: Decodable, Hashable {
    public let available: Bool?
    public let on: Bool?
    public let running: Bool?
    public let profile: String?
    public let publicUrl: String?
    public let grants: Int?
    public let pending: [PanelPending]?
}

public struct PanelReviver: Decodable, Hashable {
    public let configured: Bool?
    public let running: Bool?
    public let healthy: Bool?
    public let watchdog: String?
}

public struct PanelState: Decodable {
    public let app: PanelApp?
    public let link: PanelLink?
    public let gpt: PanelGpt?
    public let reviver: PanelReviver?
    public let platform: String?
    public let launcher: String?

    /// What this host's phones may reach. The office grants the office at
    /// pairing and the machine only on request, so the app asks here instead of
    /// guessing: nil when this phone is not in the list (an older office).
    public func authority(ofPhone id: String) -> String? {
        link?.phones?.first { $0.id == id }?.authority
    }
}

/// `panel.action` answers with the button's own words, in Spanish, from the
/// desktop panel. Shown verbatim: the phone is not rephrasing the host.
public struct PanelActionReply: Decodable {
    public let action: String
    public let ok: Bool
    public let text: String
}

/// The office this phone is paired with. Not secret: the session key is in the Keychain.
public struct PairedOffice: Codable, Equatable {
    public var officeId: String
    public var name: String
    public var boxPub: String
    public var deviceId: String
    public var deviceName: String
    /// host:port, the one that answered last first.
    public var addresses: [String]
    /// Where each address came from ("lan", "tailscale", or "manual").
    public var via: [String: String]

    public init(officeId: String, name: String, boxPub: String, deviceId: String, deviceName: String, addresses: [String], via: [String: String] = [:]) {
        self.officeId = officeId
        self.name = name
        self.boxPub = boxPub
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.addresses = addresses
        self.via = via
    }
}

public enum Address {
    public static let defaultPort = 47831

    /// "192.168.1.64", "http://100.1.2.3:47831/app/", "victus.tail1234.ts.net" → host:port.
    public static func normalize(_ input: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
        guard !s.isEmpty, s.count <= 200, !s.contains(" ") else { return nil }
        if s.hasPrefix("[") { return s.contains("]:") ? s : "\(s):\(defaultPort)" }
        return s.contains(":") ? s : "\(s):\(defaultPort)"
    }

    /// Tailscale's CGNAT range 100.64.0.0/10, or a MagicDNS name.
    public static func looksTailscale(_ hostPort: String) -> Bool {
        let host = hostPort.split(separator: ":").first.map(String.init) ?? hostPort
        if host.hasSuffix(".ts.net") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }
}
