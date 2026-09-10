import { describe, expect, test } from "bun:test";

import { decodeFrame, encodeFrame, parseRelayRequest, RelayHub } from "../scripts/relay.ts";

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
  return new RelayHub({ makeCode: () => codes[index++] ?? `X${index}` });
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
    expect(host.control()[0]).toEqual({ type: "ready", room: "ABC123" });

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
    hub.open(second, "host", "ABC123");
    expect(second.control()[0]).toEqual({ type: "ready", room: "ABC123" });
    expect(hub.roomCount).toBe(1);
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
    expect(parseRelayRequest(new URL("ws://x/relay"))).toBeNull();
    expect(parseRelayRequest(new URL("ws://x/relay?role=admin"))).toBeNull();
  });
});
