import SwiftUI

/// The desktop's sidebar on a phone. Settings sits on the left, Chats, Library and Taste in the middle as
/// the system's own segmented control, whose glass the listener can drag between them, and on the right
/// the + of whichever shows, as on the desktop: a folder for the conversations, and for the library a
/// playlist, a folder, or a playlist from a link. Taste makes nothing. A new conversation stays outside,
/// in the room's bar. Each shows the Mac's own, shared with the desktop app and the terminal.
struct SidebarView: View {
  enum Pane: Hashable { case chats, library, taste }
  /// What the + is naming, in its alert.
  enum Naming: Identifiable { case chatFolder, playlist, libraryFolder, link; var id: Self { self } }

  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @State private var pane = Pane.chats
  @State private var settings = false
  @State private var renaming: Conversation?
  @State private var title = ""
  @State private var deleting: Conversation?
  @State private var naming: Naming?
  @State private var name = ""
  @State private var renamingFolder: ConversationFolder?

  var body: some View {
    @Bindable var room = room
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
      .alert(namingTitle, isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
        TextField(naming == .link ? "https://" : String(localized: "Name"), text: $name)
          .textInputAutocapitalization(naming == .link ? .never : .sentences)
          .keyboardType(naming == .link ? .URL : .default)
        Button(naming == .link ? "Read it" : "Make") { make() }
        Button("Cancel", role: .cancel) {}
      } message: {
        if naming == .link { Text("A playlist from Spotify, Apple Music, NetEase Cloud Music or QQ Music.") }
      }
      .alert(item: $room.importPreview) { preview in
        Alert(title: Text("Import “\(preview.name)”?"), message: Text(importDetail(preview)),
              primaryButton: .default(Text("Import and let it shape my taste")) { room.keepImport(preview, shapingTaste: true) },
              secondaryButton: .default(Text("Import")) { room.keepImport(preview, shapingTaste: false) })
      }
    }
    .tint(Color.text)
    .presentationBackground(Color.paper)
    .presentationDragIndicator(.visible)
  }

  // MARK: The top row

  private var header: some View {
    HStack(spacing: 10) {
      Button { settings = true } label: {
        Image(systemName: "gearshape")
          .font(.system(size: 17))
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .foregroundStyle(Color.text)
      .glassEffect(.regular.interactive(), in: .circle)
      .accessibilityLabel(Text("Settings"))

      // The system's own control: its glass follows a tap, and a finger can drag it across.
      Picker("Sidebar", selection: $pane) {
        Text("Chats").tag(Pane.chats)
        Text("Library").tag(Pane.library)
        Text("Taste").tag(Pane.taste)
      }
      .pickerStyle(.segmented)
      .controlSize(.large)

      add
    }
    .padding(.horizontal, 16)
    .padding(.top, 22)
    .padding(.bottom, 10)
  }

  /// The + of the panel that shows.
  @ViewBuilder private var add: some View {
    let label = Image(systemName: room.importing && pane == .library ? "ellipsis" : "plus")
      .font(.system(size: 17, weight: .medium))
      .symbolEffect(.pulse, isActive: room.importing && pane == .library)
      .frame(width: 44, height: 44)
    switch pane {
    case .chats:
      Button { ask(.chatFolder) } label: { label }
        .buttonStyle(.plain)
        .foregroundStyle(Color.text)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text("New folder"))
        .disabled(!room.online)
    case .library:
      Menu {
        Button { ask(.playlist) } label: { Label("New playlist", systemImage: "music.note.list") }
        Button { ask(.libraryFolder) } label: { Label("New folder", systemImage: "folder.badge.plus") }
        Divider()
        Button { ask(.link) } label: { Label("Import a playlist…", systemImage: "link") }
      } label: { label }
        .buttonStyle(.plain)
        .foregroundStyle(Color.text)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text("New in the library"))
        .disabled(!room.online || room.importing)
    case .taste:
      // Taste makes nothing, as on the desktop; the + stays in its place, so the row doesn't move.
      label
        .foregroundStyle(Color.text3)
        .glassEffect(.regular, in: .circle)
        .opacity(0.5)
        .accessibilityHidden(true)
    }
  }

  private func ask(_ kind: Naming) {
    name = ""
    naming = kind
  }

  private var namingTitle: LocalizedStringKey {
    switch naming {
    case .chatFolder, .libraryFolder: "New folder"
    case .playlist: "New playlist"
    case .link: "Paste a playlist link"
    case nil: ""
    }
  }

  private func make() {
    switch naming {
    case .chatFolder: room.newFolder(name)
    case .playlist: room.newPlaylist(name)
    case .libraryFolder: room.newLibraryFolder(name)
    case .link: room.previewImport(name)
    case nil: break
    }
  }

  private func importDetail(_ preview: ImportPreview) -> String {
    let count = preview.total.map { $0 > preview.read ? String(localized: "\(preview.read) of \($0) songs") : nil } ?? nil
    return ([count ?? String(localized: "\(preview.read) songs")] + preview.sample.prefix(4)).joined(separator: "\n")
  }

  // MARK: Chats

  private var chats: some View {
    List {
      Section {
        ForEach(loose) { row($0) }
      }
      ForEach(room.folders) { folder in
        let inside = room.conversations.filter { $0.folderID == folder.id }
        Section {
          ForEach(inside) { row($0) }
          if inside.isEmpty {
            Text("Empty. Press a conversation to move it here.")
              .font(.footnote)
              .foregroundStyle(Color.text3)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        } header: {
          Text(folder.name)
            .font(.footnote)
            .foregroundStyle(Color.text3)
            .contextMenu {
              Button {
                name = folder.name
                renamingFolder = folder
              } label: { Label("Rename", systemImage: "pencil") }
              Button(role: .destructive) { room.deleteFolder(folder.id) } label: {
                Label("Delete folder", systemImage: "folder.badge.minus")
              }
            }
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
    .alert("Rename folder", isPresented: Binding(get: { renamingFolder != nil }, set: { if !$0 { renamingFolder = nil } })) {
      TextField("Name", text: $name)
      Button("Rename") {
        if let renamingFolder { room.renameFolder(renamingFolder.id, name) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Deleting a folder keeps its conversations.")
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
      if !room.folders.isEmpty {
        Menu {
          ForEach(room.folders) { folder in
            Button(folder.name) { room.move(conversation.id, to: folder.id) }
              .disabled(conversation.folderID == folder.id)
          }
          if conversation.folderID != nil {
            Divider()
            Button("Out of the folder") { room.move(conversation.id, to: nil) }
          }
        } label: { Label("Move to folder", systemImage: "folder") }
      }
      Button(role: .destructive) { deleting = conversation } label: { Label("Delete", systemImage: "trash") }
    }
  }
}
