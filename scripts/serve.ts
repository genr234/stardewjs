import { existsSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export const DEFAULT_PORT = 5199;

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

export async function handleRequest(
  req: Request,
  roots: HostRoots,
  server?: { timeout(request: Request, seconds: number): void },
): Promise<Response> {
  const url = new URL(req.url);
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

export function startHost(options: HostOptions) {
  const roots: HostRoots = {
    wwwroot: resolve(options.wwwroot),
    frameworkRoot: resolve(options.frameworkRoot),
  };
  return Bun.serve({
    port: options.port ?? DEFAULT_PORT,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    fetch(req, server) {
      return handleRequest(req, roots, server);
    },
  });
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
  const server = startHost({ wwwroot, frameworkRoot, port: parsePort() });
  console.log(`Serving ${wwwroot} (+ ${frameworkRoot}) at ${server.url}`);
}
