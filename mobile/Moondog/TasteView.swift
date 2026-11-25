import SwiftUI

/// Your taste, as the desktop's sidebar shows it (app/renderer/taste-list.mjs): every artist and track
/// Moondog's profile rests on, filtered by kind or by your own choices. A row opens to say why it is there,
/// and to like it, keep it out, or undo that; a track can also start Find more like this.
struct TasteView: View {
  /// Called when a request starts, so the sidebar can make way for the reply.
  var asked: () -> Void
  @Environment(Room.self) private var room
  @State private var filter = Filter.all
  @State private var open: String?

  enum Filter: CaseIterable { case all, artists, tracks, choices }

  var body: some View {
    Group {
      if let taste = room.taste {
        if taste.ready && !taste.subjects.isEmpty {
          list(taste)
        } else {
          VStack(spacing: 6) {
            ForEach(taste.lines, id: \.self) { Text($0) }
          }
          .font(.callout)
          .foregroundStyle(Color.text3)
          .multilineTextAlignment(.center)
          .padding(32)
          .frame(maxHeight: .infinity)
        }
      } else {
        ScratchMark()
          .frame(maxHeight: .infinity)
      }
    }
    // Asked for each time it shows, as the desktop does, so a choice made elsewhere is here too.
    .onAppear { room.refreshTaste() }
  }

  private func list(_ taste: Taste) -> some View {
    let shown = subjects(taste, filter)
    return List {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(Filter.allCases, id: \.self) { value in
            chip(value, count: subjects(taste, value).count)
          }
        }
      }
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))

      if shown.isEmpty, filter == .choices {
        Text("Nothing here yet. Open an artist or a track to like it or keep it out.")
          .font(.callout)
          .foregroundStyle(Color.text3)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
      }
      ForEach(shown) { subject in
        row(subject, taste)
          .listRowBackground(open == subject.id ? Color.wash : Color.clear)
          .listRowSeparator(.hidden)
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .animation(.smooth(duration: 0.25), value: open)
  }

  private func subjects(_ taste: Taste, _ value: Filter) -> [TasteSubject] {
    switch value {
    case .all: taste.subjects
    case .artists: taste.subjects.filter { $0.kind == "artist" }
    case .tracks: taste.subjects.filter { $0.kind == "track" }
    case .choices: taste.subjects.filter(\.chosen)
    }
  }

  private func chip(_ value: Filter, count: Int) -> some View {
    let chosen = filter == value
    let name: LocalizedStringKey = switch value {
    case .all: "All"
    case .artists: "Artists"
    case .tracks: "Tracks"
    case .choices: "Choices"
    }
    return Button { filter = value } label: {
      HStack(spacing: 5) {
        Text(name)
        Text(count, format: .number).foregroundStyle(Color.text3)
      }
      .font(.footnote.weight(chosen ? .semibold : .regular))
      .foregroundStyle(Color.text)
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(chosen ? Color.wash : Color.clear, in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }

  private func row(_ subject: TasteSubject, _ taste: Taste) -> some View {
    let unfolded = open == subject.id
    return VStack(alignment: .leading, spacing: 0) {
      Button { open = unfolded ? nil : subject.id } label: {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            Text(subject.label)
              .font(.body.weight(.medium))
              .foregroundStyle(Color.text)
            Text(shownLine(subject))
              .font(.footnote)
              .foregroundStyle(Color.text2)
              .lineLimit(unfolded ? nil : 1)
          }
          Spacer(minLength: 0)
          if let stance = subject.stance {
            Text(stance == "like" ? "You like this" : "Kept out")
              .font(.caption)
              .foregroundStyle(Color.text3)
          }
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityAddTraits(unfolded ? .isSelected : [])

      if unfolded { detail(subject, taste) }
    }
  }

  /// A track shows its artist; an artist where it comes from. A choice comes first among the details, and
  /// its mark says it already, so the line after it shows instead.
  private func shownLine(_ subject: TasteSubject) -> String {
    let first = (subject.chosen && subject.details.count > 1 ? subject.details[1] : subject.details.first) ?? ""
    return subject.kind == "track" || first.isEmpty ? subject.subtitle : first
  }

  private func detail(_ subject: TasteSubject, _ taste: Taste) -> some View {
    let why = subject.evidenceID.flatMap { room.tasteWhy[$0] }
    return VStack(alignment: .leading, spacing: 8) {
      // The line under the name already shows; the rest follow it.
      ForEach(Array(subject.details.enumerated()), id: \.offset) { _, line in
        if line != shownLine(subject) { Text(line) }
      }
      if let why {
        if !why.basis.isEmpty { Text(why.basis) }
        if !why.limit.isEmpty {
          Text("What it can't tell me").foregroundStyle(Color.text3).padding(.top, 4)
          Text(why.limit).foregroundStyle(Color.text2)
        }
        if let confidence = why.confidence {
          Text("How sure: \(Int((confidence * 100).rounded()))%").foregroundStyle(Color.text3)
        }
      }
      // The actions in one row, which scrolls when they run past the edge.
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
        if subject.evidenceID != nil && why == nil {
          action("Why it's here", "questionmark.circle") { room.explain(subject) }
        }
        if taste.canChoose {
          if subject.stance != "like" { action("I like this", "heart") { room.choose("like", for: subject) } }
          if subject.stance != "avoid" { action("Keep it out", "hand.raised") { room.choose("avoid", for: subject) } }
          if subject.chosen { action("Undo my choice", "arrow.uturn.backward") { room.choose("retract", for: subject) } }
        }
        if subject.kind == "track" && taste.ask != nil {
          action("Find more like this", "sparkle.magnifyingglass") {
            if room.findMore(like: subject) { asked() }
          }
        }
        }
        .padding(.vertical, 2)
      }
      .scrollClipDisabled()
      .padding(.top, 6)
    }
    .font(.subheadline)
    .foregroundStyle(Color.text)
    .padding(.top, 6)
    .padding(.bottom, 8)
  }

  private func action(_ label: LocalizedStringKey, _ symbol: String, _ run: @escaping () -> Void) -> some View {
    Button(action: run) {
      Label(label, systemImage: symbol)
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 2)
    }
    .buttonStyle(.glass)
    .controlSize(.small)
    .foregroundStyle(Color.text)
    .disabled(!room.online)
  }
}
