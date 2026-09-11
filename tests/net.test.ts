import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { RelayHub } from "../scripts/relay.ts";
import { startHost } from "../scripts/serve.ts";

const netSource = await Bun.file(new URL("../src/web/wwwroot/js/net.js", import.meta.url)).text();

/** A WebSocket that records what was sent and lets a test drive the callbacks. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  url: string;
  binaryType = "";
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  closes = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.closes += 1;
  }

  /** Bring the socket up the way the browser would. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(data: unknown) {
    this.onmessage?.({ data });
  }

  control(message: unknown) {
    this.deliver(JSON.stringify(message));
  }

  drop(reason: string) {
    this.readyState = 3;
    this.onclose?.({ reason });
  }

  /** The frames sent as bytes, in order. */
  frames(): Uint8Array[] {
    return this.sent.filter((value) => value instanceof Uint8Array) as Uint8Array[];
  }
}

/** The nth socket the sandbox opened. Tests always open it first. */
function opened(index: number): FakeSocket {
  const socket = FakeSocket.opened[index];
  if (!socket) throw new Error(`no socket at ${index}`);
  return socket;
}

function loadNet(relay?: string) {
  FakeSocket.opened = [];
  const context: Record<string, any> = {
    WebSocket: FakeSocket,
    location: { origin: "http://localhost:5199" },
    __relayUrl: relay ?? "",
    btoa: (text: string) => Buffer.from(text, "binary").toString("base64"),
    atob: (text: string) => Buffer.from(text, "base64").toString("binary"),
    console,
    // Same realm, so instanceof inside the sandbox matches the test's buffers.
    ArrayBuffer,
    Uint8Array,
    DataView,
  };
  context.globalThis = context;
  context.self = context;
  runInNewContext(netSource, context);
  return context.browserNet;
}

const base64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const bytesOf = (text: string) => [...Buffer.from(text, "base64")];

describe("browser transport", () => {
  test("dials the relay on the origin the game was served from", () => {
    const net = loadNet();
    net.hostStart(null);
    expect(opened(0).url).toBe("ws://localhost:5199/relay?role=host");

    net.clientConnect("ABC123");
    expect(opened(1).url).toBe("ws://localhost:5199/relay?role=client&room=ABC123");
  });

  test("a relay named in the settings menu replaces the origin's", () => {
    for (const written of ["farm.example:5199", "http://farm.example:5199", "ws://farm.example:5199/relay"]) {
      const net = loadNet(written);
      net.hostStart(null);
      expect(opened(0).url).toBe("ws://farm.example:5199/relay?role=host");
    }

    const secure = loadNet("https://farm.example");
    secure.clientConnect("ABC123");
    expect(opened(0).url).toBe("wss://farm.example/relay?role=client&room=ABC123");
  });

  test("reports the room code the relay assigns", () => {
    const net = loadNet();
    net.hostStart(null);
    expect(net.hostState().room).toBeNull();

    const socket = opened(0);
    socket.accept();
    socket.control({ type: "ready", room: "ABC123" });
    expect(net.hostState()).toMatchObject({ state: "open", room: "ABC123" });
  });

  test("queues arrivals, departures and messages for the next tick", () => {
    const net = loadNet();
    net.hostStart(null);
    const socket = opened(0);
    socket.accept();
    socket.control({ type: "ready", room: "ABC123" });
    socket.control({ type: "connect", peer: 1 });

    // A relayed frame: peer 1, then the message body.
    socket.deliver(new Uint8Array([1, 0, 0, 0, 42, 43]).buffer);
    socket.control({ type: "disconnect", peer: 1 });

    const events = net.hostPoll();
    expect(events.map((event: any) => event.k)).toEqual(["connect", "data", "disconnect"]);
    expect(events[1].peer).toBe(1);
    expect(bytesOf(events[1].b)).toEqual([42, 43]);

    expect(net.hostPoll()).toEqual([]);
  });

  test("addresses a host message to one peer", () => {
    const net = loadNet();
    net.hostStart(null);
    const socket = opened(0);
    socket.accept();
    expect(net.hostSend(3, base64([9, 9]))).toBe(true);
    expect([...socket.frames()[0]!]).toEqual([3, 0, 0, 0, 9, 9]);
  });

  test("refuses to send before the socket is up, rather than throwing into the game loop", () => {
    const net = loadNet();
    net.hostStart(null);
    expect(net.hostSend(1, base64([1]))).toBe(false);
    net.clientConnect("ABC123");
    expect(net.clientSend(base64([1]))).toBe(false);
  });

  test("hands the client the host's lobby data", () => {
    const net = loadNet();
    net.clientConnect("ABC123");
    const socket = opened(0);
    socket.accept();
    socket.control({ type: "ready", room: "ABC123", peer: 1, lobby: { protocolVersion: "1.6.15" } });
    const state = net.clientState();
    expect(state.state).toBe("open");
    expect(JSON.parse(state.lobby)).toEqual({ protocolVersion: "1.6.15" });
  });

  test("keeps the reason a connection ended", () => {
    const net = loadNet();
    net.clientConnect("NOPE12");
    const socket = opened(0);
    socket.accept();
    socket.control({ type: "error", reason: "no-such-room" });
    socket.drop("no-such-room");
    expect(net.clientState()).toMatchObject({ state: "closed", error: "no-such-room" });
  });

  test("ignores traffic from a socket that has been replaced", () => {
    const net = loadNet();
    net.clientConnect("ABC123");
    const first = opened(0);
    first.accept();
    net.clientConnect("ABC123");
    first.deliver(new Uint8Array([1, 2]).buffer);
    first.drop("stale");
    expect(net.clientPoll()).toEqual([]);
    expect(net.clientState().state).toBe("connecting");
  });

  test("survives a message larger than one fromCharCode apply", () => {
    const net = loadNet();
    net.clientConnect("ABC123");
    const socket = opened(0);
    socket.accept();
    const big = new Uint8Array(200_000).map((_, index) => index % 256);
    socket.deliver(big.buffer);
    const [body] = net.clientPoll();
    expect(bytesOf(body)).toHaveLength(200_000);
  });
});

