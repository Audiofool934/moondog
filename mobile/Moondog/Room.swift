import Foundation
import UIKit

struct Message: Equatable {
  var role: String
  var text: String
}

/// A reply being written: what the listener said and what Moondog has said so far.
struct Turn: Equatable {
  var user: String
  var assistant: String
}

/// A conversation on the Mac, as the desktop's sidebar lists it.
struct Conversation: Identifiable, Equatable {
  var id: String
  var title: String
  var updatedAt: Date?
  var pinned: Bool
  var folderID: String?
}

struct ConversationFolder: Identifiable, Equatable {
  var id: String
  var name: String
}

/// The model the shown conversation answers with, and its thinking levels.
struct ModelStatus: Equatable {
  var configured = false
  var provider: String?
  var model: String?
  var effort: String?
  var effortLevels: [String] = []
}

/// A model the Mac's menu offers.
struct ModelChoice: Identifiable, Equatable {
  var provider: String
  var model: String
  var name: String
  var providerName: String
  var id: String { provider + "/" + model }
}

/// Moondog's own channel while it runs: its phase, and when it ends at the latest.
struct OnAirStream: Equatable {
  var phase: String
  var endsAt: Date?
  var tracks: Int
}

struct LibraryFolder: Identifiable, Equatable {
  var id: String
  var parentID: String?
  var name: String
}

struct Playlist: Identifiable, Equatable {
  var id: String
  var folderID: String?
  var name: String
  var count: Int
  var made: Int
  var cover: URL?
  var saved: Bool
}

struct PlaylistEntry: Identifiable, Equatable {
  var id: String
  var title: String
  var artist: String
  var made: Bool
  var cover: URL?
}

struct PlaylistDetail: Equatable {
  var id: String
  var name: String
  var entries: [PlaylistEntry]
}

/// The listening room on the Mac, reached over Tailscale. The phone is one more window on Moondog's core
/// there: it speaks the desktop window's own protocol (app/window-room.mjs), so the conversations, the
/// models, the library and On Air are the Mac's, shared with the desktop app and the terminal. The phone
/// owns its player, and tells the Mac what actually plays.
@Observable
final class Room {
  enum Link: Equatable { case connecting, online, refused }

  private(set) var pairing = PairingStore.load()
  private(set) var link = Link.connecting
  /// The conversation shown, by its id on the Mac.
  private(set) var current: String?
  private(set) var messages: [Message] = []
  private(set) var turn: Turn?
  private(set) var conversations: [Conversation] = []
  private(set) var folders: [ConversationFolder] = []
  /// Conversations answering now, here or on another surface.
  private(set) var running: Set<String> = []
  private(set) var model = ModelStatus()
  private(set) var models: [ModelChoice] = []
  private(set) var onAir: OnAirStream?
  /// Whether this Mac can make music now, which On Air needs.
  private(set) var canMakeMusic = false
  private(set) var libraryFolders: [LibraryFolder] = []
  private(set) var playlists: [Playlist] = []
  private(set) var openPlaylist: PlaylistDetail?
  var notice: String?
  /// Words the Mac gave back because it couldn't take them yet, for the composer.
  var returned: String?
  /// Set when the listener asks Moondog to pick: the arm goes down and waits for the music.
  private(set) var cued = false
  /// What the host says while it works on this request, as a radio host would; a new line for each.
  private(set) var hostLine = HostLine.any()
  let player = Player()

  @ObservationIgnored private var task: URLSessionWebSocketTask?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var attempts = 0
  @ObservationIgnored private var retry: Task<Void, Never>?
  @ObservationIgnored private var active = false
  @ObservationIgnored private var lift: Task<Void, Never>?
  @ObservationIgnored private var live: OnAirLive?
  /// The time iOS gives an app that has just left the screen, kept while a reply is still coming.
  @ObservationIgnored private var grace = UIBackgroundTaskIdentifier.invalid
  private let session = URLSession(configuration: .ephemeral)

  var online: Bool { link == .online }

  init() {
    player.send = { [weak self] message in
      if let event = (message["event"] as? [String: Any])?["type"] as? String, event == "playing" { self?.cued = false }
      self?.send(message)
    }
    player.start()
    setMedia()
    live = OnAirLive()
    live?.follow(self)
  }

