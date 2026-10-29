import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_REPO = "Audiofool934/moondog";
export const SIGNING_TEAM = "DAK5S3455A";

// osx-sign 1.3.3 mistakes binary data for executable code, including each framework
// symlink alias. These known Electron data files remain sealed by the framework.
// Never match a framework, executable, dylib, node module, or our Music helper.
export const ELECTRON_DATA_SIGN_IGNORE = String.raw`/Electron Framework\.framework/(?:Versions/(?:A|Current)/)?Resources/(?:[^/]+\.lproj/locale\.pak|(?:chrome_100_percent|chrome_200_percent|resources)\.pak|icudtl\.dat|v8_context_snapshot\.arm64\.bin)$`;

// electron-builder already retries its app signing. Only our direct DMG codesign
// needs this bounded retry, and only for a transient timestamp-service failure.
export async function retryTimestampSigning(operation, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), warn = console.warn } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const detail = `${error.message || ""}\n${error.stderr || ""}`;
      if (attempt >= 3 || !(error.timestampUnavailable === true || /timestamp[^\n]*(?:unavailable|not available|timed out)/iu.test(detail))) throw error;
      warn(`Apple's timestamp service did not respond. Retry signing ${attempt + 1}/3.`);
      await wait(attempt * 5000);
    }
  }
}

// electron-builder adds the certificate type itself; codesign needs the full identity.
export function builderSigningIdentity(identity) {
  if (identity === null) return null;
  const prefix = "Developer ID Application: ";
  if (!identity.startsWith(prefix)) throw new Error("Expected a Developer ID Application identity.");
  return identity.slice(prefix.length);
}

export function parseReleaseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error("Release command returned invalid JSON."); }
}

export async function readJson(file, optional = false) {
  try { return parseReleaseJson(await readFile(file, "utf8")); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

export async function digestFile(file) {
  const sha256 = createHash("sha256"), sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; sha256.update(chunk); sha512.update(chunk); }
  return { name: path.basename(file), size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

const commandNames = new Set(["node", "npm", "git", "gh", "tar", "ditto", "security", "codesign", "xcrun", "spctl", "hdiutil", "PlistBuddy"]);
const commandName = program => typeof program === "string" && commandNames.has(path.basename(program)) ? path.basename(program) : "Release command";
const systemCodes = new Set(["ENOENT", "EACCES", "EPERM", "EAGAIN", "E2BIG", "EINVAL", "ENOMEM", "ENOTDIR", "EMFILE", "ENFILE", "ENOEXEC", "ETXTBSY"]);
const npmCodes = new Set(["E401", "E403", "E404", "E429", "E500", "E502", "E503", "E504", "EOTP", "ENEEDAUTH", "EPUBLISHCONFLICT", "EPRIVATE", "EUSAGE",
  "ENOENT", "EACCES", "EPERM", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
const signalNames = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGILL", "SIGBUS", "SIGPIPE"]);

// Child output may contain credentials. Return only fixed, recognized diagnostics;
// never retain the raw output, spawn arguments, original error, or its cause.
export function commandFailure(program, { stdout = "", stderr = "", code, signal, timedOut = false } = {}) {
  const output = `${stdout}\n${stderr}`, fields = {}, details = [];
  if (Number.isInteger(code) || systemCodes.has(code)) { fields.code = code; details.push(Number.isInteger(code) ? `exit ${code}` : code); }
  if (signalNames.has(signal)) { fields.signal = signal; details.push(signal); }
  if (timedOut) { fields.timedOut = true; details.push("timed out"); }
  const statuses = [...new Set([...output.matchAll(/\bHTTP(?:\/[12](?:\.\d)?)? ([1-5]\d{2})(?=[)\s]|$)/gu)].map(match => Number(match[1])))];
  if (statuses.length === 1) { fields.httpStatus = statuses[0]; details.push(`HTTP ${statuses[0]}`); }
  if (/timestamp[^\n]*(?:unavailable|not available|timed out)/iu.test(output)) {
    fields.timestampUnavailable = true; details.push("timestamp service unavailable");
  }
  const codes = [...new Set([...output.matchAll(/^npm (?:error|ERR!) code (E[A-Z0-9_]+)\s*$/gmu)].map(match => match[1]).filter(code => npmCodes.has(code)))];
  if (codes.length) { fields.npmCodes = codes; details.push(`npm ${codes.join(", ")}`); }
  return Object.assign(new Error(`${commandName(program)} failed (${details.join("; ") || "no exit status available"}).`), fields);
}

// Successful output stays private for JSON parsing. Live mode reports only fixed
// progress, never stdout/stderr from npm, signing tools, or their dependencies.
export function command(program, args, { cwd, live = false, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now(), label = commandName(program);
    if (live) process.stdout.write(`${label}: started.\n`);
    let child;
    try { child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(commandFailure(program, { code: error.code })); return; }
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
    const progress = live ? setInterval(() => process.stdout.write(`${label}: ${Math.round((Date.now() - start) / 1000)}s elapsed.\n`), 30_000) : null;
    const clearTimers = () => { clearTimeout(timer); clearInterval(progress); };
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8 * 1024 * 1024); });
    child.once("error", error => { settled = true; clearTimers(); reject(commandFailure(program, { code: error.code })); });
    child.once("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (live) process.stdout.write(`${label}: ${code === 0 && !timedOut ? "complete" : "failed"} after ${Math.round((Date.now() - start) / 1000)}s.\n`);
      if (code === 0 && !timedOut) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(commandFailure(program, { stdout, stderr, code, signal, timedOut }));
    });
  });
}

export async function phase(label, operation) {
  const start = Date.now();
  const elapsed = () => `${Math.round((Date.now() - start) / 1000)}s`;
  console.log(`\n${label}`);
  const timer = setInterval(() => console.log(`${label}: ${elapsed()} elapsed`), 30_000);
  try { const result = await operation(); console.log(`${label}: complete in ${elapsed()}`); return result; }
  finally { clearInterval(timer); }
}

export async function signingIdentity(run = command) {
  const { stdout } = await run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = [...stdout.matchAll(/"(Developer ID Application: [^"]+)"/gu)].map(match => match[1]);
  const selected = process.env.MOONDOG_SIGNING_IDENTITY;
  const matches = identities.filter(value => value.endsWith(`(${SIGNING_TEAM})`) && (!selected || value === selected));
  if (matches.length !== 1) throw new Error(`Expected one Developer ID Application identity for team ${SIGNING_TEAM}; found ${matches.length}.`);
  return matches[0];
}
