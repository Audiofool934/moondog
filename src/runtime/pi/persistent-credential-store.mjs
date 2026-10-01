import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { apiKeyPiProviderIds } from "./provider-registry.mjs";

const AUTH_DOCUMENT_VERSION = 1;
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const LOCK_TIMEOUT_MS = 30_000;
const SUPPORTED_CREDENTIAL_PROVIDERS = new Set([
  "openai-codex",
  "spotify",
  ...apiKeyPiProviderIds,
]);
const POSIX_PERMISSIONS_APPLY = process.platform !== "win32";

function safeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogCredentialStoreError";
  error.code = code;
  return error;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function assertNotAborted(signal) {
  signal?.throwIfAborted();
}

function assertPlainRecord(value, description) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw safeError(
      "credential_store_corrupt",
      `Moondog credential storage contains an invalid ${description}.`,
    );
  }
}

function assertExactKeys(value, expected, description) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw safeError(
      "credential_store_corrupt",
      `Moondog credential storage contains an unsupported ${description}.`,
    );
  }
}

function assertSecretString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw safeError(
      "credential_store_corrupt",
      `Moondog credential storage contains an invalid ${field}.`,
    );
  }
}

function validateOpenAICodexCredential(value) {
  assertPlainRecord(value, "openai-codex credential");
  assertExactKeys(
    value,
    ["access", "accountId", "expires", "refresh", "type"],
    "openai-codex credential shape",
  );
  if (value.type !== "oauth") {
    throw safeError(
      "credential_store_corrupt",
      "Moondog openai-codex credentials must use OAuth.",
    );
  }
  assertSecretString(value.access, "OAuth access token");
  assertSecretString(value.refresh, "OAuth refresh token");
  assertSecretString(value.accountId, "OAuth account identifier");
  if (!Number.isSafeInteger(value.expires) || value.expires <= 0) {
    throw safeError(
      "credential_store_corrupt",
      "Moondog credential storage contains an invalid OAuth expiry.",
    );
  }
  return structuredClone(value);
}

function validateSpotifyCredential(value) {
  assertPlainRecord(value, "spotify credential");
  assertExactKeys(
    value,
    [
      "accessExpiresAt",
      "accessToken",
      "refreshExpiresAt",
      "refreshToken",
      "scope",
      "tokenType",
      "type",
      ...(value.refreshAttempt === undefined ? [] : ["refreshAttempt"]),
    ],
    "spotify credential shape",
  );
  if (value.refreshAttempt !== undefined) {
    assertPlainRecord(value.refreshAttempt, "Spotify refresh attempt");
    assertExactKeys(value.refreshAttempt, ["id", "startedAt"], "Spotify refresh attempt");
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(value.refreshAttempt.id) ||
        !Number.isSafeInteger(value.refreshAttempt.startedAt) || value.refreshAttempt.startedAt <= 0) {
      throw safeError("credential_store_corrupt", "Moondog Spotify refresh state is invalid.");
    }
  }
  if (value.type !== "oauth") {
    throw safeError(
      "credential_store_corrupt",
      "Moondog Spotify credentials must use OAuth.",
    );
  }
  assertSecretString(value.accessToken, "Spotify OAuth access token");
  assertSecretString(value.refreshToken, "Spotify OAuth refresh token");
  if (
    typeof value.tokenType !== "string" ||
    value.tokenType.toLowerCase() !== "bearer"
  ) {
    throw safeError(
      "credential_store_corrupt",
      "Moondog Spotify credentials use an unsupported token type.",
    );
  }
  if (typeof value.scope !== "string" || value.scope.trim().length === 0) {
    throw safeError(
      "credential_store_corrupt",
      "Moondog Spotify credentials contain an invalid OAuth scope.",
    );
  }
  for (const [field, expiry] of [
    ["accessExpiresAt", value.accessExpiresAt],
    ["refreshExpiresAt", value.refreshExpiresAt],
  ]) {
    if (!Number.isSafeInteger(expiry) || expiry <= 0) {
      throw safeError(
        "credential_store_corrupt",
        `Moondog Spotify credentials contain an invalid ${field}.`,
      );
    }
  }
  return structuredClone(value);
}

