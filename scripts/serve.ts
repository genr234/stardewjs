import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { COOKIE_NAME, GateBusyError, GATED_PATH, OwnershipGate, readCookie } from "./ownership.ts";
import { parseRelayRequest, RelayHub, type RelaySocket } from "./relay.ts";

export const DEFAULT_PORT = 5199;

export const RELAY_PATH = "/relay";

export const OWNERSHIP_PATH = "/ownership";

export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

/** Sent with every response, beside the isolation headers. */
export const SECURITY_HEADERS = {
  ...ISOLATION_HEADERS,
  // Other sites may not embed the game's files or frame the page.
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

/** Requests per client per minute; asset requests are not limited, a boot makes hundreds. */
const OWNERSHIP_REQUESTS_PER_MINUTE = 20;
const RELAY_UPGRADES_PER_MINUTE = 30;

// Only the ownership answer has a body, and it is two hex strings.
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export type HostRoots = {
  wwwroot: string;
  frameworkRoot: string;
};

export type HostOptions = HostRoots & {
  port?: number;
  hostname?: string;
  hub?: RelayHub;
  /** Without one, nothing under Content/Audio/_framework is served, and the relay is closed. */
  gate?: OwnershipGate;
  /**
   * Behind a reverse proxy, take the client address and scheme from
   * X-Forwarded-For / X-Forwarded-Proto. Never set this when the host is
   * reachable directly: anyone could then claim any address.
   */
  trustProxy?: boolean;
};

/** Fixed one-minute windows per key; enough to blunt a script, not a botnet. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const at = this.now();
    const window = this.windows.get(key);
    if (!window || at - window.start >= 60_000) {
      if (this.windows.size >= 100_000) this.prune(at);
      this.windows.set(key, { start: at, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= this.perMinute;
  }

  private prune(at: number) {
    for (const [key, window] of this.windows) if (at - window.start >= 60_000) this.windows.delete(key);
  }
}

type RequestContext = {
  client: string;
  secure: boolean;
};

export function requestContext(
  req: Request,
  server?: { requestIP(request: Request): { address: string } | null },
  trustProxy = false,
): RequestContext {
  const url = new URL(req.url);
  let client = server?.requestIP(req)?.address ?? "unknown";
  let secure = url.protocol === "https:";
  if (trustProxy) {
    // The proxy appends the address it saw; the last entry is the one it vouches for.
    const forwarded = req.headers.get("X-Forwarded-For")?.split(",").at(-1)?.trim();
    if (forwarded) client = forwarded;
    secure = req.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim() === "https" || secure;
  }
  return { client, secure };
}

const LARGE_PATH = /(?:^|\/)(?:Content|Audio|_framework|_content)(?:\/|$)/i;

// App files must be revalidated: importScripts would keep running a stale
// js/*.js.
const GAME_ASSET_PATH = /(?:^|\/)(?:Content|Audio)(?:\/|$)|\.opus$/i;

// The game's own assets change only when the host moves to another game
// version, so a player keeps them a week (a token's life) before asking again.
// Everything else - the app and the _framework build - is asked about every
// time; Blazor checks _framework against blazor.boot.json, so a stale
// assembly would fail to load rather than merely be old. Either way the
// question is a conditional request, answered with a 304 and no body.
// `private`: these files sit behind the ownership check, so no shared cache
// in front of the host may keep a copy and hand it to someone who hasn't passed.
const GAME_ASSET_CACHE = "private, max-age=604800";
const REVALIDATE_CACHE = "private, no-cache";

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

type StaticAssetNode = {
  Children?: Record<string, StaticAssetNode> | null;
  Asset?: { ContentRootIndex: number; SubPath: string } | null;
};

type StaticAssetManifest = {
  ContentRoots: string[];
  Root: StaticAssetNode;
};

const packageAssetCache = new Map<string, Map<string, string>>();

/**
 * `dotnet build` leaves `_content/` in the NuGet cache behind a manifest;
 * this resolves it the same way `dotnet run` does.
 */
export function packageAssets(frameworkRoot: string): Map<string, string> {
  const cached = packageAssetCache.get(frameworkRoot);
  if (cached) return cached;
  const assets = new Map<string, string>();
  const buildDir = resolve(frameworkRoot, "..");
  const glob = new Bun.Glob("*.staticwebassets.runtime.json");
  for (const name of glob.scanSync({ cwd: buildDir, onlyFiles: true })) {
    let manifest: StaticAssetManifest;
    try {
      manifest = JSON.parse(readFileSync(join(buildDir, name), "utf8"));
    } catch {
      continue;
    }
    const content = manifest.Root?.Children?._content;
    const roots = manifest.ContentRoots.map((root) => resolve(buildDir, root));
    const walk = (node: StaticAssetNode, urlPath: string) => {
      if (node.Asset) {
        const root = roots[node.Asset.ContentRootIndex];
        const file = root && safeJoin(root, node.Asset.SubPath);
        if (file) assets.set(urlPath, file);
      }
      for (const [child, next] of Object.entries(node.Children ?? {})) walk(next, `${urlPath}/${child}`);
    };
    if (content) walk(content, "/_content");
  }
  packageAssetCache.set(frameworkRoot, assets);
  return assets;
}

export async function lookupFile(roots: HostRoots, urlPath: string): Promise<string | null> {
  const path = urlPath === "/" || urlPath === "" ? "/index.html" : urlPath;
  for (const root of [roots.wwwroot, roots.frameworkRoot]) {
    const candidate = safeJoin(root, path);
    if (candidate && (await isFile(candidate))) return candidate;
  }
  const decoded = decodePathname(path);
  if (decoded?.startsWith("/_content/")) {
    const candidate = packageAssets(roots.frameworkRoot).get(decoded);
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
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extra ?? {})) headers.append(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function cookieFor(gate: OwnershipGate, token: string | null, secure: boolean): string {
  const value = token ? encodeURIComponent(token) : "";
  const age = token ? gate.tokenLifetimeSeconds : 0;
  // HttpOnly: the page never reads it; the browser attaches it to asset requests.
  // Secure whenever the page came over https, so it never travels in the clear.
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** A browser always sends Origin on POST and WebSocket; another site's must not be honoured. */
function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (req.headers.get("Host") ?? new URL(req.url).host);
  } catch {
    return true;
  }
}

export async function handleOwnership(
  req: Request,
  url: URL,
  gate?: OwnershipGate,
  context: RequestContext = { client: "unknown", secure: false },
  limiter?: RateLimiter,
): Promise<Response> {
  if (!gate) return json({ error: "This host has no reference copy of the game." }, 503);
  const token = readCookie(req.headers.get("Cookie"), COOKIE_NAME);
  const route = url.pathname.slice(OWNERSHIP_PATH.length);

  if (req.method === "GET" && route === "") {
    return json({ verified: gate.verify(token, context.client) });
  }
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  if (crossOrigin(req)) return json({ error: "Forbidden" }, 403);
  if (limiter && !limiter.allow(context.client)) {
    return json({ error: "Too many attempts. Wait a minute and try again." }, 429, { "Retry-After": "60" });
  }

  if (route === "/challenge") {
    try {
      return json(await gate.challenge());
    } catch (err) {
      if (err instanceof GateBusyError) {
        return json({ error: "This host is busy checking other players. Try again shortly." }, 503, {
          "Retry-After": "30",
        });
      }
      // The error names paths on this machine; those stay in the log.
      console.error(err);
      return json({ error: "This host cannot check copies of the game right now." }, 503);
    }
  }
  if (route === "/answer") {
    const body = (await req.json().catch(() => null)) as { id?: unknown; digest?: unknown } | null;
    const granted = body ? await gate.answer(body.id, body.digest) : null;
    if (!granted) {
      return json({ verified: false, error: "That file is not the copy of the game this host runs." }, 403);
    }
    return json({ verified: true }, 200, { "Set-Cookie": cookieFor(gate, granted, context.secure) });
  }
  if (route === "/forget") {
    gate.revoke(token);
    return json({ verified: false }, 200, { "Set-Cookie": cookieFor(gate, null, context.secure) });
  }
  return json({ error: "Not Found" }, 404);
}

function text(body: string, status: number, extra?: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...extra } });
}

