import SwiftUI

/// Every conversation on the Mac, as the desktop's sidebar lists them: pinned first, then the rest, and
/// each folder's below. They are the Mac's, shared with the desktop app and the terminal, so one opened
/// or started here is there too. The library and Settings sit above them.
struct ConversationsView: View {
  @Environment(Room.self) private var room
  @Environment(\.dismiss) private var dismiss
  @State private var settings = false
  @State private var renaming: Conversation?
  @State private var title = ""
  @State private var deleting: Conversation?

  var body: some View {
    NavigationStack {
      List {
        NavigationLink {
          LibraryView()
        } label: {
          Label("Library", systemImage: "square.stack")
            .foregroundStyle(Color.text)
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)

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
      .background(Color.paper)
      .overlay {
        if room.conversations.isEmpty {
          Text(room.online ? "No conversations yet" : "Waiting for your Mac")
            .font(.callout)
            .foregroundStyle(Color.text3)
        }
      }
      .navigationTitle("Conversations")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { settings = true } label: { Image(systemName: "gearshape") }
            .accessibilityLabel(Text("Settings"))
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            room.newConversation()
            dismiss()
          } label: { Image(systemName: "square.and.pencil") }
            .accessibilityLabel(Text("New conversation"))
            .disabled(!room.online || room.turn != nil)
        }
      }
      .sheet(isPresented: $settings) { SettingsView() }
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
    .tint(Color.text)
    .presentationBackground(Color.paper)
    .presentationDragIndicator(.visible)
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
