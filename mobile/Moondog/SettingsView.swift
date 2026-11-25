import SwiftUI
import UIKit

/// The two things this phone sets up: the Mac it talks to, and Apple Music.
struct SettingsView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var pairAgain = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 36) {
          section("Mac") {
            row(Text(verbatim: room.pairing?.host ?? ""), detail: link)
            Button("Pair again") { pairAgain = true }
            Button("Forget this Mac", role: .destructive) {
              room.forget()
              dismiss()
            }
          }
          section("Apple Music") {
            row(Text(access), detail: nil)
            if room.player.access == .notDetermined {
              Button("Allow Apple Music") {
                Task { await room.player.refreshAccess(request: true); room.setActive(true) }
              }
            } else if room.player.access == .denied || room.player.access == .needsSubscription {
              Button("Open Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
            }
          }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(Color.paper)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { dismiss() }
        }
      }
      .navigationDestination(isPresented: $pairAgain) { SetupView(again: true) }
    }
    .tint(Color.text)
    .presentationDetents([.medium, .large])
    .presentationBackground(Color.paper)
  }

  private var link: LocalizedStringKey {
    switch room.link {
    case .online: "Connected"
    case .connecting: "Waiting for your Mac"
    case .refused: "Pairing key not accepted"
    }
  }

  private var access: LocalizedStringKey {
    if Player.simulated { return "Simulated in Simulator, without sound" }
    return switch room.player.access {
    case .checking: "Checking…"
    case .notDetermined: "Not allowed yet"
    case .denied: "Off for Moondog"
    case .restricted: "Restricted on this iPhone"
    case .needsSubscription: "Needs an Apple Music subscription"
    case .ready: "Plays whole songs on this iPhone"
    }
  }

  private func section(_ title: LocalizedStringKey, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.footnote)
        .foregroundStyle(Color.text3)
      content()
        .font(.body)
        .foregroundStyle(Color.text)
    }
  }

  private func row(_ title: Text, detail: LocalizedStringKey?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      title.foregroundStyle(Color.text)
      if let detail {
        Text(detail).font(.subheadline).foregroundStyle(Color.text2)
      }
    }
  }
}
