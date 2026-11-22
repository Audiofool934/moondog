// Plays a score into a WAV file with the DAWN SDK's offline renderer (vendor/dawn-sdk.mjs). The
// renderer is plain JavaScript on one CPU thread: a minute of music takes a few seconds, with no
// model, GPU or network. It runs in a worker, so the room keeps answering while a track is made;
// run as the worker, this file is the render itself.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

// The rate Moondog's other made tracks have.
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
// A minute takes a few seconds; a five-minute score on a slow laptop must still fit.
const RENDER_TIMEOUT_MS = 5 * 60_000;
// The renderer leaves several seconds of silence after the last note has rung out. The track ends
// a moment after the sound falls below about -60 dB, with a short fade so the cut is not heard.
const SILENCE = 33;
const AFTER_SECONDS = 0.4;
const FADE_SECONDS = 0.05;

function trimmed(pcm, sampleRate) {
  let last = pcm.length - 1;
  while (last >= 0 && Math.abs(pcm[last]) <= SILENCE) last -= 1;
  if (last < 0) return pcm.subarray(0, 0);
  const frames = Math.min(pcm.length / CHANNELS, Math.floor(last / CHANNELS) + 1 + Math.round(AFTER_SECONDS * sampleRate));
  const kept = pcm.slice(0, frames * CHANNELS);
  const fade = Math.min(frames, Math.round(FADE_SECONDS * sampleRate));
  for (let frame = 0; frame < fade; frame += 1) {
    const gain = frame / fade;
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const index = (frames - 1 - frame) * CHANNELS + channel;
      kept[index] = Math.round(kept[index] * gain);
    }
  }
  return kept;
}

function wav(pcm, sampleRate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Renders on the calling thread. Returns { frames, sample_rate, clipped }. */
export async function renderScoreHere(score, file) {
  const { renderArrangedPcm, scoreFromJSON } = await import("./vendor/dawn-sdk.mjs");
  const audio = renderArrangedPcm(scoreFromJSON(score), { sampleRate: SAMPLE_RATE });
  const pcm = trimmed(audio.pcm, audio.sampleRate);
  if (!pcm.length) throw Object.assign(new Error("The score rendered as silence."), { code: "generation_failed" });
  let clipped = 0;
  for (const sample of pcm) if (sample === -32768 || sample === 32767) clipped += 1;
  await writeFile(file, wav(pcm, audio.sampleRate), { mode: 0o600 });
  return { frames: pcm.length / CHANNELS, sample_rate: audio.sampleRate, clipped };
}

/**
 * Renders a score (as track-score.mjs builds it) into file, off the calling thread. A stop ends the
 * worker at once and leaves no file behind for the caller to keep.
 */
export function renderScore(score, file, { signal } = {}) {
  const stopped = () => Object.assign(new Error("Making the track was stopped."), { name: "AbortError", code: "generation_stopped" });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { score, file } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const stop = () => finish(stopped());
    const timer = setTimeout(() => finish(Object.assign(new Error("The score took too long to render, so the track was stopped."), { code: "generation_timed_out" })), RENDER_TIMEOUT_MS);
    signal?.addEventListener("abort", stop, { once: true });
    worker.once("message", (message) => {
      if (message?.ok) finish(null, message.result);
      else finish(Object.assign(new Error("The score could not be rendered."), { code: message?.code ?? "generation_failed" }));
    });
    // The worker's own errors can carry paths; only the failure is reported.
    worker.once("error", () => finish(Object.assign(new Error("The score could not be rendered."), { code: "generation_failed" })));
    worker.once("exit", () => finish(Object.assign(new Error("The score could not be rendered."), { code: "generation_failed" })));
  });
}

if (!isMainThread && parentPort && workerData?.file) {
  try {
    parentPort.postMessage({ ok: true, result: await renderScoreHere(workerData.score, workerData.file) });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: typeof error?.code === "string" ? error.code : "generation_failed" });
  }
}
