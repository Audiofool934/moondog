import SwiftUI

@main
struct MoondogApp: App {
  @State private var room = Room()
  @Environment(\.scenePhase) private var phase

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
      .onChange(of: phase, initial: true) { _, phase in room.setActive(phase == .active) }
    }
  }
}
