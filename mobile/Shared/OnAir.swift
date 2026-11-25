import ActivityKit
import Foundation

/// Moondog on the air, for the Lock Screen and the Dynamic Island while it has the room: the song on
/// the record and what the host is doing or last said. The app keeps it up to date; the widget draws it.
nonisolated struct OnAirAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var title: String?
    var artist: String?
    var playing: Bool
    /// The host is working on a request.
    var working: Bool
    /// The host's words: its line while it works, otherwise the start of its last reply.
    var line: String?
  }
}
