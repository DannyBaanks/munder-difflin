import XCTest
@testable import MunderMobileCore

/// `Tests/panel.json` is written by `node ios/MunderMobile/scripts/make-assets.cjs`
/// from the office's OWN `state()` — the same `tools/munder/lib-panel.cjs` the
/// desktop panel runs. So these are not shapes someone typed: if the host adds a
/// field, or renames one, this test stops decoding and CI says so.
@MainActor
final class PanelStateTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"), "\(name).json is in the test bundle")
        return try Data(contentsOf: url)
    }

    func testDecodesTheStateTheHostReallyAnswers() throws {
        let s = try RemoteClient.decoder.decode(PanelState.self, from: try fixture("panel"))

        // The host, not the office: `app` is the process on the other machine.
        XCTAssertEqual(s.app?.running, false)
        XCTAssertEqual(s.app?.version, "fixture")
        XCTAssertEqual(s.platform, "linux")

        // The link, including who may press what.
        XCTAssertEqual(s.link?.on, false)
        XCTAssertEqual(s.link?.phones?.count, 1)
        XCTAssertEqual(s.link?.phones?.first?.id, "9ed00cd88840bed1")
        XCTAssertEqual(s.link?.phones?.first?.authority, "machine")
        XCTAssertEqual(s.link?.urls?.count, 2)

        // A machine with no gateway and no reviver is a normal state, not a
        // decode failure: every leaf is optional on purpose.
        XCTAssertEqual(s.gpt?.available, false)
        XCTAssertNil(s.gpt?.publicUrl)
        XCTAssertEqual(s.reviver?.configured, false)
        XCTAssertNil(s.reviver?.watchdog)
    }

    /// The authority the app asks about is THIS phone's, and it is what the
    /// office granted — never what the app would like to be true.
    func testAuthorityIsReadPerPhone() throws {
        let s = try RemoteClient.decoder.decode(PanelState.self, from: try fixture("panel"))
        XCTAssertEqual(s.authority(ofPhone: "9ed00cd88840bed1"), "machine")
        XCTAssertNil(s.authority(ofPhone: "otro-celular"), "a phone that is not in the list has no authority, not office by default")

        // An older office that answers without `phones` at all: nil, and the app
        // shows the locked door rather than pretending the door is open.
        let thin = try RemoteClient.decoder.decode(PanelState.self, from: Data(#"{"app":{"running":true}}"#.utf8))
        XCTAssertNil(thin.authority(ofPhone: "9ed00cd88840bed1"))
        XCTAssertNil(thin.link)
    }

    func testAnActionReplyCarriesTheHostsOwnWords() throws {
        let json = #"{"action":"link.on","ok":true,"text":"El enlace ya estaba encendido."}"#
        let r = try RemoteClient.decoder.decode(PanelActionReply.self, from: Data(json.utf8))
        XCTAssertEqual(r.action, "link.on")
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.text, "El enlace ya estaba encendido.")
    }

    /// The phone must not offer the two desktop-only buttons. This is the client
    /// half of PANEL_OFF; the server refuses them anyway, and a test that pinned
    /// the server list would still let the app draw a button that always fails.
    func testTheTwoDesktopOnlyButtonsStayOffThePhone() {
        XCTAssertTrue(OfficeStore.panelRemoteBlocked.contains("shortcut.install"))
        XCTAssertTrue(OfficeStore.panelRemoteBlocked.contains("link.phoneAuthority"))
    }
}
