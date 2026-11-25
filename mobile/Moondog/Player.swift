import AVFoundation
import Combine
import Foundation
import MediaPlayer
import UIKit
@preconcurrency import MusicKit

/// One song or made track in the queue, as the room on the Mac sent it (app/preview-player.mjs).
struct Track: Equatable, Hashable {
  var title: String
  var artist: String
  /// The song's page in Apple Music; its `i` parameter is the catalog id MusicKit plays.
  var catalogURL: URL?
  /// A 30-second preview, played when whole songs can't be.
  var previewURL: URL?
  var artworkURL: URL?
  /// A track Moondog made on the Mac, by its id there.
  var madeID: String?
  var seconds: Double?
  /// Taken out of Up next; it keeps its place so the Mac's positions still match, and playing passes over it.
  var removed = false

  var made: Bool { madeID != nil }
  var catalogID: String? {
    guard let catalogURL else { return nil }
    let id = URLComponents(url: catalogURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "i" }?.value
    return id.flatMap { $0.allSatisfy(\.isNumber) && !$0.isEmpty ? $0 : nil }
  }
}

/// What the phone plays now, for the room's views.
struct PlayerState: Equatable {
  var status = "stopped"
  var index: Int?
  var tracks: [Track] = []

  var current: Track? {
    guard let index, tracks.indices.contains(index), status != "stopped" else { return nil }
    return tracks[index]
  }
  var playing: Bool { status == "playing" }
  /// What still plays after the current song, each with its place in the queue.
  var upNext: [(position: Int, track: Track)] {
    guard let index else { return [] }
    return tracks.enumerated().dropFirst(index + 1).filter { !$0.element.removed }.map { ($0.offset, $0.element) }
  }
}

enum MusicAccess: Equatable {
  case checking, notDetermined, denied, restricted, needsSubscription, ready
}

struct PlayerError: LocalizedError {
  var errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

/// The phone's player, the window's player on the desktop in Swift (app/renderer/previews.mjs). The room
/// on the Mac sends it a queue; it plays each run of Apple Music songs whole through MusicKit, and each
/// track Moondog made, or a preview where whole songs can't play, through its own audio player, fetched
/// from the Mac. Every change goes back to the Mac as the window's events, so the agent and On Air know
/// what plays.
@Observable
final class Player {
  private(set) var state = PlayerState()
  private(set) var access = MusicAccess.checking
  private(set) var storefront: String?
  /// Why Apple Music can't be reached from this app, when it can't: most often the MusicKit service missing
  /// on the App ID, which leaves the app without the token Apple Music's catalog asks for.
  private(set) var problem: String?
  /// The cover: MusicKit's while it plays a song whole, otherwise the catalog's picture by its address.
  private(set) var artwork: Artwork?
  private(set) var coverURL: URL?
  /// The playing cover's colours, for the grooves and the room's light; nil until read.
  private(set) var palette: [Tone]?

  /// Sends one message to the room on the Mac.
  @ObservationIgnored var send: (([String: Any]) -> Void)?
  /// Where made tracks come from: the Mac's address and the pairing key.
  @ObservationIgnored var media: (base: URL, key: String)?
  /// Whether the app is on screen; iOS may refuse to start Apple Music from the background.
  @ObservationIgnored var active = true

  /// Simulator has no Apple Music playback, so there songs are acted out without sound.
  static let simulated: Bool = {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }()

  private enum Mode { case none, full, audio }

  @ObservationIgnored private var queue: [Track] = []
  @ObservationIgnored private var index = 0
  @ObservationIgnored private var queueID: Int?
  @ObservationIgnored private var mode = Mode.none
  /// The songs MusicKit plays now: the queue positions of its entries, in order.
  @ObservationIgnored private var run: [Int] = []
  @ObservationIgnored private var runStarted = false
  @ObservationIgnored private var reported = ""
  /// A run that couldn't start because the app was away, started when it is back.
  @ObservationIgnored private var waiting: Int?
  @ObservationIgnored private var failures = 0
  @ObservationIgnored private var starting: Task<Void, Never>?

  private let music = ApplicationMusicPlayer.shared
  private let audio = AVPlayer()
  @ObservationIgnored private var watches: [AnyCancellable] = []
  @ObservationIgnored private var paletteFor: URL?
  @ObservationIgnored private var palettes: [URL: [Tone]] = [:]
  /// Simulator's clock for an acted-out song.
  @ObservationIgnored private var started: Date?
  @ObservationIgnored private var elapsedBefore: TimeInterval = 0

