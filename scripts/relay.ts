// Multiplayer rendezvous: a browser can't listen, so host and clients both dial
// in here. It only assigns peer ids and forwards opaque bytes; the game
// protocol stays in Client and Server.

import { timingSafeEqual } from "node:crypto";

export type RelaySocket = {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
};

export type RelayRole = "host" | "client";

/** No ambiguous glyphs: codes are read aloud and typed by hand. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const PEER_HEADER_BYTES = 4;

const MAX_ROOMS = 1000;
const MAX_PEERS_PER_ROOM = 16;
// A host that drops keeps its code this long; only its key can take it back.
const RESERVE_MS = 30 * 60 * 1000;
const MAX_LOBBY_KEYS = 32;
const MAX_LOBBY_KEY_LENGTH = 64;
const MAX_LOBBY_VALUE_LENGTH = 4096;
const REQUESTED_CODE = /^[A-Z0-9]{4,16}$/;

export function encodeFrame(peer: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(PEER_HEADER_BYTES + payload.length);
  new DataView(framed.buffer).setUint32(0, peer, true);
  framed.set(payload, PEER_HEADER_BYTES);
  return framed;
}

export function decodeFrame(framed: Uint8Array): { peer: number; payload: Uint8Array } | null {
  if (framed.length < PEER_HEADER_BYTES) return null;
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  return {
    peer: view.getUint32(0, true),
    payload: framed.subarray(PEER_HEADER_BYTES),
  };
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

type Room = {
  code: string;
  key: string;
  host: RelaySocket;
  lobby: Record<string, string>;
  peers: Map<number, RelaySocket>;
  nextPeer: number;
};

type Membership =
  | { role: "host"; room: Room }
  | { role: "client"; room: Room; peer: number };

export type RelayOptions = {
  makeCode?: () => string;
  makeKey?: () => string;
  now?: () => number;
  log?: (message: string) => void;
  maxRooms?: number;
  maxPeersPerRoom?: number;
};

export class RelayHub {
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Map<RelaySocket, Membership>();
  /** Every code in use or recently dropped, with the key that may reclaim it. */
  private readonly claims = new Map<string, { key: string; releasedAt: number | null }>();
  private readonly makeCode: () => string;
  private readonly makeKey: () => string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly maxRooms: number;
  private readonly maxPeersPerRoom: number;

  constructor(options: RelayOptions = {}) {
    this.makeCode = options.makeCode ?? defaultCodeGenerator();
    this.makeKey = options.makeKey ?? defaultKey;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.maxPeersPerRoom = options.maxPeersPerRoom ?? MAX_PEERS_PER_ROOM;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): { code: string; lobby: Record<string, string>; peers: number[] } | null {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return null;
    return { code: room.code, lobby: { ...room.lobby }, peers: [...room.peers.keys()] };
  }

  /** `key` is what a host was handed with its code; it proves the code is theirs. */
  open(socket: RelaySocket, role: RelayRole, requestedRoom: string | null, key?: string | null): void {
    if (role === "host") {
      this.openHost(socket, requestedRoom, key ?? null);
      return;
    }
    this.openClient(socket, requestedRoom);
  }

  private openHost(socket: RelaySocket, requestedRoom: string | null, key: string | null): void {
    this.releaseExpired();
    // A reconnecting host keeps its code, so a shared invite stays valid - but
    // only with the key, or anyone who heard the code could take the room.
    const requested = requestedRoom ? normalizeCode(requestedRoom) : null;
    const reclaiming = requested !== null && this.mayClaim(requested, key);
    if (!reclaiming && (this.rooms.size >= this.maxRooms || this.claims.size >= this.maxRooms * 2)) {
      refuse(socket, 4003, "relay-full");
      return;
    }
    const code = reclaiming ? requested : this.allocateCode();
    const existing = this.rooms.get(code);
    if (existing) {
      this.rooms.delete(code);
      this.closeRoom(existing, "host-replaced");
      existing.host.close(4000, "host-replaced");
    }
    const roomKey = this.claims.get(code)?.key ?? this.makeKey();
    this.claims.set(code, { key: roomKey, releasedAt: null });

    const room: Room = { code, key: roomKey, host: socket, lobby: {}, peers: new Map(), nextPeer: 1 };
    this.rooms.set(code, room);
    this.members.set(socket, { role: "host", room });
    this.log(`room ${code} opened`);
    socket.send(JSON.stringify({ type: "ready", room: code, key: roomKey }));
  }

  private mayClaim(code: string, key: string | null): boolean {
    if (!REQUESTED_CODE.test(code)) return false;
    const claim = this.claims.get(code);
    // A code nobody holds is free, e.g. one read out before the relay restarted.
    if (!claim) return true;
    return key !== null && sameKey(claim.key, key);
  }

  private releaseExpired(): void {
    const at = this.now();
    for (const [code, claim] of this.claims) {
      if (claim.releasedAt !== null && at - claim.releasedAt >= RESERVE_MS) this.claims.delete(code);
    }
  }

  private openClient(socket: RelaySocket, requestedRoom: string | null): void {
    const code = normalizeCode(requestedRoom ?? "");
    const room = this.rooms.get(code);
    if (!room) {
      // The join menu distinguishes "no such room" from a host leaving mid-join.
      refuse(socket, 4004, "no-such-room");
      return;
    }
    if (room.peers.size >= this.maxPeersPerRoom) {
      refuse(socket, 4005, "room-full");
      return;
    }
    const peer = room.nextPeer++;
    room.peers.set(peer, socket);
    this.members.set(socket, { role: "client", room, peer });
    socket.send(JSON.stringify({ type: "ready", room: room.code, peer, lobby: { ...room.lobby } }));
    room.host.send(JSON.stringify({ type: "connect", peer }));
    this.log(`room ${room.code}: peer ${peer} connected`);
  }

  message(socket: RelaySocket, data: unknown): void {
    const membership = this.members.get(socket);
    if (!membership) return;

    const bytes = toBytes(data);
    if (bytes) {
      this.relay(membership, bytes);
      return;
    }
    if (typeof data === "string") this.control(membership, data);
  }

  private relay(membership: Membership, bytes: Uint8Array): void {
    if (membership.role === "client") {
      membership.room.host.send(encodeFrame(membership.peer, bytes));
      return;
    }
    const frame = decodeFrame(bytes);
    if (!frame) return;
    membership.room.peers.get(frame.peer)?.send(frame.payload);
  }

  private control(membership: Membership, text: string): void {
    let message: { type?: string; [key: string]: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (membership.role !== "host") return;

    switch (message.type) {
      case "lobby": {
        const data = message.data;
        if (data && typeof data === "object") {
          const lobby = membership.room.lobby;
          for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            const text = String(value);
            if (key.length > MAX_LOBBY_KEY_LENGTH || text.length > MAX_LOBBY_VALUE_LENGTH) continue;
            if (!(key in lobby) && Object.keys(lobby).length >= MAX_LOBBY_KEYS) continue;
            lobby[key] = text;
          }
        }
        break;
      }
      case "kick": {
        const peer = Number(message.peer);
        const socket = membership.room.peers.get(peer);
        if (socket) {
          membership.room.peers.delete(peer);
          this.members.delete(socket);
          socket.close(4001, "kicked");
        }
        break;
      }
    }
  }

  close(socket: RelaySocket): void {
    const membership = this.members.get(socket);
    if (!membership) return;
    this.members.delete(socket);

    if (membership.role === "host") {
      this.rooms.delete(membership.room.code);
      const claim = this.claims.get(membership.room.code);
      if (claim) claim.releasedAt = this.now();
      this.closeRoom(membership.room, "host-left");
      this.log(`room ${membership.room.code} closed`);
      return;
    }
    membership.room.peers.delete(membership.peer);
    membership.room.host.send(JSON.stringify({ type: "disconnect", peer: membership.peer }));
    this.log(`room ${membership.room.code}: peer ${membership.peer} disconnected`);
  }

  private closeRoom(room: Room, reason: string): void {
    for (const [, socket] of room.peers) {
      this.members.delete(socket);
      socket.send(JSON.stringify({ type: "error", reason }));
      socket.close(4000, reason);
    }
    room.peers.clear();
    this.members.delete(room.host);
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = normalizeCode(this.makeCode());
      if (!this.rooms.has(code) && !this.claims.has(code)) return code;
    }
    throw new Error("could not allocate a free room code");
  }
}

function refuse(socket: RelaySocket, code: number, reason: string): void {
  socket.send(JSON.stringify({ type: "error", reason }));
  socket.close(code, reason);
}

function sameKey(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function defaultKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function defaultCodeGenerator(): () => string {
  return () => {
    // 32 glyphs, so the low five bits of a random byte pick one without bias.
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let code = "";
    for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
    return code;
  };
}

export function parseRelayRequest(
  url: URL,
): { role: RelayRole; room: string | null; key?: string } | null {
  const role = url.searchParams.get("role");
  if (role !== "host" && role !== "client") return null;
  const room = url.searchParams.get("room");
  const key = url.searchParams.get("key");
  return {
    role,
    room: room && room.length > 0 ? room : null,
    ...(key ? { key } : {}),
  };
}
