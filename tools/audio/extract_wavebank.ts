/**
 * Unpack an XACT wave bank (.xwb) and transcode each MS-ADPCM entry to Opus,
 * named by index since the bank has no entry names.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

export const FORMAT_TAGS: Record<number, string> = {
  0: "PCM",
  1: "XMA",
  2: "ADPCM",
  3: "WMA",
};

// Standard MS-ADPCM coefficients, required in each WAV header.
export const ADPCM_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [256, 0],
  [512, -256],
  [0, 0],
  [192, 64],
  [240, 0],
  [460, -208],
  [392, -232],
];

export type WaveEntry = {
  index: number;
  tag: string | number;
  channels: number;
  sample_rate: number;
  block_align_raw: number;
  bits: number;
  offset: number;
  length: number;
  opus_bytes?: number;
};

export type WaveBankHeader = {
  entryCount: number;
  metaOffset: number;
  dataOffset: number;
};

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u32(data: Uint8Array, offset: number): number {
  return viewOf(data).getUint32(offset, true);
}

function packU16(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) buf.writeUInt16LE(values[i]!, i * 2);
  return buf;
}

function packI16(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) buf.writeInt16LE(values[i]!, i * 2);
  return buf;
}

function packU32(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) buf.writeUInt32LE(values[i]!, i * 4);
  return buf;
}

function fourcc(tag: string): Buffer {
  return Buffer.from(tag, "ascii");
}

export function readHeader(data: Uint8Array): WaveBankHeader {
  if (Buffer.from(data.subarray(0, 4)).toString("ascii") !== "WBND") {
    throw new Error("not an XACT wave bank (missing WBND magic)");
  }
  const segments = Array.from({ length: 5 }, (_, i) => u32(data, 12 + 8 * i));
  const bankOffset = segments[0]!;
  return {
    entryCount: u32(data, bankOffset + 4),
    metaOffset: segments[1]!,
    dataOffset: segments[4]!,
  };
}

export function readEntries(data: Uint8Array, entryCount: number, metaOffset: number): WaveEntry[] {
  const entries: WaveEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const offset = metaOffset + i * 24;
    const packed = u32(data, offset + 4);
    const tagBits = packed & 0x3;
    entries.push({
      index: i,
      tag: FORMAT_TAGS[tagBits] ?? tagBits,
      channels: (packed >> 2) & 0x7,
      sample_rate: (packed >> 5) & 0x3ffff,
      block_align_raw: (packed >> 23) & 0xff,
      bits: (packed >> 31) & 0x1 ? 16 : 8,
      offset: u32(data, offset + 8),
      length: u32(data, offset + 12),
    });
  }
  return entries;
}

/** Wrap raw bank bytes in a RIFF header so ffmpeg can decode them. */
export function buildWav(entry: WaveEntry, payload: Uint8Array): Buffer {
  const channels = entry.channels;
  const rate = entry.sample_rate;

  let fmt: Buffer;
  let fact: Buffer;
  if (entry.tag === "ADPCM") {
    const blockAlign = (entry.block_align_raw + 22) * channels;
    const samplesPerBlock = Math.floor(((blockAlign - 7 * channels) * 8) / (4 * channels)) + 2;
    const avgBytes = Math.floor(rate / samplesPerBlock) * blockAlign;
    let extra = packU16(samplesPerBlock, ADPCM_COEFFICIENTS.length);
    extra = Buffer.concat([
      extra,
      ...ADPCM_COEFFICIENTS.map(([a, b]) => packI16(a, b)),
    ]);
    fmt = Buffer.concat([
      packU16(0x0002, channels),
      packU32(rate, avgBytes),
      packU16(blockAlign, 4),
      packU16(extra.length),
      extra,
    ]);
    fact = Buffer.concat([
      fourcc("fact"),
      packU32(4),
      packU32(Math.floor(payload.length / blockAlign) * samplesPerBlock),
    ]);
  } else {
    const bits = entry.bits;
    const blockAlign = Math.floor((channels * bits) / 8);
    fmt = Buffer.concat([
      packU16(0x0001, channels),
      packU32(rate, rate * blockAlign),
      packU16(blockAlign, bits, 0),
    ]);
    fact = Buffer.alloc(0);
  }

  let chunks = Buffer.concat([fourcc("fmt "), packU32(fmt.length), fmt, fact]);
  chunks = Buffer.concat([chunks, fourcc("data"), packU32(payload.length), payload]);
  if (payload.length % 2) chunks = Buffer.concat([chunks, Buffer.from([0])]);
  return Buffer.concat([fourcc("RIFF"), packU32(4 + chunks.length), fourcc("WAVE"), chunks]);
}