describe("relay over the real host", () => {
  let server: ReturnType<typeof startHost>;
  const hub = new RelayHub({ makeCode: () => "ABC123" });

  beforeAll(() => {
    server = startHost({
      wwwroot: join(import.meta.dir, "fixtures/wwwroot"),
      frameworkRoot: join(import.meta.dir, "fixtures/framework"),
      port: 0,
      hub,
    });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("carries a message from a joined client to the host and back", async () => {
    const base = `ws://127.0.0.1:${server.port}/relay`;
    const host = new WebSocket(`${base}?role=host`);
    const hostSaw: any[] = [];
    const hostBinary: Uint8Array[] = [];
    host.binaryType = "arraybuffer";
    host.onmessage = (event) => {
      if (typeof event.data === "string") hostSaw.push(JSON.parse(event.data));
      else hostBinary.push(new Uint8Array(event.data as ArrayBuffer));
    };
    await new Promise((resolve) => (host.onopen = resolve));
    await waitFor(() => hostSaw.length > 0);
    expect(hostSaw[0]).toEqual({ type: "ready", room: "ABC123" });

    const client = new WebSocket(`${base}?role=client&room=ABC123`);
    const clientBinary: Uint8Array[] = [];
    client.binaryType = "arraybuffer";
    client.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) clientBinary.push(new Uint8Array(event.data));
    };
    await new Promise((resolve) => (client.onopen = resolve));
    await waitFor(() => hostSaw.length > 1);
    expect(hostSaw[1]).toEqual({ type: "connect", peer: 1 });

    client.send(new Uint8Array([5, 6]));
    await waitFor(() => hostBinary.length > 0);
    expect([...hostBinary[0]!]).toEqual([1, 0, 0, 0, 5, 6]);

    host.send(new Uint8Array([1, 0, 0, 0, 7]));
    await waitFor(() => clientBinary.length > 0);
    expect([...clientBinary[0]!]).toEqual([7]);

    client.close();
    await waitFor(() => hostSaw.length > 2);
    expect(hostSaw[2]).toEqual({ type: "disconnect", peer: 1 });
    host.close();
  });

  test("rejects an upgrade with no role", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/relay`);
    expect(response.status).toBe(400);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the relay");
    await Bun.sleep(5);
  }
}
