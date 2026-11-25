import SwiftUI
import UIKit

/// The record alone, as on the desktop: the screen holds only the record, drawn large in the same dots,
/// over the cover's light, with the song beneath it. The record plays and pauses as it does in the room;
/// a tap anywhere else, or a swipe down, brings the conversation back. The screen stays on meanwhile,
/// so the phone can sit by the speaker like a turntable.
struct ImmersiveView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let state = room.player.state
    let lit = state.current == nil ? nil : room.player.palette
    GeometryReader { proxy in
      // As wide as leaves the arm clear of the screen's edge through its whole swing.
      let disc = min(proxy.size.width * 0.72, proxy.size.height * 0.56, 560)
      VStack(spacing: 0) {
        Button { room.record() } label: {
          DotRecord(playing: state.playing, armDown: state.playing || room.cued,
                    grooves: lit.map { CoverPalette.grooves($0, dark: scheme == .dark) })
            .frame(width: disc)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(!room.online && state.current == nil)
        .sensoryFeedback(.impact(weight: .light), trigger: state.playing)
        .accessibilityLabel(Text(state.current == nil ? "Play something" : state.playing ? "Pause" : "Play"))
        .padding(.top, DotRecord.reach(disc))

        // The song, quietly, at the same height whether or not one is loaded, so the record never moves.
        VStack(spacing: 3) {
          Text(state.current?.title ?? " ")
            .font(.title3)
            .foregroundStyle(Color.text)
          Text(state.current?.artist ?? " ")
            .font(.subheadline)
            .foregroundStyle(Color.text2)
        }
        .lineLimit(1)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
        .padding(.top, 40)
        .animation(.easeInOut(duration: 0.6), value: state.current)
      }
      // The disc, not the disc and the words together, sits a little above the middle of the screen.
      .frame(width: proxy.size.width, height: proxy.size.height)
      .offset(y: -proxy.size.height * 0.03)
    }
    .contentShape(.rect)
    .onTapGesture { dismiss() }
    .background {
      ZStack {
        Color.paper
        Mood(palette: lit, playing: state.playing)
      }
      .ignoresSafeArea()
    }
    .statusBarHidden()
    .persistentSystemOverlays(.hidden)
    .accessibilityAction(.escape) { dismiss() }
    .accessibilityAction(named: Text("Back to the conversation")) { dismiss() }
    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
    .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
  }
}