export type ExtractOptions = {
  bank: string;
  out: string;
  bitrate: string;
  jobs: number;
};

export function parseExtractArgs(argv: string[]): ExtractOptions {
  let bank: string | undefined;
  let out: string | undefined;
  let bitrate = "96k";
  let jobs = cpus().length || 1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") {
      out = argv[++i];
    } else if (arg === "--bitrate") {
      bitrate = argv[++i] ?? bitrate;
    } else if (arg === "--jobs") {
      jobs = Number(argv[++i]);
    } else if (!arg.startsWith("-") && bank === undefined) {
      bank = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!bank) throw new Error("missing wave bank path");
  if (!out) throw new Error("missing --out");
  if (!Number.isFinite(jobs) || jobs < 1) throw new Error("invalid --jobs");
  return { bank, out, bitrate, jobs };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function encodeEntry(
  entry: WaveEntry,
  wav: Uint8Array,
  outDir: string,
  bitrate: string,
): Promise<{ size: number | null; error: string | null }> {
  const path = join(outDir, `${String(entry.index).padStart(4, "0")}.opus`);
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      bitrate,
      "-vbr",
      "on",
      "-application",
      "audio",
      path,
    ],
    { stdin: wav, stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return { size: null, error: stderr.trim() };
  return { size: statSync(path).size, error: null };
}

export async function extractWavebank(options: ExtractOptions): Promise<void> {
  mkdirSync(options.out, { recursive: true });
  const data = new Uint8Array(await Bun.file(options.bank).arrayBuffer());
  const { entryCount, metaOffset, dataOffset } = readHeader(data);
  const entries = readEntries(data, entryCount, metaOffset);
  const waveBytes = entries.reduce((sum, entry) => sum + entry.length, 0);
  console.log(`${entryCount} entries, ${(waveBytes / 1048576).toFixed(1)} MB of wave data`);

  const failures: string[] = [];
  let total = 0;
  let done = 0;

  await mapPool(entries, options.jobs, async (entry) => {
    const payload = data.subarray(
      dataOffset + entry.offset,
      dataOffset + entry.offset + entry.length,
    );
    let size: number | null = null;
    let error: string | null = null;
    if (entry.tag !== "ADPCM" && entry.tag !== "PCM") {
      error = `unsupported format ${entry.tag}`;
    } else {
      const encoded = await encodeEntry(entry, buildWav(entry, payload), options.out, options.bitrate);
      size = encoded.size;
      error = encoded.error;
    }
    done += 1;
    if (error) {
      failures.push(`${entry.index}: ${error}`);
    } else if (size !== null) {
      total += size;
      entry.opus_bytes = size;
    }
    if (done % 100 === 0) console.log(`  ${done}/${entryCount}`);
  });

  writeFileSync(join(options.out, "index.json"), `${JSON.stringify(entries, null, 1)}\n`);

  const source = entries.reduce((sum, entry) => sum + entry.length, 0);
  console.log(`\n${entryCount - failures.length} encoded, ${failures.length} failed`);
  console.log(
    `${(source / 1048576).toFixed(1)} MB -> ${(total / 1048576).toFixed(1)} MB  (${(source / Math.max(total, 1)).toFixed(1)}x smaller)`,
  );
  for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`);
}

async function runCli(): Promise<void> {
  try {
    const options = parseExtractArgs(process.argv.slice(2));
    await extractWavebank(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) await runCli();
