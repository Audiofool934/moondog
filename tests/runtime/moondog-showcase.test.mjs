import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MOONDOG_SHOWCASE_ROUTES,
  startMoondogShowcase,
} from "../../src/surfaces/web/showcase.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function copySourceFile(root, relativePath) {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(repositoryRoot, relativePath), destination);
}

function waitForShowcaseUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Showcase startup timed out. ${stderr}`));
    }, 10_000);
    timeout.unref();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(
        /Moondog showcase is ready at (http:\/\/127\.0\.0\.1:[0-9]+\/)/u,
      );
      if (match) finish(() => resolve(match[1]));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => reject(
        new Error(`Showcase exited before startup: ${code ?? signal}. ${stderr}`),
      ));
    });
  });
}

async function stopShowcaseProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await exited;
}

test("showcase is a loopback-only, exact-allowlist, evidence-bounded product tour", async (context) => {
  const showcase = await startMoondogShowcase();
  context.after(() => showcase.close());

  assert.match(showcase.url, /^http:\/\/127\.0\.0\.1:[0-9]+\/$/u);
  const response = await fetch(showcase.url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
  assert.match(response.headers.get("content-security-policy"), /img-src 'self'/u);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.match(html, /Your listening history, made useful\./u);
  assert.match(html, /Explore the Time Machine/u);
  assert.match(html, /What stayed\. What changed\./u);
  assert.match(html, /Artists across eras/u);
  assert.match(html, /Year-to-year turnover/u);
  assert.match(html, /50% carried forward/u);
  assert.match(html, /Some songs find their way back\./u);
  assert.match(html, /Music that came back/u);
  assert.match(html, /Quiet Coordinates/u);
  assert.match(html, /421-day longest gap · 2 returns/u);
  assert.match(html, /732-day gap · 1 return/u);
  assert.match(html, /gap of at least 180 days/u);
  assert.match(
    html,
    /Recurrence is not proof of liking, nostalgia, or intentional absence\./u,
  );
  assert.match(html, /The shape of a listening stretch\./u);
  assert.match(html, /Approximate sessions/u);
  assert.match(html, /Records explored in depth/u);
  assert.match(html, /30-minute grouping is an approximation/u);
  assert.match(html, /The question that started it\./u);
  assert.match(html, /刘森最新的单曲是哪首？/u);
  assert.match(html, /Captured 2026-09-03/u);
  assert.match(html, /moondog catalog latest-single/u);
  assert.match(html, /--artist 刘森/u);
  assert.match(html, /--artist-page candidate-page/u);
  assert.match(html, /--from spotify-history\.zip/u);
  assert.match(html, /returned public page is name-checked before releases load/u);
  assert.match(html, /music\.catalog\.artist_search/u);
  assert.match(html, /music\.catalog\.artist_identity/u);
  assert.match(html, /Returned page can be selected/u);
  assert.match(html, /local\.history\.hint/u);
  assert.match(
    html,
    /Both ZIP commands above are inert showcase text and never read a ZIP\./u,
  );
  assert.match(html, /music\.catalog\.artist_releases/u);
  assert.match(html, /One storefront, not every platform\./u);
  assert.match(
    html,
    /Public music-world evidence stays separate from private listening evidence\./u,
  );
  assert.match(html, /The agent can show its work\./u);
  assert.match(html, /npm run studio --/u);
  assert.match(html, /--from spotify-history\.zip/u);
  assert.match(html, /Session-only private profile/u);
  assert.match(
    html,
    /Stopping Studio discards the in-memory profile and corrections\./u,
  );
  assert.match(html, /profile\.summary/u);
  assert.match(html, /profile\.explain/u);
  assert.match(html, /library\.search/u);
  assert.match(html, /playlist\.plan/u);
  assert.match(
    html,
    /Tasteprint, Time Machine, historical-return, continuity, session-shape, and release-depth names, tracks, dates, and counts are fictional/u,
  );
  assert.match(html, /dated catalog proof uses public Apple Music US metadata/u);
  assert.match(html, /No analytics, scripts, external fonts, or network resources/u);
  assert.doesNotMatch(html, /<script\b/iu);
  assert.doesNotMatch(html, /\bhttps?:\/\//iu);
  assert.doesNotMatch(html, /\/Users\//u);
});

test("showcase serves every declared asset with restrictive headers", async (context) => {
  const showcase = await startMoondogShowcase();
  context.after(() => showcase.close());

  for (const route of MOONDOG_SHOWCASE_ROUTES) {
    const pathname = route.pathnames[0];
    const response = await fetch(new URL(pathname, showcase.url));
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("content-type"), route.contentType, pathname);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", pathname);
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin", pathname);
    assert.ok(body.length > 0, pathname);

    const head = await fetch(new URL(pathname, showcase.url), { method: "HEAD" });
    assert.equal(head.status, 200, `${pathname} HEAD`);
    assert.equal(Number(head.headers.get("content-length")), body.length, pathname);
    assert.equal((await head.arrayBuffer()).byteLength, 0, pathname);

    if (route.contentType.startsWith("text/html")) {
      const artifact = body.toString("utf8");
      assert.doesNotMatch(artifact, /<script\b/iu, pathname);
      assert.doesNotMatch(artifact, /\bhttps?:\/\//iu, pathname);
      assert.doesNotMatch(artifact, /\/Users\//u, pathname);
    }
  }
});

test("showcase rejects nonallowlisted paths, methods, and public binding", async (context) => {
  const showcase = await startMoondogShowcase();
  context.after(() => showcase.close());

  for (const pathname of [
    "/README.md",
    "/package.json",
    "/src/surfaces/web/showcase.mjs",
    "/assets/demo/not-present.png",
  ]) {
    const response = await fetch(new URL(pathname, showcase.url));
    assert.equal(response.status, 404, pathname);
    assert.equal(await response.text(), "Not found.\n", pathname);
  }

  const method = await fetch(showcase.url, { method: "POST", body: "ignored" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
  assert.equal(await method.text(), "Method not allowed.\n");

  await assert.rejects(
    startMoondogShowcase({ host: "0.0.0.0" }),
    /may only listen on 127\.0\.0\.1/u,
  );
  await assert.rejects(
    startMoondogShowcase({ port: 65_536 }),
    /port is invalid/u,
  );
});

test("npm showcase command runs from a source tree with no installed dependencies", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "moondog-zero-install-showcase-"),
  );
  let child = null;
  try {
    const packageMetadata = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    );
    assert.equal(
      packageMetadata.scripts.showcase,
      "node --disable-warning=ExperimentalWarning scripts/showcase.mjs",
    );
    const files = new Set([
      "package.json",
      "scripts/showcase.mjs",
      "src/surfaces/web/showcase.mjs",
      ...MOONDOG_SHOWCASE_ROUTES.map((route) => route.relativePath),
    ]);
    await Promise.all(
      [...files].map((relativePath) =>
        copySourceFile(temporaryRoot, relativePath),
      ),
    );
    await assert.rejects(
      access(path.join(temporaryRoot, "node_modules")),
      /ENOENT/u,
    );

    child = spawn(
      "npm",
      ["run", "--silent", "showcase"],
      {
        cwd: temporaryRoot,
        detached: true,
        env: {
          ...process.env,
          MOONDOG_SHOWCASE_NO_OPEN: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const url = await waitForShowcaseUrl(child);
    const response = await fetch(url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Your listening history, made useful\./u);
    await assert.rejects(
      access(path.join(temporaryRoot, "node_modules")),
      /ENOENT/u,
    );
  } finally {
    await stopShowcaseProcess(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
