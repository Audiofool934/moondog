import MusicKit
import SwiftUI

/// The listening room. Before anything is said the record stands alone in the middle; once there are
/// words, it moves into the bar, small and still turning, and the conversation has the room.
struct RoomView: View {
  @Environment(Room.self) private var room
  @State private var draft = ""
  @State private var conversations = false
  @State private var settings = false
  @State private var offAir = false
  @State private var nowPlaying = false
  /// The record alone: whether it is open, and how far, from 0 in the room to 1 filling the screen.
  @State private var immersed = false
  @State private var openness: CGFloat = 0
  /// Where the record sits on screen, for the record alone to grow out of and return to.
  @State private var recordFrame = CGRect.zero
  @State private var viewport = CGSize.zero
  /// Where the top bar ends and the bottom bar begins on screen, which the words fade toward.
  @State private var topEdge: CGFloat = 0
  @State private var bottomEdge: CGFloat = .infinity
  @Namespace private var space
  @FocusState private var composing: Bool
  @Environment(\.colorScheme) private var scheme

  /// The record's width in the bar over a conversation.
  private static let small: CGFloat = 64

  var body: some View {
    ZStack {
      ZStack {
        Color.paper
        Mood(palette: lit, playing: room.player.state.playing)
      }
      .ignoresSafeArea()
      conversation
        // The room steps back while the record has the screen.
        .opacity(1 - openness)
        .scaleEffect(1 - openness * 0.04)
        .allowsHitTesting(!immersed)
        .accessibilityHidden(immersed)
      if immersed {
        ImmersiveLayer(openness: $openness, from: recordFrame, close: closeRecord)
      }
    }
    .statusBarHidden(immersed)
    .persistentSystemOverlays(immersed ? .hidden : .automatic)
    .sheet(isPresented: $conversations) { SidebarView() }
    .sheet(isPresented: $settings) { SettingsView() }
    .confirmationDialog("Go off air?", isPresented: $offAir, titleVisibility: .visible) {
      Button("Go off air", role: .destructive) { room.goOffAir() }
    } message: {
      Text("Moondog stops making music for the stream.")
    }
    // Words the Mac couldn't take yet come back to the composer.
    .onChange(of: room.returned) { _, words in
      guard let words else { return }
      draft = words
      room.returned = nil
    }
    .sheet(isPresented: $nowPlaying) { NowPlayingView() }
  }

  private func openRecord() {
    composing = false
    immersed = true
    withAnimation(.spring(duration: 0.55, bounce: 0.16)) { openness = 1 }
  }

  private func closeRecord() {
    withAnimation(.spring(duration: 0.5, bounce: 0.12)) { openness = 0 } completion: { immersed = false }
  }

