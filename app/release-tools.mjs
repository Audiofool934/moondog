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
      if (attempt >= 3 || !/timestamp[^\n]*(?:unavailable|not available|timed out)/iu.test(detail)) throw error;
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

export async function readJson(file, optional = false) {
  try { return JSON.parse(await readFile(file, "utf8")); }
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

// Arguments stay out of logs: callers may use a Keychain profile but never print credentials.
export function command(program, args, { cwd, live = false, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024); if (live) process.stdout.write(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8 * 1024 * 1024); if (live) process.stderr.write(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(Object.assign(new Error(`${program} ${timedOut ? "timed out" : `exited ${code}`}\n${stderr || stdout}`), { stdout, stderr, code }));
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
