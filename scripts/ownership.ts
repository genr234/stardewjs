// Proof of ownership, decided by the host rather than by the page.
//
// The page's own check (src/web/wwwroot/js/ownership.js) can only refuse to
// start the game; it cannot stop anyone from pulling the 544 MB of Content, the
// extracted audio, or the game assembly itself straight out of the server with
// curl. This is what closes that: until a connection has proved it holds the
// game, those paths are refused.
//
// The proof is a challenge over the file's own bytes. The host names a handful
// of random windows into its reference copy, the page hashes those windows of
// the file the player picked, and the host compares against its own bytes. The
// file is never uploaded, the windows differ every time so a recorded answer is
// worth nothing, and passing requires the actual bytes rather than a digest
// someone read off a forum.
//
// This deliberately demands the *same build* the host streams. The Content it
// serves came out of that install, so a 1.6.15 page against 1.6.9 assets is not
// a configuration worth admitting anyway.

import { timingSafeEqual } from "node:crypto";

export type Challenge = {
  id: string;
  ranges: Array<[number, number]>;
  size: number;
};

export type GateOptions = {
  referencePath: string;
  now?: () => number;
  randomBytes?: (count: number) => Uint8Array;
  challengeTtlMs?: number;
  tokenTtlMs?: number;
};

export const COOKIE_NAME = "stardew_ownership";

export const GATED_PATH = /(?:^|\/)(?:Content|Audio|_framework)(?:\/|$)/i;

const WINDOW_BYTES = 64 * 1024;
const WINDOW_COUNT = 4;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultRandomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", joined)));
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

export class OwnershipGate {
  readonly referencePath: string;
  private readonly now: () => number;
  private readonly randomBytes: (count: number) => Uint8Array;
  private readonly challengeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly pending = new Map<string, { ranges: Array<[number, number]>; expiresAt: number }>();
  private readonly tokens = new Map<string, number>();
  private reference: Promise<{ size: number }> | null = null;

  constructor(options: GateOptions) {
    this.referencePath = options.referencePath;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.challengeTtlMs = options.challengeTtlMs ?? CHALLENGE_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS;
  }

  async referenceSize(): Promise<number> {
    if (!this.reference) {
      this.reference = Bun.file(this.referencePath)
        .stat()
        .then((info) => {
          if (!info.isFile() || info.size === 0) throw new Error("not a file");
          return { size: info.size };
        })
        .catch((err) => {
          this.reference = null;
          throw new Error(`No reference copy of the game at ${this.referencePath}: ${err}`);
        });
    }
    return (await this.reference).size;
  }

  private sweep() {
    const at = this.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(id);
    for (const [token, expiresAt] of this.tokens) if (expiresAt <= at) this.tokens.delete(token);
  }

  async challenge(): Promise<Challenge> {
    this.sweep();
    const size = await this.referenceSize();
    const length = Math.min(WINDOW_BYTES, size);
    const ranges: Array<[number, number]> = [];
    const span = Math.max(1, size - length + 1);
    for (let i = 0; i < WINDOW_COUNT; i++) {
      const bytes = this.randomBytes(6);
      let offset = 0;
      for (const byte of bytes) offset = offset * 256 + byte;
      ranges.push([offset % span, length]);
    }
    const id = toHex(this.randomBytes(16));
    this.pending.set(id, { ranges, expiresAt: this.now() + this.challengeTtlMs });
    return { id, ranges, size };
  }

  private async expected(id: string, ranges: Array<[number, number]>): Promise<string> {
    const file = Bun.file(this.referencePath);
    const parts = [new TextEncoder().encode(id)];
    for (const [start, length] of ranges) {
      parts.push(new Uint8Array(await file.slice(start, start + length).arrayBuffer()));
    }
    return sha256(parts);
  }

  async answer(id: unknown, digest: unknown): Promise<string | null> {
    this.sweep();
    if (typeof id !== "string" || typeof digest !== "string") return null;
    const entry = this.pending.get(id);
    // One attempt per challenge.
    this.pending.delete(id);
    if (!entry || entry.expiresAt <= this.now()) return null;
    if (!sameSecret(digest, await this.expected(id, entry.ranges))) return null;
    return this.grant();
  }

  grant(): string {
    const token = toHex(this.randomBytes(32));
    this.tokens.set(token, this.now() + this.tokenTtlMs);
    return token;
  }

  verify(token: string | null): boolean {
    if (!token) return false;
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | null) {
    if (token) this.tokens.delete(token);
  }

  get tokenLifetimeSeconds(): number {
    return Math.floor(this.tokenTtlMs / 1000);
  }
}
