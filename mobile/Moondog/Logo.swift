import SwiftUI

/// The logo's small version, as numbers: written by `npm run logo` from src/surfaces/brand/logo.mjs.
/// The record has radius 1 around 0,0; y grows downward.
struct LogoFigure: Decodable {
  struct Cup: Decodable {
    var center: [Double]
    var radius, ring, ringWidth, dot: Double
  }
  var head, band, bandGap: [[Double]]
  var gap, halo: Double
  var cup: Cup
  var grooves: [[Double]]
  var tonearm: [[[Double]]]

  static let shared: LogoFigure = {
    let url = Bundle.main.url(forResource: "logo-figure", withExtension: "json")!
    return try! JSONDecoder().decode(LogoFigure.self, from: Data(contentsOf: url))
  }()

  /// The box the mark is drawn in, with room for the arm beyond the rim (app/renderer/mark.mjs).
  static let box = CGRect(x: -1.06, y: -1.16, width: 2.32, height: 2.32)

  /// The corner the arm swings from: its parts' top right.
  var pivot: UnitPoint {
    let points = tonearm.flatMap { $0 }
    let x = points.map { $0[0] }.max()!, y = points.map { $0[1] }.min()!
    return UnitPoint(x: (x - Self.box.minX) / Self.box.width, y: (y - Self.box.minY) / Self.box.height)
  }
}

private struct Units {
  let scale: Double
  init(_ size: CGSize) { scale = min(size.width, size.height) / LogoFigure.box.width }
  func point(_ p: [Double]) -> CGPoint { point(p[0], p[1]) }
  func point(_ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: (x - LogoFigure.box.minX) * scale, y: (y - LogoFigure.box.minY) * scale)
  }
  func polygon(_ points: [[Double]], closed: Bool = true) -> Path {
    Path { path in
      path.addLines(points.map(point))
      if closed { path.closeSubpath() }
    }
  }
  func circle(_ x: Double, _ y: Double, _ r: Double) -> Path {
    Path(ellipseIn: CGRect(origin: point(x - r, y - r), size: CGSize(width: 2 * r * scale, height: 2 * r * scale)))
  }
  func arc(radius: Double, from: Double, length: Double) -> Path {
    Path { path in
      path.addArc(center: point(0, 0), radius: radius * scale, startAngle: .radians(from), endAngle: .radians(from + length), clockwise: false)
    }
  }
}

/// Moondog's mark, drawn from the logo's own numbers: the dog with headphones on the rim of a record.
/// While music plays the arm rests on the record and two glints travel its grooves; when the music
/// stops the arm lifts and the glints go, and the record rests as the logo.
struct RecordMark: View {
  var playing: Bool
  var armDown: Bool
  var ink: Color = .text

  private static let turn: TimeInterval = 8  // 64 frames of 125 ms, as on the desktop
  // Each glint: the groove it rides, where it starts, and its length, in radians.
  private static let glints: [(Int, Double, Double)] = [(1, -0.91, 0.24), (2, 2.44, 0.2)]
  private let figure = LogoFigure.shared
  @State private var since = Date.now
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(paused: !playing || reduceMotion)) { timeline in
      Canvas { context, size in draw(in: &context, size: size, at: timeline.date) }
    }
    .overlay {
      Canvas { context, size in
        let units = Units(size)
        for part in figure.tonearm { context.fill(units.polygon(part), with: .color(ink)) }
      }
      .rotationEffect(.degrees(armDown ? 0 : -28), anchor: figure.pivot)
      .animation(.spring(duration: 0.9, bounce: 0.35), value: armDown)
    }
    .aspectRatio(1, contentMode: .fit)
    .onChange(of: playing) { since = .now }
  }

  private func draw(in context: inout GraphicsContext, size: CGSize, at date: Date) {
    let units = Units(size)
    let head = units.polygon(figure.head), band = units.polygon(figure.band)
    let cup = units.circle(figure.cup.center[0], figure.cup.center[1], figure.cup.radius)
    // The record: rim and grooves, kept clear of the dog, with the glints cut out of them.
    context.drawLayer { layer in
      for groove in figure.grooves {
        layer.stroke(units.circle(0, 0, groove[0]), with: .color(ink), lineWidth: groove[1] * units.scale)
      }
      layer.blendMode = .destinationOut
      let margin = StrokeStyle(lineWidth: figure.halo * 2 * units.scale, lineJoin: .round)
      for shape in [head, band, cup] {
        layer.fill(shape, with: .color(.black))
        layer.stroke(shape, with: .color(.black), style: margin)
      }
      guard playing else { return }
      let fade = reduceMotion ? 1 : min(1, date.timeIntervalSince(since) / 0.6)
      let angle = reduceMotion ? 0 : date.timeIntervalSince(since) / Self.turn * 2 * .pi
      layer.opacity = fade
      for (index, from, length) in Self.glints {
        let groove = figure.grooves[index]
        layer.stroke(units.arc(radius: groove[0], from: from + angle, length: length), with: .color(.black), lineWidth: groove[1] * 1.6 * units.scale)
      }
    }
    // The dog, cut into head, band and earcup by the logo's gaps.
    context.drawLayer { layer in
      for shape in [head, band, cup] { layer.fill(shape, with: .color(ink)) }
      layer.blendMode = .destinationOut
      let (cx, cy) = (figure.cup.center[0], figure.cup.center[1])
      layer.stroke(units.circle(cx, cy, figure.cup.radius + figure.gap / 2), with: .color(.black), lineWidth: figure.gap * units.scale)
      layer.stroke(units.polygon(figure.bandGap, closed: false), with: .color(.black), lineWidth: figure.gap * units.scale)
      layer.stroke(units.circle(cx, cy, figure.cup.ring), with: .color(.black), lineWidth: figure.cup.ringWidth * units.scale)
      layer.fill(units.circle(cx, cy, figure.cup.dot), with: .color(.black))
    }
  }
}

