import SwiftUI
import UIKit

/// Pairing with the Mac: paste the link the host copies, or type its address and key.
struct SetupView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  /// Shown from Settings to pair again, with a way back.
  var again = false
  @State private var host = ""
  @State private var key = ""
  @State private var problem: LocalizedStringKey?
  @FocusState private var field: Field?
  private enum Field { case host, key }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if !again {
          DotRecord(playing: false, armDown: false)
            .frame(width: 120)
            .padding(.top, 48)
            .padding(.bottom, 28)
            .accessibilityHidden(true)
        }
        Text("Connect to your Mac")
          .font(.title)
          .foregroundStyle(Color.text)
          .padding(.top, again ? 24 : 0)
        Text("Start the Moondog host on your Mac, then paste the pairing link it copies.")
          .font(.body)
          .foregroundStyle(Color.text2)
          .padding(.top, 8)

        PasteButton(payloadType: String.self) { values in
          guard let pasted = values.first, let pairing = Pairing(link: pasted) else {
            problem = "That isn't a Moondog pairing link."
            return
          }
          connect(pairing)
        }
        .buttonBorderShape(.capsule)
        .tint(Color.text)
        .padding(.top, 28)

        Text("Or type them")
          .font(.footnote)
          .foregroundStyle(Color.text3)
          .padding(.top, 36)
          .padding(.bottom, 10)
        VStack(spacing: 10) {
          TextField("Mac address", text: $host, prompt: Text(verbatim: "100.x.y.z"))
            .keyboardType(.numbersAndPunctuation)
            .focused($field, equals: .host)
            .submitLabel(.next)
            .onSubmit { field = .key }
          SecureField("Pairing key", text: $key)
            .focused($field, equals: .key)
            .submitLabel(.go)
            .onSubmit(typed)
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .textFieldStyle(Plain())

        if let problem {
          Text(problem)
            .font(.callout)
            .foregroundStyle(Color.text)
            .padding(.top, 14)
        }

        Button("Connect", action: typed)
          .buttonStyle(.glassProminent)
          .tint(Color.text)
          .foregroundStyle(Color.paper)
          .padding(.top, 20)
          .disabled(host.isEmpty || key.isEmpty)
      }
      .frame(maxWidth: 480, alignment: .leading)
      .padding(.horizontal, 28)
      .padding(.bottom, 40)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Color.paper)
    .onAppear {
      host = room.pairing?.host ?? ""
      key = room.pairing?.key ?? ""
    }
  }

  private func typed() {
    guard let pairing = Pairing(host: host, key: key) else {
      problem = "Enter your Mac's Tailscale address (100.x.y.z) and the 32-character key the host shows."
      return
    }
    connect(pairing)
  }

  private func connect(_ pairing: Pairing) {
    problem = nil
    field = nil
    room.pair(pairing)
    if again { dismiss() }
  }
}

private struct Plain: TextFieldStyle {
  func _body(configuration: TextField<Self._Label>) -> some View {
    configuration
      .font(.body)
      .foregroundStyle(Color.text)
      .padding(.horizontal, 14)
      .frame(minHeight: 48)
      .background(Color.wash, in: .rect(cornerRadius: 12))
  }
}
