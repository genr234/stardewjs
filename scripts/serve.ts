import { existsSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { COOKIE_NAME, GATED_PATH, OwnershipGate, readCookie } from "./ownership.ts";
import { parseRelayRequest, RelayHub, type RelaySocket } from "./relay.ts";

export const DEFAULT_PORT = 5199;

export const RELAY_PATH = "/relay";

export const OWNERSHIP_PATH = "/ownership";

export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

export type HostRoots = {
  wwwroot: string;
  frameworkRoot: string;
};

export type HostOptions = HostRoots & {
  port?: number;
  hostname?: string;
  hub?: RelayHub;
  /** Without one, nothing under Content/Audio/_framework is served. */
  gate?: OwnershipGate;
};

const LARGE_PATH = /(?:^|\/)(?:Content|Audio|_framework|_content)(?:\/|$)/i;

// App files must not be cached: importScripts would keep running a stale
// js/*.js. Bulk assets are immutable.
const IMMUTABLE_PATH = /(?:^|\/)(?:Content|_framework|_content)(?:\/|$)|\.opus$/i;

export function findFrameworkRoot(webProjectDir: string): string | null {
  const bin = join(webProjectDir, "bin");
  if (!existsSync(bin)) return null;
  const glob = new Bun.Glob("**/wwwroot/_framework/blazor.webassembly.js");
  const roots: string[] = [];
  for (const match of glob.scanSync({ cwd: bin, onlyFiles: true })) {
    roots.push(resolve(bin, match, "..", ".."));
  }
  if (roots.length === 0) return null;
  return roots.find((root) => root.includes("/Release/")) ?? roots[0] ?? null;
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

export function safeJoin(root: string, requestPath: string): string | null {
  const decoded = decodePathname(requestPath);
  if (decoded == null || decoded.includes("\0")) return null;
  const relativePath = decoded.replace(/^\/+/, "");
  if (relativePath.split(/[/\\]/).some((part) => part === "..")) return null;
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  const fromRoot = relative(resolvedRoot, candidate);
  if (fromRoot.startsWith("..") || resolve(fromRoot) === fromRoot) return null;
  return candidate;
}

async function isFile(path: string): Promise<boolean> {
  const info = await Bun.file(path).stat().catch(() => null);
  return info?.isFile() === true;
}

export async function lookupFile(roots: HostRoots, urlPath: string): Promise<string | null> {
  const path = urlPath === "/" || urlPath === "" ? "/index.html" : urlPath;
  for (const root of [roots.wwwroot, roots.frameworkRoot]) {
    const candidate = safeJoin(root, path);
    if (candidate && (await isFile(candidate))) return candidate;
  }
  return null;
}

function contentTypeFor(path: string, fileType: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".wasm") return "application/wasm";
  // Bun doesn't know the .opus type.
  if (extension === ".opus") return "audio/ogg";
  return fileType || "application/octet-stream";
}

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers = new Headers(ISOLATION_HEADERS);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extra ?? {})) headers.append(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function cookieFor(gate: OwnershipGate, token: string | null): string {
  const value = token ? encodeURIComponent(token) : "";
  const age = token ? gate.tokenLifetimeSeconds : 0;
  // HttpOnly: the page never reads it; the browser attaches it to asset requests.
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict`;
}

export async function handleOwnership(req: Request, url: URL, gate?: OwnershipGate): Promise<Response> {
  if (!gate) return json({ error: "This host has no reference copy of the game." }, 503);
  const token = readCookie(req.headers.get("Cookie"), COOKIE_NAME);
  const route = url.pathname.slice(OWNERSHIP_PATH.length);

  if (req.method === "GET" && route === "") {
    return json({ verified: gate.verify(token) });
  }
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  if (route === "/challenge") {
    try {
      return json(await gate.challenge());
    } catch (err) {
      return json({ error: String(err) }, 503);
    }
  }
  if (route === "/answer") {
    const body = (await req.json().catch(() => null)) as { id?: unknown; digest?: unknown } | null;
    const granted = body ? await gate.answer(body.id, body.digest) : null;
    if (!granted) {
      return json({ verified: false, error: "That file is not the copy of the game this host runs." }, 403);
    }
    return json({ verified: true }, 200, { "Set-Cookie": cookieFor(gate, granted) });
  }
  if (route === "/forget") {
    gate.revoke(token);
    return json({ verified: false }, 200, { "Set-Cookie": cookieFor(gate, null) });
  }
  return json({ error: "Not Found" }, 404);
}

export async function handleRequest(
  req: Request,
  roots: HostRoots,
  server?: { timeout(request: Request, seconds: number): void },
  gate?: OwnershipGate,
): Promise<Response> {
  const url = new URL(req.url);
  // The real ownership gate; the page's check only decides whether to start.
  if (GATED_PATH.test(url.pathname) && !gate?.verify(readCookie(req.headers.get("Cookie"), COOKIE_NAME))) {
    return new Response("Verify your copy of the game first.", { status: 403, headers: ISOLATION_HEADERS });
  }
  const filePath = await lookupFile(roots, url.pathname);
  if (!filePath) {
    return new Response("Not Found", { status: 404, headers: ISOLATION_HEADERS });
  }

  if (LARGE_PATH.test(url.pathname)) {
    server?.timeout(req, 0);
  }

  const file = Bun.file(filePath);
  const headers = new Headers(ISOLATION_HEADERS);
  headers.set("Content-Type", contentTypeFor(filePath, file.type));
  if (!IMMUTABLE_PATH.test(url.pathname)) {
    // No validator is sent, so this means re-fetch; these files are small.
    headers.set("Cache-Control", "no-cache");
  }
  return new Response(file, { headers });
}

type RelaySocketData = {
  role: "host" | "client";
  room: string | null;
};

export function startHost(options: HostOptions) {
  const roots: HostRoots = {
    wwwroot: resolve(options.wwwroot),
    frameworkRoot: resolve(options.frameworkRoot),
  };
  const hub = options.hub ?? new RelayHub({ log: (message) => console.log(`[relay] ${message}`) });
  return Bun.serve<RelaySocketData>({
    port: options.port ?? DEFAULT_PORT,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    fetch(req, server): Response | Promise<Response> | undefined {
      const url = new URL(req.url);
      if (url.pathname === RELAY_PATH) {
        const request = parseRelayRequest(url);
        if (!request) {
          return new Response("Bad Request", { status: 400, headers: ISOLATION_HEADERS });
        }
        // The socket doesn't exist until open(), so the room rides the upgrade.
        if (server.upgrade(req, { data: request })) return undefined;
        return new Response("Expected a WebSocket upgrade", {
          status: 426,
          headers: ISOLATION_HEADERS,
        });
      }
      if (url.pathname === OWNERSHIP_PATH || url.pathname.startsWith(OWNERSHIP_PATH + "/")) {
        return handleOwnership(req, url, options.gate);
      }
      return handleRequest(req, roots, server, options.gate);
    },
    websocket: {
      // A joining farmhand gets the whole world state in one message.
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        hub.open(ws, ws.data.role, ws.data.room);
      },
      message(ws, message) {
        hub.message(ws, message);
      },
      close(ws) {
        hub.close(ws);
      },
    },
  });
}

export const DEFAULT_REFERENCE = "vendor/game/MacOS/Stardew Valley.dll";

export async function openGate(repoRoot: string): Promise<OwnershipGate> {
  const referencePath = process.env.OWNERSHIP_REFERENCE ?? join(repoRoot, DEFAULT_REFERENCE);
  const gate = new OwnershipGate({ referencePath });
  // Fail here rather than on the first player: without a reference nothing
  // under Content/Audio/_framework can be served at all.
  await gate.referenceSize();
  return gate;
}

export function parsePort(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PORT) return Number(env.PORT);
  const urls = env.ASPNETCORE_URLS;
  const match = urls?.match(/:(\d+)\s*$/);
  if (match?.[1]) return Number(match[1]);
  return DEFAULT_PORT;
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const wwwroot = process.env.WWWROOT ?? join(repoRoot, "src/web/wwwroot");
  const frameworkRoot =
    process.env.FRAMEWORK_ROOT ?? findFrameworkRoot(join(repoRoot, "src/web"));
  if (!frameworkRoot) {
    console.error(
      "No Blazor _framework output found. Run `dotnet build src/web/StardewValley.Web.csproj` first, or set FRAMEWORK_ROOT.",
    );
    process.exit(1);
  }
  const gate = await openGate(repoRoot).catch((err) => {
    console.error(String(err));
    console.error("Set OWNERSHIP_REFERENCE to your own `Stardew Valley.dll` to serve the game.");
    process.exit(1);
  });
  const server = startHost({ wwwroot, frameworkRoot, port: parsePort(), gate });
  console.log(`Serving ${wwwroot} (+ ${frameworkRoot}) at ${server.url}`);
  console.log(`Players verify against ${gate.referencePath}`);
}
