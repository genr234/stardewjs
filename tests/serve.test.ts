import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ISOLATION_HEADERS, startHost } from "../scripts/serve.ts";

const wwwroot = join(import.meta.dir, "fixtures/wwwroot");
const frameworkRoot = join(import.meta.dir, "fixtures/framework");

describe("static host", () => {
  let server: ReturnType<typeof startHost>;

  beforeAll(() => {
    server = startHost({ wwwroot, frameworkRoot, port: 0 });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("serves index.html at /", async () => {
    const res = await server.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("fixture");
  });

  test("serves wwwroot scripts", async () => {
    const res = await server.fetch(new Request("http://localhost/js/host.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("__fixtureHost");
  });

  test("sets wasm content type from the framework root", async () => {
    const res = await server.fetch(new Request("http://localhost/_framework/dotnet.native.wasm"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/wasm");
  });

  test("sets an audio content type on extracted wave bank entries", async () => {
    const res = await server.fetch(new Request("http://localhost/Audio/main/0005.opus"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  test("sends COOP and COEP on every response", async () => {
    const ok = await server.fetch(new Request("http://localhost/"));
    const missing = await server.fetch(new Request("http://localhost/nope"));
    for (const res of [ok, missing]) {
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe(ISOLATION_HEADERS["Cross-Origin-Opener-Policy"]);
      expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe(ISOLATION_HEADERS["Cross-Origin-Embedder-Policy"]);
    }
    expect(missing.status).toBe(404);
  });

  test("the app's own files are served without caching, the bulk assets are not", async () => {
    // A worker kept running a cached js/audio.js across an edit, which looked
    // like a missing function rather than a stale file.
    for (const path of ["/", "/index.html", "/js/host.js"]) {
      const res = await server.fetch(new Request("http://localhost" + path));
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
    }
    // The 544 MB of assets keep whatever caching the browser would give them.
    for (const path of ["/Content/Maps/Town.xnb", "/Audio/main/0005.opus"]) {
      const res = await server.fetch(new Request("http://localhost" + path));
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBeNull();
    }
  });

  test("rejects path traversal", async () => {
    const paths = ["/../package.json", "/js/../../package.json", "/%2e%2e/package.json"];
    for (const path of paths) {
      const res = await server.fetch(new Request(`http://localhost${path}`));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("stardew-web");
    }
  });

  test("does not list directories", async () => {
    const res = await server.fetch(new Request("http://localhost/js/"));
    expect(res.status).toBe(404);
  });

  test("streams Content files via Bun.file", async () => {
    const res = await server.fetch(new Request("http://localhost/Content/Maps/Town.xnb"));
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    expect(await res.text()).toBe("fake-xnb\n");
  });
});
