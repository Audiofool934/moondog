import SwiftUI

/// The listener's library on the Mac, the desktop's shelf: Saved first, then each playlist, by folder.
/// A playlist plays here, on the phone, through the same core as on the desktop.
struct LibraryView: View {
  @Environment(Room.self) private var room

  var body: some View {
    List {
      Section {
        ForEach(room.playlists.filter { $0.folderID == nil }) { row($0) }
      }
      ForEach(room.libraryFolders.filter { folder in room.playlists.contains { $0.folderID == folder.id } }) { folder in
        Section {
          ForEach(room.playlists.filter { $0.folderID == folder.id }) { row($0) }
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
    .navigationTitle("Library")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func row(_ playlist: Playlist) -> some View {
    NavigationLink {
      PlaylistView(playlist: playlist)
    } label: {
      HStack(spacing: 12) {
        Sleeve(cover: playlist.cover, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text(playlist.saved ? String(localized: "Saved") : playlist.name)
            .foregroundStyle(Color.text)
            .lineLimit(1)
          Text("\(playlist.count) songs")
            .font(.footnote)
            .foregroundStyle(Color.text3)
        }
      }
    }
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
  }
}

/// One playlist: play it from the top or shuffled, or from any song in it.
private struct PlaylistView: View {
  var playlist: Playlist
  @Environment(Room.self) private var room

  var body: some View {
    let detail = room.openPlaylist?.id == playlist.id ? room.openPlaylist : nil
    List {
      HStack(spacing: 10) {
        Button { room.play(playlist: playlist.id) } label: {
          Label("Play", systemImage: "play.fill").frame(maxWidth: .infinity, minHeight: 32)
        }
        .buttonStyle(.glassProminent)
        .tint(Color.text)
        .foregroundStyle(Color.paper)
        Button { room.play(playlist: playlist.id, shuffle: true) } label: {
          Label("Shuffle", systemImage: "shuffle").frame(maxWidth: .infinity, minHeight: 32)
        }
        .buttonStyle(.glass)
        .foregroundStyle(Color.text)
      }
      .disabled(playlist.count == 0 || !room.online)
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .padding(.vertical, 6)

      if let detail {
        ForEach(detail.entries) { entry in
          Button { room.play(playlist: playlist.id, from: entry.id) } label: {
            HStack(spacing: 12) {
              Sleeve(cover: entry.cover, size: 40)
              VStack(alignment: .leading, spacing: 1) {
                Text(entry.title).foregroundStyle(Color.text)
                Text(entry.made ? String(localized: "Made by Moondog") : entry.artist)
                  .font(.footnote)
                  .foregroundStyle(Color.text2)
              }
              .lineLimit(1)
              Spacer(minLength: 0)
            }
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }
      } else {
        ScratchMark()
          .frame(maxWidth: .infinity)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Color.paper)
    .overlay {
      if detail?.entries.isEmpty == true {
        Text("Nothing here yet")
          .font(.callout)
          .foregroundStyle(Color.text3)
      }
    }
    .navigationTitle(playlist.saved ? String(localized: "Saved") : playlist.name)
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { room.openPlaylistOnMac(playlist.id) }
    .onDisappear { room.openPlaylistOnMac(nil) }
  }
}
