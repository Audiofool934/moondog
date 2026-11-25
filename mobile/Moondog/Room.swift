import Foundation

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
  let player = Player()

  @ObservationIgnored private var task: URLSessionWebSocketTask?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var attempts = 0
  @ObservationIgnored private var retry: Task<Void, Never>?
  @ObservationIgnored private var active = false
  @ObservationIgnored private var lift: Task<Void, Never>?
  private let session = URLSession(configuration: .ephemeral)

  var online: Bool { link == .online }

  init() {
    player.changed = { [weak self] state in
      if state.playing { self?.cued = false }
      self?.send(["type": "state", "state": state.report])
    }
    player.start()
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
    guard value else { return }
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
    }
    switch message.type {
    case "room":
      messages = message.messages ?? []
      let ended = turn != nil && message.turn == nil
      turn = message.turn
      if ended { liftWhenSilent() }
    case "delta":
      turn?.assistant += message.text ?? ""
    case "reply":
      turn?.assistant = message.text ?? ""
    case "notice":
      notice = message.text
    case "play", "control":
      guard let id = message.id else { return }
      do {
        if let expires = message.expires, Date.now.timeIntervalSince1970 * 1000 > expires {
          throw PlayerError(String(localized: "The request expired while the phone was away."))
        }
        let state = message.type == "play"
          ? try await player.play(ids: message.ids ?? [], tracks: message.tracks ?? [], queueID: id)
          : try await player.control(message.action ?? "")
        if state.playing { cued = false }
        send(["type": "receipt", "id": id, "state": state.report])
      } catch {
        notice = error.localizedDescription
        send(["type": "receipt", "id": id, "error": error.localizedDescription])
      }
    default:
      break
    }
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
