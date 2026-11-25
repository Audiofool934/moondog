import CoreGraphics
import SwiftUI

/// A colour as hue in degrees, saturation and lightness from 0 to 1.
struct Tone: Hashable {
  var h, s, l: Double
}

/// The colours of the cover that is playing, read as the desktop reads them (app/renderer/mood.mjs):
/// the cover at 24 by 24 pixels, its strongest distinct hues, up to three.
enum CoverPalette {
  static let size = 24

  static func of(_ image: CGImage) -> [Tone]? {
    let size = Self.size
    var pixels = [UInt8](repeating: 0, count: size * size * 4)
    guard let context = CGContext(data: &pixels, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    // Twelve hues, each a weighted sum: vivid, mid-light pixels count most; greys and near-blacks barely.
    var buckets = Array(repeating: (r: 0.0, g: 0.0, b: 0.0, weight: 0.0), count: 12)
    var grey = 0.0
    for at in stride(from: 0, to: pixels.count, by: 4) {
      let (r, g, b) = (Double(pixels[at]) / 255, Double(pixels[at + 1]) / 255, Double(pixels[at + 2]) / 255)
      let tone = hsl(r, g, b)
      grey += tone.l
      let weight = pow(tone.s, 1.4) * max(0, 1 - abs(tone.l - 0.5) * 1.6)
      if weight < 0.02 { continue }
      let index = Int(tone.h / 30) % 12
      buckets[index].r += r * weight
      buckets[index].g += g * weight
      buckets[index].b += b * weight
      buckets[index].weight += weight
    }
    let ranked = buckets.filter { $0.weight > 0 }.sorted { $0.weight > $1.weight }
    let total = ranked.reduce(0) { $0 + $1.weight }
    var picked: [Tone] = []
    for bucket in ranked {
      if bucket.weight < total * 0.06 { break }
      let tone = hsl(bucket.r / bucket.weight, bucket.g / bucket.weight, bucket.b / bucket.weight)
      // Neighbouring hues would read as one colour; each field gets its own.
      if picked.contains(where: { min(abs($0.h - tone.h), 360 - abs($0.h - tone.h)) < 28 }) { continue }
      picked.append(tone)
      if picked.count == 3 { break }
    }
    // A black-and-white cover still lights the window, in its own grey.
    if picked.isEmpty { picked.append(Tone(h: 0, s: 0, l: grey / Double(size * size))) }
    while picked.count < 3, let last = picked.last {
      picked.append(Tone(h: (last.h + 18).truncatingRemainder(dividingBy: 360), s: last.s, l: last.l))
    }
    return picked
  }

  /// The grooves' colours, rim inward: each hue at one steady lightness for the theme, so the rings read
  /// as the cover's colour and never outweigh the dog, which stays in ink.
  static func grooves(_ palette: [Tone], dark: Bool) -> [Color] {
    palette.map { tone in
      color(tone.h, min(tone.s, 0.72) * (dark ? 0.8 : 0.9), (dark ? 0.64 : 0.46) + (tone.l - 0.5) * 0.12)
    }
  }

  /// The three fields of light, far too faint to compete with the words. Light on a dark window glows
  /// by itself; on paper a pale tint only greys it, so by day the fields are clearer and a little stronger.
  static func mood(_ palette: [Tone], dark: Bool) -> [Color] {
    let strength = dark ? [0.34, 0.24, 0.16] : [0.5, 0.38, 0.28]
    return palette.enumerated().map { index, tone in
      let saturation = min(tone.s, dark ? 0.62 : 0.72) * (dark ? 0.9 : 0.95)
      let lightness = dark ? 0.3 + tone.l * 0.22 : 0.68 + tone.l * 0.12
      return color(tone.h, saturation, lightness).opacity(strength[index])
    }
  }

  private static func hsl(_ r: Double, _ g: Double, _ b: Double) -> Tone {
    let high = max(r, g, b), low = min(r, g, b)
    let l = (high + low) / 2
    if high == low { return Tone(h: 0, s: 0, l: l) }
    let d = high - low
    let s = l > 0.5 ? d / (2 - high - low) : d / (high + low)
    let h = high == r ? (g - b) / d + (g < b ? 6 : 0) : high == g ? (b - r) / d + 2 : (r - g) / d + 4
    return Tone(h: h * 60, s: s, l: l)
  }

  private static func color(_ h: Double, _ s: Double, _ l: Double) -> Color {
    let a = s * min(l, 1 - l)
    func channel(_ n: Double) -> Double {
      let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
      return l - a * max(-1, min(k - 3, 9 - k, 1))
    }
    return Color(red: channel(0), green: channel(8), blue: channel(4))
  }
}

/// The cover playing lights the room: its colours as three soft fields that drift into place when the
/// song changes and move as slowly as weather while it plays.
struct Mood: View {
  var palette: [Tone]?
  var playing: Bool
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var drift = false

  // Each field: where its center sits and its half-width and half-height, as parts of the room.
  private static let fields: [(UnitPoint, CGFloat, CGFloat)] = [
    (UnitPoint(x: 0.86, y: 0.16), 0.46, 0.52),
    (UnitPoint(x: 0.10, y: 0.82), 0.50, 0.58),
    (UnitPoint(x: 0.44, y: 0.36), 0.52, 0.58),
  ]

  var body: some View {
    GeometryReader { proxy in
      let box = CGSize(width: proxy.size.width * 1.28, height: proxy.size.height * 1.28)
      ZStack {
        if let palette {
          let colours = CoverPalette.mood(palette, dark: scheme == .dark)
          ZStack(alignment: .topLeading) {
            ForEach(0..<3, id: \.self) { index in
              let (at, wide, tall) = Self.fields[index]
              Ellipse()
                .fill(EllipticalGradient(stops: [
                  .init(color: colours[index], location: 0),
                  .init(color: colours[index].opacity(0.45), location: 0.42),
                  .init(color: .clear, location: 1),
                ], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5))
                .frame(width: box.width * wide * 2, height: box.height * tall * 2)
                .position(x: box.width * at.x, y: box.height * at.y)
            }
          }
          .frame(width: box.width, height: box.height)
          .scaleEffect(drift ? 1.07 : 1)
          .rotationEffect(.degrees(drift ? 2 : 0))
          .offset(x: drift ? -box.width * 0.03 : 0, y: drift ? box.height * 0.025 : 0)
          .id(palette)
          .transition(.opacity)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .clipped()
    }
    .animation(.easeInOut(duration: 3), value: palette)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onChange(of: playing && !reduceMotion, initial: true) { _, moving in
      withAnimation(moving ? .easeInOut(duration: 56).repeatForever(autoreverses: true) : .easeInOut(duration: 2)) {
        drift = moving
      }
    }
  }
}
