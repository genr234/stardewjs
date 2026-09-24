import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { COOKIE_NAME, OwnershipGate } from "../scripts/ownership.ts";
import { hostBinding, ISOLATION_HEADERS, isGatedPath, matchesEntityTag, RateLimiter, requestContext, SECURITY_HEADERS, startHost } from "../scripts/serve.ts";

const wwwroot = join(import.meta.dir, "fixtures/wwwroot");
const frameworkRoot = join(import.meta.dir, "fixtures/framework");

describe("static host", () => {
  let server: ReturnType<typeof startHost>;
  // Content, Audio and _framework are behind the ownership gate; what this
  // file is about is everything else the host does, so it asks as a verified
  // player would. tests/ownership.test.ts covers the gate itself.
  const gate = new OwnershipGate({ referencePath: join(frameworkRoot, "_framework/dotnet.native.wasm") });
  let cookie: string;

  function get(path: string) {
    return server.fetch(new Request("http://localhost" + path, { headers: { Cookie: cookie } }));
  }

  beforeAll(() => {
    server = startHost({ wwwroot, frameworkRoot, port: 0, gate });
    cookie = `${COOKIE_NAME}=${gate.grant()}`;
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("serves index.html at /", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("fixture");
  });

  test("serves wwwroot scripts", async () => {
    const res = await get("/js/host.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("__fixtureHost");
  });

  test("sets wasm content type from the framework root", async () => {
    const res = await get("/_framework/dotnet.native.wasm");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/wasm");
  });

  test("serves package _content through the build's static web assets manifest", async () => {
    // dotnet build leaves these in the NuGet cache and only records where.
    const res = await get("/_content/Fixture.Pkg/js/Pkg.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("__fixturePackage");
    expect((await get("/_content/Fixture.Pkg/js/Missing.js")).status).toBe(404);
  });

  test("sets an audio content type on extracted wave bank entries", async () => {
    const res = await get("/Audio/main/0005.opus");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  test("sends COOP and COEP on every response", async () => {
    const ok = await get("/");
    const missing = await get("/nope");
    for (const res of [ok, missing]) {
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe(ISOLATION_HEADERS["Cross-Origin-Opener-Policy"]);
      expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe(ISOLATION_HEADERS["Cross-Origin-Embedder-Policy"]);
    }
    expect(missing.status).toBe(404);
  });

  test("the app and the build are revalidated every time, the game's assets kept a week", async () => {
    // A worker kept running a cached js/audio.js across an edit, which looked
    // like a missing function rather than a stale file.
    for (const path of ["/", "/index.html", "/js/host.js", "/_framework/dotnet.native.wasm"]) {
      const res = await get(path);
      expect(`${path}: ${res.headers.get("Cache-Control")}`).toBe(`${path}: private, no-cache`);
    }
    for (const path of ["/Content/Maps/Town.xnb", "/Audio/main/0005.opus"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=604800");
    }
  });

  test("a revalidation of an unchanged file is a 304 with no body", async () => {
    for (const path of ["/js/host.js", "/Content/Maps/Town.xnb"]) {
      const first = await get(path);
      const etag = first.headers.get("ETag");
      expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
      const again = await server.fetch(
        new Request("http://localhost" + path, { headers: { Cookie: cookie, "If-None-Match": etag! } }),
      );
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
      expect(again.headers.get("Cache-Control")).toBe(first.headers.get("Cache-Control"));
      const stale = await server.fetch(
        new Request("http://localhost" + path, { headers: { Cookie: cookie, "If-None-Match": 'W/"0-0"' } }),
      );
      expect(stale.status).toBe(200);
    }
  });

  test("a revalidation still has to pass the ownership check", async () => {
    const etag = (await get("/Content/Maps/Town.xnb")).headers.get("ETag")!;
    const res = await server.fetch(new Request("http://localhost/Content/Maps/Town.xnb", { headers: { "If-None-Match": etag } }));
    expect(res.status).toBe(403);
  });

  test("sends the hardening headers on every response", async () => {
    for (const res of [await get("/"), await get("/nope"), await get("/ownership")]) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
    }
  });

  test("serves files to GET and HEAD only", async () => {
    const res = await server.fetch(new Request("http://localhost/", { method: "POST", headers: { Cookie: cookie } }));
    expect(res.status).toBe(405);
    expect((await server.fetch(new Request("http://localhost/", { method: "HEAD" }))).status).toBe(200);
  });

  test("rejects path traversal", async () => {
    const paths = ["/../package.json", "/js/../../package.json", "/%2e%2e/package.json"];
    for (const path of paths) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("stardew-web");
    }
  });

  test("does not list directories", async () => {
    const res = await get("/js/");
    expect(res.status).toBe(404);
  });

  test("streams Content files via Bun.file", async () => {
    const res = await get("/Content/Maps/Town.xnb");
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    expect(await res.text()).toBe("fake-xnb\n");
  });
});

describe("gate paths", () => {
  test("an encoded path is gated the same as the plain one", () => {
    const sneaky = [
      "/%5Fframework/dotnet.native.wasm",
      "/_framework%2Fdotnet.native.wasm",
      "/%41udio/main/0005.opus",
      "/%43ontent/Maps/Town.xnb",
      "/js/%2E%2E/Content/Maps/Town.xnb",
      "/Content%5CMaps%5CTown.xnb",
      "/%E0%A4%A", // undecodable: refused rather than guessed at
    ];
    for (const path of sneaky) expect(`${path}: ${isGatedPath(path)}`).toBe(`${path}: true`);
    for (const path of ["/", "/js/host.js", "/index.html"]) expect(isGatedPath(path)).toBe(false);
  });

  test("an unverified request cannot fetch the game through an encoded path", async () => {
    const frameworkRoot = join(import.meta.dir, "fixtures/framework");
    const gate = new OwnershipGate({ referencePath: join(frameworkRoot, "_framework/dotnet.native.wasm") });
    const server = startHost({ wwwroot: join(import.meta.dir, "fixtures/wwwroot"), frameworkRoot, port: 0, gate });
    try {
      for (const path of ["/%5Fframework/dotnet.native.wasm", "/_framework%2Fdotnet.native.wasm", "/%41udio/main/0005.opus"]) {
        const res = await server.fetch(new Request("http://localhost" + path));
        expect(`${path}: ${res.status}`).toBe(`${path}: 403`);
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("request context", () => {
  const server = { requestIP: () => ({ address: "10.0.0.5" }) };

  test("ignores forwarding headers unless told there is a proxy", () => {
    const req = new Request("http://localhost/", {
      headers: { "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Proto": "https" },
    });
    expect(requestContext(req, server)).toMatchObject({ client: "10.0.0.5", secure: false });
    expect(requestContext(req, server, true)).toMatchObject({ client: "1.2.3.4", secure: true });
  });

  test("behind a proxy that passes X-Forwarded-For through, trusts only the scheme", () => {
    const req = new Request("http://localhost/", {
      headers: { "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Proto": "https" },
    });
    expect(requestContext(req, server, "proto")).toMatchObject({ client: "10.0.0.5", secure: true });
  });

  test("behind a proxy that re-addresses the request, the browser's host comes from X-Forwarded-Host", () => {
    // Nest's WebSocket proxy drops Host and dials the container by address.
    const req = new Request("http://10.60.6.74/relay", {
      headers: { Host: "10.60.6.74", "X-Forwarded-Host": "stardew.example" },
    });
    expect(requestContext(req, server).host).toBe("10.60.6.74");
    expect(requestContext(req, server, "proto").host).toBe("stardew.example");
  });

  test("reads the host's binding and limits from the environment", () => {
    expect(hostBinding({})).toEqual({
      hostname: "127.0.0.1",
      trustProxy: false,
      secureCookies: false,
      ownershipPerMinute: undefined,
      relayPerMinute: undefined,
    });
    expect(hostBinding({ HOST: "0.0.0.0", TRUST_PROXY: "proto", SECURE_COOKIES: "1", OWNERSHIP_RATE: "300", RELAY_RATE: "nope" })).toEqual({
      hostname: "0.0.0.0",
      trustProxy: "proto",
      secureCookies: true,
      ownershipPerMinute: 300,
      relayPerMinute: undefined,
    });
    expect(hostBinding({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
  });

  test("takes the address the proxy itself saw, not one the client wrote", () => {
    const req = new Request("http://localhost/", { headers: { "X-Forwarded-For": "6.6.6.6, 1.2.3.4" } });
    expect(requestContext(req, server, true).client).toBe("1.2.3.4");
  });
});

describe("rate limiter", () => {
  test("allows a burst per minute per key, then resets", () => {
    let clock = 0;
    const limiter = new RateLimiter(2, () => clock);
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([true, true, false]);
    expect(limiter.allow("b")).toBe(true);
    clock += 60_000;
    expect(limiter.allow("a")).toBe(true);
  });
});

describe("entity tags", () => {
  test("match weakly, in lists, and on a wildcard", () => {
    const tag = 'W/"a-b"';
    expect(matchesEntityTag(tag, tag)).toBe(true);
    expect(matchesEntityTag('"a-b"', tag)).toBe(true);
    expect(matchesEntityTag('W/"x", W/"a-b"', tag)).toBe(true);
    expect(matchesEntityTag("*", tag)).toBe(true);
    expect(matchesEntityTag('W/"a-c"', tag)).toBe(false);
    expect(matchesEntityTag(null, tag)).toBe(false);
  });
});
