import SwiftUI
import UIKit

/// The record alone, as on the desktop. It opens in place: the record grows out of where it sat in the
/// room to fill the screen over the cover's light, while the conversation fades behind it, and the song
/// rises beneath it. A swipe down carries it back under the finger, and letting go far enough, or a tap
/// beside the record, sends it home; a tap on the record plays or pauses. The screen stays on meanwhile,
/// so the phone can sit by the speaker like a turntable.
struct ImmersiveLayer: View {
  /// 0 with the record in its place in the room, 1 with it filling the screen.
  @Binding var openness: CGFloat
  /// Where the record sits in the room, on screen.
  var from: CGRect
  var close: () -> Void
  @Environment(Room.self) private var room
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let state = room.player.state
    let lit = state.current == nil ? nil : room.player.palette
    GeometryReader { proxy in
      let size = proxy.size
      // As wide as leaves the arm clear of the screen's edge through its whole swing.
      let disc = min(size.width * 0.72, size.height * 0.56, 560)
      let target = CGRect(x: (size.width - disc) / 2, y: size.height * 0.42 - disc / 2, width: disc, height: disc)
      let source = from.width > 0 ? from : target.insetBy(dx: disc * 0.4, dy: disc * 0.4)
      let shown = Self.mix(source, target, openness)
      ZStack {
        // A tap beside the record goes back to the room.
        Color.clear
          .contentShape(.rect)
          .onTapGesture(perform: close)

        // A tap, not a button, so a swipe that starts on the record carries it rather than pausing it.
        DotRecord(playing: state.playing, armDown: state.playing || room.cued,
                  grooves: lit.map { CoverPalette.grooves($0, dark: scheme == .dark) })
          .frame(width: disc)
          .contentShape(.circle)
          .onTapGesture { if room.online || state.current != nil { room.record() } }
          .sensoryFeedback(.impact(weight: .light), trigger: state.playing)
          .accessibilityElement()
          .accessibilityAddTraits(.isButton)
          .accessibilityLabel(Text(state.current == nil ? "Play something" : state.playing ? "Pause" : "Play"))
          .accessibilityAction { room.record() }
        .scaleEffect(shown.width / disc)
        .position(x: shown.midX, y: shown.midY)

        // The song, quietly, rising into place as the record arrives.
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
        .frame(width: size.width)
        .position(x: size.width / 2, y: target.maxY + 64 + (1 - openness) * 40)
        .opacity(Double(max(0, openness * 1.6 - 0.6)))
        .animation(.easeInOut(duration: 0.6), value: state.current)
      }
      .gesture(
        DragGesture(minimumDistance: 8)
          .onChanged { value in
            openness = 1 - min(1, max(0, value.translation.height) / (size.height * 0.7))
          }
          .onEnded { value in
            if value.translation.height > 110 || value.predictedEndTranslation.height > 320 {
              close()
            } else {
              withAnimation(.spring(duration: 0.45, bounce: 0.2)) { openness = 1 }
            }
          }
      )
    }
    .ignoresSafeArea()
    .accessibilityAddTraits(.isModal)
    .accessibilityAction(.escape, close)
    .accessibilityAction(named: Text("Back to the conversation"), close)
    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
    .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
  }

  private static func mix(_ a: CGRect, _ b: CGRect, _ t: CGFloat) -> CGRect {
    CGRect(x: a.minX + (b.minX - a.minX) * t, y: a.minY + (b.minY - a.minY) * t,
           width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t)
  }
}
