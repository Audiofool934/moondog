<p align="center">
  <img src="assets/brand/moondog-lunar-record/moondog-logo-1x1.png" width="144" alt="Moondog lunar record logo">
</p>

<h1 align="center">Moondog</h1>

<p align="center"><strong>A personal music agent that shows its work.</strong></p>

<p align="center">Your listening history. Your say in what it means.</p>

<p align="center">
  <img src="assets/demo/moondog-tui-home.png" width="1000" alt="Moondog's terminal listening room: a lunar record drawn in characters, a short menu, a Pink Floyd lyric, and a message box">
</p>

<p align="center"><sub>The real terminal app, shown with fictional listening data.</sub></p>

Moondog reads the history your music services already keep and turns it into a profile you can open, question, and correct.
It tells you what it found, shows the evidence behind every reading, and is honest about what play counts can never know.
When you want company, an agent can use that profile to talk music, find songs you haven't heard, and shape a playlist with you.

It runs in your terminal, keeps your data on your machine, and is built on [Pi](https://github.com/earendil-works/pi).

## Start listening

You need Node.js **22.19.0 or newer** on macOS or Linux.

```bash
git clone https://github.com/Audiofool934/moondog.git
cd moondog
npm ci
npm start
```

Your profile works without a model, an API key, or a music-service login.
To see the agent at work with fictional data and no sign-in at all, run `npm run demo`.

## Bring your history

Type `/import` and pick **Spotify**, **Apple Music**, **YouTube Music**, **QQ Music**, or **NetEase Cloud Music**.
Moondog walks you through getting your data, then shows you what's inside before anything is added.

- **Spotify:** your latest plays in a minute, or your whole history from the ZIP Spotify emails you.
- **Apple Music:** the `Library.xml` you export from Music on a Mac.
- **YouTube Music:** a Google Takeout export.
- **QQ Music and NetEase:** any public playlist, from its share link.
- **ListenBrainz:** a saved listens file.

A Spotify ZIP can also go straight in:

```text
/import "/path/to/spotify-history.zip"
```

When the import finishes, your profile opens right there in the same TUI session, with the full report kept in the conversation above it.
Importing the same file twice changes nothing, and your original files are never touched.
Some sources aren't supported yet, such as Apple's privacy download and full QQ or NetEase listening history; the import guide says so where it matters.
The [terminal guide](docs/TERMINAL_GUIDE.md#import-and-inspect-listening-history) covers every format in detail.

## See what it says, and tell it what it got wrong

| In your profile | What you can do |
| --- | --- |
| **Find a song or artist** | Type to filter, then open the one you want. |
| **See why it's there** | Read what you played, what that can't prove, and what you told Moondog, each on its own. |
| **Make a choice** | Choose **I like this** (Like) or **Keep it out** (Avoid), and watch the profile update. |
| **Change your mind** | **Undo my choice** at any time; you can retract anything, and the original listening history never changes. |
| **Find more like this** | Start an editable request for three songs, seeded from the track you picked. |

<p align="center">
  <img src="assets/demo/moondog-tui-profile.png" width="1000" alt="Moondog's listening profile showing the fictional track Midnight Lines, why it is there, and what that evidence cannot tell">
</p>

<p align="center"><sub>The profile with fictional data. Playing a song a lot shows you know it, not that you love it.</sub></p>

Type `/taste report` for the whole picture on one page.
It walks through your years one song at a time, finds songs that went quiet and songs that came back, and ends with the dark side of the moon: what your listening data can't tell anyone.
You can also save it as a private web page that works offline.

## Getting around

| Command or key | What it does |
| --- | --- |
| `/taste` | Open your profile. |
| Type, ↑ ↓, Enter | Filter, pick, and see why something is there, or make a choice. |
| Tab in the profile | Switch between All, Tracks, Artists, and Your choices. |
| Esc | Go back; whatever you were typing stays put. |
| Ctrl+P | Search every command. |
| `/resume` · `/new` | Pick up a saved conversation, or start a fresh one. |
| `/home` | Back to the record sleeve, without clearing the conversation. |

Each launch starts a new conversation, while your profile and anything Moondog remembers carry over.
Change the look with `/theme paper` or `/theme charcoal`, switch the artwork with `/art ascii`, or keep it still with `/motion off`.

## Add an agent when you want one

Sign in with `/auth` to GLM, Kimi, DeepSeek, Grok, GPT, Claude, Gemini, or OpenRouter, then pick a model with `/model`.
`openai-codex` uses your ChatGPT sign-in.
You can switch models mid-conversation; the [model setup guide](docs/TERMINAL_GUIDE.md#enable-agent-conversation) lists provider IDs and environment variables.

Ask for a route through your own history, reshuffle what it suggests, or reach past your library.
Every song the agent picks has to come from a real list it looked up, and what it read about the wider music world stays separate from what it knows about you.

| Optional connection | What it adds |
| --- | --- |
| **A model through Pi** | Conversation, discovery, and building playlists together. |
| **Codex CLI** | `/web` lookups with links to their sources, using your own signed-in Codex CLI. |
| **Spotify sign-in** | Playback control, and private playlists made only when you ask. |

Your profile never touches the network.
The agent and connected features talk to the services you set up; `/web` sends only the question or link you give it, never your profile, history, or files.
Importing a Spotify ZIP doesn't need a Spotify sign-in.
Read the [connection and data details](docs/TERMINAL_GUIDE.md) before you connect anything.

## Explore further

- [Terminal guide](docs/TERMINAL_GUIDE.md): import formats, commands, appearance, models, Spotify, memory, and your local data.
- [Private Tasteprint](docs/PRIVATE_TASTEPRINT.md): what the evidence can support, and what a report reveals about you.
- [Product charter](docs/PRODUCT_CHARTER.md) and [public roadmap](docs/ROADMAP.md): where Moondog is headed, and what it won't do.
- [Voice](docs/VOICE.md): how Moondog talks, and where Pink Floyd shows up.
- [Runtime architecture](docs/ADR_0001_AGENT_RUNTIME_AND_CLI.md) and [data contracts](contracts/README.md): how the pieces fit together.
- [Contribution guide](CONTRIBUTING.md) and [release readiness](docs/PUBLIC_RELEASE_READINESS.md): local setup, checks, and how private data is kept out.

Moondog is early, and the Pi-based TUI is where the work happens.
GUI and Studio development is paused; the earlier [browser prototypes](docs/TERMINAL_GUIDE.md#archived-gui-prototypes-paused) are still there for reference.
There is no open-source license yet.
