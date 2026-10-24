const validUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && /(?:^|\.)music\.126\.net$/u.test(url.hostname) ? url.href : null;
  } catch { return null; }
};

// Preserve the account-authorized path and signature; only try NetEase's known
// alternate music CDNs when its selected node refuses or stalls the stream.
const sourcesFor = (value) => {
  const original = validUrl(value);
  if (!original) return [];
  const sources = [original];
  const url = new URL(original);
  if (/^m[0-9]+\.music\.126\.net$/u.test(url.hostname)) {
    for (const host of ["m701.music.126.net", "m801.music.126.net"]) {
      url.hostname = host;
      sources.push(url.href);
    }
  }
  return [...new Set(sources)];
};

export function createNeteaseAudio({ send, beforePlay = () => {}, AudioClass = Audio, sourceTimeoutMs = 4000 }) {
  let audio = null;
  let token = null;
  let timer = null;
  let wantsPlay = true;
  let retry = null;
  function release() {
    clearTimeout(timer); timer = null;
    const previous = audio;
    audio = null;
    if (previous) { previous.pause(); previous.removeAttribute("src"); previous.load(); }
  }
  function clear() {
    token = null;
    retry = null;
    release();
  }
  function receive(message) {
    if (message.type !== "netease-audio") return;
    if (message.action === "play") {
      const sources = sourcesFor(message.url);
      if (!sources.length || !message.token) return;
      clear(); beforePlay();
      token = message.token;
      wantsPlay = true;
      const own = token;
      let sourceIndex = 0;
      const attempt = (position = 0) => {
        release();
        const active = new AudioClass();
        audio = active;
        const current = () => audio === active && token === own;
        const report = (state) => {
          if (!current()) return;
          send({ type: "netease-audio-event", token: own, state, positionMs: Math.round((active.currentTime || 0) * 1000),
            ...(Number.isFinite(active.duration) ? { durationMs: Math.round(active.duration * 1000) } : {}) });
        };
        const failed = () => {
          if (!current()) return;
          const at = active.currentTime || position;
          if (sourceIndex < sources.length) attempt(at);
          else { report("failed"); release(); retry = null; }
        };
        retry = failed;
        active.addEventListener("playing", () => { if (current()) { clearTimeout(timer); timer = null; report("playing"); } });
        for (const [name, state] of [["pause", "paused"], ["ended", "ended"]]) active.addEventListener(name, () => report(state));
        active.addEventListener("error", failed);
        if (position > 0) active.addEventListener("loadedmetadata", () => {
          if (current()) active.currentTime = Number.isFinite(active.duration) ? Math.min(position, active.duration) : position;
        }, { once: true });
        let last = 0;
        active.addEventListener("timeupdate", () => { if (Date.now() - last > 500) { last = Date.now(); report(active.paused ? "paused" : "playing"); } });
        active.src = sources[sourceIndex++];
        if (wantsPlay) {
          timer = setTimeout(failed, sourceTimeoutMs);
          void active.play().catch(failed);
        }
      };
      attempt();
      return;
    }
    if (!audio || message.token !== token) return;
    if (message.action === "pause") { wantsPlay = false; clearTimeout(timer); timer = null; audio.pause(); }
    if (message.action === "resume") {
      wantsPlay = true;
      const failed = retry;
      clearTimeout(timer);
      timer = setTimeout(failed, sourceTimeoutMs);
      void audio.play().catch(failed);
    }
    if (message.action === "seek" && Number.isFinite(message.positionMs)) audio.currentTime = Math.max(0, message.positionMs / 1000);
    if (message.action === "stop") clear();
  }
  return { receive, stop: clear };
}
