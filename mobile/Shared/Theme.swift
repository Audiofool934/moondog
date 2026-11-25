import SwiftUI
import UIKit

// The desktop window's material on a phone: ink on paper by day, moonlight at night. There is no
// accent colour; the cover brings the only colour. Ink is one colour at several strengths, so text,
// lines and fills always agree (app/renderer/tokens.css).
extension Color {
  static let paper = Color(light: 0xF7F6F2, dark: 0x141413)
  /// The ink itself, for drawings that set their own strengths.
  static let ink = ink(1, dark: 1)
  static let text = ink(0.93, dark: 0.92)
  static let text2 = ink(0.66, dark: 0.62)
  static let text3 = ink(0.50, dark: 0.46)
  static let wash = ink(0.06, dark: 0.08)

  private static func ink(_ light: Double, dark: Double) -> Color {
    Color(UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 237 / 255, green: 234 / 255, blue: 227 / 255, alpha: dark)
        : UIColor(red: 27 / 255, green: 26 / 255, blue: 23 / 255, alpha: light)
    })
  }

  init(light: UInt32, dark: UInt32) {
    func color(_ hex: UInt32) -> UIColor {
      UIColor(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    self.init(UIColor { $0.userInterfaceStyle == .dark ? color(dark) : color(light) })
  }
}

// Moondog's replies are the one place that reads like a page; everything else is steady UI text.
extension Font {
  static let reply = Font.system(.body, design: .serif)
  static let title = Font.system(.title, design: .serif)
}