  func start() {
    audio.automaticallyWaitsToMinimizeStalling = true
    NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
      let item = (note.object as? AVPlayerItem).map(ObjectIdentifier.init)
      MainActor.assumeIsolated { self?.audioEnded(item) }
    }
    NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
      let item = (note.object as? AVPlayerItem).map(ObjectIdentifier.init)
      MainActor.assumeIsolated { self?.audioFailed(item) }
    }
    watches = [
      music.state.objectWillChange.sink { [weak self] _ in Task { self?.musicChanged() } },
      music.queue.objectWillChange.sink { [weak self] _ in Task { self?.musicChanged() } },
      audio.publisher(for: \.timeControlStatus).sink { [weak self] _ in Task { self?.audioChanged() } },
    ]
    remoteCommands()
  }

  // MARK: Access

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

  /// What the Mac asks once it connects: the storefront its catalog searches, and whether songs play whole.
  func announce() {
    if let storefront { send?(["type": "storefront", "code": storefront]) }
    send?(["type": "whole-songs", "canPlay": access == .ready && problem == nil])
  }

  private var wholeSongs: Bool { access == .ready && problem == nil }

  // MARK: Messages from the Mac

  func receive(_ message: [String: Any]) {
    let id = message["id"] as? Int
    switch message["type"] as? String {
    case "preview":
      // A queue the phone already plays, sent again after a reconnect, goes on as it is. A restarted Mac
      // numbers its queues from 1 again, so only a resent one is matched by its number.
      guard let id, !(message["replay"] as? Bool == true && id == queueID) else { return }
      let tracks = (message["tracks"] as? [[String: Any]] ?? []).compactMap(track)
      guard !tracks.isEmpty else {
        send?(["type": "preview-event", "id": id, "event": ["type": "stopped"]])
        return
      }
      if !queue.isEmpty { stop() }
      queue = tracks
      queueID = id
      index = 0
      failures = 0
      report("queue")
      play(at: 0)
    case "preview-enqueue":
      guard let id, id == queueID, let raw = message["track"] as? [String: Any], let track = track(raw) else { return }
      // Made tracks follow made tracks, as Moondog's stream sends them; songs join any queue.
      if track.made && queue.contains(where: { !$0.made }) { return }
      queue.append(track)
      publish()
    case "preview-control":
      guard let id, id == queueID else { return }
      if message["action"] as? String == "skip" { next() }
      if message["action"] as? String == "stop" { stop(notify: false) }
    default:
      break
    }
  }

  private func track(_ raw: [String: Any]) -> Track? {
    let title = (raw["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return nil }
    let https = { (key: String, host: String) -> URL? in
      guard let url = (raw[key] as? String).flatMap(URL.init(string:)), url.scheme == "https", url.host == host else { return nil }
      return url
    }
    if raw["generated"] as? Bool == true {
      let media = raw["media_url"] as? String ?? ""
      guard let id = media.split(separator: "/").last.map(String.init), media.hasPrefix("moondog-media://generated/") else { return nil }
      return Track(title: title, artist: "Moondog", madeID: id, seconds: raw["duration_seconds"] as? Double)
    }
    let artwork = (raw["artwork_url"] as? String).flatMap(URL.init(string:))
    let song = Track(title: title, artist: raw["artist_credit"] as? String ?? "", catalogURL: https("catalog_url", "music.apple.com"),
                     previewURL: https("preview_url", "audio-ssl.itunes.apple.com"), artworkURL: artwork)
    return song.catalogID != nil || song.previewURL != nil ? song : nil
  }

  // MARK: Events to the Mac

  private func report(_ type: String) {
    guard let queueID, queue.indices.contains(index) else { return }
    let track = queue[index]
    let described: [String: Any] = track.made
      ? ["title": track.title, "artist_credit": "", "generated": true, "id": track.madeID ?? ""]
      : ["title": track.title, "artist_credit": track.artist, "catalog_url": track.catalogURL?.absoluteString ?? ""]
    send?(["type": "preview-event", "id": queueID,
           "event": ["type": type, "track": described, "position": index + 1, "count": queue.count]])
  }

  // MARK: Playing

  private func following(_ from: Int) -> Int {
    var at = from + 1
    while at < queue.count && queue[at].removed { at += 1 }
    return at
  }

  private func preceding(_ from: Int) -> Int {
    var at = from - 1
    while at > 0 && queue[at].removed { at -= 1 }
    return max(0, at)
  }

  /// Plays the queue from a position: a song whole through MusicKit with the songs after it up to the next
  /// made track, anything else through the audio player.
  private func play(at position: Int) {
    guard !queue.isEmpty else { return }
    index = max(0, min(queue.count - 1, position))
    if queue[index].removed { index = following(index) < queue.count ? following(index) : preceding(index) }
    let track = queue[index]
    starting?.cancel()
    if !track.made, track.catalogID != nil, wholeSongs || Self.simulated {
      audio.pause()
      audio.replaceCurrentItem(with: nil)
      var end = index
      while end < queue.count, !queue[end].made, !queue[end].removed, queue[end].catalogID != nil { end += 1 }
      run = Array(index..<end)
      mode = .full
      runStarted = false
      reported = ""
      report("loading")
      let positions = run
      let id = queueID
      starting = Task { await startRun(positions, queue: id) }
      publish()
      return
    }
    if mode == .full { music.stop() }
    mode = .audio
    load()
  }

  private func startRun(_ positions: [Int], queue id: Int?) async {
    if Self.simulated {
      resetClock(running: true)
      runStarted = true
      reported = "playing|\(index)"
      report("playing")
      publish()
      return
    }
    let ids = positions.compactMap { queue[$0].catalogID }
    send?(["type": "log", "text": "starting \(ids.count) songs"])
    do {
      let request = MusicCatalogResourceRequest<Song>(matching: \.id, memberOf: ids.map { MusicItemID($0) })
      let found = try await request.response().items
      guard !Task.isCancelled, id == queueID else { return }
      // Songs this region's catalog lacks are passed over; the run plays the rest in order.
      var songs: [Song] = []
      var kept: [Int] = []
      for position in positions {
        if let song = found.first(where: { $0.id.rawValue == queue[position].catalogID }) {
          songs.append(song)
          kept.append(position)
        } else {
          queue[position].removed = true
        }
      }
      if songs.count < positions.count { send?(["type": "log", "text": "\(positions.count - songs.count) not in the \(storefront ?? "unknown") catalog"]) }
      guard !songs.isEmpty else { throw PlayerError(String(localized: "A song isn't available in this Apple Music region.")) }
      run = kept
      index = kept[0]
      music.queue = ApplicationMusicPlayer.Queue(for: songs)
      try await startMusic()
      guard id == queueID else { return }
      musicChanged()
    } catch is CancellationError {
      return
    } catch {
      guard id == queueID, !Task.isCancelled else { return }
      if !active {
        // iOS may not let Apple Music start from the background; the run starts when the listener is back.
        waiting = index
        send?(["type": "log", "text": "waiting for Moondog to be open to start"])
        return
      }
      send?(["type": "log", "text": "whole songs failed: \(error.localizedDescription)"])
      // As on the desktop: a run that can't play whole goes to the previews.
      if queue[index].previewURL != nil {
        mode = .audio
        load()
      } else {
        report("failed")
        skipAfterFailure()
      }
    }
  }

  /// Starts MusicKit and waits until it says it plays, at most 20 seconds. Its play() can return before
  /// its status turns, and sometimes never answers at all.
  private func startMusic() async throws {
    final class Outcome { var error: (any Error)? }
    let outcome = Outcome()
    let music = self.music
    Task { do { try await music.prepareToPlay(); try await music.play() } catch { outcome.error = error } }
    for _ in 0..<80 {
      if let error = outcome.error { throw error }
      if music.state.playbackStatus == .playing { return }
      try await Task.sleep(for: .milliseconds(250))
    }
    throw PlayerError(String(localized: "Apple Music didn't start playing within 20 seconds."))
  }

  /// MusicKit changed: which song of the run plays, and whether it plays.
  private func musicChanged() {
    guard mode == .full, !queue.isEmpty, !Self.simulated else { return publish() }
    let entries = Array(music.queue.entries)
    if let entry = music.queue.currentEntry, let at = entries.firstIndex(where: { $0.id == entry.id }), run.indices.contains(at) {
      index = run[at]
    }
    let status = music.state.playbackStatus
    let key = "\(status)|\(index)"
    if key != reported {
      reported = key
      switch status {
      case .playing:
        runStarted = true
        report("playing")
      case .paused, .interrupted:
        // MusicKit pauses at the end of its queue; at the run's last song, with the song done, the run ended.
        if runStarted, index == run.last, music.playbackTime < 0.5 || music.queue.currentEntry == nil {
          return afterRun()
        }
        if runStarted { report("paused") }
      case .stopped:
        if runStarted { return afterRun() }
      default:
        break
      }
    }
    publish()
  }

  /// After MusicKit's run, the queue goes on with the made track after it, or ends.
  private func afterRun() {
    guard let last = run.last else { return stop() }
    following(last) < queue.count ? play(at: following(last)) : stop()
  }

  /// A made track or a preview through the audio player.
  private func load() {
    let track = queue[index]
    let url: URL?
    var options: [String: Any] = [:]
    if let id = track.madeID, let media {
      url = media.base.appending(path: "media/generated/\(id)")
      options["AVURLAssetHTTPHeaderFieldsKey"] = ["Authorization": "Bearer \(media.key)"]
    } else {
      url = track.previewURL
    }
    guard let url else {
      report("failed")
      return skipAfterFailure()
    }
    try? AVAudioSession.sharedInstance().setCategory(.playback)
    try? AVAudioSession.sharedInstance().setActive(true)
    audio.replaceCurrentItem(with: AVPlayerItem(asset: AVURLAsset(url: url, options: options)))
    reported = ""
    report("loading")
    audio.play()
    publish()
  }

  private func audioChanged() {
    guard mode == .audio, !queue.isEmpty else { return }
    let key: String
    switch audio.timeControlStatus {
    case .playing: key = "playing|\(index)"
    case .paused: key = audio.currentItem == nil ? "" : "paused|\(index)"
    default: return
    }
    if key != reported, !key.isEmpty {
      reported = key
      if key.hasPrefix("playing") { failures = 0 }
      report(key.hasPrefix("playing") ? "playing" : "paused")
    }
    publish()
  }

  private func audioEnded(_ item: ObjectIdentifier?) {
    guard mode == .audio, item != nil, item == audio.currentItem.map(ObjectIdentifier.init) else { return }
    // A made track that played to its end is reported as finished, for the loop back from listening.
    if queue[index].made { report("finished") }
    following(index) < queue.count ? play(at: following(index)) : stop()
  }

  private func audioFailed(_ item: ObjectIdentifier?) {
    guard mode == .audio, item != nil, item == audio.currentItem.map(ObjectIdentifier.init) else { return }
    report("failed")
    skipAfterFailure()
  }

  /// A track that won't load is passed over; three in a row end the queue.
  private func skipAfterFailure() {
    failures += 1
    if failures < 3 && following(index) < queue.count { play(at: following(index)) } else { stop() }
  }

  private func stop(notify: Bool = true) {
    guard !queue.isEmpty else { return }
    if notify { report("stopped") }
    starting?.cancel()
    queue = []
    queueID = nil
    run = []
    waiting = nil
    if mode == .full, !Self.simulated { music.stop() }
    mode = .none
    audio.pause()
    audio.replaceCurrentItem(with: nil)
    resetClock(running: false)
    publish()
  }

  // MARK: The listener's own controls

  /// The app came back: a run that couldn't start from the background starts now.
  func becameActive() {
    active = true
    guard let position = waiting else { return }
    waiting = nil
    play(at: position)
  }

  func toggle() {
    guard !queue.isEmpty else { return }
    switch mode {
    case .full:
      if Self.simulated {
        let playing = state.playing
        resetClock(running: !playing, keep: true)
        reported = "\(playing ? "paused" : "playing")|\(index)"
        report(playing ? "paused" : "playing")
        return publish()
      }
      if music.state.playbackStatus == .playing { music.pause() } else { Task { try? await music.play() } }
    case .audio:
      if audio.timeControlStatus == .paused { audio.play() } else { audio.pause() }
    case .none:
      break
    }
  }

  func next() {
    guard !queue.isEmpty else { return }
    if mode == .full {
      // Past the run's last song the queue goes on with what follows it, or ends.
      guard let at = run.firstIndex(of: index), at + 1 < run.count, !Self.simulated else {
        if Self.simulated, following(index) < queue.count { return play(at: following(index)) }
        return afterRun()
      }
      Task { try? await music.skipToNextEntry() }
      return
    }
    if following(index) < queue.count { return play(at: following(index)) }
    // A made track skipped past the end of its queue: Moondog's stream moves on once its next track is made.
    if queue[index].made { report("skipped") }
    stop()
  }

  func previous() {
    guard !queue.isEmpty else { return }
    if mode == .full, !Self.simulated {
      if music.playbackTime > 3 { music.restartCurrentEntry(); return }
      if index == run.first, index > 0 { return play(at: preceding(index)) }
      Task { try? await music.skipToPreviousEntry() }
      return
    }
    if mode == .audio, audio.currentTime().seconds > 3 || index == 0 {
      audio.seek(to: .zero)
      return
    }
    play(at: preceding(index))
  }

  /// A song in Up next, by its place in the queue: it plays now, past the ones before it.
  func jump(to position: Int) {
    guard queue.indices.contains(position), position > index, !queue[position].removed else { return }
    play(at: position)
  }

  /// A song taken out of Up next. The one playing stays.
  func remove(at position: Int) {
    guard queue.indices.contains(position), position > index, !queue[position].removed, let queueID else { return }
    queue[position].removed = true
    send?(["type": "preview-event", "id": queueID, "event": ["type": "removed", "position": position + 1]])
    publish()
  }

  /// The view's controls by name, as the record and the bar use them.
  func control(_ action: String) {
    switch action {
    case "pause" where state.playing, "resume" where !state.playing: toggle()
    case "next": next()
    case "previous": previous()
    default: break
    }
  }

  /// Where the current song is, in seconds, and how long it runs, when known.
  func position() -> (elapsed: TimeInterval, duration: TimeInterval?) {
    switch mode {
    case .full where Self.simulated:
      return (elapsedBefore + (started.map { Date.now.timeIntervalSince($0) } ?? 0), 214)
    case .full:
      var duration: TimeInterval?
      if case .song(let song)? = music.queue.currentEntry?.item { duration = song.duration }
      return (music.playbackTime, duration)
    case .audio:
      let duration = audio.currentItem?.duration.seconds
      return (max(0, audio.currentTime().seconds.isFinite ? audio.currentTime().seconds : 0),
              duration?.isFinite == true ? duration : queue[safe: index]?.seconds)
    case .none:
      return (0, nil)
    }
  }

  private func resetClock(running: Bool, keep: Bool = false) {
    if keep, let started { elapsedBefore += Date.now.timeIntervalSince(started) }
    if !keep { elapsedBefore = 0 }
    started = running ? .now : nil
  }

  // MARK: What the views read

  private func publish() {
    let status: String
    switch mode {
    case .none: status = "stopped"
    case .full where Self.simulated: status = started == nil ? (runStarted ? "paused" : "stopped") : "playing"
    case .full:
      status = switch music.state.playbackStatus {
      case .playing, .seekingForward, .seekingBackward: "playing"
      case .paused, .interrupted: "paused"
      default: runStarted ? "stopped" : "paused"
      }
    case .audio: status = audio.timeControlStatus == .paused ? "paused" : "playing"
    }
    let next = PlayerState(status: queue.isEmpty ? "stopped" : status, index: queue.isEmpty ? nil : index, tracks: queue)
    artwork = mode == .full && !Self.simulated ? music.queue.currentEntry?.artwork : nil
    coverURL = next.current?.artworkURL.map(Self.large)
    readPalette()
    nowPlayingInfo(next)
    if next != state { state = next }
  }

  /// The catalog's covers come at 100 pixels; the same address serves larger ones.
  private static func large(_ url: URL) -> URL {
    URL(string: url.absoluteString.replacingOccurrences(of: "100x100bb", with: "600x600bb")) ?? url
  }

  /// Reads the cover at the size the palette needs, once per cover.
  private func readPalette() {
    if Self.simulated {
      guard let title = state.current?.title ?? queue[safe: index]?.title, !queue.isEmpty else { palette = nil; return }
      let hue = Double(title.unicodeScalars.reduce(0) { ($0 * 31 + Int($1.value)) % 360 })
      palette = [0, 70, 150].map { Tone(h: (hue + $0).truncatingRemainder(dividingBy: 360), s: 0.6, l: 0.5) }
      return
    }
    guard let url = artwork?.url(width: CoverPalette.size, height: CoverPalette.size) ?? coverURL else {
      if queue.isEmpty { palette = nil }
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

  // MARK: Lock Screen, for what the audio player plays (MusicKit shows its own songs)

  private func nowPlayingInfo(_ next: PlayerState) {
    guard mode == .audio, let track = next.current else {
      if mode != .full { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
      return
    }
    var info: [String: Any] = [MPMediaItemPropertyTitle: track.title, MPMediaItemPropertyArtist: track.artist,
                               MPNowPlayingInfoPropertyPlaybackRate: next.playing ? 1.0 : 0.0,
                               MPNowPlayingInfoPropertyElapsedPlaybackTime: position().elapsed]
    if let duration = position().duration { info[MPMediaItemPropertyPlaybackDuration] = duration }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func remoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    center.playCommand.addTarget { [weak self] _ in self?.control("resume"); return .success }
    center.pauseCommand.addTarget { [weak self] _ in self?.control("pause"); return .success }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.toggle(); return .success }
    center.nextTrackCommand.addTarget { [weak self] _ in self?.next(); return .success }
    center.previousTrackCommand.addTarget { [weak self] _ in self?.previous(); return .success }
  }
}

extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
