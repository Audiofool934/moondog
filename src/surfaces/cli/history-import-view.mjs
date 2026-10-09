import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  getCapabilities,
  getKeybindings,
  hyperlink,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { FreshCompletionEditor } from "./brand-components.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";
import { IMPORT_GUIDE_URLS } from "./import-guides.mjs";
import { SPOTIFY_LIBRARY_SCOPES } from "../../integrations/spotify/library-snapshot.mjs";
import { screenTranslator } from "../../i18n/index.mjs";

function clean(value) {
  return sanitizeTerminalText(stripVTControlCharacters(String(value ?? "")))
    .replace(/\s+/gu, " ").trim();
}

function fit(value, width) {
  const clipped = truncateToWidth(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function paint(value, width, theme) {
  const line = fit(value, width);
  // Keep Pi's zero-width hardware cursor marker in NO_COLOR terminals.
  return theme.plain ? line.replace(/\u001b\[[\d;:]*m/g, "") : theme.background(theme.text(line));
}

function safeEditorLine(value) {
  // Preserve Pi's styling and cursor protocol, but remove controls from paths.
  return value.split(CURSOR_MARKER).map((part) => part.split(/(\u001b\[[\d;:]*m)/gu)
    .map((segment) => /^\u001b\[[\d;:]*m$/u.test(segment) ? segment
      : sanitizeTerminalText(stripVTControlCharacters(segment)).replace(/[\r\n\t]/gu, " "))
    .join("")).join(CURSOR_MARKER);
}

function day(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/** Acquisition guidance and file review; all effects belong to the host. */
export class HistoryImportView {
  constructor({ tui, getTheme, getRows, profileReady = false, onAction, getText = () => screenTranslator("en") }) {
    this.getTheme = getTheme;
    this.getText = getText;
    this.getRows = getRows;
    this.profileReady = profileReady;
    this.onAction = onAction;
    this.state = { page: "start" };
    this.selected = 0;
    this.contentOffset = 0;
    this.contentPageSize = 1;
    this.contentMaxOffset = 0;
    this.pasteActive = false;
    this.pasteTail = "";
    this._focused = false;
    const selectList = Object.fromEntries(
      ["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"]
        .map((key) => [key, (text) => this.getTheme().selectListTheme[key](text)]),
    );
    this.editor = new FreshCompletionEditor(tui, {
      borderColor: (text) => this.getTheme().faint(text), selectList,
    }, { paddingX: 1, autocompleteMaxVisible: 3 });
    const completion = new CombinedAutocompleteProvider([], process.cwd(), null);
    // This editor contains one path, so absolute paths are not slash commands.
    // A temporary quote also lets Pi complete a literal path containing spaces.
    const quotedInput = (lines, line, column) => {
      const quoted = !String(lines[line] ?? "").startsWith('"');
      const input = [...lines];
      if (quoted) input[line] = `"${input[line] ?? ""}`;
      return { lines: input, column: column + Number(quoted), quoted };
    };
    this.editor.setAutocompleteProvider({
      async getSuggestions(lines, line, column, options) {
        const input = quotedInput(lines, line, column);
        const result = await completion.getSuggestions(input.lines, line, input.column, { ...options, force: true });
        return result && { ...result, prefix: input.quoted ? result.prefix.slice(1) : result.prefix };
      },
      applyCompletion(lines, line, column, item, prefix) {
        const input = quotedInput(lines, line, column);
        return completion.applyCompletion(input.lines, line, input.column, item, input.quoted ? `"${prefix}` : prefix);
      },
    });
    // Pi clears its editor on submit, including after accepting some completions.
    this.editor.onSubmit = (text) => {
      this.editor.setText(text);
      this.emit("inspect", { path: this.getPath() });
    };
    this.clientEditor = new Editor(tui, {
      borderColor: (text) => this.getTheme().faint(text), selectList,
    }, { paddingX: 1 });
    this.clientEditor.onSubmit = (text) => {
      this.clientEditor.setText(text);
      this.emit("configureSpotify", { clientId: text.trim() });
    };
  }

  get focused() { return this._focused; }
  set focused(value) {
    this._focused = Boolean(value);
    this.editor.focused = this._focused && this.state.page === "file";
    this.clientEditor.focused = this._focused && this.state.page === "client";
    if (!value) this.editor.setText(this.getPath());
  }

  invalidate() { this.editor.invalidate(); this.clientEditor.invalidate(); }
  getPath() { return this.editor.getExpandedText(); }
  setPath(value) { this.editor.setText(String(value ?? "")); }

  setState(state) {
    const next = { page: "start", ...state };
    if (next.page !== this.state.page) {
      this.selected = 0;
      this.contentOffset = 0;
      this.pasteActive = false;
      this.pasteTail = "";
      this.editor.setText(this.getPath());
      // A pasted Client ID must replace the old one, not join it. A failed save keeps the text to fix.
      if (next.page === "client" && this.state.page !== "working") this.clientEditor.setText("");
    }
    this.state = next;
    if (typeof state?.profileReady === "boolean") this.profileReady = state.profileReady;
    this.editor.focused = this._focused && next.page === "file";
    this.clientEditor.focused = this._focused && next.page === "client";
  }

  emit(type, detail = {}) { this.onAction?.({ type, ...detail }); }

  // A preview's source decides its label and note; brand names stay as they are.
  previewSource(preview) {
    const tr = this.getText();
    switch (preview.source) {
      case "spotify-quick-library": return [tr("Your Spotify library and recent plays"),
        tr("Your library shows what you keep and what Spotify ranks highest for you. Recent plays are your latest 50. A history ZIP can add years of listening later.")];
      case "spotify-quick-recent": return [tr("Spotify recent listening"),
        tr("Your latest plays, up to 50. Spotify doesn't say how long you listened here. A history ZIP can add the older ones later.")];
      case "apple-library": return [tr("Apple Music library"),
        tr("Your library with loves, ratings, play counts and when you last played each song. It doesn't list every play.")];
      case "listenbrainz": return [tr("ListenBrainz history"),
        tr("Your saved listens. Some don't say how long you listened, so they count as plays without minutes.")];
      case "spotify-extended": return [tr("Spotify Extended Streaming History"),
        tr("Every play in this file, with how long you listened and how each song started and ended.")];
      case "spotify-account": return [tr("Spotify Account Data"),
        tr("Your plays from the past year, plus your library and playlists. For older plays and listening time, use Extended streaming history.")];
      case "youtube-music": return [clean(preview.sourceLabel),
        tr("Your library songs and YouTube Music plays, read in English or Chinese. Regular YouTube videos are left out. Google doesn't say how long you listened, and history you deleted or paused can't come back.")];
      case "public-playlist": return [clean(preview.sourceLabel), Number.isFinite(preview.totalTracks)
        ? tr("{read} of {total} songs could be read; the service hides some. Only this playlist is added. It shows what you keep, not what you played, and it may not be one you made.", { read: tr.number(preview.availableTracks), total: tr.number(preview.totalTracks) })
        : tr("{read} songs could be read; the service hides some. Only this playlist is added. It shows what you keep, not what you played, and it may not be one you made.", { read: tr.number(preview.availableTracks) })];
      default: return [clean(preview.sourceLabel), clean(preview.scopeNote)];
    }
  }

  spotifyQuickPreview(preview) {
    const tr = this.getText();
    const library = preview.library;
    const first = day(preview.earliestListeningAt);
    const last = day(preview.latestListeningAt);
    const [label, note] = this.previewSource(preview);
    return {
      title: tr("Review your Spotify"),
      notice: tr("Nothing is added until you import it."),
      paragraphs: [
        label,
        ...(library ? [
          [tr.n(library.savedTracks, "{count} saved song", "{count} saved songs"), tr.n(library.savedAlbums, "{count} saved album", "{count} saved albums"),
            tr.n(library.followedArtists, "{count} followed artist", "{count} followed artists")].join(" · "),
          tr("{songs} across {playlists}", { songs: tr.n(library.playlistTracks, "{count} song", "{count} songs"),
            playlists: tr.n(library.playlists, "{count} playlist you made", "{count} playlists you made") }),
          tr("{artists} and {tracks} from Spotify", { artists: tr.n(library.topArtists, "{count} top artist", "{count} top artists"),
            tracks: tr.n(library.topTracks, "{count} top track", "{count} top tracks") }),
          ...(library.truncated?.length ? [tr("A very large library: Moondog read up to its limit and stopped there.")] : []),
          ...(library.skippedPlaylists ? [tr.n(library.skippedPlaylists, "{count} playlist couldn't be read and will be left out.", "{count} playlists couldn't be read and will be left out.")] : []),
        ] : preview.libraryUnavailable ? [tr("Your library isn't included: Reconnect Spotify to allow it.")] : []),
        preview.listeningEvents
          ? first && last
            ? tr("{plays}, {first} to {last}", { plays: tr.n(preview.listeningEvents, "{count} recent play", "{count} recent plays"), first, last })
            : tr.n(preview.listeningEvents, "{count} recent play", "{count} recent plays")
          : tr("No recent plays from Spotify right now."),
        note,
      ].filter(Boolean),
      actions: [{ type: "commit", label: tr("Add to my profile") }, { type: "recent", label: tr("Read Spotify again") }, { type: "back", label: tr("Back") }],
    };
  }

  pageContent() {
    const tr = this.getText();
    const profile = this.profileReady ? [{ type: "profile", label: tr("View my profile") }] : [];
    const file = { type: "file", label: tr("Choose a file") };
    const back = { type: "back", label: tr("Back") };
    const website = url => tr("Website: {url}", { url });
    switch (this.state.page) {
      case "youtube_music": return {
        title: tr("Import from YouTube Music"),
        paragraphs: [tr("Start with the songs in your library, then add what you've played from Google Takeout."),
          tr("Already have an export? Bring it in now. A new export takes a while to arrive, but there's nothing to set up.")],
        actions: [{ type: "youtubeQuick", label: tr("Start with my music library") }, { type: "youtubeHistory", label: tr("Add past listening history") }, back],
      };
      case "youtubeQuick":
      case "youtubeHistory": return {
        title: this.state.page === "youtubeQuick" ? tr("YouTube Music: saved library") : tr("YouTube Music: past listening"),
        paragraphs: [
          website(IMPORT_GUIDE_URLS.youtube),
          tr("1. In Google Takeout, deselect all products, then select YouTube and YouTube Music."),
          tr("2. Under included data, select music library songs and history. In format options, set history to JSON (not HTML)."),
          tr("3. Create a one-time ZIP export with a download link. Google emails you when it is ready; save it in Downloads."),
          tr("4. Return here and choose the ZIP, or an extracted music-library-songs.csv or watch-history.json."),
          tr("Library songs show what you keep. Only YouTube Music plays count as plays; regular YouTube videos are left out. Google doesn't say how long you listened."),
          tr("Regular YouTube playlist CSVs and uploaded audio don't work yet. If the ZIP is over 256 MB, unzip it and bring in the music files one at a time."),
        ],
        actions: [{ type: "file", label: tr("Choose my Takeout file") }, { type: "openYouTube", label: tr("Open Google Takeout") }, back],
      };
      case "qq_music":
      case "netease": {
        const qq = this.state.page === "qq_music";
        return {
          title: tr("Import from {service}", { service: qq ? "QQ Music / QQ 音乐" : "NetEase / 网易云音乐" }),
          paragraphs: [
            tr("Quick start: open a playlist that sounds like you, choose Share > Copy link, and paste it below."),
            tr("Moondog reads the public song list without signing in. You'll see the playlist and its songs before anything is added."),
            tr("Private playlists can't be read, and some songs may be unavailable; the preview shows how many made it. A playlist shows what you keep, not what you played, and not necessarily one you made."),
            tr("Past listening: there's no reliable way to export your full history from this service yet, so playlists are the way in for now."),
          ],
          actions: [{ type: "file", label: tr("Paste a playlist share link") }, { type: qq ? "openQQ" : "openNetEase", label: tr("Open my music service") }, back],
        };
      }
      case "spotify": return {
        title: tr("Import from Spotify"),
        paragraphs: [
          tr("Quick start: connect Spotify and bring in your library, your top artists, and what you've played lately."),
          tr("Past history: bring in the history ZIP Spotify sends you, going back years."),
          tr("Either way, it all ends up in the same profile."),
        ],
        actions: [{ type: "quick", label: tr("Quick start") }, { type: "spotifyHistory", label: tr("Add past listening history") }, back],
      };
      case "apple": return {
        title: tr("Import from Apple Music"),
        paragraphs: [
          tr("Quick start: export your library from Music on Mac and bring in the XML file."),
          tr("Past history: Apple can send you your data, but Moondog can't read that archive yet."),
        ],
        actions: [{ type: "appleQuick", label: tr("Quick start with library XML") }, { type: "appleHistory", label: tr("Past listening history guide") }, back],
      };
      case "appleQuick": return {
        title: tr("Quick start with Apple Music"),
        paragraphs: [
          tr("1. In Music on Mac, choose File > Library > Export Library."),
          tr("2. Save Library.xml somewhere easy to find, such as Downloads."),
          tr("3. Choose the XML below. Preview it before adding it to your profile."),
          tr("Moondog reads the file on this machine, including your loves, ratings and play counts. Nothing to sign in to."),
          tr("A library shows what you keep and how often, but not when you played each song. Apple's privacy download is a different format."),
        ],
        actions: [{ type: "file", label: tr("Choose my Library.xml") }, { type: "openAppleHelp", label: tr("Open Apple XML export guide") }, back],
      };
      case "appleHistory": return {
        title: tr("Apple Music: past listening history"),
        paragraphs: [
          website(IMPORT_GUIDE_URLS.applePrivacy),
          tr("1. Sign in to Apple's Data & Privacy website and choose Request a copy of your data."),
          tr("2. Select Apple Media Services information, which includes Apple Music activity, then complete the request."),
          tr("3. Apple notifies you when it is ready. Return to Data & Privacy to download the prepared files within 14 days."),
          tr("4. Save the download on your computer. Your browser usually uses Downloads, or asks you to choose a folder."),
          tr("What's included depends on your account and region. Opening the link doesn't request or import anything by itself."),
          tr("Moondog can't read Apple's privacy download yet. Keep it safe, and start with Library.xml for now."),
        ],
        actions: [{ type: "openApplePrivacy", label: tr("Open privacy.apple.com") }, { type: "appleQuick", label: tr("Start with library XML") }, back],
      };
      case "quick": {
        const status = this.state.spotify ?? {};
        const granted = status.state === "ready" ? status.scopes?.granted ?? [] : [];
        const recentOnly = granted.includes("user-read-recently-played");
        const ready = recentOnly && SPOTIFY_LIBRARY_SCOPES.every((scope) => granted.includes(scope));
        const configured = status.client_id_configured;
        return {
          title: tr("Quick start with Spotify"),
          paragraphs: [
            tr("Start your profile from your Spotify library: saved songs and albums, the artists you follow, your own playlists, and the artists and tracks Spotify ranks highest for you. Your latest 50 plays come along too."),
            tr("You'll see it all before anything is saved. No model or download needed."),
            tr("Years of listening can come later with a history ZIP."),
            ready ? tr("Spotify is connected. Go ahead when you're ready.")
              : recentOnly ? tr("Your Spotify sign-in only covers recent plays. Reconnect once so Moondog can read your library too.")
              : configured ? tr("Connect Spotify so Moondog can read your library and recent plays.")
                : tr("Connecting Spotify takes a one-time setup on this computer. Or start with a downloaded ZIP instead."),
          ],
          actions: [
            ready ? { type: "recent", label: tr("Preview my Spotify") }
              : recentOnly ? { type: "connectSpotify", label: tr("Reconnect Spotify") }
              : configured ? { type: "connectSpotify", label: tr("Connect Spotify") } : { type: "setup", label: tr("Set up Spotify connection") },
            ...(ready ? [{ type: "connectSpotify", label: tr("Reconnect Spotify") }] : recentOnly ? [{ type: "recent", label: tr("Just my recent plays") }] : []),
            // A mistyped Client ID only shows up at sign-in, so keep a way to replace it.
            ...(configured && !ready && !recentOnly ? [{ type: "client", label: tr("Change Client ID") }] : []),
            { type: "spotifyHistory", label: tr("Add past listening history") }, back,
          ],
        };
      }
      case "setup": return {
        title: tr("Set up Spotify connection"),
        paragraphs: [
          tr("For now, Moondog connects through a Spotify app you create yourself. It takes a few minutes."),
          `1. ${tr("In the Spotify Dashboard, create an app with Web API turned on.")}`,
          `2. ${tr("Add redirect URI: {uri}", { uri: "http://127.0.0.1:43821/callback" })}`,
          `3. ${tr("Copy the Client ID from the app's settings. You don't need the client secret.")}`,
          tr("The app owner needs Premium, and up to 5 people can use it. If you're not the owner, get added under User Management."),
        ],
        actions: [
          { type: "openSpotifySetup", label: tr("Open Spotify Dashboard") },
          { type: "client", label: tr("Enter my Client ID") },
          { type: "spotifyHistory", label: tr("Use a history ZIP instead") }, back,
        ],
      };
      case "empty": return {
        title: tr("Silence from Spotify"),
        paragraphs: [
          tr("Spotify didn't return any recent plays, so nothing was imported."),
          tr("Play something in Spotify and try again, or bring a history ZIP."),
          tr("This only covers the last few plays. Your full history is still there."),
        ],
        actions: [{ type: "recent", label: tr("Try recent listening again") }, { type: "spotifyHistory", label: tr("Add past listening history") }, back],
      };
      case "spotifyHistory": return {
        title: tr("Spotify: past listening history"),
        paragraphs: [
          tr("Already have your Spotify ZIP? Choose it below. No need to unzip it."),
          website(IMPORT_GUIDE_URLS.spotify),
          tr("1. Sign in, find Download your data, and select Extended streaming history. It goes back the furthest."),
          tr("2. Confirm the request. Spotify emails you when it's ready, which can take up to 30 days."),
          tr("3. Download the ZIP. It usually lands in your Downloads folder."),
          tr("4. Come back to /import > Spotify > Add past listening history and choose that ZIP."),
          tr("The quicker Account data download works too. It covers the past year plus your library. Neither needs a Spotify app or sign-in."),
          tr("Opening the website doesn't request or import anything by itself."),
        ],
        actions: [
          { type: "file", label: tr("Choose my Spotify ZIP") },
          { type: "openSpotify", label: tr("Open Spotify data export website") },
          { type: "waiting", label: tr("I'm waiting for my download") }, back,
        ],
      };
      case "waiting": return {
        title: tr("Wish you were here"),
        paragraphs: [
          tr("When Spotify's email arrives, save the ZIP, usually in Downloads."),
          tr("Then come back to /import > Spotify > Add past listening history and choose it."),
          this.profileReady ? tr("Your profile is still here to explore in the meantime.") : tr("You can still talk music while you wait."),
          tr("Connecting Spotify now brings in your latest plays, not your full history."),
        ],
        actions: [{ type: "quick", label: tr("Quick start while I wait") }, file, ...profile, back],
      };
      case "other": return {
        title: tr("Other listening sources"),
        paragraphs: [
          tr("ListenBrainz: choose a listens JSON file saved from ListenBrainz, either a GET export or a single/import payload."),
        ],
        actions: [file, back],
      };
      case "preview": {
        const preview = this.state.preview ?? {};
        const recent = this.state.origin === "quick";
        if (preview.kind === "spotify-quick") return this.spotifyQuickPreview(preview);
        const library = preview.kind === "library";
        const collection = preview.kind === "collection";
        const first = day(preview.earliestListeningAt);
        const last = day(preview.latestListeningAt);
        const [label, note] = this.previewSource(preview);
        const known = value => Number.isFinite(value) && value >= 0;
        return {
          title: library ? tr("Review your Apple Music library") : recent ? tr("Review recent listening") : tr("Review this import"),
          notice: tr("Nothing is added until you import it."),
          paragraphs: [
            label || tr("Your history"),
            clean(preview.fileName),
            library || collection
              ? known(preview.tracks) ? tr.n(preview.tracks, "{count} song", "{count} songs") : tr("Unknown number of songs")
              : `${known(preview.listeningEvents) ? tr.n(preview.listeningEvents, "{count} play", "{count} plays") : tr("Unknown number of plays")} · ${known(preview.tracks) ? tr.n(preview.tracks, "{count} track", "{count} tracks") : tr("Unknown number of tracks")}`,
            library || collection ? tr("As of {date}", { date: day(preview.capturedAt) ?? tr("an unknown date") }) : first && last ? tr("{first} to {last}", { first, last }) : tr("No dates in this file."),
            library || collection ? tr("This shows what you keep, so no plays will be added.") : recent
              ? tr("Spotify doesn't say how long you listened to recent plays.")
              : preview.eventsWithPlayedMs === preview.listeningEvents
                ? tr("Listening time is known for every play.")
                : tr("Listening time is known for {known} of {total} plays.", { known: tr.number(preview.eventsWithPlayedMs), total: tr.number(preview.listeningEvents) }),
            ...(preview.profileEvidence > 0 ? [tr.n(preview.profileEvidence, "Also {count} saved song, follow, or playlist entry", "Also {count} saved songs, follows, or playlist entries")] : []),
            ...(preview.skippedRecords > 0 ? [tr.n(preview.skippedRecords, "Left out {count} podcast, video, or incomplete entry", "Left out {count} podcasts, videos, or incomplete entries")] : []),
            note,
            ...(preview.sampleTracks ?? []).map((track) => `  ${clean(track)}`),
          ].filter(Boolean),
          actions: [
            { type: "commit", label: tr("Add to my profile") },
            recent ? { type: "recent", label: tr("Refresh recent listening") } : { type: "file", label: tr("Choose a different file") }, back,
          ],
        };
      }
      default: return {
        title: tr("Bring your music"),
        paragraphs: [
          tr("Pick your music service. Start with what you've played lately, or go all the way back."),
          this.profileReady ? tr("Anything you bring in joins your profile. Your choices stay as they are.") : tr("You'll see what's inside before anything is added. It all stays on this machine."),
        ],
        actions: [{ type: "spotify", label: "Spotify" }, { type: "apple", label: "Apple Music" }, { type: "youtube_music", label: "YouTube Music" }, { type: "qq_music", label: "QQ Music / QQ 音乐" }, { type: "netease", label: "NetEase / 网易云音乐" }, { type: "other", label: tr("Other sources") }, ...profile],
      };
    }
  }

  handleInput(data) {
    if (this.state.page === "working") return;
    if (data.includes("\x1b[200~")) this.pasteActive = true;
    if (this.pasteActive) {
      if (this.state.page === "file") this.editor.handleInput(data);
      if (this.state.page === "client") this.clientEditor.handleInput(data);
      const paste = this.pasteTail + data;
      this.pasteActive = !paste.includes("\x1b[201~");
      this.pasteTail = this.pasteActive ? paste.slice(-5) : "";
      return;
    }
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.emit(this.state.page === "start" ? "close" : "back");
      return;
    }
    if (this.state.page === "file") {
      if (keys.matches(data, "tui.input.submit") && !this.editor.isShowingAutocomplete()) {
        this.emit("inspect", { path: this.getPath() });
      } else this.editor.handleInput(data);
      return;
    }
    if (this.state.page === "client") {
      this.clientEditor.handleInput(data);
      return;
    }
    const { actions } = this.pageContent();
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      this.selected = (this.selected + (keys.matches(data, "tui.select.up") ? -1 : 1) + actions.length) % actions.length;
    } else if (keys.matches(data, "tui.select.confirm")) {
      this.emit(actions[this.selected]?.type ?? actions[0].type);
    } else if (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
      const direction = keys.matches(data, "tui.select.pageUp") ? -1 : 1;
      this.contentOffset = Math.max(0, Math.min(this.contentMaxOffset,
        this.contentOffset + direction * Math.max(1, this.contentPageSize - 1)));
    }
  }

  renderFile(width, height, theme) {
    const client = this.state.page === "client";
    const playlist = ["qq_music", "netease"].includes(this.state.provider);
    const input = client ? this.clientEditor : this.editor;
    const error = clean(this.state.error?.message ?? this.state.error);
    const errorLines = error ? wrapTextWithAnsi(error, width).slice(0, Math.min(3, Math.max(1, height - 6))).map(theme.error) : [];
    const tr = this.getText();
    const fileKind = { apple: tr("Apple Music library XML"), spotify: tr("Original Spotify history ZIP"),
      youtube_music: tr("Takeout ZIP, music library CSV or watch-history JSON"), other: "ListenBrainz JSON" }[this.state.provider] ?? tr("Music export file or public playlist link");
    const header = client
      ? [theme.bold(tr("Enter your Spotify Client ID")), theme.muted(tr("From your app settings. No client secret.")), theme.text("Client ID")]
      : playlist ? [theme.bold(tr("Paste your playlist share link")), theme.muted(this.state.provider === "qq_music" ? tr("QQ Music public playlist") : tr("NetEase Cloud Music public playlist")), theme.text(tr("Link (or the copied share text)"))]
      : [theme.bold(tr("Choose your music file")), theme.muted(fileKind), theme.text(tr("File path"))];
    const hint = client ? theme.muted(tr("Enter save · Esc back")) : playlist ? theme.muted(tr("Paste link · Enter preview · Esc back")) : theme.muted(width >= 64 ? tr("Paste or drag one path · Tab completes · Enter inspect · Esc back")
      : width >= 38 ? tr("Paste/drag · Tab path · ↵ inspect · Esc") : tr("Tab path · ↵ inspect · Esc"));
    const budget = Math.max(1, height - header.length - errorLines.length - 1);
    input.setAutocompleteMaxVisible(Math.max(1, Math.min(4, budget - 8)));
    let editor = input.render(width);
    if (editor.length > budget) {
      const tailSize = input.isShowingAutocomplete()
        ? Math.min(input.getAutocompleteMaxVisible() + 1, Math.max(0, budget - 1)) : 0;
      const tail = tailSize ? editor.slice(-tailSize) : [];
      const core = tailSize ? editor.slice(0, -tailSize) : editor;
      const available = budget - tail.length;
      const cursor = core.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(core.length - available, cursor - available + 1));
      editor = [...core.slice(start, start + available), ...tail];
    }
    return [...header, ...editor.map(safeEditorLine), ...errorLines, hint];
  }

  render(width) {
    const columns = Math.max(1, Math.floor(width));
    const requestedRows = Number(this.getRows());
    const height = Number.isFinite(requestedRows) ? Math.max(0, Math.floor(requestedRows)) : 0;
    if (!height) return [];
    const inset = columns >= 8 ? 1 : 0;
    const inner = Math.max(1, columns - inset * 2);
    const theme = this.getTheme();
    const tr = this.getText();
    let lines;
    if (["file", "client"].includes(this.state.page)) {
      lines = this.renderFile(inner, height, theme);
    } else if (this.state.page === "working") {
      const message = clean(this.state.message) || tr("Working on it…");
      lines = [theme.bold(tr("Your listening history")), "", ...wrapTextWithAnsi(message, inner).map(theme.text)];
      if (height >= 5) lines.push("", theme.muted(tr("One moment.")));
    } else if (this.state.page === "signin") {
      // Spotify reports a wrong Client ID or redirect URI only in the browser, so say what to look for here.
      const url = clean(this.state.url);
      // A link split across rows cannot be copied whole, so prefer one clickable label.
      const link = url && getCapabilities().hyperlinks ? hyperlink(tr("Open the Spotify sign-in page"), url) : url;
      const paragraphs = [
        tr("Your browser opened Spotify. Sign in, then choose Agree."),
        tr("If Spotify shows INVALID_CLIENT or \"Invalid redirect URI\", your Spotify app doesn't match yet. Cancel, check the redirect URI, then choose Change Client ID."),
        tr("Add redirect URI: {uri}", { uri: "http://127.0.0.1:43821/callback" }),
        ...(link ? [tr("Browser didn't open? Use this link:"), link] : []),
      ];
      lines = [theme.bold(tr("Sign in to Spotify")), "",
        ...paragraphs.flatMap((text, index) => [...(index ? [""] : []), ...wrapTextWithAnsi(text, inner).map(text === link ? theme.text : theme.muted)]),
        "", theme.faint(tr("Esc cancels"))];
      if (lines.length > height) lines = [...lines.slice(0, height - 1), lines.at(-1)];
    } else {
      const page = this.pageContent();
      const spacious = height >= 17;
      const header = [theme.bold(page.title), ...(page.notice ? [theme.accent(page.notice)] : []), ...(spacious ? [""] : [])];
      const error = clean(this.state.error?.message ?? this.state.error);
      const message = clean(this.state.message);
      const paragraphs = [
        ...(error ? wrapTextWithAnsi(error, inner).map(theme.error) : []),
        ...(message ? wrapTextWithAnsi(message, inner).map(theme.accent) : []),
        ...page.paragraphs.flatMap((text) => wrapTextWithAnsi(clean(text), inner).map(theme.muted)),
      ];
      const capacity = Math.max(0, height - header.length - page.actions.length - 1 - (spacious ? 1 : 0));
      this.contentPageSize = Math.max(1, capacity);
      this.contentMaxOffset = Math.max(0, paragraphs.length - capacity);
      this.contentOffset = Math.min(this.contentOffset, this.contentMaxOffset);
      this.selected = Math.min(this.selected, page.actions.length - 1);
      const actions = page.actions.map(({ label }, index) => {
        const selected = index === this.selected;
        const text = fit((selected ? "◉ " : "  ") + label, inner);
        return selected ? theme.selected(text) : theme.text(text);
      });
      const hint = this.contentMaxOffset > 0
        ? inner >= 36 ? tr("↑↓ ↵ choose · PgUp/Dn read · Esc back") : tr("↑↓ ↵ · PgUp/Dn read · Esc")
        : inner >= 34 ? tr("↑↓ choose · Enter select · Esc back") : tr("↑↓ choose · ↵ select · Esc");
      lines = [...header, ...paragraphs.slice(this.contentOffset, this.contentOffset + capacity),
        ...(spacious ? [""] : []), ...actions, theme.faint(hint)];
    }
    return Array.from({ length: height }, (_, row) => paint(" ".repeat(inset) + (lines[row] ?? ""), columns, theme));
  }
}