/// The working mark, in place of a spinner: not the logo but one of its parts, the glints that travel
/// its grooves, scratched back and forth about the spindle and stretched by each stroke.
struct ScratchMark: View {
  private static let period: TimeInterval = 1.6
  // Keyframes of the desktop's scratch: time, glint length and where it sits, in turns.
  private static let frames: [(Double, Double, Double)] = [
    (0, 0.05, 0.545), (0.06, 0.16, 0.41), (0.12, 0.05, 0.375), (0.18, 0.15, 0.395), (0.25, 0.05, 0.505),
    (0.31, 0.12, 0.41), (0.37, 0.05, 0.395), (0.43, 0.10, 0.41), (0.5, 0.05, 0.475), (1, 0.05, 0.545),
  ]
  private static let grooves: [(Double, Double)] = [(0.84, 118), (0.5, -62)]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(paused: reduceMotion)) { timeline in
      Canvas { context, size in
        let r = min(size.width, size.height) / 2
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let (length, offset) = Self.stroke(at: timeline.date.timeIntervalSinceReferenceDate)
        for (radius, start) in Self.grooves {
          let ring = Path(ellipseIn: CGRect(x: center.x - radius * r, y: center.y - radius * r, width: 2 * radius * r, height: 2 * radius * r))
          var faint = context
          faint.opacity = 0.28
          faint.stroke(ring, with: .foreground, lineWidth: 0.13 * r)
          let from = Angle.degrees(start + offset * 360)
          let glint = Path { path in
            path.addArc(center: center, radius: radius * r, startAngle: from, endAngle: from + .degrees(length * 360), clockwise: false)
          }
          context.stroke(glint, with: .foreground, style: StrokeStyle(lineWidth: 0.22 * r, lineCap: .round))
        }
        context.fill(Path(ellipseIn: CGRect(x: center.x - 0.13 * r, y: center.y - 0.13 * r, width: 0.26 * r, height: 0.26 * r)), with: .foreground)
      }
    }
    .frame(width: 16, height: 16)
    .accessibilityHidden(true)
  }

  private static func stroke(at time: TimeInterval) -> (Double, Double) {
    let t = time.truncatingRemainder(dividingBy: period) / period
    let after = frames.firstIndex { $0.0 > t } ?? frames.count - 1
    let (t0, l0, o0) = frames[after - 1], (t1, l1, o1) = frames[after]
    var k = (t - t0) / (t1 - t0)
    if t0 < 0.5 { k = k * k * (3 - 2 * k) }
    return (l0 + (l1 - l0) * k, o0 + (o1 - o0) * k)
  }
}

/// What the host says while it works, as a radio host would; a new line for each turn.
enum HostLine {
  static let all: [LocalizedStringResource] = [
    "Reading the room", "Checking the request line", "Finding the groove", "Working the decks",
    "Planning the segue", "Mic check", "Riding the faders", "Finding the cue",
  ]
  static func any() -> LocalizedStringResource { all.randomElement()! }
}

/// The lunar record the terminal opens with, as dots: the frames `npm run logo` writes from
/// src/surfaces/cli/terminal-art.mjs, the same ones the desktop window draws above the words.
final class RecordDots {
  static let shared = RecordDots()
  /// Each layer's ink, as on the desktop: grooves, surface, the dog and the arm.
  static let ink: [Double] = [0, 0.22, 0.5, 0.93]
  static let frameCount = 64

  let width: Int
  let lifted: Double
  /// The record's center and radius on the grid, in dots.
  let center: [Double]
  let radius: Double
  private let frames: [Data]
  private let arms: [Data]
  private var frameDots: [Int: [[Int]]] = [:]
  private var armDots: [Int: [Int]] = [:]

  private struct File: Decodable {
    var width: Int
    var lifted: Double
    var center: [Double]
    var radius: Double
    var frames: [String]
    var arm: [String]
  }

  private init() {
    let url = Bundle.main.url(forResource: "record-dots", withExtension: "json")!
    let file = try! JSONDecoder().decode(File.self, from: Data(contentsOf: url))
    width = file.width
    lifted = file.lifted
    center = file.center
    radius = file.radius
    frames = file.frames.map { Data(base64Encoded: $0)! }
    arms = file.arm.map { Data(base64Encoded: $0)! }
  }