function validateCredential(providerId, value) {
  if (providerId === "openai-codex") {
    return validateOpenAICodexCredential(value);
  }
  if (providerId === "spotify") {
    return validateSpotifyCredential(value);
  }
  if (apiKeyPiProviderIds.includes(providerId)) {
    assertPlainRecord(value, `${providerId} credential`);
    assertExactKeys(value, ["type", "key"], `${providerId} credential shape`);
    if (
      value.type !== "api_key" ||
      typeof value.key !== "string" ||
      value.key.length === 0 ||
      /[\u0000-\u0020\u007f]/u.test(value.key)
    ) {
      throw safeError(
        "credential_store_corrupt",
        `Moondog ${providerId} credentials must contain a nonempty API key without whitespace or control characters.`,
      );
    }
    return structuredClone(value);
  }
  throw safeError(
    "credential_provider_unsupported",
    `Moondog does not persist credentials for provider ${providerId}.`,
  );
}

function emptyDocument() {
  return {
    version: AUTH_DOCUMENT_VERSION,
    credentials: {},
  };
}

function validateDocument(value) {
  assertPlainRecord(value, "document");
  assertExactKeys(value, ["credentials", "version"], "document shape");
  if (value.version !== AUTH_DOCUMENT_VERSION) {
    throw safeError(
      "credential_store_version_unsupported",
      "Moondog credential storage uses an unsupported version.",
    );
  }
  assertPlainRecord(value.credentials, "credential map");

  const credentials = {};
  for (const providerId of Object.keys(value.credentials).sort()) {
    if (!SUPPORTED_CREDENTIAL_PROVIDERS.has(providerId)) {
      throw safeError(
        "credential_store_corrupt",
        "Moondog credential storage contains an unsupported provider entry.",
      );
    }
    credentials[providerId] = validateCredential(
      providerId,
      value.credentials[providerId],
    );
  }
  return {
    version: AUTH_DOCUMENT_VERSION,
    credentials,
  };
}

function assertOwned(stat, description) {
  if (
    POSIX_PERMISSIONS_APPLY &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw safeError(
      "credential_store_unsafe",
      `Moondog credential ${description} is not owned by the current user.`,
    );
  }
}

function safeOpenFlags(base) {
  return base | (fsConstants.O_NOFOLLOW ?? 0);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export function resolveMoondogAuthFile(environment = process.env) {
  const configured = environment.MOONDOG_CONFIG_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw safeError(
        "credential_store_path_invalid",
        "MOONDOG_CONFIG_HOME must be an absolute path.",
      );
    }
    return path.join(path.resolve(configured), "auth.json");
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome && path.isAbsolute(xdgConfigHome)) {
    return path.join(path.resolve(xdgConfigHome), "moondog", "auth.json");
  }

  return path.join(homedir(), ".config", "moondog", "auth.json");
}

export class PersistentCredentialStore {
  constructor({ authFile = resolveMoondogAuthFile() } = {}) {
    if (!path.isAbsolute(authFile)) {
      throw safeError(
        "credential_store_path_invalid",
        "The Moondog credential file path must be absolute.",
      );
    }
    this.authFile = path.resolve(authFile);
    this.directory = path.dirname(this.authFile);
    this.lockDirectory = `${this.authFile}.lock`;
  }

  async ensureDirectory({ create }) {
    if (create) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }

    let stat;
    try {
      stat = await lstat(this.directory);
    } catch (error) {
      if (!create && isMissing(error)) return false;
      throw safeError(
        "credential_store_unsafe",
        "Moondog could not access its credential directory.",
        error,
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw safeError(
        "credential_store_unsafe",
        "The Moondog credential directory must be a real directory, not a symlink.",
      );
    }
    assertOwned(stat, "directory");
    if (POSIX_PERMISSIONS_APPLY && (stat.mode & 0o077) !== 0) {
      throw safeError(
        "credential_store_unsafe",
        "The Moondog credential directory permissions must be 0700.",
      );
    }
    return true;
  }

