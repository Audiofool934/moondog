const validUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && /(?:^|\.)music\.126\.net$/u.test(url.hostname) ? url.href : null;
  } catch { return null; }
};

export function createNeteaseAudio({ send, beforePlay = () => {}, AudioClass = Audio }) {
  let audio = null;
  let token = null;
  function clear() {
    token = null;
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); audio = null; }
  }
  function receive(message) {
    if (message.type !== "netease-audio") return;
    if (message.action === "play") {
      const url = validUrl(message.url);
      if (!url || !message.token) return;
      clear(); beforePlay();
      token = message.token;
      const active = new AudioClass();
      audio = active;
      const own = token;
      const report = (state) => {
        if (audio !== active || token !== own) return;
        send({ type: "netease-audio-event", token: own, state, positionMs: Math.round((active.currentTime || 0) * 1000),
          ...(Number.isFinite(active.duration) ? { durationMs: Math.round(active.duration * 1000) } : {}) });
      };
      for (const [name, state] of [["playing", "playing"], ["pause", "paused"], ["ended", "ended"], ["error", "failed"]]) active.addEventListener(name, () => report(state));
      let last = 0;
      active.addEventListener("timeupdate", () => { if (Date.now() - last > 500) { last = Date.now(); report(active.paused ? "paused" : "playing"); } });
      active.src = url;
      void active.play().catch(() => report("failed"));
      return;
    }
    if (!audio || message.token !== token) return;
    if (message.action === "pause") audio.pause();
    if (message.action === "resume") void audio.play().catch(() => send({ type: "netease-audio-event", token, state: "failed" }));
    if (message.action === "seek" && Number.isFinite(message.positionMs)) audio.currentTime = Math.max(0, message.positionMs / 1000);
    if (message.action === "stop") clear();
  }
  return { receive, stop: clear };
}
