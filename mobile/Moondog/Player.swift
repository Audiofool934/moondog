import Combine
import Foundation
import UIKit
@preconcurrency import MusicKit

struct Track: Codable, Equatable, Hashable {
  var id: String?
  var title: String
  var artist: String
}

/// What the phone plays, in the shape the Mac host reads (mobile/host/room.mjs).
struct PlayerState: Equatable {
  var status = "stopped"
  var queueID = ""
  var index: Int?
  var tracks: [Track] = []

  var current: Track? {
    guard let index, tracks.indices.contains(index), status != "stopped" else { return nil }
    return tracks[index]
  }
  var playing: Bool { status == "playing" }
  var upNext: [Track] { index.map { Array(tracks.dropFirst($0 + 1)) } ?? [] }

  var report: [String: Any] {
    var value: [String: Any] = [
      "status": status, "queueID": queueID,
      "tracks": tracks.map { track in
        var entry = ["title": track.title, "artist": track.artist]
        entry["id"] = track.id
        return entry
      },
    ]
    value["index"] = index
    return value
  }
}

enum MusicAccess: Equatable {
  case checking, notDetermined, denied, restricted, needsSubscription, ready
}

struct PlayerError: LocalizedError {
  var errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

/// The phone's own Apple Music player. The Mac's agent asks it to play; it answers with what is
/// actually playing, and reports every change the listener makes on the phone or the lock screen.
@Observable
final class Player {
  private(set) var state = PlayerState()
  private(set) var access = MusicAccess.checking
  private(set) var storefront: String?
  /// Why Apple Music can't be reached from this app, when it can't: most often the MusicKit service missing
  /// on the App ID, which leaves the app without the token Apple Music's catalog asks for.
  private(set) var problem: String?
  private(set) var artwork: Artwork?
  /// The playing cover's colours, for the grooves and the room's light; nil until read.
  private(set) var palette: [Tone]?
  @ObservationIgnored private var paletteFor: URL?
  @ObservationIgnored private var palettes: [URL: [Tone]] = [:]
  @ObservationIgnored var changed: ((PlayerState) -> Void)?

  /// Simulator has no Apple Music playback, so there the queue is acted out without sound.
  static let simulated: Bool = {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }()

  private let player = ApplicationMusicPlayer.shared
  @ObservationIgnored private var watches: [AnyCancellable] = []
  @ObservationIgnored private var started: Date?
  @ObservationIgnored private var elapsedBefore: TimeInterval = 0

  func start() {
    guard !Self.simulated else { return }
    watch()
    publish()
  }

  private func watch() {
    watches = [
      player.state.objectWillChange.sink { [weak self] _ in Task { self?.publish() } },
      player.queue.objectWillChange.sink { [weak self] _ in Task { self?.publish() } },
    ]
  }

  func refreshAccess(request: Bool = false) async {
    if Self.simulated {
      access = .ready
      storefront = "us"
      return
    }
    let status = request ? await MusicAuthorization.request() : MusicAuthorization.currentStatus
    switch status {
    case .authorized:
      let subscription = try? await MusicSubscription.current
      access = subscription?.canPlayCatalogContent == true ? .ready : .needsSubscription
      do {
        storefront = try await MusicDataRequest.currentCountryCode
        problem = nil
      } catch {
        storefront = nil
        problem = error.localizedDescription
      }
    case .notDetermined: access = .notDetermined
    case .restricted: access = .restricted
    default: access = .denied
    }
  }

  func play(ids: [String], tracks: [Track], queueID: String) async throws -> PlayerState {
    if Self.simulated {
      guard !tracks.isEmpty || !ids.isEmpty else { throw PlayerError(String(localized: "Nothing to play.")) }
      let named = tracks.isEmpty ? ids.map { Track(id: $0, title: $0, artist: "") } : tracks
      state = PlayerState(status: "playing", queueID: queueID, index: 0, tracks: named)
      resetClock(running: true)
      simulatePalette()
      return state
    }
    guard MusicAuthorization.currentStatus == .authorized else {
      throw PlayerError(String(localized: "Allow Apple Music on this iPhone first."))
    }
    guard try await MusicSubscription.current.canPlayCatalogContent else {
      throw PlayerError(String(localized: "Playing whole songs needs an Apple Music subscription."))
    }
    let request = MusicCatalogResourceRequest<Song>(matching: \.id, memberOf: ids.map { MusicItemID($0) })
    let found = try await request.response().items
    let songs = ids.compactMap { id in found.first { $0.id.rawValue == id } }
    guard !songs.isEmpty, songs.count == ids.count else {
      throw PlayerError(String(localized: "A song isn't available in this Apple Music region."))
    }
    state.queueID = queueID
    player.queue = ApplicationMusicPlayer.Queue(for: songs)
    watch()
    do { try await player.play() } catch {
      publish()
      throw error
    }
    publish()
    return state
  }

