import XCTest
@testable import MunderMobileCore

/// A stand-in for Face ID: answers from a script and counts how often it was asked.
private final class FakeAuth: DeviceAuthenticator {
    var answers: [AuthResult]
    private(set) var asked: [String] = []
    init(_ answers: [AuthResult]) { self.answers = answers }
    func authenticate(reason: String) async -> AuthResult {
        asked.append(reason)
        return answers.isEmpty ? .failed : answers.removeFirst()
    }
}

private final class Clock {
    var t = Date(timeIntervalSince1970: 1_800_000_000)
    func advance(_ s: TimeInterval) { t = t.addingTimeInterval(s) }
}

@MainActor
final class AppLockTests: XCTestCase {
    private func make(_ answers: [AuthResult], enabled: Bool = true) -> (AppLock, FakeAuth, Clock) {
        let auth = FakeAuth(answers)
        let clock = Clock()
        let lock = AppLock(enabled: enabled, policy: LockPolicy(relockAfter: 60, actionWindow: 30), auth: auth, now: { clock.t })
        return (lock, auth, clock)
    }

    func testStartsLockedAndOnlyTheOwnerOpensIt() async {
        let (lock, auth, _) = make([.failed, .success])
        XCTAssertTrue(lock.locked)
        let first = await lock.unlock()
        XCTAssertFalse(first)
        XCTAssertTrue(lock.locked, "a failed or cancelled Face ID stays locked")
        let second = await lock.unlock()
        XCTAssertTrue(second)
        XCTAssertFalse(lock.locked)
        XCTAssertEqual(auth.asked.count, 2)
    }

    func testNothingChangesTheOfficeWhileLocked() async {
        let (lock, auth, _) = make([.success])
        for action in SensitiveAction.allCases {
            let ok = await lock.authorize(action)
            XCTAssertFalse(ok, "\(action) must be refused while locked")
        }
        XCTAssertTrue(auth.asked.isEmpty, "a locked app does not even prompt; it unlocks first")
    }

    func testActionsAskAgainOutsideTheWindow() async {
        let (lock, auth, clock) = make([.success, .success])
        await lock.unlock()
        clock.advance(10)
        let within = await lock.authorize(.ask)
        XCTAssertTrue(within)
        XCTAssertEqual(auth.asked.count, 1, "just unlocked: covered by that check")
        clock.advance(31)
        let after = await lock.authorize(.delegate)
        XCTAssertTrue(after)
        XCTAssertEqual(auth.asked.count, 2)
        XCTAssertEqual(auth.asked.last, SensitiveAction.delegate.reason)
    }

    func testARefusedActionIsRefused() async {
        let (lock, _, clock) = make([.success, .failed])
        await lock.unlock()
        clock.advance(60)
        let ok = await lock.authorize(.forget)
        XCTAssertFalse(ok)
    }

    func testRelocksAfterAMinuteInTheBackgroundNotBefore() async {
        let (lock, _, clock) = make([.success])
        await lock.unlock()
        lock.didEnterBackground()
        clock.advance(20)
        XCTAssertFalse(lock.willEnterForeground())
        XCTAssertFalse(lock.locked, "a quick trip to another app does not relock")
        lock.didEnterBackground()
        clock.advance(61)
        XCTAssertTrue(lock.willEnterForeground(), "back from the background and locked: prompt once")
        XCTAssertTrue(lock.locked)
    }

    func testCancellingFaceIDDoesNotLoop() async {
        // The Face ID sheet makes the app inactive, then active again, with no
        // background in between: that must not ask for another prompt.
        let (lock, _, _) = make([.failed])
        await lock.unlock()
        XCTAssertTrue(lock.locked)
        XCTAssertFalse(lock.willEnterForeground())
    }

    func testAPhoneWithoutPasscodeOpensButIsFlagged() async {
        let (lock, _, _) = make([.unavailable])
        let opened = await lock.unlock()
        XCTAssertTrue(opened)
        XCTAssertTrue(lock.unprotected)
        let ok = await lock.authorize(.ask)
        XCTAssertTrue(ok)
    }

    func testDisabledLockNeverPrompts() async {
        let (lock, auth, _) = make([], enabled: false)
        XCTAssertFalse(lock.locked)
        let ok = await lock.authorize(.forget)
        XCTAssertTrue(ok)
        XCTAssertTrue(auth.asked.isEmpty)
    }

    func testPolicyEdges() {
        let p = LockPolicy(relockAfter: 60, actionWindow: 30)
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(p.mustRelock(backgroundedAt: nil, now: t))
        XCTAssertTrue(p.mustRelock(backgroundedAt: t, now: t.addingTimeInterval(60)))
        XCTAssertTrue(p.actionNeedsAuth(lastAuth: nil, now: t))
        XCTAssertFalse(p.actionNeedsAuth(lastAuth: t, now: t.addingTimeInterval(29)))
        XCTAssertTrue(p.actionNeedsAuth(lastAuth: t, now: t.addingTimeInterval(30)))
        XCTAssertTrue(p.actionNeedsAuth(lastAuth: t, now: t.addingTimeInterval(-5)), "a clock moved backwards never extends the window")
    }

    func testTheStoreAsksBeforeChangingAnything() async {
        let defaults = UserDefaults(suiteName: "applock-\(UUID().uuidString)")!
        let store = OfficeStore(defaults: defaults)
        var asked: [SensitiveAction] = []
        store.authorize = { action in asked.append(action); return false }
        let sent = await store.delegate(to: "other-office", text: "hola")
        XCTAssertFalse(sent)
        await store.addAddress("100.115.163.4")
        XCTAssertEqual(asked, [.delegate], "unpaired: addAddress stops before asking; delegate is refused by the owner check")
    }
}
