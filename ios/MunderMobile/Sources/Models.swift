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
public struct MessageReply: Decodable { public let messageId: String? }
public struct DelegateReply: Decodable {
    public let office: String
    public let taskId: String?
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