/**
 * Whether a path reaches gated files. Tested on the decoded path - the one
 * the file lookup uses - so `%5Fframework` or `Content%2F...` can't slip past.
 */
export function isGatedPath(pathname: string): boolean {
  const decoded = decodePathname(pathname);
  if (decoded === null) return true;
  return GATED_PATH.test(decoded.replaceAll("\\", "/"));
}

export async function handleRequest(
  req: Request,
  roots: HostRoots,
  server?: { timeout(request: Request, seconds: number): void },
  gate?: OwnershipGate,
  context?: RequestContext,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  }
  // The real ownership gate; the page's check only decides whether to start.
  if (isGatedPath(url.pathname) && !gate?.verify(readCookie(req.headers.get("Cookie"), COOKIE_NAME), context?.client)) {
    return text("Verify your copy of the game first.", 403);
  }
  const filePath = await lookupFile(roots, url.pathname);
  if (!filePath) {
    return text("Not Found", 404);
  }

  if (LARGE_PATH.test(url.pathname)) {
    server?.timeout(req, 0);
  }

  const file = Bun.file(filePath);
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", contentTypeFor(filePath, file.type));
  headers.set("Cache-Control", GAME_ASSET_PATH.test(url.pathname) ? GAME_ASSET_CACHE : REVALIDATE_CACHE);
  // Bun sends no validator for a file, so without this every revalidation
  // would download the whole file again.
  const etag = await entityTag(filePath);
  if (etag) {
    headers.set("ETag", etag);
    if (matchesEntityTag(req.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(file, { headers });
}

/** Weak, from size and modification time: cheap, and changes whenever the file is replaced. */
async function entityTag(path: string): Promise<string | null> {
  const info = await Bun.file(path).stat().catch(() => null);
  if (!info) return null;
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

export function matchesEntityTag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

type RelaySocketData = {
  role: "host" | "client";
  room: string | null;
  key?: string;
};

export function startHost(options: HostOptions) {
  const roots: HostRoots = {
    wwwroot: resolve(options.wwwroot),
    frameworkRoot: resolve(options.frameworkRoot),
  };
  const hub = options.hub ?? new RelayHub({ log: (message) => console.log(`[relay] ${message}`) });
  const trustProxy = options.trustProxy ?? false;
  const ownershipLimiter = new RateLimiter(OWNERSHIP_REQUESTS_PER_MINUTE);
  const relayLimiter = new RateLimiter(RELAY_UPGRADES_PER_MINUTE);
  return Bun.serve<RelaySocketData>({
    port: options.port ?? DEFAULT_PORT,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch(req, server): Response | Promise<Response> | undefined {
      const url = new URL(req.url);
      const context = requestContext(req, server, trustProxy);
      if (url.pathname === RELAY_PATH) {
        const request = parseRelayRequest(url);
        if (!request) return text("Bad Request", 400);
        if (crossOrigin(req)) return text("Forbidden", 403);
        // The relay carries whole farms between players, so it is for verified players too.
        if (!options.gate?.verify(readCookie(req.headers.get("Cookie"), COOKIE_NAME), context.client)) {
          return text("Verify your copy of the game first.", 403);
        }
        if (!relayLimiter.allow(context.client)) return text("Too Many Requests", 429, { "Retry-After": "60" });
        // The socket doesn't exist until open(), so the room rides the upgrade.
        if (server.upgrade(req, { data: request })) return undefined;
        return text("Expected a WebSocket upgrade", 426);
      }
      if (url.pathname === OWNERSHIP_PATH || url.pathname.startsWith(OWNERSHIP_PATH + "/")) {
        return handleOwnership(req, url, options.gate, context, ownershipLimiter);
      }
      return handleRequest(req, roots, server, options.gate, context);
    },
    websocket: {
      // A joining farmhand gets the whole world state in one message.
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        hub.open(ws, ws.data.role, ws.data.room, ws.data.key);
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

/** Token signing key, kept on disk so host restarts don't log players out. Not committed. */
export const DEFAULT_SECRET = ".ownership-key";

export async function openGate(repoRoot: string): Promise<OwnershipGate> {
  const referencePath = process.env.OWNERSHIP_REFERENCE ?? join(repoRoot, DEFAULT_REFERENCE);
  const secretPath = process.env.OWNERSHIP_SECRET ?? join(repoRoot, DEFAULT_SECRET);
  const gate = new OwnershipGate({ referencePath, secretPath });
  await gate.referenceSize();
  return gate;
}

/**
 * HOST picks the interface (default loopback only). Set TRUST_PROXY=1 only
 * when HOST is loopback and a TLS proxy in front forwards to it.
 */
export function hostBinding(env: NodeJS.ProcessEnv = process.env): { hostname: string; trustProxy: boolean } {
  return { hostname: env.HOST || "127.0.0.1", trustProxy: env.TRUST_PROXY === "1" };
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
  const server = startHost({ wwwroot, frameworkRoot, port: parsePort(), gate, ...hostBinding() });
  console.log(`Serving ${wwwroot} (+ ${frameworkRoot}) at ${server.url}`);
  console.log(`Players verify against ${gate.referencePath}`);
}
