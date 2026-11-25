import Foundation
import Security

/// The Mac this phone talks to: its Tailscale IPv4 address and the key the host printed.
struct Pairing: Codable, Equatable {
  static let port = 47831
  var host: String
  var key: String

  /// A pairing from what the listener typed or pasted, or nil when it can't be one. The host listens
  /// only on a Tailscale address (100.64.0.0/10), or on loopback for Simulator.
  init?(host: String, key: String) {
    let host = host.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ":\(Self.port)", with: "")
    let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard Self.isPrivate(host), key.wholeMatch(of: /[A-Za-z0-9_-]{32}/) != nil else { return nil }
    self.host = host
    self.key = key
  }

  /// The link `npm run host -- --copy` puts on the Mac's clipboard: moondog://pair?host=…&key=…
  init?(link: String) {
    guard let parts = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
          parts.scheme == "moondog", parts.host == "pair",
          let host = parts.queryItems?.first(where: { $0.name == "host" })?.value,
          let key = parts.queryItems?.first(where: { $0.name == "key" })?.value
    else { return nil }
    self.init(host: host, key: key)
  }

  var url: URL { URL(string: "ws://\(host):\(Self.port)/room")! }

  static func isPrivate(_ host: String) -> Bool {
    if host == "127.0.0.1" { return true }
    let octets = host.split(separator: ".", omittingEmptySubsequences: false)
    guard octets.count == 4,
          octets.allSatisfy({ $0.wholeMatch(of: /0|[1-9]\d{0,2}/) != nil && Int($0)! <= 255 })
    else { return false }
    let second = Int(octets[1])!
    return octets[0] == "100" && second >= 64 && second < 128
  }
}

/// The pairing lives in Keychain on this device only, readable after the first unlock so the phone
/// can reconnect while music plays in the background.
enum PairingStore {
  private static let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "ai.audiofool.moondog.mac",
    kSecAttrAccount as String: "pairing",
  ]

  static func load() -> Pairing? {
    var item: CFTypeRef?
    var search = query
    search[kSecReturnData as String] = true
    guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return try? JSONDecoder().decode(Pairing.self, from: data)
  }

  static func save(_ pairing: Pairing) {
    clear()
    var item = query
    item[kSecValueData as String] = try? JSONEncoder().encode(pairing)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
  }

  static func clear() { SecItemDelete(query as CFDictionary) }
}
