// Multiplayer rendezvous: a browser can't listen, so host and clients both dial
// in here. It only assigns peer ids and forwards opaque bytes; the game
// protocol stays in Client and Server.

export type RelaySocket = {
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
};

export type RelayRole = "host" | "client";

/** No ambiguous glyphs: codes are read aloud and typed by hand. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const PEER_HEADER_BYTES = 4;

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
  log?: (message: string) => void;
};

export class RelayHub {
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Map<RelaySocket, Membership>();
  private readonly makeCode: () => string;
  private readonly log: (message: string) => void;

  constructor(options: RelayOptions = {}) {
    this.makeCode = options.makeCode ?? defaultCodeGenerator();
    this.log = options.log ?? (() => {});
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): { code: string; lobby: Record<string, string>; peers: number[] } | null {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return null;
    return { code: room.code, lobby: { ...room.lobby }, peers: [...room.peers.keys()] };
  }

  open(socket: RelaySocket, role: RelayRole, requestedRoom: string | null): void {
    if (role === "host") {
      this.openHost(socket, requestedRoom);
      return;
    }
    this.openClient(socket, requestedRoom);
  }

  private openHost(socket: RelaySocket, requestedRoom: string | null): void {
    // A reconnecting host keeps its code, so a shared invite stays valid.
    let code = requestedRoom ? normalizeCode(requestedRoom) : this.allocateCode();
    const existing = this.rooms.get(code);
    if (existing) this.closeRoom(existing, "host-replaced");

    const room: Room = { code, host: socket, lobby: {}, peers: new Map(), nextPeer: 1 };
    this.rooms.set(code, room);
    this.members.set(socket, { role: "host", room });
    this.log(`room ${code} opened`);
    socket.send(JSON.stringify({ type: "ready", room: code }));
  }

  private openClient(socket: RelaySocket, requestedRoom: string | null): void {
    const code = normalizeCode(requestedRoom ?? "");
    const room = this.rooms.get(code);
    if (!room) {
      // The join menu distinguishes "no such room" from a host leaving mid-join.
      socket.send(JSON.stringify({ type: "error", reason: "no-such-room" }));
      socket.close(4004, "no-such-room");
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
          for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            membership.room.lobby[key] = String(value);
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
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("could not allocate a free room code");
  }
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function defaultCodeGenerator(): () => string {
  return () => {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
  };
}

export function parseRelayRequest(url: URL): { role: RelayRole; room: string | null } | null {
  const role = url.searchParams.get("role");
  if (role !== "host" && role !== "client") return null;
  const room = url.searchParams.get("room");
  return { role, room: room && room.length > 0 ? room : null };
}
