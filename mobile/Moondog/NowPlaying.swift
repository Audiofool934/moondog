import MusicKit
import SwiftUI

/// The album sleeve: the cover is the one picture of what plays, nearly square, resting on the paper.
struct Sleeve: View {
  var artwork: Artwork?
  /// The catalog's picture, for a song played as a preview or listed in the library.
  var cover: URL? = nil
  var size: CGFloat
  /// Its corners; a sleeve inside a rounded bar takes the bar's radius less its inset, so the curves stay parallel.
  var corner: CGFloat?

  var body: some View {
    Group {
      if let artwork {
        ArtworkImage(artwork, width: size, height: size)
      } else if let cover {
        AsyncImage(url: cover) { image in
          image.resizable().scaledToFill()
        } placeholder: {
          Color.wash
        }
      } else {
        // No cover yet, as in Simulator: the record stands in for the sleeve.
        Color.wash.overlay {
          RecordMark(playing: false, armDown: false, ink: .text3)
            .padding(size * 0.22)
            .opacity(0.5)
        }
      }
    }
    .frame(width: size, height: size)
    .clipShape(.rect(cornerRadius: corner ?? (size > 100 ? 8 : 4)))
    .shadow(color: .black.opacity(size > 100 ? 0.22 : 0.1), radius: size > 100 ? 18 : 3, y: size > 100 ? 12 : 1)
    .accessibilityHidden(true)
  }
}

/// The song and its two most used controls, in reach above the composer.
struct NowPlayingBar: View {
  @Environment(Room.self) private var room
  var open: () -> Void
  // The cover sits the same distance from the bar's top, bottom and left edges.
  private static let inset: CGFloat = 8
  private static let radius: CGFloat = 22

  var body: some View {
    let state = room.player.state
    HStack(spacing: 12) {
      Button(action: open) {
        HStack(spacing: 12) {
          Sleeve(artwork: room.player.artwork, cover: room.player.coverURL, size: 44, corner: Self.radius - Self.inset)
          VStack(alignment: .leading, spacing: 1) {
            Text(state.current?.title ?? "")
              .font(.subheadline.weight(.medium))
              .foregroundStyle(Color.text)
            Text(state.current?.artist ?? "")
              .font(.footnote)
              .foregroundStyle(Color.text2)
          }
          .lineLimit(1)
          Spacer(minLength: 0)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityHint(Text("Shows the song and what comes next"))
      PlayerButton(symbol: state.playing ? "pause.fill" : "play.fill", label: state.playing ? "Pause" : "Play") {
        room.control(state.playing ? "pause" : "resume")
      }
      PlayerButton(symbol: "forward.fill", label: "Next song") { room.control("next") }
        .disabled(state.upNext.isEmpty)
    }
    .padding(.leading, Self.inset)
    .padding(.trailing, 4)
    .padding(.vertical, Self.inset)
    .glassEffect(.regular, in: .rect(cornerRadius: Self.radius))
  }
}

struct PlayerButton: View {
  var symbol: String
  var label: LocalizedStringKey
  var size: CGFloat = 17
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: size))
        .contentTransition(.symbolEffect(.replace))
        .frame(width: max(44, size * 2.2), height: max(44, size * 2.2))
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.text)
    .accessibilityLabel(Text(label))
  }
}

/// The song in full: the sleeve, where the song is, the controls, and what comes next.
struct NowPlayingView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let state = room.player.state
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        GeometryReader { proxy in
          Sleeve(artwork: room.player.artwork, cover: room.player.coverURL, size: proxy.size.width)
        }
        .aspectRatio(1, contentMode: .fit)
        .padding(.top, 36)
        .padding(.bottom, 28)

        Text(state.current?.title ?? "")
          .font(.title)
          .foregroundStyle(Color.text)
        Text(state.current?.artist ?? "")
          .font(.body)
          .foregroundStyle(Color.text2)
          .padding(.top, 2)

        Progress(player: room.player, playing: state.playing)
          .padding(.top, 22)

        HStack {
          Spacer()
          PlayerButton(symbol: "backward.fill", label: "Previous song", size: 24) { room.control("previous") }
          Spacer()
          PlayerButton(symbol: state.playing ? "pause.fill" : "play.fill", label: state.playing ? "Pause" : "Play", size: 34) {
            room.control(state.playing ? "pause" : "resume")
          }
          Spacer()
          PlayerButton(symbol: "forward.fill", label: "Next song", size: 24) { room.control("next") }
            .disabled(state.upNext.isEmpty)
          Spacer()
        }
        .padding(.vertical, 12)

        if !state.upNext.isEmpty {
          Text("Up next")
            .font(.footnote)
            .foregroundStyle(Color.text3)
            .padding(.top, 28)
            .padding(.bottom, 6)
          ForEach(state.upNext, id: \.position) { position, track in
            // A tap plays it now; a long press takes it out, as on the desktop.
            Button { room.player.jump(to: position) } label: {
              HStack(spacing: 6) {
                if track.made { Image(systemName: "waveform").foregroundStyle(Color.text3) }
                Text(track.title).foregroundStyle(Color.text)
                Text(track.artist).foregroundStyle(Color.text2)
                Spacer(minLength: 0)
              }
              .font(.subheadline)
              .lineLimit(1)
              .padding(.vertical, 7)
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .contextMenu {
              Button(role: .destructive) { room.player.remove(at: position) } label: {
                Label("Take out of Up next", systemImage: "minus.circle")
              }
            }
          }
        }
      }
      .padding(.horizontal, 32)
      .padding(.bottom, 32)
    }
    .background {
      ZStack {
        Color.paper
        Mood(palette: room.player.palette, playing: state.playing)
      }
      .ignoresSafeArea()
    }
    .presentationDragIndicator(.visible)
    .presentationBackground(Color.paper)
    .onChange(of: state.current == nil) { _, gone in if gone { dismiss() } }
  }
}

/// Where the song is: a hairline that fills, with the time on either side.
private struct Progress: View {
  var player: Player
  var playing: Bool

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.5)) { _ in
      let (elapsed, duration) = player.position()
      VStack(spacing: 6) {
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(Color.wash)
            Capsule().fill(Color.text2)
              .frame(width: proxy.size.width * min(1, duration.map { elapsed / max($0, 1) } ?? 0))
          }
        }
        .frame(height: 3)
        HStack {
          Text(Self.time(elapsed))
          Spacer()
          if let duration { Text("-" + Self.time(max(0, duration - elapsed))) }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(Color.text3)
      }
    }
    .accessibilityElement(children: .combine)
  }

  static func time(_ seconds: TimeInterval) -> String {
    Duration.seconds(seconds.rounded(.down)).formatted(.time(pattern: .minuteSecond))
  }
}
