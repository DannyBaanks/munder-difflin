import Foundation
import CryptoKit
import Security

/// munder-remote@1, the same wire the office speaks (tools/munder/lib-remote.cjs)
/// and the PWA speaks (tools/munder/remote-app/remote-crypto.js). Everything here
/// is CryptoKit: X25519, HKDF-SHA256, ChaCha20-Poly1305, SHA-256. Tests/vectors.json
/// is computed by the office's own Node code and RemoteCryptoTests must match it
/// byte for byte.
public enum RemoteCrypto {
    public static let protocolName = "munder-remote@1"

    /// First 8 bytes of SHA-256(raw X25519 public key), as 16 hex chars.
    public static func deviceId(publicKey: Data) -> String {
        SHA256.hash(data: publicKey).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// The 6 digits both screens show. The phone's nonce was committed before the office answered.
    public static func sas(officeBoxPub: String, devicePub: String, officeNonce: String, deviceNonce: String) -> String {
        let text = "\(protocolName)|sas|\(officeBoxPub)|\(devicePub)|\(officeNonce)|\(deviceNonce)"
        let b = Array(SHA256.hash(data: Data(text.utf8)))
        let n = (UInt32(b[0]) << 24) | (UInt32(b[1]) << 16) | (UInt32(b[2]) << 8) | UInt32(b[3])
        return String(format: "%06u", n % 1_000_000)
    }

    /// What the phone sends first: the hash of its nonce, never the nonce.
    public static func commit(nonce: Data) -> String {
        Data(SHA256.hash(data: nonce)).base64URL
    }

    public static func sessionKey(devicePrivate: Curve25519.KeyAgreement.PrivateKey, officeBoxPub: String, officeId: String, deviceId: String) throws -> SymmetricKey {
        guard let raw = Data(base64URL: officeBoxPub), raw.count == 32 else { throw RemoteError.badOffice }
        let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
        let secret = try devicePrivate.sharedSecretFromKeyAgreement(with: pub)
        return secret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data("\(officeId)|\(deviceId)".utf8),
            sharedInfo: Data("\(protocolName) key".utf8),
            outputByteCount: 32
        )
    }

    static func aad(_ direction: String, deviceId: String, officeId: String) -> Data {
        Data("\(protocolName)|\(direction)|\(deviceId)|\(officeId)".utf8)
    }

    /// ciphertext ‖ 16-byte tag, exactly what Node's chacha20-poly1305 produces.
    public static func seal(_ plaintext: Data, key: SymmetricKey, iv: Data, direction: String, deviceId: String, officeId: String) throws -> Data {
        let box = try ChaChaPoly.seal(
            plaintext,
            using: key,
            nonce: ChaChaPoly.Nonce(data: iv),
            authenticating: aad(direction, deviceId: deviceId, officeId: officeId)
        )
        return Data(box.ciphertext) + Data(box.tag)
    }

    public static func open(_ sealed: Data, key: SymmetricKey, iv: Data, direction: String, deviceId: String, officeId: String) throws -> Data {
        guard sealed.count >= 16 else { throw RemoteError.badReply }
        let bytes = Data(sealed)
        let box = try ChaChaPoly.SealedBox(
            nonce: ChaChaPoly.Nonce(data: iv),
            ciphertext: Data(bytes.prefix(bytes.count - 16)),
            tag: Data(bytes.suffix(16))
        )
        return try ChaChaPoly.open(box, using: key, authenticating: aad(direction, deviceId: deviceId, officeId: officeId))
    }

    public static func randomBytes(_ count: Int) -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        precondition(status == errSecSuccess, "no randomness")
        return data
    }
}

public extension Data {
    init?(base64URL: String) {
        var s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        self.init(base64Encoded: s)
    }

    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

public enum RemoteError: Error, LocalizedError, Equatable {
    /// The office answered with an error before sealing (not paired, waiting, rate limited…).
    case http(status: Int, code: String, message: String)
    /// The sealed answer said ok:false.
    case remote(code: String, message: String)
    case badReply
    case badOffice
    case unreachable(String)
    case notPaired

    public var code: String {
        switch self {
        case .http(_, let code, _), .remote(let code, _): return code
        case .badReply: return "bad_reply"
        case .badOffice: return "bad_office"
        case .unreachable: return "unreachable"
        case .notPaired: return "not_paired"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .http(_, _, let message), .remote(_, let message): return message
        case .badReply: return "La respuesta de la oficina no corresponde a esta llamada."
        case .badOffice: return "Esa no parece una oficina Munder."
        case .unreachable(let why): return "No alcanzo la oficina (\(why)). ¿Está encendido el enlace y estás en tu red o en Tailscale?"
        case .notPaired: return "Este celular no está emparejado."
        }
    }
}
