import Foundation
import UIKit

struct Message: Decodable, Equatable {
  var role: String
  var text: String
}

struct Turn: Decodable, Equatable {
  var user: String
  var assistant: String
}

/// One message from the Mac host (mobile/host/room.mjs). Each type fills its own fields.
private struct Inbound: Decodable {
  var type: String
  var messages: [Message]?
  var turn: Turn?
  var text: String?
  var id: String?
  var ids: [String]?
  var tracks: [Track]?
  var action: String?
  var expires: Double?
}

/// The listening room on the Mac, reached over Tailscale. The Mac owns the conversation and the agent;
/// the phone owns the player and answers each playback request with what actually plays.
@Observable
final class Room {
  enum Link: Equatable { case connecting, online, refused }

  private(set) var pairing = PairingStore.load()
  private(set) var link = Link.connecting
  private(set) var messages: [Message] = []
  private(set) var turn: Turn?
  var notice: String?
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
  /// A song the Mac sent while the phone was away and could not start, played when the listener is back.
  @ObservationIgnored private var waiting: (id: String, ids: [String], tracks: [Track])?
  private let session = URLSession(configuration: .ephemeral)

  var online: Bool { link == .online }

  init() {
    player.changed = { [weak self] state in
      if state.playing { self?.cued = false }
      self?.send(["type": "state", "state": state.report])
    }
    player.start()
    live = OnAirLive()
    live?.follow(self)
  }

  /// What the Live Activity shows, or nil while there is nothing on: no song loaded and no request.
  var onAir: OnAirAttributes.ContentState? {
    let current = player.state.current
    guard pairing != nil, current != nil || turn != nil else { return nil }
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
    messages = []
    turn = nil
    notice = nil
    disconnect()
    attempts = 0
    connect()
  }

  func forget() {
    PairingStore.clear()
    disconnect()
    pairing = nil
    messages = []
    turn = nil
  }

  // MARK: Lifecycle

  /// The app came to the foreground or left it. In the background the socket stays as long as iOS
  /// keeps the app running, as it does while music plays, but no new attempts start.
  func setActive(_ value: Bool) {
    active = value
    send(["type": "presence", "active": value])
    guard value else {
      // iOS stops an app soon after it leaves the screen unless it plays; a reply still coming keeps it a little longer.
      if turn != nil || cued { stayForReply() }
      return
    }
    letGo()
    if let waiting {
      self.waiting = nil
      Task {
        do { _ = try await player.play(ids: waiting.ids, tracks: waiting.tracks, queueID: waiting.id) } catch {
          notice = error.localizedDescription
          send(["type": "receipt", "id": waiting.id, "error": error.localizedDescription])
        }
      }
    }
    Task {
      await player.refreshAccess()
      sendAccess()
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
        if case .string(let text) = message { await handle(Data(text.utf8)) }
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

  // MARK: Messages

  @discardableResult
  private func send(_ value: [String: Any]) -> Bool {
    guard online, let task, let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8)
    else { return false }
    task.send(.string(text)) { _ in }
    return true
  }

  private func sendAccess() {
    var value: [String: Any] = ["type": "access", "ready": player.access == .ready]
    value["storefront"] = player.storefront
    value["problem"] = player.problem
    send(value)
  }

  @discardableResult
  func prompt(_ text: String) -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, turn == nil, send(["type": "prompt", "text": text]) else { return false }
    notice = nil
    return true
  }

  func cancel() { send(["type": "cancel"]) }

  /// The record: a playing song pauses, a paused one resumes, and with nothing loaded Moondog picks.
  func record() {
    if player.state.current != nil {
      control(player.state.playing ? "pause" : "resume")
    } else if prompt(String(localized: "Play something for right now")) {
      cued = true
    }
  }

  func control(_ action: String) {
    Task {
      do { _ = try await player.control(action) } catch { notice = error.localizedDescription }
    }
  }

  private func handle(_ data: Data) async {
    guard let message = try? JSONDecoder().decode(Inbound.self, from: data) else { return }
    if link != .online {
      link = .online
      attempts = 0
      sendAccess()
      send(["type": "state", "state": player.state.report])
      send(["type": "presence", "active": active])
    }
    switch message.type {
    case "room":
      messages = message.messages ?? []
      let ended = turn != nil && message.turn == nil
      if turn == nil && message.turn != nil { hostLine = HostLine.any() }
      turn = message.turn
      if ended {
        liftWhenSilent()
        if !active { letGo() }
      }
    case "delta":
      turn?.assistant += message.text ?? ""
    case "reply":
      turn?.assistant = message.text ?? ""
    case "notice":
      notice = message.text
    case "play", "control":
      guard let id = message.id else { return }
      // A request the Mac stopped waiting for: it holds a song for the listener's return and sends it again.
      if let expires = message.expires, Date.now.timeIntervalSince1970 * 1000 > expires { return }
      do {
        let state = message.type == "play"
          ? try await player.play(ids: message.ids ?? [], tracks: message.tracks ?? [], queueID: id)
          : try await player.control(message.action ?? "")
        if state.playing { cued = false }
        send(["type": "receipt", "id": id, "state": state.report])
      } catch where message.type == "play" && !active {
        // iOS may not let a song start from the background; it starts when the listener is back.
        waiting = (id, message.ids ?? [], message.tracks ?? [])
        send(["type": "receipt", "id": id, "deferred": true])
      } catch {
        notice = error.localizedDescription
        send(["type": "receipt", "id": id, "error": error.localizedDescription])
      }
    default:
      break
    }
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
