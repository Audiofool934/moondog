import ActivityKit
import SwiftUI
import WidgetKit

@main
struct MoondogActivities: WidgetBundle {
  var body: some Widget {
    OnAirActivity()
  }
}

/// Moondog away from the app: in the Dynamic Island the logo beside what the record is doing, and opened,
/// the song and the host's words; on the Lock Screen the same, in ink on paper as the room is.
struct OnAirActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OnAirAttributes.self) { context in
      LockScreen(state: context.state)
        .activityBackgroundTint(Color.paper)
        .activitySystemActionForegroundColor(Color.text)
    } dynamicIsland: { context in
      let state = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Mark().frame(width: 40, height: 40).padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Status(state: state).font(.system(size: 17)).frame(height: 40).padding(.trailing, 6)
        }
        DynamicIslandExpandedRegion(.center) {
          Song(state: state, secondary: .white.opacity(0.6))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if let line = state.line {
            Text(line)
              .font(.system(.subheadline, design: .serif))
              .foregroundStyle(.white.opacity(0.85))
              .lineLimit(2)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 4)
              .padding(.top, 4)
          }
        }
      } compactLeading: {
        Mark().frame(width: 22, height: 22)
      } compactTrailing: {
        Status(state: state).font(.system(size: 13))
      } minimal: {
        Mark().frame(width: 20, height: 20)
      }
      .keylineTint(.white.opacity(0.5))
    }
  }
}

/// The small logo: the dog with headphones on the rim of its record.
private struct Mark: View {
  var body: some View {
    Image("Mark")
      .renderingMode(.template)
      .resizable()
      .aspectRatio(contentMode: .fit)
      .accessibilityLabel(Text(verbatim: "Moondog"))
  }
}

/// What the record is doing: the host at work, music playing, or the record at rest.
private struct Status: View {
  var state: OnAirAttributes.ContentState

  var body: some View {
    Image(systemName: state.working ? "ellipsis" : state.playing ? "waveform" : "pause.fill")
      .accessibilityHidden(true)
  }
}

private struct Song: View {
  var state: OnAirAttributes.ContentState
  var secondary: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(state.title ?? "Moondog")
        .font(.subheadline.weight(.medium))
      if let artist = state.artist {
        Text(artist)
          .font(.footnote)
          .foregroundStyle(secondary)
      }
    }
    .lineLimit(1)
  }
}

private struct LockScreen: View {
  var state: OnAirAttributes.ContentState

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Mark()
        .frame(width: 40, height: 40)
        .foregroundStyle(Color.text)
      VStack(alignment: .leading, spacing: 6) {
        Song(state: state, secondary: Color.text2)
          .foregroundStyle(Color.text)
        if let line = state.line {
          Text(line)
            .font(.system(.subheadline, design: .serif))
            .foregroundStyle(Color.text)
            .lineLimit(3)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Status(state: state)
        .font(.system(size: 15))
        .foregroundStyle(Color.text2)
        .frame(height: 20)
    }
    .padding(16)
  }
}
