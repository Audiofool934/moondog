import MusicKit
import SwiftUI

/// The listening room. Before anything is said the record stands alone in the middle; once there are
/// words, it moves into the bar, small and still turning, and the conversation has the room.
struct RoomView: View {
  @Environment(Room.self) private var room
  @State private var draft = ""
  @State private var settings = false
  @State private var nowPlaying = false
  @State private var immersed = false
  @State private var viewport = CGSize.zero
  @Namespace private var space
  @FocusState private var composing: Bool
  @Environment(\.colorScheme) private var scheme

  /// The record's width in the bar over a conversation.
  private static let small: CGFloat = 64

  var body: some View {
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
    .mask {
      GeometryReader { proxy in
        VStack(spacing: 0) {
          LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
            .frame(height: 24)
            .padding(.top, max(0, proxy.safeAreaInsets.top - 10))
          Color.black
          LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
            .frame(height: 28)
            .padding(.bottom, max(0, proxy.safeAreaInsets.bottom - 24))
        }
        .ignoresSafeArea()
      }
    }
    .background {
      ZStack {
        Color.paper
        Mood(palette: lit, playing: room.player.state.playing)
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
    }
    .safeAreaBar(edge: .top, spacing: 0) { bar }
    .animation(.smooth(duration: 0.5), value: empty)
    .sheet(isPresented: $settings) { SettingsView() }
    .sheet(isPresented: $nowPlaying) { NowPlayingView() }
    .fullScreenCover(isPresented: $immersed) {
      ImmersiveView()
        .navigationTransition(.zoom(sourceID: "record", in: space))
    }
  }

  // MARK: Parts

  // Settings on the left, the record alone on the right, and over a conversation the record between them.
  private var bar: some View {
    ZStack {
      HStack {
        BarButton(symbol: "gearshape", label: "Settings") { settings = true }
        Spacer()
        BarButton(symbol: "arrow.up.left.and.arrow.down.right", label: "The record alone") { immersed = true }
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
    .matchedTransitionSource(id: "record", in: space)
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
