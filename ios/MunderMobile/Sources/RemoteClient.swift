import Foundation
import CryptoKit

/// Talks munder-remote@1 to one paired office.
///
/// The office can be reached at several addresses: its LAN IP at home, its
/// Tailscale IP from anywhere. Every call tries them in order, the one that
/// answered last first, and moves the winner to the front. So at home the LAN
/// answers straight away and away from home the dead LAN costs one short
/// timeout before Tailscale answers. `hello` hands over the office's current
/// addresses, so pairing once at home is enough.
public final class RemoteClient {
    public private(set) var office: PairedOffice
    private let key: SymmetricKey
    private let session: URLSession
    /// Called when the address order or list changed, so the caller can persist it.
    public var onOfficeChanged: ((PairedOffice) -> Void)?

    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    public init(office: PairedOffice, key: SymmetricKey, session: URLSession = RemoteClient.makeSession()) {
        self.office = office
        self.key = key
        self.session = session
    }

    /// Short timeouts on purpose: an address that is not there (the LAN IP away
    /// from home) must fail fast so the next one gets its turn.
    public static func makeSession(timeout: TimeInterval = 3.5) -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = timeout
        c.timeoutIntervalForResource = timeout * 3
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }

    // MARK: sealed calls

    public func call<T: Decodable>(_ op: String, args: [String: Any] = [:], as type: T.Type = T.self) async throws -> T {
        let data = try await callRaw(op, args: args)
        return try Self.decoder.decode(T.self, from: data)
    }

    public func callRaw(_ op: String, args: [String: Any] = [:]) async throws -> Data {
        var lastError: Error = RemoteError.unreachable("no hay direcciones guardadas")
        for address in office.addresses {
            let iv = RemoteCrypto.randomBytes(12)
            let payload: [String: Any] = ["ts": Int(Date().timeIntervalSince1970 * 1000), "op": op, "args": args]
            let plain = try JSONSerialization.data(withJSONObject: payload)
            let ct = try RemoteCrypto.seal(plain, key: key, iv: iv, direction: "req", deviceId: office.deviceId, officeId: office.officeId)
            let envelope: [String: Any] = ["v": 1, "dev": office.deviceId, "iv": iv.base64URL, "ct": ct.base64URL]

            let status: Int
            let body: Data
            do {
                (status, body) = try await Self.post(session, address: address, path: "/remote/v1/call", json: envelope)
            } catch {
                lastError = RemoteError.unreachable(Self.describe(error))
                continue // this address is not there right now: try the next one
            }
            promote(address)

            let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            guard status == 200 else {
                throw RemoteError.http(status: status, code: obj["code"] as? String ?? "http_\(status)", message: obj["error"] as? String ?? "HTTP \(status)")
            }
            guard let rivText = obj["iv"] as? String, let rctText = obj["ct"] as? String,
                  let riv = Data(base64URL: rivText), let rct = Data(base64URL: rctText) else { throw RemoteError.badReply }
            let opened: Data
            do {
                opened = try RemoteCrypto.open(rct, key: key, iv: riv, direction: "res", deviceId: office.deviceId, officeId: office.officeId)
            } catch {
                throw RemoteError.badReply
            }
            guard let msg = (try? JSONSerialization.jsonObject(with: opened)) as? [String: Any] else { throw RemoteError.badReply }
            // `re` binds the answer to THIS request: a recorded answer can't be replayed as another's.
            guard (msg["re"] as? String) == iv.base64URL else { throw RemoteError.badReply }
            guard (msg["ok"] as? Bool) == true else {
                throw RemoteError.remote(code: msg["code"] as? String ?? "error", message: msg["error"] as? String ?? "error")
            }
            return try JSONSerialization.data(withJSONObject: msg["result"] ?? NSNull(), options: [.fragmentsAllowed])
        }
        throw lastError
    }

    /// Adopt the office's own list: keep the address that works first, add the rest.
    public func learn(_ addresses: [OfficeAddress]) {
        var next = office
        for a in addresses where next.addresses.count < 8 {
            guard let norm = Address.normalize(a.address) else { continue }
            if !next.addresses.contains(norm) { next.addresses.append(norm) }
            if next.via[norm] == nil { next.via[norm] = a.via ?? (Address.looksTailscale(norm) ? "tailscale" : "lan") }
        }
        if next != office {
            office = next
            onOfficeChanged?(office)
        }
    }

    public func add(address: String, via: String) {
        guard !office.addresses.contains(address) else { return }
        office.addresses.insert(address, at: 0)
        office.via[address] = via
        onOfficeChanged?(office)
    }

    public func remove(address: String) {
        office.addresses.removeAll { $0 == address }
        office.via[address] = nil
        onOfficeChanged?(office)
    }

    private func promote(_ address: String) {
        guard office.addresses.first != address, let i = office.addresses.firstIndex(of: address) else { return }
        office.addresses.remove(at: i)
        office.addresses.insert(address, at: 0)
        onOfficeChanged?(office)
    }

    // MARK: pairing (plain JSON: nothing is trusted until a human accepts the code on the computer)

    public struct PairingResult {
        public let office: PairedOffice
        public let key: SymmetricKey
        public let code: String
    }

    public static func pair(address: String, deviceName: String, session: URLSession = RemoteClient.makeSession(timeout: 8)) async throws -> PairingResult {
        let priv = Curve25519.KeyAgreement.PrivateKey()
        let pub = priv.publicKey.rawRepresentation
        let nonce = RemoteCrypto.randomBytes(16)
        let deviceId = RemoteCrypto.deviceId(publicKey: pub)

        // 1) commit: only the hash of our nonce goes out before the office shows its own
        let first = try await postOrUnreachable(session, address: address, path: "/remote/v1/pair",
                                                json: ["name": deviceName, "pub": pub.base64URL, "commit": RemoteCrypto.commit(nonce: nonce)])
        let o = try check(first)
        guard o["protocol"] as? String == RemoteCrypto.protocolName,
              o["device_id"] as? String == deviceId,
              let boxPub = o["box_pub"] as? String,
              let officeId = o["office_id"] as? String,
              let officeNonce = o["nonce"] as? String else { throw RemoteError.badOffice }

        // 2) reveal
        _ = try check(try await postOrUnreachable(session, address: address, path: "/remote/v1/reveal",
                                                  json: ["device_id": deviceId, "nonce": nonce.base64URL]))

        let key = try RemoteCrypto.sessionKey(devicePrivate: priv, officeBoxPub: boxPub, officeId: officeId, deviceId: deviceId)
        let code = RemoteCrypto.sas(officeBoxPub: boxPub, devicePub: pub.base64URL, officeNonce: officeNonce, deviceNonce: nonce.base64URL)
        let office = PairedOffice(
            officeId: officeId, name: o["name"] as? String ?? "oficina", boxPub: boxPub,
            deviceId: deviceId, deviceName: deviceName, addresses: [address],
            via: [address: Address.looksTailscale(address) ? "tailscale" : "lan"]
        )
        return PairingResult(office: office, key: key, code: code)
    }

    // MARK: HTTP

    static func post(_ session: URLSession, address: String, path: String, json: [String: Any]) async throws -> (Int, Data) {
        guard let url = URL(string: "http://\(address)\(path)") else { throw RemoteError.unreachable("dirección inválida") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, response) = try await session.data(for: req)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    static func postOrUnreachable(_ session: URLSession, address: String, path: String, json: [String: Any]) async throws -> (Int, Data) {
        do { return try await post(session, address: address, path: path, json: json) }
        catch let e as RemoteError { throw e }
        catch { throw RemoteError.unreachable(describe(error)) }
    }

    static func check(_ reply: (Int, Data)) throws -> [String: Any] {
        let obj = (try? JSONSerialization.jsonObject(with: reply.1)) as? [String: Any] ?? [:]
        guard reply.0 == 200 else {
            throw RemoteError.http(status: reply.0, code: obj["code"] as? String ?? "http_\(reply.0)", message: obj["error"] as? String ?? "HTTP \(reply.0)")
        }
        return obj
    }

    static func describe(_ error: Error) -> String {
        if let u = error as? URLError {
            switch u.code {
            case .timedOut: return "no contesta"
            case .cannotConnectToHost: return "conexión rechazada"
            case .notConnectedToInternet: return "sin red"
            case .cannotFindHost, .dnsLookupFailed: return "no encuentro ese nombre"
            default: return u.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
