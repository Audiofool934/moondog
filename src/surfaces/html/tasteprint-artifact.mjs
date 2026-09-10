import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { resolveListeningHistoryPath } from "../../profile/listening-history-store.mjs";
import {
  renderTasteprintCardHtml,
  renderTasteprintHtml,
} from "./tasteprint.mjs";

function timestampSlug(value) {
  return new Date(value).toISOString().replaceAll(/[:.]/gu, "-");
}

export function resolveTasteprintOutputPath({
  outputPath,
  environment = process.env,
  generatedAt = new Date().toISOString(),
  format = "full",
} = {}) {
  if (!new Set(["full", "card"]).has(format)) {
    throw new TypeError("Tasteprint artifact format must be full or card.");
  }
  if (outputPath !== undefined) {
    if (typeof outputPath !== "string" || !outputPath.trim()) {
      throw new TypeError("Tasteprint output path must be a non-empty string.");
    }
    const resolved = path.resolve(outputPath);
    if (path.extname(resolved).toLocaleLowerCase("en-US") !== ".html") {
      throw new TypeError("Tasteprint output path must end in .html.");
    }
    return { path: resolved, privateDirectory: false };
  }

  const privateRoot = path.join(
    path.dirname(resolveListeningHistoryPath(environment)),
    "tasteprints",
  );
  return {
    path: path.join(
      privateRoot,
      `${format === "card" ? "tasteprint-card" : "tasteprint"}-${timestampSlug(generatedAt)}.html`,
    ),
    privateDirectory: true,
  };
}

export async function writeTasteprintArtifact(
  profile,
  {
    outputPath,
    environment = process.env,
    generatedAt = new Date().toISOString(),
    format = "full",
  } = {},
) {
  const destination = resolveTasteprintOutputPath({
    outputPath,
    environment,
    generatedAt,
    format,
  });
  const directory = path.dirname(destination.path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (destination.privateDirectory) await chmod(directory, 0o700);

  const html = format === "card"
    ? renderTasteprintCardHtml(profile, { generatedAt })
    : renderTasteprintHtml(profile, { generatedAt });
  let handle;
  try {
    handle = await open(destination.path, "wx", 0o600);
    await handle.writeFile(html, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Tasteprint output already exists: ${destination.path}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await chmod(destination.path, 0o600);

  return {
    artifact_version:
      format === "card"
        ? "moondog-tasteprint-card-artifact/1"
        : "moondog-tasteprint-artifact/1",
    artifact_format: format,
    path: destination.path,
    bytes: Buffer.byteLength(html),
    sha256: createHash("sha256").update(html).digest("hex"),
    private: true,
    network_requests: "none",
  };
}
