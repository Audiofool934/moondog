import Combine
import ExpoModulesCore
import MusicKit

@MainActor
private final class PhonePlayer {
  private let player = ApplicationMusicPlayer.shared
  private var stateWatch: AnyCancellable?
  private var queueWatch: AnyCancellable?
  private var queueID = ""
  var changed: (([String: Any]) -> Void)?

  func observe() {
    stateWatch = player.state.objectWillChange.sink { [weak self] _ in
      Task { @MainActor in self?.publish() }
    }
    watchQueue()
  }

  private func watchQueue() {
    queueWatch = player.queue.objectWillChange.sink { [weak self] _ in
      Task { @MainActor in self?.publish() }
    }
  }

  func snapshot() -> [String: Any] {
    guard !queueID.isEmpty, let entry = player.queue.currentEntry else {
      return ["status": "stopped", "queueID": queueID, "tracks": []]
    }
    let entries = Array(player.queue.entries)
    let tracks = entries.map { element -> [String: String] in
      var track = ["title": element.title, "artist": element.subtitle ?? ""]
      if case .song(let song)? = element.item { track["id"] = song.id.rawValue }
      return track
    }
    guard let index = entries.firstIndex(where: { $0.id == entry.id }) else {
      return ["status": "stopped", "queueID": queueID, "tracks": []]
    }
    let status: String
    switch player.state.playbackStatus {
    case .playing, .seekingForward, .seekingBackward: status = "playing"
    case .paused, .interrupted: status = "paused"
    default: status = "stopped"
    }
    return ["status": status, "queueID": queueID, "index": index, "tracks": tracks]
  }

  private func publish() { changed?(snapshot()) }

  func play(ids: [String], queueID: String) async throws -> [String: Any] {
    guard MusicAuthorization.currentStatus == .authorized else { throw error("Allow Apple Music access on this iPhone first.") }
    guard try await MusicSubscription.current.canPlayCatalogContent else { throw error("An Apple Music subscription is needed to play full songs.") }
    let found = try await MusicCatalogResourceRequest<Song>(matching: \.id, memberOf: ids.map { MusicItemID($0) }).response().items
    let songs = ids.compactMap { id in found.first { $0.id.rawValue == id } }
    guard !songs.isEmpty, songs.count == ids.count else { throw error("A requested song is unavailable in this Apple Music region.") }
    self.queueID = queueID
    player.queue = ApplicationMusicPlayer.Queue(for: songs)
    watchQueue()
    do { try await player.play() } catch { publish(); throw error }
    publish()
    return snapshot()
  }

  func control(_ action: String) async throws -> [String: Any] {
    switch action {
    case "pause": player.pause()
    case "resume": try await player.play()
    case "next": try await player.skipToNextEntry()
    case "previous": try await player.skipToPreviousEntry()
    default: throw error("Unknown player control.")
    }
    publish()
    return snapshot()
  }

  private func error(_ message: String) -> NSError {
    NSError(domain: "MoondogMusic", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

public final class MoondogMusicModule: Module {
  @MainActor private lazy var music = PhonePlayer()

  public func definition() -> ModuleDefinition {
    Name("MoondogMusic")
    Events("onPlayback")
    OnStartObserving { [weak self] in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.music.changed = { [weak self] state in self?.sendEvent("onPlayback", state) }
        self.music.observe()
      }
    }
    AsyncFunction("access") { (request: Bool) async throws -> [String: String] in
      let status = request ? await MusicAuthorization.request() : MusicAuthorization.currentStatus
      guard status == .authorized else { return ["status": String(describing: status)] }
      let allowed = try await MusicSubscription.current.canPlayCatalogContent
      var info = ["status": allowed ? "ready" : "subscription"]
      info["storefront"] = try? await MusicDataRequest.currentCountryCode
      return info
    }
    AsyncFunction("state") { () async -> [String: Any] in await self.music.snapshot() }
    AsyncFunction("play") { (ids: [String], queueID: String) async throws -> [String: Any] in
      try await self.music.play(ids: ids, queueID: queueID)
    }
    AsyncFunction("control") { (action: String) async throws -> [String: Any] in try await self.music.control(action) }
  }
}