  /// What the Live Activity shows, or nil while there is nothing on: no song loaded and no request.
  var liveState: OnAirAttributes.ContentState? {
    let current = player.state.current
    guard pairing != nil, current != nil || turn != nil || onAir != nil else { return nil }
    let reply = messages.last { $0.role == "assistant" }.map { Self.gist($0.text) }
    return .init(title: current?.title, artist: current?.artist, playing: player.state.playing, working: turn != nil,
                 line: turn != nil ? String(localized: hostLine) : reply)
  }

  /// A reply as one plain run of words, short enough for the Lock Screen.
  private static func gist(_ text: String) -> String {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    let plain = (try? AttributedString(markdown: text, options: options)).map { String($0.characters) } ?? text
    let words = plain.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return words.count > 200 ? String(words.prefix(200)) + "…" : words
  }

  // MARK: Pairing

  func pair(_ pairing: Pairing) {
    PairingStore.save(pairing)
    self.pairing = pairing
    clear()
    setMedia()
    disconnect()
    attempts = 0
    connect()
  }

  func forget() {
    PairingStore.clear()
    disconnect()
    pairing = nil
    clear()
  }

  private func clear() {
    messages = []
    turn = nil
    current = nil
    conversations = []
    notice = nil
  }

  private func setMedia() {
    player.media = pairing.flatMap { pairing in URL(string: "http://\(pairing.host):\(Pairing.port)/").map { ($0, pairing.key) } }
  }

  // MARK: Lifecycle

  /// The app came to the foreground or left it. In the background the socket stays as long as iOS
  /// keeps the app running, as it does while music plays, but no new attempts start.
  func setActive(_ value: Bool) {
    active = value
    player.active = value
    send(["type": "visible", "visible": value])
    guard value else {
      // iOS stops an app soon after it leaves the screen unless it plays; a reply still coming keeps it a little longer.
      if turn != nil || cued { stayForReply() }
      return
    }
    letGo()
    player.becameActive()
    Task {
      await player.refreshAccess()
      player.announce()
    }
    if task == nil {
      attempts = 0
      retry?.cancel()
      connect()
    }
  }

  private func connect() {
    guard let pairing, task == nil, active else { return }
    var request = URLRequest(url: pairing.url, timeoutInterval: 10)
    request.setValue("Bearer \(pairing.key)", forHTTPHeaderField: "Authorization")
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = 8 * 1024 * 1024
    generation += 1
    let current = generation
    self.task = task
    if link != .refused { link = .connecting }
    task.resume()
    Task { await receive(from: task, generation: current) }
  }

  private func disconnect() {
    retry?.cancel()
    generation += 1
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    link = .connecting
  }

  private func receive(from task: URLSessionWebSocketTask, generation current: Int) async {
    while true {
      do {
        let message = try await task.receive()
        guard current == generation else { return }
        if case .string(let text) = message { handle(Data(text.utf8)) }
      } catch {
        guard current == generation else { return }
        dropped(refused: (task.response as? HTTPURLResponse)?.statusCode == 401)
        return
      }
    }
  }

  private func dropped(refused: Bool) {
    task = nil
    link = refused ? .refused : .connecting
    guard pairing != nil, active else { return }
    let delay = min(15, pow(2, Double(min(attempts, 4))))
    attempts += 1
    retry = Task {
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      connect()
    }
  }

  // MARK: Asking the Mac