  private var conversation: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if empty { record(width: quietWidth) }
        status
        ForEach(Array(room.messages.enumerated()), id: \.offset) { _, message in
          MessageView(message: message)
        }
        if let turn = room.turn {
          MessageView(message: Message(role: "user", text: turn.user))
          if turn.assistant.isEmpty {
            working
          } else {
            MessageView(message: Message(role: "assistant", text: turn.assistant))
          }
        }
        if let notice = room.notice {
          Text(notice)
            .font(.callout)
            .foregroundStyle(Color.text3)
            .textSelection(.enabled)
            .padding(.top, 20)
        }
      }
      .padding(.horizontal, 22)
      .padding(.top, empty ? 0 : 8)
      .padding(.bottom, 16)
      // A short conversation hangs from the bar rather than sinking to the composer.
      .frame(minHeight: viewport.height, alignment: .top)
      // A tap anywhere in the conversation puts the keyboard away.
      .contentShape(.rect)
      .onTapGesture { composing = false }
    }
    // The mask below fades the words; the system's own edges would draw a line where the bars end.
    .scrollEdgeEffectHidden(true, for: [.top, .bottom])
    .onScrollGeometryChange(for: CGSize.self) { $0.containerSize } action: { _, size in
      viewport = size
    }
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
    // Words fade out as they reach the bars, with no line to mark where they end, and the room's light shows through.
    // The fades follow the bars' own places on screen, which the keyboard moves, rather than safe-area numbers,
    // which iOS versions count differently while the keyboard is up.
    .mask {
      GeometryReader { proxy in
        let frame = proxy.frame(in: .global)
        let top = min(max(0, topEdge - frame.minY), frame.height)
        let bottom = min(max(0, frame.maxY - bottomEdge - 4), frame.height)
        VStack(spacing: 0) {
          Color.clear.frame(height: top)
          LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 24)
          Color.black
          LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 28)
          Color.clear.frame(height: bottom)
        }
      }
      .ignoresSafeArea()
    }
    .safeAreaBar(edge: .bottom, spacing: 0) {
      VStack(spacing: 6) {
        if room.player.state.current != nil {
          NowPlayingBar { nowPlaying = true }
        }
        composer
      }
      .padding(.horizontal, 12)
      .padding(.bottom, 6)
      .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { bottomEdge = $0 }
    }
    .safeAreaBar(edge: .top, spacing: 0) {
      bar.onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { topEdge = $0 }
    }
    .animation(.smooth(duration: 0.5), value: empty)
  }

  // MARK: Parts

  // Conversations and a new one on the left, On Air and the record alone on the right, and over a
  // conversation the record between them.
  private var bar: some View {
    ZStack {
      HStack(spacing: 8) {
        BarButton(symbol: "list.bullet", label: "Conversations") { conversations = true }
        // A room with nothing said is already a new conversation.
        if !empty {
          BarButton(symbol: "square.and.pencil", label: "New conversation") {
            composing = false
            room.newConversation()
          }
          .disabled(!room.online || room.turn != nil)
        }
        Spacer()
        if room.onAir != nil {
          Button { offAir = true } label: {
            HStack(spacing: 6) {
              Circle().fill(Color.text).frame(width: 7, height: 7)
              Text("On Air").font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
          }
          .buttonStyle(.plain)
          .glassEffect(.regular.interactive(), in: .capsule)
          .accessibilityHint(Text("Goes off air"))
        } else if room.canMakeMusic && room.model.configured {
          BarButton(symbol: "dot.radiowaves.left.and.right", label: "Go on air") {
            composing = false
            room.goOnAir()
          }
          .disabled(!room.online || room.turn != nil)
        }
        BarButton(symbol: "arrow.up.left.and.arrow.down.right", label: "The record alone") { openRecord() }
      }
      if !empty { record(width: Self.small) }
    }
    .foregroundStyle(Color.text)
    .padding(.horizontal, 16)
    .padding(.top, empty ? 0 : DotRecord.reach(Self.small))
    .padding(.bottom, 6)
  }

  /// The cover's colours light the room while its song is loaded.
  private var lit: [Tone]? { room.player.state.current == nil ? nil : room.player.palette }

  private var armDown: Bool { room.player.state.playing || room.cued }

  private var empty: Bool { room.messages.isEmpty && room.turn == nil }

  /// The record's width in a quiet room: most of the screen, less while the keyboard is up.
  private var quietWidth: CGFloat {
    min(max(0, viewport.width - 44) * 0.8, viewport.height * 0.5, 340)
  }

  /// The record, wherever it is: a tap plays or pauses what is loaded, or with nothing loaded asks Moondog to pick.
  private func record(width: CGFloat) -> some View {
    let quiet = width > Self.small
    let reach = DotRecord.reach(width)
    return Button {
      composing = false
      room.record()
    } label: {
      DotRecord(playing: room.player.state.playing, armDown: armDown, grooves: lit.map { CoverPalette.grooves($0, dark: scheme == .dark) })
        .frame(width: width)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .matchedGeometryEffect(id: "record", in: space)
    // The record alone grows out of this one, which steps aside meanwhile.
    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { recordFrame = $0 }
    .opacity(immersed ? 0 : 1)
    .disabled(!room.online && room.player.state.current == nil)
    .sensoryFeedback(.impact(weight: .light), trigger: armDown)
    .accessibilityLabel(Text(room.player.state.current == nil ? "Play something" : room.player.state.playing ? "Pause" : "Play"))
    // In a quiet room the disc itself sits in the middle, with as much room below it as the arm takes above.
    .padding(.vertical, quiet ? reach + 14 : 0)
    .frame(maxWidth: quiet ? .infinity : nil)
    .frame(minHeight: quiet ? max(0, viewport.height - 60) : nil)
  }

  @ViewBuilder private var status: some View {
    let text: LocalizedStringKey? = switch room.link {
    case .refused: "Your Mac didn't accept this pairing key."
    case .connecting: "Waiting for your Mac"
    case .online:
      switch room.player.access {
      case .notDetermined: "Allow Apple Music"
      case .denied, .restricted: "Apple Music is off for Moondog"
      case .needsSubscription: "Playing whole songs needs an Apple Music subscription."
      default: nil
      }
    }
    if let text {
      Button {
        if room.link == .online && room.player.access == .notDetermined {
          Task { await room.player.refreshAccess(request: true); room.setActive(true) }
        } else {
          settings = true
        }
      } label: {
        HStack(spacing: 8) {
          if room.link == .connecting { ScratchMark() }
          Text(text)
        }
        .font(.callout)
        .foregroundStyle(Color.text2)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
    }
  }

  private var working: some View {
    HStack(spacing: 8) {
      ScratchMark()
      Text(room.hostLine)
    }
    .font(.callout)
    .foregroundStyle(Color.text2)
    .padding(.top, 4)
    .transition(.opacity)
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 4) {
      TextField("Ask Moondog", text: $draft, axis: .vertical)
        .lineLimit(1...6)
        .focused($composing)
        .font(.body)
        .foregroundStyle(Color.text)
        .padding(.leading, 18)
        .padding(.vertical, 13)
        .submitLabel(.send)
        .onSubmit(send)
      ModelMenu()
        .padding(.bottom, 5)
      Group {
        if room.turn != nil {
          Button(action: room.cancel) {
            Image(systemName: "stop.fill").font(.system(size: 13))
          }
          .accessibilityLabel(Text("Stop"))
        } else {
          Button(action: send) {
            Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
          }
          .accessibilityLabel(Text("Send"))
          .disabled(!room.online || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .buttonStyle(SendButtonStyle())
      .padding(5)
    }
    .glassEffect(.regular, in: .rect(cornerRadius: 24))
  }

  private func send() {
    if room.prompt(draft) {
      draft = ""
      // The reply is what to read next, not the keyboard.
      composing = false
    }
  }
}

private struct BarButton: View {
  var symbol: String
  var label: LocalizedStringKey
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 17))
        .frame(width: 44, height: 44)
    }
    .accessibilityLabel(Text(label))
    .glassEffect(.regular.interactive(), in: .circle)
  }
}

