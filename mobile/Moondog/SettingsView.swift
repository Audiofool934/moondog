import SwiftUI
import UIKit

/// The two things this phone sets up: the Mac it talks to, and Apple Music.
struct SettingsView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var pairAgain = false
  @State private var detent = PresentationDetent.medium

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 36) {
          section("Mac") {
            row(Text(verbatim: room.pairing?.host ?? ""), detail: link, symbol: room.online ? "checkmark.circle.fill" : "circle.dotted")
            HStack(spacing: 10) {
              Button { pairAgain = true } label: {
                Label("Pair again", systemImage: "qrcode.viewfinder")
              }
              Button(role: .destructive) {
                room.forget()
                dismiss()
              } label: {
                Label("Forget this Mac", systemImage: "xmark.circle")
              }
            }
            .buttonStyle(.glass)
          }
          section("Apple Music") {
            row(Text(access), detail: nil, symbol: room.player.access == .ready ? "checkmark.circle.fill" : "music.note")
            if room.player.access == .notDetermined {
              Button {
                Task { await room.player.refreshAccess(request: true); room.setActive(true) }
              } label: {
                Label("Allow Apple Music", systemImage: "music.note")
              }
              .buttonStyle(.glassProminent)
              .foregroundStyle(Color.paper)
            } else if room.player.access == .denied || room.player.access == .needsSubscription {
              Button { openURL(URL(string: UIApplication.openSettingsURLString)!) } label: {
                Label("Open Settings", systemImage: "gear")
              }
              .buttonStyle(.glass)
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
    .presentationDetents([.medium, .large], selection: $detent)
    .onChange(of: pairAgain) { _, again in if again { detent = .large } }
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

  /// What is set up, with a mark that says whether it works; the buttons under it are what can be done.
  private func row(_ title: Text, detail: LocalizedStringKey?, symbol: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .foregroundStyle(Color.text2)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        title.foregroundStyle(Color.text)
        if let detail {
          Text(detail).font(.subheadline).foregroundStyle(Color.text2)
        }
      }
    }
  }
}
