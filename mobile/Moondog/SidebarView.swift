import SwiftUI

/// The desktop's sidebar on a phone: Chats, Library and Taste in a row of glass at the top, with a new
/// conversation beside Chats and Settings at the end. Each shows the Mac's own: its conversations, shared
/// with the desktop app and the terminal, its library, and the profile Moondog's taste rests on.
struct SidebarView: View {
  enum Pane: Hashable { case chats, library, taste }

  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @State private var pane = Pane.chats
  @State private var settings = false
  @State private var renaming: Conversation?
  @State private var title = ""
  @State private var deleting: Conversation?

  var body: some View {
    NavigationStack {
      Group {
        switch pane {
        case .chats: chats
        case .library: LibraryView()
        case .taste: TasteView { dismiss() }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Color.paper)
      .safeAreaInset(edge: .top, spacing: 0) { header }
      .toolbarVisibility(.hidden, for: .navigationBar)
      .sheet(isPresented: $settings) { SettingsView() }
    }
    .tint(Color.text)
    .presentationBackground(Color.paper)
    .presentationDragIndicator(.visible)
  }

  // MARK: The row of glass

  private var header: some View {
    GlassEffectContainer(spacing: 10) {
      HStack(spacing: 8) {
        tab(.chats, "Chats")
        // Always here, so the row stays still whichever of the three shows.
        Button {
          room.newConversation()
          dismiss()
        } label: {
          Image(systemName: "plus")
            .font(.system(size: 15, weight: .semibold))
            .frame(width: 38, height: 38)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.text)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text("New conversation"))
        .disabled(!room.online || room.turn != nil)
        tab(.library, "Library")
        tab(.taste, "Taste")
        Spacer(minLength: 0)
        Button { settings = true } label: {
          Image(systemName: "gearshape")
            .font(.system(size: 16))
            .frame(width: 38, height: 38)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.text)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text("Settings"))
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 22)
    .padding(.bottom, 10)
  }

  /// One of the three: ink when chosen, clear glass otherwise.
  private func tab(_ value: Pane, _ label: LocalizedStringKey) -> some View {
    let chosen = pane == value
    return Button { pane = value } label: {
      Text(label)
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
        .padding(.horizontal, 14)
        .frame(height: 38)
    }
    .buttonStyle(.plain)
    .foregroundStyle(chosen ? Color.paper : Color.text)
    .glassEffect(chosen ? .regular.tint(Color.text).interactive() : .regular.interactive(), in: .capsule)
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }

  // MARK: Chats

  private var chats: some View {
    List {
      Section {
        ForEach(loose) { row($0) }
      }
      ForEach(room.folders.filter { folder in room.conversations.contains { $0.folderID == folder.id } }) { folder in
        Section {
          ForEach(room.conversations.filter { $0.folderID == folder.id }) { row($0) }
        } header: {
          Text(folder.name)
            .font(.footnote)
            .foregroundStyle(Color.text3)
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .overlay {
      if room.conversations.isEmpty {
        Text(room.online ? "No conversations yet" : "Waiting for your Mac")
          .font(.callout)
          .foregroundStyle(Color.text3)
      }
    }
    .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $title)
      Button("Rename") {
        if let renaming { room.rename(renaming.id, title) }
      }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog(
      "Delete this conversation?",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible,
      presenting: deleting
    ) { conversation in
      Button("Delete", role: .destructive) { room.delete(conversation.id) }
    } message: { _ in
      Text("It is deleted on your Mac too.")
    }
  }

  /// Conversations in no folder, pinned ones first, as the Mac sends them.
  private var loose: [Conversation] { room.conversations.filter { $0.folderID == nil } }

  private func row(_ conversation: Conversation) -> some View {
    let shown = conversation.id == room.current
    return Button {
      room.open(conversation.id)
      dismiss()
    } label: {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(conversation.title.isEmpty ? String(localized: "New conversation") : conversation.title)
            .font(.body.weight(shown ? .semibold : .regular))
            .foregroundStyle(Color.text)
            .lineLimit(1)
          if let date = conversation.updatedAt {
            Text(date, format: .relative(presentation: .named))
              .font(.footnote)
              .foregroundStyle(Color.text3)
          }
        }
        Spacer(minLength: 0)
        if room.running.contains(conversation.id) {
          ScratchMark()
            .accessibilityLabel(Text("Answering"))
        } else if conversation.pinned {
          Image(systemName: "pin.fill")
            .font(.caption)
            .foregroundStyle(Color.text3)
            .accessibilityLabel(Text("Pinned"))
        }
      }
      .padding(.vertical, 4)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .listRowBackground(shown ? Color.wash : Color.clear)
    .listRowSeparator(.hidden)
    .swipeActions(edge: .trailing) {
      Button { deleting = conversation } label: { Label("Delete", systemImage: "trash") }
        .tint(.red)
    }
    .swipeActions(edge: .leading) {
      Button { room.setPinned(conversation.id, !conversation.pinned) } label: {
        Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
      }
      .tint(Color.text2)
    }
    .contextMenu {
      Button {
        title = conversation.title
        renaming = conversation
      } label: { Label("Rename", systemImage: "pencil") }
      Button { room.setPinned(conversation.id, !conversation.pinned) } label: {
        Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
      }
      Button(role: .destructive) { deleting = conversation } label: { Label("Delete", systemImage: "trash") }
    }
  }
}
