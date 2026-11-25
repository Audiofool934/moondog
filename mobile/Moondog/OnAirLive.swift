@preconcurrency import ActivityKit
import Foundation
import Observation

/// Keeps Moondog's Live Activity in step with the room. It starts when a song is loaded or the host takes
/// a request, follows every change, and ends when the room has nothing on. A listener who swipes it away
/// is not shown another until the room has been quiet.
final class OnAirLive {
  private var activity: Activity<OnAirAttributes>?
  private var shown: OnAirAttributes.ContentState?
  private var declined = false

  init() {
    // A run that ended without tidying up leaves its activity behind; this run starts its own.
    for old in Activity<OnAirAttributes>.activities {
      Task { await old.end(nil, dismissalPolicy: .immediate) }
    }
  }

  func follow(_ room: Room) {
    let state = withObservationTracking { room.liveState } onChange: { [weak self, weak room] in
      Task { @MainActor in
        guard let self, let room else { return }
        self.follow(room)
      }
    }
    show(state)
  }

  private func show(_ state: OnAirAttributes.ContentState?) {
    guard state != shown else { return }
    shown = state
    guard let state else {
      declined = false
      if let activity {
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
      }
      return
    }
    let content = ActivityContent(state: state, staleDate: nil)
    if let activity {
      if activity.activityState == .active || activity.activityState == .stale {
        Task { await activity.update(content) }
        return
      }
      self.activity = nil
      declined = true
    }
    // iOS starts a Live Activity only while the app is in front; a change made in the background waits
    // for the next one.
    guard !declined, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    activity = try? Activity.request(attributes: OnAirAttributes(), content: content)
  }
}
