// The scene the window plays on the project page: the needle goes down and Moondog picks something
// for right now, then a request for a late train home. The listener is the made-up one from the
// demo history (src/demo/fictional-spotify-history.mjs); the new artists are made up too, and every
// cover is drawn here, so nothing is fetched.
const svg = (body) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">${body}</svg>`)}`;

const COVERS = {
  // Night Transit: a lit train under an amber moon.
  nightTransit: svg(`<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#0d1830"/><stop offset="1" stop-color="#22385c"/></linearGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/><circle cx="428" cy="158" r="48" fill="#e9b65c"/>
    <rect y="402" width="600" height="2" fill="#e9b65c" opacity=".35"/>
    ${Array.from({ length: 9 }, (_, i) => `<rect x="${34 + i * 62}" y="356" width="38" height="24" rx="3" fill="#f1c776" opacity="${0.55 + (i % 3) * 0.15}"/>`).join("")}
    <rect y="404" width="600" height="196" fill="#08101f" opacity=".7"/>`),
  // Pale Signals: a radio mast at dusk, its lights blinking.
  paleSignals: svg(`<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#f1d2bd"/><stop offset=".62" stop-color="#d49a8f"/><stop offset="1" stop-color="#7b5a6e"/></linearGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/><path d="M300 150 L262 470 M300 150 L338 470 M272 390 L328 390 M281 310 L319 310 M290 230 L310 230" stroke="#4b3446" stroke-width="5" fill="none"/>
    <circle cx="300" cy="140" r="11" fill="#c2412e"/><circle cx="300" cy="140" r="34" fill="none" stroke="#c2412e" stroke-width="3" opacity=".45"/>
    <circle cx="300" cy="140" r="64" fill="none" stroke="#c2412e" stroke-width="2" opacity=".22"/><rect y="470" width="600" height="130" fill="#5e4255"/>`),
  // Tidewater: slow water.
  tidewater: svg(`<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#0f3a40"/><stop offset="1" stop-color="#5e9993"/></linearGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/>
    ${Array.from({ length: 7 }, (_, i) => `<path d="M0 ${250 + i * 46} Q150 ${226 + i * 46} 300 ${250 + i * 46} T600 ${250 + i * 46}" fill="none" stroke="#dcefe9" stroke-width="3" opacity="${0.18 + i * 0.09}"/>`).join("")}`),
  // Paper Lanterns: three warm lights at dusk.
  paperLanterns: svg(`<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#2a1d3c"/><stop offset="1" stop-color="#6b3d58"/></linearGradient>
    <radialGradient id="l"><stop offset="0" stop-color="#ffd896"/><stop offset=".55" stop-color="#f0a457"/><stop offset="1" stop-color="#f0a457" stop-opacity="0"/></radialGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/><circle cx="170" cy="250" r="92" fill="url(#l)"/><circle cx="330" cy="340" r="74" fill="url(#l)" opacity=".85"/><circle cx="460" cy="220" r="58" fill="url(#l)" opacity=".7"/>`),
  // Sodium: one streetlight in the dark.
  sodium: svg(`<defs><radialGradient id="l" cx=".5" cy=".3" r=".6"><stop offset="0" stop-color="#f08a2a"/><stop offset=".45" stop-color="#7a3a10"/><stop offset="1" stop-color="#14100c"/></radialGradient></defs>
    <rect width="600" height="600" fill="url(#l)"/><rect x="296" y="196" width="8" height="404" fill="#14100c"/><rect x="262" y="182" width="76" height="16" rx="8" fill="#ffd9a0"/>`),
  // Shoreline Code: a pale horizon and a low dark sun.
  shoreline: svg(`<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#dde1e3"/><stop offset="1" stop-color="#93a3ad"/></linearGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="330" r="64" fill="#2f3b45"/><rect y="350" width="600" height="250" fill="#7d8f9b"/>
    <rect y="350" width="600" height="2" fill="#f4f6f7" opacity=".7"/>`),
};

const song = (title, artist, album, cover, seconds) => ({ title, artists: [artist], album, image: COVERS[cover], duration_ms: seconds * 1000 });

// The model the window's composer shows.
export const MODEL = { provider: "deepseek", model: "deepseek-flash", providerName: "DeepSeek", modelName: "DeepSeek V4.1 Flash" };

// Each exchange: the steps Moondog takes, each with its tool and how long it runs; the reply; and the
// songs the last step starts. The first exchange answers the needle; the second is typed.
export const EXCHANGES = [
  {
    steps: [
      { tool: "moondog_listening_now", ms: 700 },
      { tool: "moondog_profile_summary", ms: 1100 },
      { tool: "moondog_music_catalog_search", ms: 1400 },
      { tool: "moondog_music_app_control", args: { action: "play" }, ms: 700, plays: true },
    ],
    reply: "Something for right now. I'll start with one of yours and take you somewhere new.\n\n"
      + "- **Glass Highway** by North Window. One you keep coming back to.\n"
      + "- **Tidewater** by Low Harbour. New to you: the same slow pulse, with more light in it.\n"
      + "- **Paper Lanterns** by The Slow Lamps. New too, to land on.",
    songs: [
      song("Glass Highway", "North Window", "Pale Signals", "paleSignals", 252),
      song("Tidewater", "Low Harbour", "Tidewater", "tidewater", 228),
      song("Paper Lanterns", "The Slow Lamps", "Paper Lanterns", "paperLanterns", 271),
    ],
  },
  {
    request: "Something for a late train home",
    steps: [
      { tool: "moondog_profile_summary", ms: 900 },
      { tool: "moondog_music_catalog_search", ms: 1600 },
      { tool: "moondog_music_app_control", args: { action: "play" }, ms: 700, plays: true },
    ],
    reply: "Three for the ride, starting with one of yours.\n\n"
      + "- **Last Tram Home** by Mara Vale. The title says it.\n"
      + "- **Sodium Light** by Halden Rue. New to you, with the same low hum as the carriage.\n"
      + "- **Window Seat** by Cinder Lake. You know the band, but not this song.\n\n"
      + "I'll keep the line going if you want more.",
    songs: [
      song("Last Tram Home", "Mara Vale", "Night Transit", "nightTransit", 237),
      song("Sodium Light", "Halden Rue", "Sodium", "sodium", 245),
      song("Window Seat", "Cinder Lake", "Shoreline Code", "shoreline", 216),
    ],
  },
];
