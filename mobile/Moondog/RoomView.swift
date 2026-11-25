import MusicKit
import SwiftUI

/// The listening room: the record above the conversation, the song and the composer at the bottom.
struct RoomView: View {
  @Environment(Room.self) private var room
  @State private var draft = ""
  @State private var settings = false
  @State private var nowPlaying = false
  @State private var immersed = false
  @State private var recordGone = false
  @State private var viewport = CGSize.zero
  @State private var position = ScrollPosition(edge: .bottom)
  @Namespace private var space
  @FocusState private var composing: Bool
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        record
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
      .padding(.bottom, 16)
      // A short conversation hangs from the record rather than sinking to the composer.
      .frame(minHeight: viewport.height, alignment: .top)
    }
    .scrollPosition($position)
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
    .sheet(isPresented: $settings) { SettingsView() }
    .sheet(isPresented: $nowPlaying) { NowPlayingView() }
    .fullScreenCover(isPresented: $immersed) {
      ImmersiveView()
        .navigationTransition(.zoom(sourceID: "record", in: space))
    }
  }

  // MARK: Parts

  // Settings on the left, clear of the arm; the record alone on the right.
  private var bar: some View {
    HStack {
      BarButton(symbol: "gearshape", label: "Settings") { settings = true }
      Spacer()
      BarButton(symbol: "arrow.up.left.and.arrow.down.right", label: "The record alone") { immersed = true }
    }
    .overlay {
      // The record folds into the bar, under the camera, once it scrolls out of view; a tap brings it back.
      Button {
        withAnimation(.smooth(duration: 0.5)) { position.scrollTo(edge: .top) }
      } label: {
        RecordMark(playing: room.player.state.playing, armDown: armDown)
          .frame(width: 30, height: 30)
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .opacity(recordGone ? 1 : 0)
      .scaleEffect(recordGone ? 1 : 0.6)
      .animation(.smooth(duration: 0.3), value: recordGone)
      .allowsHitTesting(recordGone)
      .accessibilityHidden(!recordGone)
      .accessibilityLabel(Text("Back to the record"))
    }
    .foregroundStyle(Color.text)
    .padding(.horizontal, 16)
    .padding(.bottom, 4)
  }

  /// The cover's colours light the room while its song is loaded.
  private var lit: [Tone]? { room.player.state.current == nil ? nil : room.player.palette }

  private var armDown: Bool { room.player.state.playing || room.cued }

  private var empty: Bool { room.messages.isEmpty && room.turn == nil }

  /// The disc's width: most of the screen while the room is quiet, a little over half once there are words.
  private var disc: CGFloat {
    let room = max(0, viewport.width - 44)
    return empty ? min(room * 0.8, 340) : min(room * 0.66, 260)
  }

  private var record: some View {
    let disc = disc
    let reach = disc * DotRecord.reach.top
    return Button { room.record() } label: {
      DotRecord(playing: room.player.state.playing, armDown: armDown, grooves: lit.map { CoverPalette.grooves($0, dark: scheme == .dark) })
        .frame(width: disc)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .matchedTransitionSource(id: "record", in: space)
    .disabled(!room.online && room.player.state.current == nil)
    .sensoryFeedback(.impact(weight: .light), trigger: armDown)
    .accessibilityLabel(Text(room.player.state.current == nil ? "Play something" : room.player.state.playing ? "Pause" : "Play"))
    // Room above for the arm, clear of the bar's fade; in a quiet room as much below, so the disc itself sits in the middle.
    .padding(.top, reach + 14)
    .padding(.bottom, empty ? reach + 14 : 24)
    .frame(maxWidth: .infinity)
    .frame(minHeight: empty ? max(0, viewport.height - 60) : 0)
    .onScrollVisibilityChange(threshold: 0.16) { visible in recordGone = !visible }
    .visualEffect { content, proxy in
      // Scrolled up, the record stays under the bar and shrinks just ahead of the words, rising into the
      // bar's center, where the mark takes over. The scroll view's space starts below the bar.
      let frame = proxy.frame(in: .scrollView)
      let scrolled = max(0, -frame.minY)
      let under = min(1, scrolled / max(frame.height, 1))
      return content
        .scaleEffect(max(0.001, 1 - under), anchor: .top)
        .offset(y: scrolled - under * 44)
        .opacity(min(1, max(0, (0.86 - under) / 0.16)))
    }
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
