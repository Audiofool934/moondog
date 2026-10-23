// Moondog's Apple Music player: full songs from the Apple Music catalog through MusicKit, for the
// window to use in place of 30-second previews. It runs as a helper of the app, inside its bundle,
// so MusicKit knows it as Moondog. One JSON object per line in, one per line out.
//
//   {"id":1,"type":"check"}                      can it play? {"authorization","canPlay","reason","storefront"}
//   {"id":2,"type":"authorize"}                  asks the listener once, then checks
//   {"id":3,"type":"play","ids":["…"],"start":0,"token":"q1"}
//                                                plays catalog songs in the window's order, from one of them
//   {"type":"pause"|"resume"|"next"|"previous"|"stop"}, {"type":"seek","ms":61000}
//
// While a queue plays it reports {"type":"state","token":…} whenever the player changes and every few
// seconds, with the index of the song in the window's list; {"status":"ended"} closes the queue.
// A quit meant for Moondog that reaches the helper comes out as {"type":"quit"}.
// MusicKit gives the app its developer token only once MusicKit is enabled for the app's identifier in
// the Apple Developer account; until then check answers canPlay false.
import AppKit
import Combine
import Foundation
import MusicKit

// Swift names a case ".authorized"; the window reads "authorized".
func word(_ value: Any) -> String { String(describing: value).trimmingCharacters(in: CharacterSet(charactersIn: ".")) }