  @discardableResult
  private func send(_ value: [String: Any]) -> Bool {
    guard online, let task, let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8)
    else { return false }
    task.send(.string(text)) { _ in }
    return true
  }

  @discardableResult
  func prompt(_ text: String) -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, turn == nil, send(["type": "prompt", "text": text]) else { return false }
    notice = nil
    // Drawn at once; the Mac's start of the turn confirms it.
    turn = Turn(user: text, assistant: "")
    hostLine = HostLine.any()
    return true
  }

  func cancel() { send(["type": "cancel"]) }

  /// A new conversation, as the desktop's New button and /new start one.
  func newConversation() {
    guard turn == nil else { return }
    send(["type": "new"])
  }

  func open(_ id: String) {
    guard id != current else { return }
    send(["type": "open", "id": id])
  }

  func delete(_ id: String) { send(["type": "delete", "ids": [id]]) }

  func setPinned(_ id: String, _ pinned: Bool) { send(["type": "label", "ids": [id], "patch": ["pinned": pinned]]) }

  func rename(_ id: String, _ title: String) {
    let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    send(["type": "label", "ids": [id], "patch": ["title": title]])
  }

  /// The shown conversation's model, as the desktop composer's menu chooses it.
  func choose(_ choice: ModelChoice) { send(["type": "model", "provider": choice.provider, "model": choice.model]) }

  func choose(effort: String) { send(["type": "effort", "effort": effort]) }

  func refreshModels() { send(["type": "model-list"]) }

  func openPlaylistOnMac(_ id: String?) { send(["type": "library-open", "id": id ?? NSNull()]) }

  func play(playlist: String, from entry: String? = nil, shuffle: Bool = false) {
    var value: [String: Any] = ["type": "library-play", "playlistId": playlist, "shuffle": shuffle]
    value["entryId"] = entry
    send(value)
  }

  /// What plays now, kept in a playlist: Saved by default, as the desktop's save button does.
  func savePlaying(to playlist: String = "saved") {
    send(["type": "library-save", "from": "queue", "playlistId": playlist])
  }

  /// On Air starts as the desktop's button starts it: by asking Moondog in words.
  func goOnAir() {
    _ = prompt(String(localized: "Go on air: make new music for right now and keep it going"))
  }

  func goOffAir() { send(["type": "on-air-stop"]) }

  /// The record: a playing song pauses, a paused one resumes, and with nothing loaded Moondog picks.
  func record() {
    if player.state.current != nil {
      control(player.state.playing ? "pause" : "resume")
    } else if prompt(String(localized: "Play something for right now")) {
      cued = true
    }
  }

  func control(_ action: String) { player.control(action) }

  // MARK: What the Mac says

  private func handle(_ data: Data) {
    guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = message["type"] as? String
    else { return }
    if link != .online {
      link = .online
      attempts = 0
      send(["type": "visible", "visible": active])
      player.announce()
    }
    let session = message["session"] as? String
    switch type {
    case "ready":
      status(message)
      conversations(message)
      showConversation(message)
      refreshModels()
    case "status":
      status(message)
    case "sessions":
      conversations(message)
    case "session":
      showConversation(message)
    case "turn" where session == nil || session == current:
      switch message["state"] as? String {
      case "start":
        let text = message["text"] as? String ?? turn?.user ?? ""
        if turn == nil || turn?.user != text { hostLine = HostLine.any() }
        turn = Turn(user: text, assistant: turn?.user == text ? turn?.assistant ?? "" : "")
      case "end":
        let reply = (message["text"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? turn?.assistant ?? ""
        if let turn { messages.append(Message(role: "user", text: turn.user)) }
        if !reply.isEmpty { messages.append(Message(role: "assistant", text: reply)) }
        endTurn()
      case "error":
        if let turn { messages.append(Message(role: "user", text: turn.user)) }
        if let text = message["message"] as? String { messages.append(Message(role: "notice", text: text)) }
        endTurn()
      default:
        break
      }
    case "text" where session == nil || session == current:
      if let replace = message["replace"] as? String {
        turn?.assistant = replace
      } else if let delta = message["delta"] as? String {
        turn?.assistant += delta
      }
    case "notice":
      if message["code"] as? String == "message_busy", let text = message["text"] as? String {
        // The Mac couldn't take it yet; the words go back to the composer.
        turn = nil
        returned = text
      }
      notice = (message["message"] as? String) ?? notice
    case "on-air":
      onAir = Self.stream(message["onAir"])
    case "model-list":
      models = (message["models"] as? [[String: Any]] ?? []).compactMap { raw in
        guard raw["ready"] as? Bool == true, let provider = raw["provider"] as? String, let model = raw["model"] as? String else { return nil }
        return ModelChoice(provider: provider, model: model, name: raw["name"] as? String ?? model,
                           providerName: raw["providerName"] as? String ?? provider)
      }
    case "library":
      libraryFolders = (message["folders"] as? [[String: Any]] ?? []).compactMap { raw in
        guard let id = raw["id"] as? String else { return nil }
        return LibraryFolder(id: id, parentID: raw["parentId"] as? String, name: raw["name"] as? String ?? "")
      }
      playlists = (message["playlists"] as? [[String: Any]] ?? []).compactMap { raw in
        guard let id = raw["id"] as? String else { return nil }
        let cover = (raw["cover"] as? [String: Any])?["artwork_url"] as? String
        return Playlist(id: id, folderID: raw["folderId"] as? String, name: raw["name"] as? String ?? "",
                        count: raw["count"] as? Int ?? 0, made: raw["made"] as? Int ?? 0,
                        cover: cover.flatMap(URL.init(string:)), saved: raw["saved"] as? Bool == true)
      }
    case "library-playlist":
      guard let raw = message["playlist"] as? [String: Any], let id = raw["id"] as? String else {
        openPlaylist = nil
        return
      }
      openPlaylist = PlaylistDetail(id: id, name: raw["name"] as? String ?? "", entries: (raw["entries"] as? [[String: Any]] ?? []).compactMap { entry in
        guard let id = entry["id"] as? String else { return nil }
        let refs = entry["refs"] as? [String: Any]
        return PlaylistEntry(id: id, title: entry["title"] as? String ?? "", artist: entry["artist_credit"] as? String ?? "",
                             made: entry["kind"] as? String == "made", cover: (refs?["artwork_url"] as? String).flatMap(URL.init(string:)))
      })
    case "library-played":
      switch message["state"] as? String {
      case "empty": notice = String(localized: "Nothing in this playlist can play here.")
      case "not_found": notice = String(localized: "That playlist is gone.")
      default: break
      }
    case "preview", "preview-enqueue", "preview-control":
      player.receive(message)
    default:
      break
    }
  }

  private func endTurn() {
    turn = nil
    liftWhenSilent()
    if !active { letGo() }
  }

  private func status(_ message: [String: Any]) {
    if let raw = message["model"] as? [String: Any] {
      model = ModelStatus(configured: raw["state"] as? String == "configured", provider: raw["provider"] as? String,
                          model: raw["model"] as? String, effort: raw["effort"] as? String,
                          effortLevels: raw["effortLevels"] as? [String] ?? [])
    }
    if message.keys.contains("onAir") { onAir = Self.stream(message["onAir"]) }
    if let generation = message["generation"] as? [String: Any] {
      canMakeMusic = generation["state"] as? String == "ready"
    } else if message.keys.contains("generation") {
      canMakeMusic = false
    }
  }

  private func conversations(_ message: [String: Any]) {
    let dates = ISO8601DateFormatter()
    dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let list = message["sessions"] as? [[String: Any]] {
      conversations = list.compactMap { raw in
        guard let id = raw["id"] as? String else { return nil }
        return Conversation(id: id, title: raw["title"] as? String ?? "", updatedAt: (raw["updatedAt"] as? String).flatMap(dates.date(from:)),
                            pinned: raw["pinned"] as? Bool == true, folderID: raw["folderId"] as? String)
      }
    }
    if let list = message["folders"] as? [[String: Any]] {
      folders = list.compactMap { raw in
        (raw["id"] as? String).map { ConversationFolder(id: $0, name: raw["name"] as? String ?? "") }
      }
    }
    if let list = message["running"] as? [String] { running = Set(list) }
  }

  private func showConversation(_ message: [String: Any]) {
    guard message.keys.contains("current") else { return }
    let next = message["current"] as? String
    let shown = (message["transcript"] as? [[String: Any]] ?? []).compactMap { raw -> Message? in
      guard let role = raw["role"] as? String, let text = raw["text"] as? String else { return nil }
      return Message(role: role, text: text)
    }
    if next != current { notice = nil }
    current = next
    messages = shown
    // A reply still being written, here or on another surface, is drawn from where it stands.
    turn = (message["live"] as? [String: Any]).map { Turn(user: $0["user"] as? String ?? "", assistant: $0["text"] as? String ?? "") }
  }

  private static func stream(_ value: Any?) -> OnAirStream? {
    guard let raw = value as? [String: Any], let phase = raw["phase"] as? String else { return nil }
    let ends = (raw["endsAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
      ?? (raw["endsAt"] as? String).flatMap { text in
        let dates = ISO8601DateFormatter()
        dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return dates.date(from: text)
      }
    return OnAirStream(phase: phase, endsAt: ends, tracks: raw["tracks"] as? Int ?? 0)
  }

  private func stayForReply() {
    guard grace == .invalid else { return }
    grace = UIApplication.shared.beginBackgroundTask(withName: "Moondog reply") { [weak self] in self?.letGo() }
  }

  private func letGo() {
    guard grace != .invalid else { return }
    UIApplication.shared.endBackgroundTask(grace)
    grace = .invalid
  }

  /// A reply that started no music lifts the arm again after a moment.
  private func liftWhenSilent() {
    guard cued else { return }
    lift?.cancel()
    lift = Task {
      try? await Task.sleep(for: .seconds(4))
      guard !Task.isCancelled, !player.state.playing else { return }
      cued = false
    }
  }
}
