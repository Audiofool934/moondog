import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MOONDOG_SHOWCASE_HOST = "127.0.0.1";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const showcaseContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
].join("; ");

const artifactContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
].join("; ");

export const MOONDOG_SHOWCASE_ROUTES = Object.freeze([
  {
    pathnames: ["/", "/showcase", "/showcase/", "/index.html"],
    relativePath: "showcase/index.html",
    contentType: "text/html; charset=utf-8",
    contentSecurityPolicy: showcaseContentSecurityPolicy,
  },
  {
    pathnames: [
      "/assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
    ],
    relativePath:
      "assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
    contentType: "image/png",
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
  },
  {
    pathnames: ["/assets/demo/moondog-time-machine-preview.png"],
    relativePath: "assets/demo/moondog-time-machine-preview.png",
    contentType: "image/png",
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
  },
  {
    pathnames: ["/assets/demo/moondog-offline-demo.gif"],
    relativePath: "assets/demo/moondog-offline-demo.gif",
    contentType: "image/gif",
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
  },
  {
    pathnames: ["/assets/demo/moondog-tasteprint-card-preview.png"],
    relativePath: "assets/demo/moondog-tasteprint-card-preview.png",
    contentType: "image/png",
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
  },
  {
    pathnames: ["/assets/demo/moondog-tasteprint-demo.html"],
    relativePath: "assets/demo/moondog-tasteprint-demo.html",
    contentType: "text/html; charset=utf-8",
    contentSecurityPolicy: artifactContentSecurityPolicy,
  },
  {
    pathnames: ["/assets/demo/moondog-tasteprint-card-demo.html"],
    relativePath: "assets/demo/moondog-tasteprint-card-demo.html",
    contentType: "text/html; charset=utf-8",
    contentSecurityPolicy: artifactContentSecurityPolicy,
  },
]);

function baseHeaders(contentType, contentSecurityPolicy) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": contentSecurityPolicy,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, statusCode, body, headers, { headOnly = false } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(statusCode, {
    ...headers,
    "Content-Length": buffer.length,
  });
  response.end(headOnly ? undefined : buffer);
}

function plainTextHeaders() {
  return baseHeaders(
    "text/plain; charset=utf-8",
    "default-src 'none'; frame-ancestors 'none'",
  );
}

async function loadRoutes(root) {
  const routeMap = new Map();
  for (const route of MOONDOG_SHOWCASE_ROUTES) {
    const body = await readFile(path.join(root, route.relativePath));
    for (const pathname of route.pathnames) {
      routeMap.set(pathname, {
        body,
        headers: baseHeaders(
          route.contentType,
          route.contentSecurityPolicy,
        ),
      });
    }
  }
  return routeMap;
}

async function openBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function startMoondogShowcase({
  host = MOONDOG_SHOWCASE_HOST,
  port = 0,
  root = repositoryRoot,
} = {}) {
  if (host !== MOONDOG_SHOWCASE_HOST) {
    throw new TypeError("The Moondog showcase may only listen on 127.0.0.1.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("The Moondog showcase port is invalid.");
  }
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("The Moondog showcase root must be absolute.");
  }

  const routes = await loadRoutes(root);
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      request.resume();
      send(response, 405, "Method not allowed.\n", {
        ...plainTextHeaders(),
        Allow: "GET, HEAD",
      });
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      send(response, 400, "Bad request.\n", plainTextHeaders(), {
        headOnly: method === "HEAD",
      });
      return;
    }
    const route = routes.get(pathname);
    if (!route) {
      send(response, 404, "Not found.\n", plainTextHeaders(), {
        headOnly: method === "HEAD",
      });
      return;
    }
    send(response, 200, route.body, route.headers, {
      headOnly: method === "HEAD",
    });
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 50;
  server.on("clientError", (error, socket) => {
    if (error?.code !== "ECONNRESET" && socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("The Moondog showcase did not receive a loopback address.");
  }
  const url = `http://${host}:${address.port}/`;
  let closed = false;

  return {
    url,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function runMoondogShowcase({
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  launchBrowser = openBrowser,
} = {}) {
  const showcase = await startMoondogShowcase();
  stdout.write(
    `Moondog showcase is ready at ${showcase.url}\nPublic-safe product tour with fictional personal-profile data and one dated public-catalog proof. No private listening history, analytics, or network resources. Press Ctrl+C to stop.\n`,
  );
  if (environment.MOONDOG_SHOWCASE_NO_OPEN !== "1") {
    try {
      await launchBrowser(showcase.url);
    } catch {
      stderr.write(
        "Moondog could not open a browser automatically. Use the local URL above.\n",
      );
    }
  }

  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await showcase.close();
  }
}