func write(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

@MainActor
final class Player {
  let player = ApplicationMusicPlayer.shared
  // The window's songs in its order, and the ones of them this storefront has, which the queue holds.
  var requested: [String] = []
  var queued: [String] = []
  var token: Any?
  // A queue of ours is loaded and has started. Every play or stop moves the generation on, so a play
  // still loading when the next command arrives gives way to it.
  var loaded = false
  var started = false
  var stopped = false
  var generation = 0
  // The last song seen playing and how far into it, to tell the end of the queue from a pause.
  var lastPlayed: (id: String, seconds: TimeInterval, duration: TimeInterval)?
  var stateWatch: AnyCancellable?
  var queueWatch: AnyCancellable?
  var timer: Timer?

  init() {
    stateWatch = player.state.objectWillChange.sink { [weak self] _ in Task { @MainActor in self?.report() } }
    watchQueue()
  }

  // A new queue is a new object; the watch moves to it.
  func watchQueue() {
    queueWatch = player.queue.objectWillChange.sink { [weak self] _ in Task { @MainActor in self?.report() } }
  }

  // The catalog first: without MusicKit enabled for the app, Apple gives no developer token and
  // nothing else matters. Then the listener's permission, then their subscription.
  func check() async -> [String: Any] {
    let status = MusicAuthorization.currentStatus
    var answer: [String: Any] = ["authorization": word(status), "canPlay": false]
    do {
      var request = MusicCatalogSearchRequest(term: "moon", types: [Song.self])
      request.limit = 1
      _ = try await request.response()
    } catch {
      answer["reason"] = word(error)
      return answer
    }
    // The account's storefront, which the core's catalog searches so its songs are ones MusicKit has.
    if let country = try? await MusicDataRequest.currentCountryCode { answer["storefront"] = country }
    guard status == .authorized else { return answer }
    do {
      let subscription = try await MusicSubscription.current
      if subscription.canPlayCatalogContent { answer["canPlay"] = true } else { answer["reason"] = "noSubscription" }
    } catch {
      answer["reason"] = word(error)
    }
    return answer
  }

  func play(ids: [String], start: Int, token: Any?) async throws {
    generation += 1
    let mine = generation
    self.token = token
    requested = ids
    queued = []
    loaded = false
    started = false
    stopped = false
    lastPlayed = nil
    let found = try await MusicCatalogResourceRequest<Song>(matching: \.id, memberOf: ids.map { MusicItemID($0) }).response().items
    guard mine == generation else { return }
    let byId = Dictionary(found.map { ($0.id.rawValue, $0) }, uniquingKeysWith: { first, _ in first })
    let songs = ids.compactMap { byId[$0] }
    guard !songs.isEmpty else { throw NSError(domain: "moondog", code: 1, userInfo: [NSLocalizedDescriptionKey: "notFound"]) }
    // The queue begins at the first song the storefront has at or after the one asked for. It holds
    // no songs before it: on macOS, Queue(for:startingAt:) fails every catalog queue with "Prepare
    // queue failed with unexpected start item".
    let first = ids[min(max(0, start), ids.count - 1)...].compactMap { byId[$0] }.first ?? songs[0]
    let playing = Array(songs.drop { $0.id != first.id })
    queued = playing.map { $0.id.rawValue }
    player.queue = ApplicationMusicPlayer.Queue(for: playing)
    watchQueue()
    loaded = true
    try await player.play()
    // A stop that came while the music started stops it again; a newer play replaces the queue itself.
    if mine != generation { if stopped { player.stop() }; return }
    keepReporting()
  }

  func stop() {
    generation += 1
    stopped = true
    loaded = false
    started = false
    lastPlayed = nil
    requested = []
    queued = []
    player.stop()
    timer?.invalidate()
    timer = nil
  }

  // Every few seconds while a queue of ours is loaded, whatever its status, so a pause or resume from
  // the keyboard's media keys reaches the window too.
  func keepReporting() {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in Task { @MainActor in self.report() } }
  }

  func end(_ state: inout [String: Any]) {
    state["status"] = "ended"
    loaded = false
    timer?.invalidate()
    timer = nil
  }

  func report() {
    guard loaded else { return }
    let status = player.state.playbackStatus
    let seconds = player.playbackTime
    var state: [String: Any] = ["type": "state", "status": word(status), "positionMs": seconds.isFinite ? Int(max(0, seconds) * 1000) : 0]
    if let token { state["token"] = token }
    if status == .playing { started = true }
    guard let entry = player.queue.currentEntry else {
      // The queue ran out: the window hears it once, and the helper lets the queue go.
      if started { end(&state); write(state) }
      return
    }
    var song: [String: Any] = ["title": entry.title]
    if let subtitle = entry.subtitle { song["artist"] = subtitle }
    if case .song(let item)? = entry.item {
      let id = item.id.rawValue
      let duration = item.duration.flatMap { $0.isFinite ? $0 : nil }
      song["id"] = id
      song["artist"] = item.artistName
      if let album = item.albumTitle { song["album"] = album }
      if let duration { song["durationMs"] = Int(duration * 1000) }
      if let url = item.artwork?.url(width: 600, height: 600) { song["artwork"] = url.absoluteString }
      if let link = item.url { song["link"] = link.absoluteString }
      if let index = requested.firstIndex(of: id) { state["index"] = index }
      if status == .playing, let duration { lastPlayed = (id, seconds, duration) }
      // At the end of the queue MusicKit pauses, at the end of the last song or back at the start of
      // the first one. Reports come every 5 seconds, so the last one seen playing the last song is
      // within its final seconds.
      if started, status != .playing {
        let atEnd = id == queued.last && duration.map { seconds >= $0 - 1 } == true
        let wrapped = seconds < 1 && lastPlayed.map { $0.id == queued.last && $0.seconds >= $0.duration - 7 } == true
        if atEnd || wrapped { end(&state) }
      }
    }
    state["song"] = song
    write(state)
  }

  func handle(_ command: [String: Any]) async {
    var answer: [String: Any] = ["type": "answer"]
    if let id = command["id"] { answer["id"] = id }
    do {
      switch command["type"] as? String {
      case "check": answer.merge(await check()) { _, new in new }
      case "authorize":
        _ = await MusicAuthorization.request()
        answer.merge(await check()) { _, new in new }
      case "play":
        try await play(ids: command["ids"] as? [String] ?? [], start: command["start"] as? Int ?? 0, token: command["token"])
      case "stop": stop()
      // The rest act only on a queue of ours, never on whatever MusicKit held before.
      case "pause" where loaded: player.pause()
      case "resume" where loaded: try await player.play(); keepReporting()
      case "next" where loaded: try await player.skipToNextEntry()
      case "previous" where loaded:
        if player.playbackTime > 3 { player.restartCurrentEntry() } else { try await player.skipToPreviousEntry() }
      case "seek" where loaded: player.playbackTime = max(0, (command["ms"] as? Double ?? 0) / 1000)
      case "pause", "resume", "next", "previous", "seek": answer["error"] = "nothingLoaded"
      default: answer["error"] = "unknownCommand"
      }
    } catch {
      answer["error"] = word(error)
    }
    write(answer)
    report()
  }
}

// The helper carries the app's identifier, so a quit addressed to Moondog by a script, an installer
// or the system can land here instead of on the app. The helper hands it to the app, which quits and
// closes the pipe; termination waits for that, so the helper never cancels a logout, and goes on its
// own if the app doesn't answer.
@MainActor
final class Delegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    write(["type": "quit"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { sender.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }
}

@main
enum Helper {
  static func main() {
    let application = NSApplication.shared
    // No Dock icon and no menu: the window speaks for it.
    application.setActivationPolicy(.prohibited)
    let delegate = MainActor.assumeIsolated { Delegate() }
    application.delegate = delegate
    let player = MainActor.assumeIsolated { Player() }
    Thread.detachNewThread {
      while let line = readLine() {
        guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        Task { @MainActor in await player.handle(command) }
      }
      // The app closed the pipe: the helper goes with it.
      exit(0)
    }
    // The application holds its delegate weakly.
    withExtendedLifetime(delegate) { application.run() }
  }
}
