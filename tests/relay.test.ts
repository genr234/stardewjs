import { describe, expect, test } from "bun:test";

import { decodeFrame, defaultCodeGenerator, encodeFrame, parseRelayRequest, RelayHub } from "../scripts/relay.ts";

type Sent = string | Uint8Array;

function socket() {
  const sent: Sent[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closed,
    send(data: Sent) {
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    /** The control messages received, in order. */
    control(): any[] {
      return sent.filter((value) => typeof value === "string").map((value) => JSON.parse(value as string));
    },
    binary(): Uint8Array[] {
      return sent.filter((value) => value instanceof Uint8Array) as Uint8Array[];
    },
  };
}

function hubWithCodes(...codes: string[]) {
  let index = 0;
  return new RelayHub({ makeCode: () => codes[index++] ?? `X${index}`, makeKey: () => `key-${index}` });
}

describe("relay framing", () => {
  test("round-trips a peer id and payload", () => {
    const framed = encodeFrame(9, new Uint8Array([1, 2, 3]));
    const frame = decodeFrame(framed)!;
    expect(frame.peer).toBe(9);
    expect([...frame.payload]).toEqual([1, 2, 3]);
  });

  test("rejects a frame too short to carry a peer id", () => {
    expect(decodeFrame(new Uint8Array([1, 2]))).toBeNull();
  });
});

describe("relay rooms", () => {
  test("assigns the host a room code and forwards both directions", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    const client = socket();

    hub.open(host, "host", null);
    expect(host.control()[0]).toEqual({ type: "ready", room: "ABC123", key: "key-1" });

    hub.open(client, "client", "abc123"); // codes are typed by hand, so case-insensitive
    expect(client.control()[0].room).toBe("ABC123");
    expect(host.control()[1]).toEqual({ type: "connect", peer: 1 });

    hub.message(client, new Uint8Array([7, 7]));
    const toHost = decodeFrame(host.binary()[0]!)!;
    expect(toHost.peer).toBe(1);
    expect([...toHost.payload]).toEqual([7, 7]);

    hub.message(host, encodeFrame(1, new Uint8Array([8])));
    expect([...client.binary()[0]!]).toEqual([8]);
  });

  test("turns away a client whose room does not exist", () => {
    const hub = hubWithCodes("ABC123");
    const client = socket();
    hub.open(client, "client", "NOPE12");
    expect(client.control()[0]).toEqual({ type: "error", reason: "no-such-room" });
    expect(client.closed).toHaveLength(1);
  });

  test("hands the host's lobby data to a client before any game message", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    hub.open(host, "host", null);
    hub.message(host, JSON.stringify({ type: "lobby", data: { protocolVersion: "1.6.15", farmName: "Sun" } }));

    const client = socket();
    hub.open(client, "client", "ABC123");
    expect(client.control()[0].lobby).toEqual({ protocolVersion: "1.6.15", farmName: "Sun" });
  });

  test("tells the host when a peer leaves", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    const client = socket();
    hub.open(host, "host", null);
    hub.open(client, "client", "ABC123");
    hub.close(client);
    expect(host.control().at(-1)).toEqual({ type: "disconnect", peer: 1 });
    expect(hub.getRoom("ABC123")!.peers).toEqual([]);
  });

  test("kicks the peer the host names, and only that one", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    const first = socket();
    const second = socket();
    hub.open(host, "host", null);
    hub.open(first, "client", "ABC123");
    hub.open(second, "client", "ABC123");

    hub.message(host, JSON.stringify({ type: "kick", peer: 1 }));
    expect(first.closed[0]?.reason).toBe("kicked");
    expect(second.closed).toHaveLength(0);
    expect(hub.getRoom("ABC123")!.peers).toEqual([2]);
  });

  test("closes every peer when the host goes away", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    const client = socket();
    hub.open(host, "host", null);
    hub.open(client, "client", "ABC123");
    hub.close(host);
    expect(client.control().at(-1)).toEqual({ type: "error", reason: "host-left" });
    expect(client.closed).toHaveLength(1);
    expect(hub.getRoom("ABC123")).toBeNull();
  });

  test("a reconnecting host keeps the invite code that was already read out", () => {
    const hub = hubWithCodes("ABC123", "ZZZ999");
    const first = socket();
    hub.open(first, "host", null);
    hub.close(first);

    const second = socket();
    hub.open(second, "host", "ABC123", "key-1");
    expect(second.control()[0]).toEqual({ type: "ready", room: "ABC123", key: "key-1" });
    expect(hub.roomCount).toBe(1);
  });

  test("hearing a code is not enough to take the room over", () => {
    const hub = hubWithCodes("ABC123", "ZZZ999", "YYY888");
    const host = socket();
    const client = socket();
    hub.open(host, "host", null);
    hub.open(client, "client", "ABC123");

    for (const key of [undefined, "guess"]) {
      const intruder = socket();
      hub.open(intruder, "host", "ABC123", key);
      expect(intruder.control()[0].room).not.toBe("ABC123");
    }
    expect(host.closed).toHaveLength(0);
    expect(client.closed).toHaveLength(0);
    hub.message(client, new Uint8Array([1]));
    expect(host.binary()).toHaveLength(1);
  });

  test("a dropped host's code is held for it, then released", () => {
    let clock = 0;
    let index = 0;
    const codes = ["ABC123", "ZZZ999"];
    const hub = new RelayHub({ makeCode: () => codes[index++] ?? `X${index}`, now: () => clock });
    const first = socket();
    hub.open(first, "host", null);
    hub.close(first);

    const squatter = socket();
    hub.open(squatter, "host", "ABC123");
    expect(squatter.control()[0].room).toBe("ZZZ999");
    hub.close(squatter);

    clock += 31 * 60 * 1000;
    const later = socket();
    hub.open(later, "host", "ABC123");
    expect(later.control()[0].room).toBe("ABC123");
  });

  test("a full relay turns new hosts away, a full room new clients", () => {
    const hub = new RelayHub({ makeCode: () => "ABC123", maxRooms: 1, maxPeersPerRoom: 1 });
    const host = socket();
    hub.open(host, "host", null);
    const another = socket();
    hub.open(another, "host", null);
    expect(another.control()[0]).toEqual({ type: "error", reason: "relay-full" });
    expect(another.closed).toHaveLength(1);

    const first = socket();
    const second = socket();
    hub.open(first, "client", "ABC123");
    hub.open(second, "client", "ABC123");
    expect(first.closed).toHaveLength(0);
    expect(second.control()[0]).toEqual({ type: "error", reason: "room-full" });
  });

  test("lobby data is bounded", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    hub.open(host, "host", null);
    const data: Record<string, string> = { huge: "x".repeat(10_000), ["k".repeat(100)]: "v" };
    for (let i = 0; i < 100; i++) data[`key${i}`] = String(i);
    hub.message(host, JSON.stringify({ type: "lobby", data }));
    const lobby = hub.getRoom("ABC123")!.lobby;
    expect(Object.keys(lobby)).toHaveLength(32);
    expect(lobby.huge).toBeUndefined();
  });

  test("generated codes come from the typed alphabet", () => {
    const make = defaultCodeGenerator();
    for (let i = 0; i < 200; i++) expect(make()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  test("a client cannot publish lobby data or kick anyone", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    const first = socket();
    const second = socket();
    hub.open(host, "host", null);
    hub.open(first, "client", "ABC123");
    hub.open(second, "client", "ABC123");

    hub.message(first, JSON.stringify({ type: "kick", peer: 2 }));
    hub.message(first, JSON.stringify({ type: "lobby", data: { protocolVersion: "evil" } }));
    expect(second.closed).toHaveLength(0);
    expect(hub.getRoom("ABC123")!.lobby).toEqual({});
  });

  test("ignores a host frame addressed to a peer that is not in the room", () => {
    const hub = hubWithCodes("ABC123");
    const host = socket();
    hub.open(host, "host", null);
    expect(() => hub.message(host, encodeFrame(42, new Uint8Array([1])))).not.toThrow();
  });
});

describe("relay requests", () => {
  test("accepts the two roles and rejects anything else", () => {
    expect(parseRelayRequest(new URL("ws://x/relay?role=host"))).toEqual({ role: "host", room: null });
    expect(parseRelayRequest(new URL("ws://x/relay?role=client&room=ABC123"))).toEqual({
      role: "client",
      room: "ABC123",
    });
    expect(parseRelayRequest(new URL("ws://x/relay?role=host&room=ABC123&key=k"))).toEqual({
      role: "host",
      room: "ABC123",
      key: "k",
    });
    expect(parseRelayRequest(new URL("ws://x/relay"))).toBeNull();
    expect(parseRelayRequest(new URL("ws://x/relay?role=admin"))).toBeNull();
  });
});
