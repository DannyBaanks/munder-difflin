import Foundation
import LocalAuthentication

/// Whoever holds this phone unlocked must not be able to see or drive the office.
///
/// Two gates, both answered by the phone's own owner check (Face ID / Touch ID,
/// falling back to the device passcode — `.deviceOwnerAuthentication`):
///   1. **Seeing.** The app opens locked, and locks again when it comes back after
///      `relockAfter` in the background. Nothing from the office is on screen
///      while locked.
///   2. **Acting.** Every action that changes something in the office (talk to
///      Michael, answer, delegate, touch the addresses, forget the pairing) asks
///      again, unless the owner proved themselves in the last `actionWindow`.
///
/// Munder never sees the biometric or the passcode: iOS answers yes or no.
public enum SensitiveAction: Equatable, CaseIterable {
    case ask, answer, delegate, addAddress, removeAddress, forget

    /// Shown by iOS under the Face ID / passcode prompt.
    public var reason: String {
        switch self {
        case .ask: return "Confirma que eres tú para mandarle algo a tu oficina"
        case .answer: return "Confirma que eres tú para responder en tu oficina"
        case .delegate: return "Confirma que eres tú para delegar a otra oficina"
        case .addAddress: return "Confirma que eres tú para agregar una dirección"
        case .removeAddress: return "Confirma que eres tú para quitar una dirección"
        case .forget: return "Confirma que eres tú para olvidar esta oficina"
        }
    }
}

public enum AuthResult: Equatable {
    case success
    case failed
    /// The phone has no passcode, so iOS cannot check the owner at all.
    case unavailable
}

public protocol DeviceAuthenticator {
    func authenticate(reason: String) async -> AuthResult
}

/// The timing rules, kept pure so the tests can drive the clock.
public struct LockPolicy: Equatable {
    public var relockAfter: TimeInterval
    public var actionWindow: TimeInterval

    public init(relockAfter: TimeInterval = 60, actionWindow: TimeInterval = 30) {
        self.relockAfter = relockAfter
        self.actionWindow = actionWindow
    }

    /// Coming back to the foreground: lock again if it was away long enough.
    public func mustRelock(backgroundedAt: Date?, now: Date) -> Bool {
        guard let b = backgroundedAt else { return false }
        return now.timeIntervalSince(b) >= relockAfter
    }

    /// An action is covered by a recent owner check, or needs a new one.
    public func actionNeedsAuth(lastAuth: Date?, now: Date) -> Bool {
        guard let a = lastAuth else { return true }
        let age = now.timeIntervalSince(a)
        return age < 0 || age >= actionWindow
    }
}

@MainActor
public final class AppLock: ObservableObject {
    @Published public private(set) var locked: Bool
    /// The phone has no passcode: Munder cannot protect itself, and says so.
    @Published public private(set) var unprotected = false
    @Published public private(set) var checking = false

    public let enabled: Bool
    private let policy: LockPolicy
    private let auth: DeviceAuthenticator
    private let now: () -> Date
    private var lastAuth: Date?
    private var backgroundedAt: Date?

    public init(enabled: Bool = true,
                policy: LockPolicy = LockPolicy(),
                auth: DeviceAuthenticator = LocalDeviceAuthenticator(),
                now: @escaping () -> Date = { Date() }) {
        self.enabled = enabled
        self.policy = policy
        self.auth = auth
        self.now = now
        self.locked = enabled
    }

    /// Ask the owner to unlock the app. A failed or cancelled check stays locked.
    @discardableResult
    public func unlock() async -> Bool {
        guard enabled, locked, !checking else { return !locked }
        checking = true
        defer { checking = false }
        switch await auth.authenticate(reason: "Desbloquea Munder para ver tu oficina") {
        case .success:
            lastAuth = now()
            unprotected = false
            locked = false
        case .unavailable:
            // No passcode on the phone: there is no owner to ask. Open, but warn.
            unprotected = true
            locked = false
        case .failed:
            break
        }
        return !locked
    }

    public func didEnterBackground() {
        guard enabled else { return }
        backgroundedAt = now()
    }

    /// Back in the foreground. True when the app really was in the background and
    /// is locked, so the caller may prompt once. A Face ID sheet only makes the app
    /// *inactive*, never background: without this, cancelling Face ID would bring
    /// the app back to active and re-prompt forever.
    @discardableResult
    public func willEnterForeground() -> Bool {
        guard enabled else { return false }
        let wasAway = backgroundedAt != nil
        if policy.mustRelock(backgroundedAt: backgroundedAt, now: now()) { locked = true }
        backgroundedAt = nil
        return wasAway && locked
    }

    /// Gate one office-changing action. True = go ahead.
    public func authorize(_ action: SensitiveAction) async -> Bool {
        guard enabled else { return true }
        if locked { return false }
        if unprotected { return true }
        guard policy.actionNeedsAuth(lastAuth: lastAuth, now: now()) else { return true }
        switch await auth.authenticate(reason: action.reason) {
        case .success:
            lastAuth = now()
            return true
        case .unavailable:
            unprotected = true
            return true
        case .failed:
            return false
        }
    }
}

/// Face ID / Touch ID with the device passcode as fallback.
public struct LocalDeviceAuthenticator: DeviceAuthenticator {
    public init() {}

    public func authenticate(reason: String) async -> AuthResult {
        let context = LAContext()
        context.localizedCancelTitle = "Cancelar"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return (error as? LAError)?.code == .passcodeNotSet ? .unavailable : .failed
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .success : .failed
        } catch {
            return .failed
        }
    }
}
