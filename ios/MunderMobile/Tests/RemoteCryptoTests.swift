import XCTest
import CryptoKit
@testable import MunderMobileCore

/// Tests/vectors.json and Tests/overview.json are written by the office's own
/// Node code (scripts/make-assets.cjs). Matching them byte for byte is what
/// proves this app and the office speak the same munder-remote@1.
final class RemoteCryptoTests: XCTestCase {
    struct Vectors: Decodable {
        struct Sealed: Decodable { let iv: String; let plaintext: String; let ct: String }
        let protocolName: String
        let officeId: String
        let officeBoxPub: String
        let devicePriv: String
        let devicePub: String
        let deviceId: String
        let sessionKey: String
        let officeNonce: String
        let deviceNonce: String
        let commit: String
        let sas: String
        let request: Sealed
        let response: Sealed

        enum CodingKeys: String, CodingKey {
            case protocolName = "protocol"
            case officeId = "office_id", officeBoxPub = "office_box_pub", devicePriv = "device_priv", devicePub = "device_pub"
            case deviceId = "device_id", sessionKey = "session_key", officeNonce = "office_nonce", deviceNonce = "device_nonce"
            case commit, sas, request, response
        }
    }

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"), "\(name).json is in the test bundle")
        return try Data(contentsOf: url)
    }

    private func vectors() throws -> Vectors {
        try JSONDecoder().decode(Vectors.self, from: fixture("vectors"))
    }

    private func key(_ v: Vectors) throws -> SymmetricKey {
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: XCTUnwrap(Data(base64URL: v.devicePriv)))
        return try RemoteCrypto.sessionKey(devicePrivate: priv, officeBoxPub: v.officeBoxPub, officeId: v.officeId, deviceId: v.deviceId)
    }

    func testProtocolName() throws {
        XCTAssertEqual(try vectors().protocolName, RemoteCrypto.protocolName)
    }

    func testDeviceIdentity() throws {
        let v = try vectors()
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: XCTUnwrap(Data(base64URL: v.devicePriv)))
        XCTAssertEqual(priv.publicKey.rawRepresentation.base64URL, v.devicePub)
        XCTAssertEqual(RemoteCrypto.deviceId(publicKey: priv.publicKey.rawRepresentation), v.deviceId)
    }

    func testSessionKeyMatchesTheOffice() throws {
        let v = try vectors()
        let raw = try key(v).withUnsafeBytes { Data($0) }
        XCTAssertEqual(raw.base64URL, v.sessionKey)
    }

    func testCommitAndCode() throws {
        let v = try vectors()
        XCTAssertEqual(RemoteCrypto.commit(nonce: try XCTUnwrap(Data(base64URL: v.deviceNonce))), v.commit)
        XCTAssertEqual(RemoteCrypto.sas(officeBoxPub: v.officeBoxPub, devicePub: v.devicePub, officeNonce: v.officeNonce, deviceNonce: v.deviceNonce), v.sas)
    }

    func testSealsARequestExactlyLikeTheOffice() throws {
        let v = try vectors()
        let ct = try RemoteCrypto.seal(Data(v.request.plaintext.utf8), key: key(v), iv: XCTUnwrap(Data(base64URL: v.request.iv)),
                                       direction: "req", deviceId: v.deviceId, officeId: v.officeId)
        XCTAssertEqual(ct.base64URL, v.request.ct)
    }

    func testOpensTheOfficesAnswer() throws {
        let v = try vectors()
        let plain = try RemoteCrypto.open(XCTUnwrap(Data(base64URL: v.response.ct)), key: key(v), iv: XCTUnwrap(Data(base64URL: v.response.iv)),
                                          direction: "res", deviceId: v.deviceId, officeId: v.officeId)
        XCTAssertEqual(String(decoding: plain, as: UTF8.self), v.response.plaintext)
    }

    func testTamperedOrMisdirectedAnswersAreRejected() throws {
        let v = try vectors()
        var ct = try XCTUnwrap(Data(base64URL: v.response.ct))
        ct[0] ^= 1
        XCTAssertThrowsError(try RemoteCrypto.open(ct, key: key(v), iv: XCTUnwrap(Data(base64URL: v.response.iv)),
                                                   direction: "res", deviceId: v.deviceId, officeId: v.officeId))
        // A request can't be passed off as an answer: the direction is in the AAD.
        XCTAssertThrowsError(try RemoteCrypto.open(XCTUnwrap(Data(base64URL: v.request.ct)), key: key(v), iv: XCTUnwrap(Data(base64URL: v.request.iv)),
                                                   direction: "res", deviceId: v.deviceId, officeId: v.officeId))
    }

    func testDecodesARealOverview() throws {
        let o = try RemoteClient.decoder.decode(Overview.self, from: fixture("overview"))
        XCTAssertEqual(o.office.name, "michael-victus")
        XCTAssertEqual(o.capacity.workersIdle, 1)
        XCTAssertEqual(o.agents.first { $0.god == true }?.name, "Michael")
        XCTAssertEqual(o.agents.first { $0.id == "dwight" }?.onHold, true)
        XCTAssertEqual(o.questions.first?.question?.q.hasPrefix("**¿Qué dominio"), true)
        XCTAssertEqual(o.tasks.first { $0.id == "task-2" }?.fromOffice, "michael-xeon")
        XCTAssertNil(o.tasks.first { $0.id == "task-3" }?.title, "a card without a title still decodes")
    }

    func testDecodesHelloAddresses() throws {
        let v = try vectors()
        let msg = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(v.response.plaintext.utf8)) as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(msg["result"]))
        struct R: Decodable { let name: String; let addresses: [OfficeAddress] }
        let r = try RemoteClient.decoder.decode(R.self, from: data)
        XCTAssertEqual(r.addresses.first?.via, "tailscale")
    }

    func testAddresses() {
        XCTAssertEqual(Address.normalize("192.168.1.64"), "192.168.1.64:47831")
        XCTAssertEqual(Address.normalize(" http://100.101.4.7:47831/app/ "), "100.101.4.7:47831")
        XCTAssertEqual(Address.normalize("victus.tail1234.ts.net"), "victus.tail1234.ts.net:47831")
        XCTAssertNil(Address.normalize("   "))
        XCTAssertTrue(Address.looksTailscale("100.101.4.7:47831"))
        XCTAssertTrue(Address.looksTailscale("victus.tail1234.ts.net:47831"))
        XCTAssertFalse(Address.looksTailscale("192.168.1.64:47831"))
        XCTAssertFalse(Address.looksTailscale("100.200.1.1:47831"), "outside 100.64/10")
    }

    func testLearningAddressesKeepsTheWorkingOneFirst() {
        let office = PairedOffice(officeId: "o", name: "michael-victus", boxPub: "x", deviceId: "d", deviceName: "iPhone",
                                  addresses: ["192.168.1.64:47831"], via: ["192.168.1.64:47831": "lan"])
        let client = RemoteClient(office: office, key: SymmetricKey(size: .bits256))
        var saved: PairedOffice?
        client.onOfficeChanged = { saved = $0 }
        client.learn([OfficeAddress(address: "100.101.4.7:47831", via: "tailscale"), OfficeAddress(address: "192.168.1.64:47831", via: "lan")])
        XCTAssertEqual(saved?.addresses, ["192.168.1.64:47831", "100.101.4.7:47831"])
        XCTAssertEqual(saved?.via["100.101.4.7:47831"], "tailscale")
    }
}
