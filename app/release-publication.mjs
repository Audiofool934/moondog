import { compareReleaseVersions, releaseVersion } from "../src/core/application-update.mjs";

export function validateNpmRelease(metadata, { name, version, source }) {
  if (metadata?.name !== name || metadata.version !== version || metadata.gitHead !== source) {
    throw new Error("The published npm package does not match this release version and commit.");
  }
}

export function markAsLatest(version, existingVersions) {
  if (!releaseVersion(version)) throw new Error("Invalid release version.");
  if (version.includes("-")) return false;
  return existingVersions.every(current => {
    if (!current) return true;
    if (!releaseVersion(current)) throw new Error(`Cannot compare the current latest version: ${current}`);
    return compareReleaseVersions(version, current) >= 0;
  });
}

// Check every existing asset before uploading anything. Public releases are immutable;
// incomplete drafts can resume, but changed bytes require a new release version.
export async function uploadImmutableAssets({ items, getRelease, upload, remoteDigest, deleteAsset }) {
  let release = await getRelease();
  const missing = [];
  const placeholders = new Map();
  const emptyStarter = asset => asset?.state === "starter" && asset.size === 0 && Number.isSafeInteger(asset.id) && asset.id > 0;
  const find = (snapshot, item) => {
    const matches = snapshot.assets.filter(asset => asset.name === item.name);
    if (matches.length > 1) throw new Error(`Duplicate remote asset: ${item.name}.`);
    return matches[0];
  };
  const check = async (item, asset) => {
    if (asset.state !== "uploaded" || asset.size !== item.size || await remoteDigest(asset) !== item.sha256) {
      throw new Error(`Remote asset differs: ${item.name}. It was not overwritten; publish a new version.`);
    }
  };
  for (const item of items) {
    const asset = find(release, item);
    // GitHub documents empty starter assets left by a 502 as safe to delete.
    // Finish the immutable-asset preflight before removing even a draft placeholder.
    if (release.draft && emptyStarter(asset)) { placeholders.set(item.name, asset); missing.push(item); }
    else if (asset) await check(item, asset);
    else missing.push(item);
  }
  if (!release.draft && missing.length) throw new Error("The public release is incomplete. Do not repair it by replacing live assets; publish a new version.");
  for (const item of missing) {
    release = await getRelease();
    if (!release.draft) throw new Error("The release is now public; no assets were changed.");
    let existing = find(release, item);
    const placeholder = placeholders.get(item.name);
    if (placeholder && existing) {
      if (existing.id !== placeholder.id || !emptyStarter(existing)) throw new Error(`The upload placeholder changed: ${item.name}. It was not deleted.`);
      if (!deleteAsset) throw new Error(`Cannot recover the empty upload placeholder: ${item.name}.`);
      await deleteAsset(existing);
      release = await getRelease();
      if (!release.draft) throw new Error("The release is now public; no further assets were changed.");
      existing = find(release, item);
    }
    if (existing) { await check(item, existing); continue; }
    await upload(item);
    release = await getRelease();
    const asset = find(release, item);
    if (!asset) throw new Error(`The upload is missing: ${item.name}.`);
    await check(item, asset);
  }
  return release;
}