  /// The cells each layer inks in one frame of the turn, worked out once and kept.
  func layers(_ frame: Int) -> [[Int]] {
    if let known = frameDots[frame] { return known }
    var layers: [[Int]] = [[], [], [], []]
    unpack(frames[frame]) { at, layer in layers[layer].append(at) }
    frameDots[frame] = layers
    return layers
  }

  /// The arm's cells at a step of its swing, 0 on the record to the last step lifted off it.
  var armSteps: Int { arms.count - 1 }
  func arm(_ step: Int) -> [Int] {
    if let known = armDots[step] { return known }
    var cells: [Int] = []
    unpack(arms[step]) { at, _ in cells.append(at) }
    armDots[step] = cells
    return cells
  }

  private func unpack(_ data: Data, _ each: (Int, Int) -> Void) {
    for (index, byte) in data.enumerated() where byte != 0 {
      for slot in 0..<4 {
        let layer = Int(byte >> (slot * 2) & 3)
        if layer != 0 { each(index * 4 + slot, layer) }
      }
    }
  }

  /// Dots as one path, each centered on a pixel so rows of them never beat against the screen.
  func path(_ cells: [Int], size: CGFloat, scale: CGFloat) -> Path {
    let pitch = size / CGFloat(width)
    let radius = pitch * 0.32
    let snap: (CGFloat) -> CGFloat = pitch * scale >= 1.9 ? { (($0 * scale - 0.5).rounded() + 0.5) / scale } : { $0 }
    var path = Path()
    for at in cells {
      let x = snap((CGFloat(at % width) + 0.5) * pitch)
      let y = snap((CGFloat(at / width) + 0.5) * pitch)
      path.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
    }
    return path
  }
}

/// The record above the conversation, drawn in dots as on the desktop. It turns a frame every eighth
/// of a second while music plays and rests where it stopped; its arm rests on it while music plays
/// and swings off when the music stops.
struct DotRecord: View {
  var playing: Bool
  var armDown: Bool
  /// The playing cover's colours for the grooves, rim inward, or nil for ink.
  var grooves: [Color]? = nil

  private static let interval: TimeInterval = 0.125
  @State private var since = Date.now
  @State private var rest = 0
  @Environment(\.displayScale) private var scale
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.periodic(from: since, by: Self.interval)) { timeline in
      let frame = turning ? frame(at: timeline.date) : rest
      ZStack {
        // The grooves alone, so a new cover's colours can drift in over the last ones.
        Grooves(frame: frame, colours: grooves, scale: scale)
          .id(grooves)
          .transition(.opacity)
        Canvas { context, size in
          let dots = RecordDots.shared
          let layers = dots.layers(frame)
          for layer in 2...3 {
            context.fill(dots.path(layers[layer], size: size.width, scale: scale), with: .color(.ink.opacity(RecordDots.ink[layer])))
          }
        }
      }
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 2.4), value: grooves)
    .overlay { Arm(swing: armDown ? 0 : 1, scale: scale) }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.56), value: armDown)
    .aspectRatio(1, contentMode: .fit)
    .onChange(of: turning) { _, now in
      if now { since = .now } else { rest = frame(at: .now) }
    }
  }

  private var turning: Bool { playing && !reduceMotion }

  private func frame(at date: Date) -> Int {
    (rest + Int(max(0, date.timeIntervalSince(since)) / Self.interval)) % RecordDots.frameCount
  }

  /// The grooves in ink, or in a cover's three colours from the rim inward, a little stronger so the colour reads.
  private struct Grooves: View {
    var frame: Int
    var colours: [Color]?
    var scale: CGFloat

    var body: some View {
      Canvas { context, size in
        let dots = RecordDots.shared
        let path = dots.path(dots.layers(frame)[1], size: size.width, scale: scale)
        guard let colours, colours.count == 3 else {
          context.fill(path, with: .color(.ink.opacity(RecordDots.ink[1])))
          return
        }
        let pitch = size.width / CGFloat(dots.width)
        let center = CGPoint(x: (dots.center[0] + 0.5) * pitch, y: (dots.center[1] + 0.5) * pitch)
        let radius = dots.radius * pitch
        let gradient = Gradient(stops: [.init(color: colours[2], location: 0), .init(color: colours[1], location: 0.55), .init(color: colours[0], location: 1)])
        context.opacity = 0.6
        context.fill(path, with: .radialGradient(gradient, center: center, startRadius: radius * 0.45, endRadius: radius))
      }
    }
  }

  /// The arm on its own, so it can swing: 0 rests it on the record, 1 lifts it off.
  private struct Arm: View, Animatable {
    var swing: Double
    var scale: CGFloat
    var animatableData: Double {
      get { swing }
      set { swing = newValue }
    }

    var body: some View {
      Canvas { context, size in
        let dots = RecordDots.shared
        let step = Int((swing * Double(dots.armSteps)).rounded())
        context.fill(dots.path(dots.arm(step), size: size.width, scale: scale), with: .color(.ink.opacity(RecordDots.ink[3])))
      }
    }
  }
}
