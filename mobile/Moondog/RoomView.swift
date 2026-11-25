import MusicKit
import SwiftUI

/// The listening room: the record above the conversation, the song and the composer at the bottom.
struct RoomView: View {
  @Environment(Room.self) private var room
  @State private var draft = ""
  @State private var settings = false
  @State private var nowPlaying = false
  @State private var line = HostLine.any()
  @State private var recordGone = false
  @State private var viewport: CGFloat = 0
  @FocusState private var composing: Bool

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
      .frame(minHeight: viewport, alignment: .top)
    }
    .onScrollGeometryChange(for: CGFloat.self) { $0.containerSize.height } action: { _, height in
      viewport = height
    }
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
    .background(Color.paper)
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
    .onChange(of: room.turn == nil) { _, idle in if !idle { line = HostLine.any() } }
  }

  // MARK: Parts

  private var bar: some View {
    HStack {
      Spacer()
      Button { settings = true } label: {
        Image(systemName: "gearshape")
          .font(.system(size: 17))
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel(Text("Settings"))
      .glassEffect(.regular.interactive(), in: .circle)
    }
    .overlay {
      // The record folds into the bar once it scrolls out of view.
      RecordMark(playing: room.player.state.playing, armDown: armDown)
        .frame(width: 28, height: 28)
        .opacity(recordGone ? 1 : 0)
        .animation(.easeOut(duration: 0.2), value: recordGone)
        .accessibilityHidden(true)
    }
    .foregroundStyle(Color.text)
    .padding(.horizontal, 16)
    .padding(.bottom, 4)
    .background {
      // Words fade out under the bar, with no line to mark where it ends.
      LinearGradient(stops: [.init(color: .paper, location: 0.7), .init(color: .paper.opacity(0), location: 1)], startPoint: .top, endPoint: .bottom)
        .padding(.bottom, -36)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
    }
  }

  private var armDown: Bool { room.player.state.playing || room.cued }

  private var empty: Bool { room.messages.isEmpty && room.turn == nil }

  private var record: some View {
    Button { room.record() } label: {
      RecordMark(playing: room.player.state.playing, armDown: armDown)
        .frame(width: empty ? 220 : 150)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .disabled(!room.online && room.player.state.current == nil)
    .sensoryFeedback(.impact(weight: .light), trigger: armDown)
    .accessibilityLabel(Text(room.player.state.current == nil ? "Play something" : room.player.state.playing ? "Pause" : "Play"))
    .frame(maxWidth: .infinity)
    .frame(height: empty ? max(260, viewport - 60) : 150)
    .padding(.top, empty ? 0 : 12)
    .padding(.bottom, empty ? 0 : 28)
    .onScrollVisibilityChange(threshold: 0.2) { visible in recordGone = !visible }
    .visualEffect { content, proxy in
      // Scrolling into the conversation shrinks the record to half its size, never less.
      let top = proxy.frame(in: .scrollView).minY
      let scale = max(0.5, min(1, 1 + top / max(proxy.size.height, 1)))
      return content.scaleEffect(scale, anchor: .bottom)
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
      Text(line)
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