  func control(_ action: String) async throws -> PlayerState {
    if Self.simulated {
      guard let index = state.index else { throw PlayerError(String(localized: "Nothing is playing.")) }
      switch action {
      case "pause": state.status = "paused"; resetClock(running: false, keep: true)
      case "resume": state.status = "playing"; resetClock(running: true, keep: true)
      case "next" where index + 1 < state.tracks.count: state.index = index + 1; resetClock(running: state.playing)
      case "previous": state.index = max(0, index - 1); resetClock(running: state.playing)
      case "next": break
      default: throw PlayerError("Unknown player control.")
      }
      simulatePalette()
      changed?(state)
      return state
    }
    switch action {
    case "pause": player.pause()
    case "resume": try await player.play()
    case "next": try await player.skipToNextEntry()
    case "previous":
      if player.playbackTime > 3 { player.restartCurrentEntry() } else { try await player.skipToPreviousEntry() }
    default: throw PlayerError("Unknown player control.")
    }
    publish()
    return state
  }

  /// Where the current song is, in seconds, and how long it runs, when known.
  func position() -> (elapsed: TimeInterval, duration: TimeInterval?) {
    if Self.simulated {
      return (elapsedBefore + (started.map { Date.now.timeIntervalSince($0) } ?? 0), 214)
    }
    var duration: TimeInterval?
    if case .song(let song)? = player.queue.currentEntry?.item { duration = song.duration }
    return (player.playbackTime, duration)
  }

  private func resetClock(running: Bool, keep: Bool = false) {
    if keep, let started { elapsedBefore += Date.now.timeIntervalSince(started) }
    if !keep { elapsedBefore = 0 }
    started = running ? .now : nil
  }

  /// Reads the cover at the size the palette needs, once per cover.
  private func readPalette() {
    guard let url = artwork?.url(width: CoverPalette.size, height: CoverPalette.size) else {
      if state.current == nil { palette = nil }
      return
    }
    guard url != paletteFor else { return }
    paletteFor = url
    if let known = palettes[url] {
      palette = known
      return
    }
    Task {
      guard let (data, _) = try? await URLSession.shared.data(from: url),
            let image = UIImage(data: data)?.cgImage, let tones = CoverPalette.of(image)
      else { return }
      if palettes.count > 40 { palettes.removeAll() }
      palettes[url] = tones
      if paletteFor == url { palette = tones }
    }
  }

  /// Simulator has no covers, so each made-up song gets steady colours of its own from its title.
  private func simulatePalette() {
    guard let title = state.current?.title else { palette = nil; return }
    let hue = Double(title.unicodeScalars.reduce(0) { ($0 * 31 + Int($1.value)) % 360 })
    palette = [0, 70, 150].map { Tone(h: (hue + $0).truncatingRemainder(dividingBy: 360), s: 0.6, l: 0.5) }
  }

  /// Reads the system player after each change and passes the result on when it differs.
  private func publish() {
    let next = snapshot()
    artwork = player.queue.currentEntry?.artwork
    readPalette()
    guard next != state else { return }
    state = next
    changed?(next)
  }

  private func snapshot() -> PlayerState {
    let queueID = state.queueID
    guard !queueID.isEmpty, let entry = player.queue.currentEntry else {
      return PlayerState(queueID: queueID)
    }
    let entries = Array(player.queue.entries)
    let tracks = entries.map { element in
      var id: String?
      if case .song(let song)? = element.item { id = song.id.rawValue }
      return Track(id: id, title: element.title, artist: element.subtitle ?? "")
    }
    guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return PlayerState(queueID: queueID) }
    let status = switch player.state.playbackStatus {
    case .playing, .seekingForward, .seekingBackward: "playing"
    case .paused, .interrupted: "paused"
    default: "stopped"
    }
    return PlayerState(status: status, queueID: queueID, index: index, tracks: tracks)
  }
}