private struct SendButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(Color.paper)
      .frame(width: 36, height: 36)
      .background(Circle().fill(enabled ? Color.text : Color.text3.opacity(0.5)))
      .opacity(configuration.isPressed ? 0.7 : 1)
      .frame(width: 44, height: 44)
      .contentShape(.circle)
  }
}

/// One message: the listener's words in a film of glass on the right, Moondog's as a page.
struct MessageView: View {
  var message: Message

  var body: some View {
    switch message.role {
    case "user":
      Text(message.text)
        .font(.body)
        .foregroundStyle(Color.text)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .glassEffect(.regular, in: UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 5, topTrailingRadius: 16))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .padding(.top, 28)
        .padding(.bottom, 14)
    case "assistant":
      Text(Self.markdown(message.text))
        .font(.reply)
        .lineSpacing(6)
        .foregroundStyle(Color.text)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    default:
      Text(message.text)
        .font(.callout)
        .foregroundStyle(Color.text3)
        .textSelection(.enabled)
        .padding(.top, 8)
    }
  }

  static func markdown(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }
}

/// The shown conversation's model, as the desktop composer shows it: its maker's mark beside the send
/// button, and a menu of the models set up on the Mac, each by its mark and name, with the thinking levels
/// of the one chosen.
private struct ModelMenu: View {
  @Environment(Room.self) private var room

  var body: some View {
    if !room.models.isEmpty || room.model.model != nil {
      Menu {
        Picker("Model", selection: Binding(get: { current?.id ?? "" }, set: { id in
          if let choice = room.models.first(where: { $0.id == id }) { room.choose(choice) }
        })) {
          ForEach(room.models) { choice in
            Label {
              Text(verbatim: label(choice))
            } icon: {
              ModelMarks.image(provider: choice.provider, model: choice.model)
            }
            .tag(choice.id)
          }
        }
        .pickerStyle(.inline)
        if room.model.effortLevels.count > 1 {
          Picker("Thinking", selection: Binding(get: { room.model.effort ?? "default" }, set: { room.choose(effort: $0) })) {
            Text("Default").tag("default")
            ForEach(room.model.effortLevels, id: \.self) { level in
              Text(Self.effortName(level)).tag(level)
            }
          }
          .pickerStyle(.menu)
        }
      } label: {
        ModelMark(provider: room.model.provider ?? "", model: room.model.model ?? "")
          .frame(width: 19, height: 19)
          .foregroundStyle(Color.text2)
          .frame(width: 40, height: 44)
          .contentShape(.rect)
      }
      .accessibilityLabel(Text("Model"))
      .accessibilityValue(Text(verbatim: shown))
      .onAppear { if room.models.isEmpty { room.refreshModels() } }
    }
  }

  private var current: ModelChoice? {
    room.models.first { $0.provider == room.model.provider && $0.model == room.model.model }
  }

  /// The model's own name, with its provider's when two share one, as on the desktop.
  private func label(_ choice: ModelChoice) -> String {
    room.models.filter { $0.name == choice.name }.count > 1 ? "\(choice.name) · \(choice.providerName)" : choice.name
  }

  private var shown: String { current?.name ?? room.model.model ?? "" }

  private static func effortName(_ level: String) -> String {
    switch level {
    case "off": String(localized: "Off")
    case "low": String(localized: "Low")
    case "medium": String(localized: "Medium")
    case "high": String(localized: "High")
    case "xhigh": String(localized: "Extra high")
    case "max": String(localized: "Max")
    default: level
    }
  }
}