  async readDocument(options = {}) {
    assertNotAborted(options.signal);
    if (!(await this.ensureDirectory({ create: false }))) {
      return emptyDocument();
    }

    let handle;
    try {
      handle = await open(
        this.authFile,
        safeOpenFlags(fsConstants.O_RDONLY),
      );
    } catch (error) {
      if (isMissing(error)) return emptyDocument();
      throw safeError(
        "credential_store_unsafe",
        "Moondog could not safely open its credential file.",
        error,
      );
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw safeError(
          "credential_store_unsafe",
          "The Moondog credential path must contain a regular file.",
        );
      }
      assertOwned(stat, "file");
      if (stat.size > MAX_AUTH_FILE_BYTES) {
        throw safeError(
          "credential_store_corrupt",
          "The Moondog credential file is unexpectedly large.",
        );
      }
      if (POSIX_PERMISSIONS_APPLY && (stat.mode & 0o077) !== 0) {
        throw safeError(
          "credential_store_unsafe",
          "The Moondog credential file permissions must be 0600.",
        );
      }
      assertNotAborted(options.signal);
      const serialized = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(serialized, "utf8") > MAX_AUTH_FILE_BYTES) {
        throw safeError(
          "credential_store_corrupt",
          "The Moondog credential file is unexpectedly large.",
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(serialized);
      } catch (error) {
        throw safeError(
          "credential_store_corrupt",
          "The Moondog credential file is not valid JSON.",
          error,
        );
      }
      return validateDocument(parsed);
    } finally {
      await handle.close();
    }
  }

  async writeDocument(document, options = {}) {
    assertNotAborted(options.signal);
    await this.ensureDirectory({ create: true });
    const validated = validateDocument(document);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_AUTH_FILE_BYTES) {
      throw safeError(
        "credential_store_corrupt",
        "The Moondog credential document is unexpectedly large.",
      );
    }

    try {
      const targetStat = await lstat(this.authFile);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw safeError(
          "credential_store_unsafe",
          "The Moondog credential path must contain a regular file.",
        );
      }
      assertOwned(targetStat, "file");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const temporaryFile = path.join(
      this.directory,
      `.auth.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    let renamed = false;
    try {
      handle = await open(
        temporaryFile,
        safeOpenFlags(
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_WRONLY,
        ),
        0o600,
      );
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      assertNotAborted(options.signal);
      await rename(temporaryFile, this.authFile);
      renamed = true;
      await syncDirectory(this.directory);
    } finally {
      await handle?.close();
      if (!renamed) {
        await unlink(temporaryFile).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      }
    }
  }

  async readLockOwner() {
    let handle;
    try {
      const names = await readdir(this.lockDirectory);
      if (names.length !== 1) return undefined;
      const [name] = names;
      if (name !== "owner.json" && !/^owner-[\da-f-]{36}\.json$/u.test(name)) return undefined;
      handle = await open(
        path.join(this.lockDirectory, name),
        safeOpenFlags(fsConstants.O_RDONLY),
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) return undefined;
      assertOwned(stat, "lock owner file");
      const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Number.isSafeInteger(parsed.pid) ||
        parsed.pid <= 0 ||
        typeof parsed.nonce !== "string" ||
        parsed.nonce.length === 0 ||
        !Number.isSafeInteger(parsed.createdAt) ||
        parsed.createdAt <= 0
      ) {
        return undefined;
      }
      if (name !== "owner.json" && name !== `owner-${parsed.nonce}.json`) return undefined;
      return { ...parsed, file: path.join(this.lockDirectory, name), legacy: name === "owner.json" };
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined;
      throw safeError(
        "credential_store_unsafe",
        "Moondog could not safely inspect its credential lock.",
        error,
      );
    } finally {
      await handle?.close();
    }
  }

  processIsAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  async recoverStaleLock() {
    let lockStat;
    try {
      lockStat = await lstat(this.lockDirectory);
    } catch (error) {
      if (isMissing(error)) return true;
      throw safeError(
        "credential_store_unsafe",
        "Moondog could not inspect its credential lock.",
        error,
      );
    }
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      throw safeError(
        "credential_store_unsafe",
        "The Moondog credential lock path is unsafe.",
      );
    }
    assertOwned(lockStat, "lock directory");

    const owner = await this.readLockOwner();
    // An empty/partial owner can be a live creator. Legacy fixed filenames
    // cannot be reclaimed without a reaper deleting a successor's owner.
    if (!owner || owner.legacy || this.processIsAlive(owner.pid)) return false;
    try {
      await unlink(owner.file);
    } catch (error) {
      // Only the successful unlinker may remove the directory. A losing
      // reaper must never remove a new owner's empty creation window.
      return false;
    }
    try {
      await rmdir(this.lockDirectory);
      return true;
    } catch (error) {
      return isMissing(error);
    }
  }

  async acquireLock(options = {}) {
    assertNotAborted(options.signal);
    await this.ensureDirectory({ create: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      assertNotAborted(options.signal);
      const owner = {
        pid: process.pid,
        nonce: randomUUID(),
        createdAt: Date.now(),
      };
      const ownerFile = path.join(this.lockDirectory, `owner-${owner.nonce}.json`);
      try {
        await mkdir(this.lockDirectory, { mode: 0o700 });
        let handle;
        try {
          handle = await open(
            ownerFile,
            safeOpenFlags(
              fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_WRONLY,
            ),
            0o600,
          );
          await handle.writeFile(`${JSON.stringify(owner)}\n`, {
            encoding: "utf8",
          });
          await handle.sync();
        } catch (error) {
          await handle?.close();
          await unlink(ownerFile).catch(() => {});
          await rmdir(this.lockDirectory).catch(() => {});
          throw safeError(
            "credential_store_unsafe",
            "Moondog could not create its credential lock.",
            error,
          );
        } finally {
          await handle?.close();
        }

        return async () => {
          const currentOwner = await this.readLockOwner();
          if (!currentOwner || currentOwner.nonce !== owner.nonce) {
            throw safeError(
              "credential_store_lock_lost",
              "Moondog lost ownership of its credential lock.",
            );
          }
          await unlink(ownerFile);
          await rmdir(this.lockDirectory);
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      if (await this.recoverStaleLock()) continue;
      if (Date.now() >= deadline) {
        throw safeError(
          "credential_store_locked",
          "Moondog credential storage is busy in another process.",
        );
      }
      await delay(75, undefined, { signal: options.signal });
    }
  }

  async read(providerId, options = {}) {
    assertNotAborted(options.signal);
    if (!SUPPORTED_CREDENTIAL_PROVIDERS.has(providerId)) return undefined;
    const document = await this.readDocument(options);
    const credential = document.credentials[providerId];
    return credential ? structuredClone(credential) : undefined;
  }

  async list(options = {}) {
    assertNotAborted(options.signal);
    const document = await this.readDocument(options);
    return Object.entries(document.credentials).map(
      ([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }),
    );
  }

  async modify(providerId, fn, options = {}) {
    if (!SUPPORTED_CREDENTIAL_PROVIDERS.has(providerId)) {
      throw safeError(
        "credential_provider_unsupported",
        `Moondog does not persist credentials for provider ${providerId}.`,
      );
    }
    const release = await this.acquireLock(options);
    try {
      const document = await this.readDocument(options);
      let current = document.credentials[providerId];
      const persist = async (value) => {
        const validated = validateCredential(providerId, value);
        document.credentials[providerId] = validated;
        await this.writeDocument(document, options);
        current = validated;
      };
      let active = true;
      let pending = Promise.resolve();
      // A checkpoint is durable even if the callback later throws. Its
      // lifetime is fenced to this transaction; all started writes drain
      // before the lock is released, including accidentally unawaited ones.
      const checkpoint = (value) => {
        if (!active) throw safeError("credential_store_transaction_closed", "The credential transaction has ended.");
        const validated = validateCredential(providerId, value);
        pending = pending.then(() => persist(validated));
        pending.catch(() => {});
        return pending;
      };
      let next;
      try {
        next = await fn(current ? structuredClone(current) : undefined, { checkpoint });
      } finally {
        active = false;
        await pending;
      }
      assertNotAborted(options.signal);
      if (next === undefined) {
        return current ? structuredClone(current) : undefined;
      }
      await persist(next);
      return structuredClone(current);
    } finally {
      await release();
    }
  }

  async delete(providerId, options = {}) {
    if (!SUPPORTED_CREDENTIAL_PROVIDERS.has(providerId)) {
      throw safeError(
        "credential_provider_unsupported",
        `Moondog does not persist credentials for provider ${providerId}.`,
      );
    }
    const release = await this.acquireLock(options);
    try {
      const document = await this.readDocument(options);
      if (!(providerId in document.credentials)) return;
      delete document.credentials[providerId];
      await this.writeDocument(document, options);
    } finally {
      await release();
    }
  }
}

export function createPersistentCredentialStore(environment = process.env) {
  return new PersistentCredentialStore({
    authFile: resolveMoondogAuthFile(environment),
  });
}

// Reuse the owner-checked, cancellable filesystem lock for other private files.
// This acquires only <file>.lock; it never reads or writes credential documents.
export function acquirePrivateFileLock(file, options = {}) {
  return new PersistentCredentialStore({ authFile: file }).acquireLock(options);
}
