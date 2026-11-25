import SwiftUI

@main
struct MoondogApp: App {
  @State private var room = Room()
  @Environment(\.scenePhase) private var phase
  @State private var offered: Pairing?

  var body: some Scene {
    WindowGroup {
      Group {
        if room.pairing == nil {
          SetupView()
        } else {
          RoomView()
        }
      }
      .environment(room)
      .tint(Color.text)
      // Only leaving the app counts as away. A system alert, Control Center or the app switcher makes the
      // scene inactive for a moment while the app keeps running, and must not hold back a song.
      .onChange(of: phase, initial: true) { _, phase in room.setActive(phase != .background) }
      // The code `npm run pair` shows opens here from the Camera. A phone already paired with another
      // Mac asks first, so no link can move it without the listener.
      .onOpenURL { url in
        guard let pairing = Pairing(link: url.absoluteString) else { return }
        if room.pairing == nil || room.pairing?.host == pairing.host { room.pair(pairing) } else { offered = pairing }
      }
      .alert("Pair with this Mac?", isPresented: Binding(get: { offered != nil }, set: { if !$0 { offered = nil } }), presenting: offered) { pairing in
        Button("Pair") { room.pair(pairing) }
        Button("Cancel", role: .cancel) {}
      } message: { pairing in
        Text("Moondog will talk to the Mac at \(pairing.host) instead of \(room.pairing?.host ?? "").")
      }
    }
  }
}
