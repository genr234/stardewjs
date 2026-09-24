// Server-side proof of ownership. Until a connection proves it holds the game,
// Content, Audio and _framework are refused. The host picks random byte ranges
// of its reference copy; the page hashes the same ranges of the player's file.
// The same build is required. Passing yields a signed, expiring token cookie,
// so nothing is stored per player.

import { createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  /** Persisting the key lets tokens survive restarts. */
  secretPath?: string;
  /** The key itself, as 64 hex digits; wins over secretPath. For hosts with no writable disk. */
  secretHex?: string;
  /** Challenges outstanding at once; past this the host asks players to retry. */
  maxPending?: number;
  /** A token seen from more addresses than this within shareWindowMs is revoked. */
  maxClientsPerToken?: number;
  shareWindowMs?: number;
};

/** Thrown by challenge() while too many challenges are outstanding. */
export class GateBusyError extends Error {}

export const COOKIE_NAME = "stardew_ownership";

export const GATED_PATH = /(?:^|\/)(?:Content|Audio|_framework)(?:\/|$)/i;

const WINDOW_BYTES = 64 * 1024;
const WINDOW_COUNT = 4;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
// Short enough that a token passed around stops working within the week.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Bounds memory: a flood of challenge requests can't grow the map past this.
const MAX_PENDING = 10_000;
// A phone moving between wifi and mobile data changes address a few times a
// day; a token posted publicly shows up from far more.
const MAX_CLIENTS_PER_TOKEN = 8;
const SHARE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// expiry.nonce.signature; the nonce keeps two players verified in the same
// millisecond from sharing a token, and so sharing a revocation.
const TOKEN_SHAPE = /^(([0-9a-z]{1,12})\.[0-9a-f]{16})\.([0-9a-f]{64})$/;

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

function loadSecret(path: string): Buffer {
  const stored = (() => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  })();
  if (/^[0-9a-f]{64}$/.test(stored)) return Buffer.from(stored, "hex");
  const secret = cryptoRandomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, secret.toString("hex") + "\n", { mode: 0o600 });
  return secret;
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
  /** Tokens revoked via /forget, kept until they would have expired. */
  private readonly revoked = new Map<string, number>();
  /** Per token, the addresses it was used from and when each was last seen. */
  private readonly seenFrom = new Map<string, { expiresAt: number; clients: Map<string, number> }>();
  private readonly maxPending: number;
  private readonly maxClientsPerToken: number;
  private readonly shareWindowMs: number;
  private lastSweep = 0;
  private readonly secret: Buffer;
  private binding: string | null = null;
  private reference: Promise<{ size: number }> | null = null;

  constructor(options: GateOptions) {
    this.referencePath = options.referencePath;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.challengeTtlMs = options.challengeTtlMs ?? CHALLENGE_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING;
    this.maxClientsPerToken = options.maxClientsPerToken ?? MAX_CLIENTS_PER_TOKEN;
    this.shareWindowMs = options.shareWindowMs ?? SHARE_WINDOW_MS;
    if (options.secretHex !== undefined) {
      if (!/^[0-9a-f]{64}$/i.test(options.secretHex)) throw new Error("The ownership key must be 64 hex digits.");
      this.secret = Buffer.from(options.secretHex, "hex");
    } else {
      this.secret = options.secretPath ? loadSecret(options.secretPath) : cryptoRandomBytes(32);
    }
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
    this.lastSweep = at;
    for (const [id, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(id);
    for (const [token, expiresAt] of this.revoked) if (expiresAt <= at) this.revoked.delete(token);
    for (const [token, entry] of this.seenFrom) if (entry.expiresAt <= at) this.seenFrom.delete(token);
  }

  /**
   * Tokens are bound to this host's build, so switching builds invalidates them.
   * Synchronous because verify() is on the asset path.
   */
  private referenceTag(): string | null {
    if (this.binding === null) {
      try {
        const info = statSync(this.referencePath);
        if (!info.isFile() || info.size === 0) return null;
        this.binding = `${this.referencePath}:${info.size}`;
      } catch {
        return null;
      }
    }
    return this.binding;
  }

  private sign(body: string, tag: string): string {
    return createHmac("sha256", this.secret).update(`${body}\n${tag}`).digest("hex");
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
    if (this.pending.size >= this.maxPending) throw new GateBusyError("too many checks in progress");
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
    const tag = this.referenceTag();
    if (!tag) throw new Error(`No reference copy of the game at ${this.referencePath}`);
    const body = `${(this.now() + this.tokenTtlMs).toString(36)}.${toHex(this.randomBytes(8))}`;
    return `${body}.${this.sign(body, tag)}`;
  }

  /**
   * Pass the requester's address to count it against the token; a token used
   * from too many places has been shared and is revoked.
   */
  verify(token: string | null, client?: string): boolean {
    if (!token) return false;
    const parts = TOKEN_SHAPE.exec(token);
    if (!parts) return false;
    const [, body, expiry, signature] = parts as unknown as [string, string, string, string];
    const expiresAt = parseInt(expiry, 36);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return false;
    if (this.revoked.has(token)) return false;
    const tag = this.referenceTag();
    if (!tag) return false;
    if (!sameSecret(signature, this.sign(body, tag))) return false;
    return client === undefined || this.noteClient(token, expiresAt, client);
  }

  private noteClient(token: string, expiresAt: number, client: string): boolean {
    const at = this.now();
    if (at - this.lastSweep >= SWEEP_INTERVAL_MS) this.sweep();
    let entry = this.seenFrom.get(token);
    if (!entry) {
      entry = { expiresAt, clients: new Map() };
      this.seenFrom.set(token, entry);
    }
    entry.clients.set(client, at);
    for (const [seen, lastSeen] of entry.clients) {
      if (lastSeen <= at - this.shareWindowMs) entry.clients.delete(seen);
    }
    if (entry.clients.size <= this.maxClientsPerToken) return true;
    this.revoked.set(token, expiresAt);
    this.seenFrom.delete(token);
    return false;
  }

  revoke(token: string | null) {
    if (!token || !this.verify(token)) return;
    const parts = TOKEN_SHAPE.exec(token);
    this.revoked.set(token, parseInt(parts![2]!, 36));
    this.seenFrom.delete(token);
  }

  get tokenLifetimeSeconds(): number {
    return Math.floor(this.tokenTtlMs / 1000);
  }
}
