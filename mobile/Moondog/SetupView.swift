import SwiftUI
import VisionKit

/// The first thing the app shows: the record, one line about where Moondog lives, and one way to reach
/// it. The Mac shows a code with `npm run pair`; scanning it, here or with the Camera, pairs the phone.
/// Pasting the link or typing the address and key waits behind a second, quieter button.
struct SetupView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  /// Shown from Settings to pair again, with a way back.
  var again = false
  @State private var scanning = false
  @State private var otherWay = false

  private var canScan: Bool { DataScannerViewController.isSupported }

  var body: some View {
    GeometryReader { proxy in
      VStack(spacing: 0) {
        Spacer(minLength: 24)
        DotRecord(playing: false, armDown: false)
          .frame(width: min(proxy.size.width * 0.56, 240))
          .padding(.top, DotRecord.reach(min(proxy.size.width * 0.56, 240)))
          .accessibilityHidden(true)
        VStack(spacing: 10) {
          Text("Moondog lives on your Mac")
            .font(.title)
            .foregroundStyle(Color.text)
          Text("Run this in Moondog's mobile folder there, then scan the code it shows.")
            .font(.body)
            .foregroundStyle(Color.text2)
          Text(verbatim: "npm run pair")
            .font(.callout.monospaced())
            .foregroundStyle(Color.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.wash, in: .capsule)
            .textSelection(.enabled)
            .padding(.top, 6)
        }
        .multilineTextAlignment(.center)
        .padding(.top, 44)
        Spacer(minLength: 24)
        VStack(spacing: 12) {
          if canScan {
            Button { scanning = true } label: {
              Label("Scan the code", systemImage: "qrcode.viewfinder")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.glassProminent)
            .tint(Color.text)
            .foregroundStyle(Color.paper)
            Button { otherWay = true } label: {
              Label("Pair another way", systemImage: "link")
                .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.glass)
            .foregroundStyle(Color.text)
          } else {
            // Without a camera, as in Simulator, the link is the way in.
            Button { otherWay = true } label: {
              Label("Enter the pairing link", systemImage: "link")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.glassProminent)
            .tint(Color.text)
            .foregroundStyle(Color.paper)
          }
        }
        .controlSize(.large)
        .padding(.bottom, 8)
      }
      .padding(.horizontal, 32)
      .frame(width: proxy.size.width, height: proxy.size.height)
    }
    .background(Color.paper.ignoresSafeArea())
    .fullScreenCover(isPresented: $scanning) {
      ScanView { link in
        guard let pairing = Pairing(link: link) else { return false }
        scanning = false
        connect(pairing)
        return true
      }
    }
    .sheet(isPresented: $otherWay) {
      OtherWay { pairing in
        otherWay = false
        connect(pairing)
      }
    }
  }

  private func connect(_ pairing: Pairing) {
    room.pair(pairing)
    if again { dismiss() }
  }
}

/// The camera, looking for the code the Mac shows.
private struct ScanView: View {
  /// Called with each code read; true when it was a pairing link.
  var found: (String) -> Bool
  @Environment(\.dismiss) private var dismiss
  @State private var wrong = false

  var body: some View {
    ZStack {
      CodeScanner { code in
        if !found(code) { wrong = true }
      }
      .ignoresSafeArea()
      VStack {
        HStack {
          Spacer()
          Button(role: .close) { dismiss() }
            .buttonStyle(.glass)
            .controlSize(.large)
        }
        Spacer()
        Text(wrong ? "That code isn't a Moondog pairing code." : "Point the camera at the code on your Mac.")
          .font(.callout)
          .foregroundStyle(.white)
          .padding(.horizontal, 18)
          .padding(.vertical, 12)
          .glassEffect(.regular, in: .capsule)
          .animation(.easeInOut, value: wrong)
      }
      .padding(20)
    }
    .background(.black)
  }
}

/// VisionKit's live scanner, reading QR codes only.
private struct CodeScanner: UIViewControllerRepresentable {
  var read: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                            isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
    context.coordinator.read = read
    if !scanner.isScanning { try? scanner.startScanning() }
  }

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  func makeCoordinator() -> Coordinator { Coordinator(read: read) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    var read: (String) -> Void
    init(read: @escaping (String) -> Void) { self.read = read }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      for item in addedItems {
        if case .barcode(let code) = item, let text = code.payloadStringValue { read(text) }
      }
    }
  }
}

/// Pairing without the camera: paste the link the Mac copies, or type its address and key.
private struct OtherWay: View {
  var connect: (Pairing) -> Void
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @State private var host = ""
  @State private var key = ""
  @State private var problem: LocalizedStringKey?
  @FocusState private var field: Field?
  private enum Field { case host, key }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text("`npm run pair` also copies the link; with the same Apple ID on both, it is ready to paste here.")
            .font(.subheadline)
            .foregroundStyle(Color.text2)
          PasteButton(payloadType: String.self) { values in
            guard let pasted = values.first, let pairing = Pairing(link: pasted) else {
              problem = "That isn't a Moondog pairing link."
              return
            }
            connect(pairing)
          }
          .buttonBorderShape(.capsule)
          .controlSize(.large)
          .tint(Color.text)
          .padding(.top, 14)

          Text("Or type them")
            .font(.footnote)
            .foregroundStyle(Color.text3)
            .padding(.top, 32)
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
          Text("`npm run --silent host -- --show-key` shows the key on your Mac.")
            .font(.footnote)
            .foregroundStyle(Color.text3)
            .padding(.top, 10)

          if let problem {
            Text(problem)
              .font(.callout)
              .foregroundStyle(Color.text)
              .padding(.top, 14)
          }

          Button(action: typed) {
            Label("Connect", systemImage: "link")
              .frame(maxWidth: .infinity, minHeight: 36)
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
          .tint(Color.text)
          .foregroundStyle(Color.paper)
          .padding(.top, 24)
          .disabled(host.isEmpty || key.isEmpty)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(Color.paper)
      .navigationTitle("Pair another way")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { dismiss() }
        }
      }
    }
    .tint(Color.text)
    .presentationBackground(Color.paper)
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
