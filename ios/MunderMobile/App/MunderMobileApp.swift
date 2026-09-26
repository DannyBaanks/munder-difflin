import SwiftUI
import MunderMobileCore

@main
struct MunderMobileApp: App {
    @StateObject private var store: OfficeStore
    @StateObject private var lock: AppLock

    init() {
        let store = OfficeStore()
        let demo = ProcessInfo.processInfo.arguments.contains("-MunderDemo")
        // Face ID / passcode before seeing or changing the office. Off only in the
        // bundled demo (CI screenshots), which has no real office behind it.
        // `-MunderDemoLocked` (CI screenshot of the lock screen): locked demo whose
        // owner check never passes, since the simulator has no Face ID enrolled.
        let demoLocked = demo && ProcessInfo.processInfo.arguments.contains("-MunderDemoLocked")
        let lock = demoLocked ? AppLock(enabled: true, auth: NeverAuthenticator()) : AppLock(enabled: !demo)
        store.authorize = { [weak lock] action in await lock?.authorize(action) ?? false }
        // `-MunderDemo` (CI simulator screenshots): the bundled demo office, no network.
        if demo,
           let o = Bundle.main.url(forResource: "overview", withExtension: "json", subdirectory: "Media/Demo").flatMap({ try? Data(contentsOf: $0) }),
           let p = Bundle.main.url(forResource: "demo-peers", withExtension: "json", subdirectory: "Media/Demo").flatMap({ try? Data(contentsOf: $0) }) {
            store.loadDemo(overview: o, peers: p)
        }
        _store = StateObject(wrappedValue: store)
        _lock = StateObject(wrappedValue: lock)
    }

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store).environmentObject(lock)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: OfficeStore
    @EnvironmentObject private var lock: AppLock
    @Environment(\.scenePhase) private var scenePhase

    /// Nothing to protect before a pairing exists; after it, the office stays
    /// behind the lock. Not even rendered underneath, so VoiceOver and the
    /// app switcher cannot read it either.
    private var showLock: Bool { lock.locked && store.phase == .paired }

    var body: some View {
        ZStack(alignment: .bottom) {
            Px.cream50.ignoresSafeArea()
            if showLock {
                LockView()
            } else {
                switch store.phase {
                case .unpaired: PairView()
                case .waiting(let code): CodeView(code: code)
                case .paired: MainView()
                }
            }
            // The app switcher snapshots the screen as it goes inactive: cover it.
            if lock.enabled && scenePhase != .active && store.phase == .paired {
                Px.cream50.ignoresSafeArea().overlay(Portrait(name: "michael", scale: 3))
            }
            if let toast = store.toast {
                Text(toast)
                    .font(.subheadline)
                    .foregroundColor(Px.cream50)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Px.ink900)
                    .background(Rectangle().fill(Px.shadow).offset(x: 3, y: 3))
                    .padding(.bottom, 90)
                    .padding(.horizontal, 16)
                    .transition(.opacity)
                    .task(id: toast) {
                        try? await Task.sleep(nanoseconds: 2_600_000_000)
                        if store.toast == toast { store.toast = nil }
                    }
            }
        }
        .animation(.easeOut(duration: 0.15), value: store.toast)
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .background: lock.didEnterBackground()
            case .active:
                if lock.willEnterForeground() && showLock { Task { await lock.unlock() } }
            default: break
            }
        }
        // Right after a pairing is accepted the office appears: ask for the owner then.
        .onChange(of: store.phase) { phase in
            if phase == .paired && showLock { Task { await lock.unlock() } }
        }
        .task { if showLock { await lock.unlock() } }
    }
}

/// Shown instead of the office until the owner proves it is them.
struct LockView: View {
    @EnvironmentObject private var lock: AppLock

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            HStack(alignment: .bottom, spacing: 12) {
                Portrait(name: "dwight", scale: 3)
                Bubble { Text("Esta oficina es privada. Confirma que eres tú.") }
                    .padding(.bottom, 20)
            }
            PixelCard {
                VStack(alignment: .leading, spacing: 12) {
                    PixelLabel("Munder bloqueado", size: 10, color: Px.ink900)
                    Text("Usa Face ID o el código de tu iPhone. Munder no ve ni guarda ninguno de los dos: iOS solo le dice sí o no.")
                        .font(.footnote).foregroundColor(Px.ink500)
                    Button(lock.checking ? "Comprobando…" : "Desbloquear") { Task { await lock.unlock() } }
                        .buttonStyle(PixelButtonStyle())
                        .disabled(lock.checking)
                }
            }
            Spacer()
        }
        .padding(16)
    }
}

/// CI only: an owner check that never passes, to capture the lock screen.
private struct NeverAuthenticator: DeviceAuthenticator {
    func authenticate(reason: String) async -> AuthResult { .failed }
}
