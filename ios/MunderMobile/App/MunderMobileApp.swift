import SwiftUI
import MunderMobileCore

@main
struct MunderMobileApp: App {
    @StateObject private var store: OfficeStore

    init() {
        let store = OfficeStore()
        // `-MunderDemo` (CI simulator screenshots): the bundled demo office, no network.
        if ProcessInfo.processInfo.arguments.contains("-MunderDemo"),
           let o = Bundle.main.url(forResource: "overview", withExtension: "json", subdirectory: "Resources/Demo").flatMap({ try? Data(contentsOf: $0) }),
           let p = Bundle.main.url(forResource: "peers", withExtension: "json", subdirectory: "Resources/Demo").flatMap({ try? Data(contentsOf: $0) }) {
            store.loadDemo(overview: o, peers: p)
        }
        _store = StateObject(wrappedValue: store)
    }

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: OfficeStore

    var body: some View {
        ZStack(alignment: .bottom) {
            Px.cream50.ignoresSafeArea()
            switch store.phase {
            case .unpaired: PairView()
            case .waiting(let code): CodeView(code: code)
            case .paired: MainView()
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
    }
}
