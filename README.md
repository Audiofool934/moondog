<p align="center">
  <img src="assets/brand/moondog-lunar-record/moondog-logo-1x1.png" width="156" alt="Moondog lunar record">
</p>

<h1 align="center">Moondog</h1>

<p align="center">Version 0.1.0</p>

<p align="center"><strong>A listening room that shows its work.</strong></p>

<p align="center">
  <img src="assets/demo/moondog-tui-home.png" width="1000" alt="Moondog's listening room in charcoal: a lunar record beside the wordmark, a four-line tracklist, and the line Is there anybody out there">
</p>

<p align="center"><sub>The real TUI, in charcoal, with fictional listening data.</sub></p>

Moondog is a listening room in your terminal.
It reads the history your music services already keep, and turns it into a profile you can open, question, and correct.
The profile works without a model, an API key, or a music-service login.
When you want company, an agent can talk music with you, find songs you have not heard, and shape a playlist.
Your data stays on your machine.
The room is built on [Pi](https://github.com/earendil-works/pi).

## Open the room

You need Node.js 22.19.0 or newer, on macOS or Linux.
Install from this checkout to run the room shown here.

```bash
git clone https://github.com/Audiofool934/moondog.git
cd moondog
npm ci
npm start
```

[@audiofool/moondog](https://www.npmjs.com/package/@audiofool/moondog) 0.1.0 is the published package.
To see the agent work through fictional data, with no sign-in at all, run `npm run demo` from the checkout.

## The sleeve

The opening is a record sleeve drawn in characters.
Nothing in the terminal is a picture.
On a wide screen the record sits beside the title, with the wordmark level with the dog's eye.
On a tall or narrow screen the record stacks above the title.
Moondog uses whichever arrangement leaves the record larger.
A lyric rests midway between the record and the input box, with room on both sides.
The input asks what you have been listening to.

Until your library has a line of its own, the sleeve rotates three short ones: "Where have you been?", "Is there anybody out there?", and "Wish you were here."
When a matching line from music you have played is available, that line takes the place.
Moondog asks [LRCLIB](https://lrclib.net/) for the original words only, and does not send your profile, your history, or the conversation.

The room is black and white, like the moon.
Paper is black ink on white.
Charcoal is moonlight on a black sky.
`/theme terminal` keeps your own colors.
The only other colors are the six from the prism on *The Dark Side of the Moon*.
Red means a step failed, orange is a caution, green confirms, and the spectrum shows while Moondog is working.

Press Tab on an empty input to step onto the tracklist, then use the arrow keys and Enter.

| On the sleeve | Command |
| --- | --- |
| Listening profile | `/taste` |
| Import your music | `/import` |
| Appearance | `/theme` |
| Help & commands | `/help` |

While the room is idle, lunar marks travel the record, a highlight follows the groove, and the needle pulses.
The dog and the wordmark stay still.
`/motion off` holds the sleeve.
`/art ascii` switches the drawing.
`/home` returns here and leaves the conversation where it was.

## Bring your history

Type `/import` and pick a service.
Moondog shows you what is inside before anything is saved.
When the import finishes, your profile opens in the same TUI session.

| Service | What you can bring |
| --- | --- |
| Spotify | Recent plays after you connect, or the whole history from the ZIP Spotify emails you. |
| Apple Music | The Library.xml you export from Music on a Mac. |
| YouTube Music | A Google Takeout export. |
| QQ Music and NetEase | Any public playlist, from its share link. |
| ListenBrainz | A saved listens file. |

A Spotify ZIP can also go straight in.

```text
/import "/path/to/spotify-history.zip"
```

Importing the same file twice changes nothing, and your original files are never touched.
Apple's privacy download, and full QQ or NetEase listening history, are not supported yet.
The [terminal guide](docs/TERMINAL_GUIDE.md#import-and-inspect-listening-history) has every format.

## Your profile

The profile says what you played, and what that cannot prove.
Playing a song a lot shows how well you know it.
It does not prove you love it.

<p align="center">
  <img src="assets/demo/moondog-tui-profile.png" width="1000" alt="The listening profile for the fictional track Midnight Lines by Mara Vale, with the plays on one side and the limit of that evidence on the other">
</p>

<p align="center"><sub>Fictional data, with the evidence and the limit of that evidence.</sub></p>

| In the profile | What you can do |
| --- | --- |
| Find a song or artist | Type to filter, then open it. |
| See why it is there | Read what you played, what that cannot prove, and what you told Moondog, each on its own. |
| Make a choice | Choose **I like this** (Like) or **Keep it out** (Avoid), and the profile updates in place. |
| Change your mind | Choose **Undo my choice**, and the original listening history never changes. |
| Find more like this | Start an editable request for three songs, from the track you picked. |

Type `/taste report` for the long view.
It walks the years one song at a time, names songs that went quiet and songs that came back, and ends on the dark side of the moon: what play counts can never tell anyone.
You can save that report as a private page that works offline.

## An agent, when you want one

Sign in with `/auth`, then pick a model with `/model`.
GLM, Kimi, DeepSeek, Grok, GPT, Claude, Gemini, and OpenRouter are there.
`openai-codex` uses your ChatGPT sign-in.
You can switch models in the middle of a conversation.
The [model setup guide](docs/TERMINAL_GUIDE.md#enable-agent-conversation) lists each provider and the environment variable it reads.

While an answer is on the way, each step appears in the conversation as it starts.
The steps stay above the reply, with a count of what finished, what failed, and what was not confirmed.
Every song the agent picks has to come from a real list it looked up.
What it reads about the wider music world stays separate from what it knows about you.

| Optional connection | What it adds |
| --- | --- |
| A model through Pi | Conversation, discovery, and playlists built together. |
| Codex CLI | `/web` lookups with links to their sources, through your own signed-in Codex CLI. |
| Spotify sign-in | Playback, and private playlists made only when you ask. |

Your profile never touches the network.
The agent talks only to the services you set up.
`/web` sends the question or the link you give it, and nothing from your profile, history, or files.
A Spotify ZIP does not need a Spotify sign-in.
Read the [connection and data details](docs/TERMINAL_GUIDE.md) before you connect anything.

## Getting around

| Command or key | What it does |
| --- | --- |
| `/taste` | Open your profile. |
| Type, arrow keys, Enter | Filter, pick a row, and see why it is there, or make a choice. |
| Tab in the profile | Switch between All, Tracks, Artists, and Your choices. |
| Tab on the sleeve | Step onto the tracklist, then press Escape to return to the line you were writing. |
| Esc | Go back, and the draft stays put. |
| Ctrl+P | Search every command. |
| Page Up, Page Down | Move through the conversation while the header, the draft, and the status line stay put. |
| Up and Down in the draft | Recall what you typed in this conversation. |
| `/resume`, `/new` | Pick up a saved conversation, or start a fresh one. |
| `/home` | Back to the sleeve, without clearing the conversation. |
| `/lyrics` | See which line is on the sleeve, and which song it came from. |
| `/theme paper` | Black ink on white. |
| `/theme charcoal` | Moonlight on a black sky. |
| `/theme terminal` | Your terminal's own colors. |

Each launch starts a new conversation.
Your profile, and anything Moondog remembers, carry over.

## Further

- [Terminal guide](docs/TERMINAL_GUIDE.md): import formats, commands, appearance, models, Spotify, memory, and your local data.
- [Private Tasteprint](docs/PRIVATE_TASTEPRINT.md): what the evidence can support, and what a report reveals about you.
- [Product charter](docs/PRODUCT_CHARTER.md) and [public roadmap](docs/ROADMAP.md): where Moondog is headed, and what it will not do.
- [Voice](docs/VOICE.md): how Moondog talks, and where Pink Floyd shows up.
- [Runtime architecture](docs/ADR_0001_AGENT_RUNTIME_AND_CLI.md) and [data contracts](contracts/README.md): how the pieces fit together.
- [Contribution guide](CONTRIBUTING.md) and [release readiness](docs/PUBLIC_RELEASE_READINESS.md): local setup, checks, and how private data is kept out.

Moondog is at 0.1.0, and the work happens in the TUI.
GUI and Studio development is paused.
The earlier [browser prototypes](docs/TERMINAL_GUIDE.md#archived-gui-prototypes-paused) remain for reference.
There is no open-source license yet.
