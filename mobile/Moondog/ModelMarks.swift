import SwiftUI
import UIKit

/// Which mark a model shows, by the desktop's rule (app/renderer/renderer.mjs, makerMark): its maker's,
/// by the account it comes through, or for OpenRouter and an endpoint by the maker its id names. The
/// marks are the window's own (npm run marks); Moondog's model shows the logo.
enum ModelMarks {
  private static let makers = ["anthropic": "claude", "openai": "openai", "google": "gemini", "deepseek": "deepseek",
                               "moonshotai": "kimi", "moonshotai-cn": "kimi", "xai": "grok", "zai": "zai", "openrouter": "openrouter"]
  private static let routed = ["anthropic": "claude", "openai": "openai", "google": "gemini", "deepseek": "deepseek",
                               "moonshotai": "kimi", "x-ai": "grok", "z-ai": "zai"]
  private static let named: [(String, String)] = [("^claude", "claude"), ("^(gpt|chatgpt|o[0-9])", "openai"), ("^(gemini|gemma)", "gemini"),
                                                  ("^deepseek", "deepseek"), ("^(kimi|moonshot)", "kimi"), ("^grok", "grok"), ("^glm", "zai")]

  /// The mark's name, or nil for Moondog's own model, which shows the logo.
  static func mark(provider: String, model: String) -> String? {
    if provider == "moondog" { return nil }
    let id = model.lowercased()
    if provider == "openrouter" { return routed[String(id.split(separator: "/").first ?? "")] ?? "openrouter" }
    guard provider.hasPrefix("endpoint-") else { return makers[provider] ?? "model" }
    let parts = id.split(separator: "/", maxSplits: 1).map(String.init)
    let (maker, rest) = parts.count == 2 ? (parts[0], parts[1]) : ("", id)
    return routed[maker] ?? named.first { rest.range(of: $0.0, options: .regularExpression) != nil }?.1 ?? "model"
  }

  /// The mark as an image, for a menu, which shows images only.
  static func image(provider: String, model: String) -> Image {
    guard let mark = mark(provider: provider, model: model) else { return logo }
    return Image("mark-\(mark)").renderingMode(.template)
  }

  /// Moondog's logo drawn once as a template image.
  @MainActor private static let logo: Image = {
    let renderer = ImageRenderer(content: RecordMark(playing: false, armDown: false, ink: .black).frame(width: 24, height: 24))
    renderer.scale = 3
    return renderer.uiImage.map { Image(uiImage: $0.withRenderingMode(.alwaysTemplate)) } ?? Image(systemName: "record.circle")
  }()
}

/// A model's mark at the size of an icon, in the ink around it.
struct ModelMark: View {
  var provider: String
  var model: String

  var body: some View {
    if let mark = ModelMarks.mark(provider: provider, model: model) {
      Image("mark-\(mark)")
        .renderingMode(.template)
        .resizable()
        .scaledToFit()
    } else {
      RecordMark(playing: false, armDown: false, ink: .text2)
    }
  }
}
