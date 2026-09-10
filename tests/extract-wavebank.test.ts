import { describe, expect, test } from "bun:test";
import {
  ADPCM_COEFFICIENTS,
  buildWav,
  parseExtractArgs,
  readEntries,
  readHeader,
  type WaveEntry,
} from "../tools/audio/extract_wavebank.ts";

function u32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value >>> 0, true);
}

function packedFormat(options: {
  tag: number;
  channels: number;
  sampleRate: number;
  blockAlignRaw: number;
  bits16: boolean;
}): number {
  let packed = options.tag & 0x3;
  packed |= (options.channels & 0x7) << 2;
  packed |= (options.sampleRate & 0x3ffff) << 5;
  packed |= (options.blockAlignRaw & 0xff) << 23;
  if (options.bits16) packed |= 1 << 31;
  return packed >>> 0;
}

function makeBank(entry: {
  tag: number;
  channels: number;
  sampleRate: number;
  blockAlignRaw: number;
  bits16: boolean;
  payload: Uint8Array;
}): Uint8Array {
  const headerSize = 52;
  const bankSize = 12;
  const metaSize = 24;
  const metaOffset = headerSize + bankSize;
  const dataOffset = metaOffset + metaSize;
  const data = new Uint8Array(dataOffset + entry.payload.length);

  data[0] = 0x57;
  data[1] = 0x42;
  data[2] = 0x4e;
  data[3] = 0x44;
  u32(data, 12, headerSize);
  u32(data, 20, metaOffset);
  u32(data, 44, dataOffset);
  u32(data, headerSize + 4, 1);
  u32(data, metaOffset + 4, packedFormat(entry));
  u32(data, metaOffset + 8, 0);
  u32(data, metaOffset + 12, entry.payload.length);
  data.set(entry.payload, dataOffset);
  return data;
}

function asciiAt(buf: Uint8Array, offset: number, length: number): string {
  return Buffer.from(buf.subarray(offset, offset + length)).toString("ascii");
}

describe("readHeader / readEntries", () => {
  test("rejects a buffer without WBND magic", () => {
    expect(() => readHeader(new Uint8Array([1, 2, 3, 4]))).toThrow(
      "not an XACT wave bank (missing WBND magic)",
    );
  });

  test("parses a single PCM entry", () => {
    const payload = new Uint8Array([0, 1, 2, 3]);
    const bank = makeBank({
      tag: 0,
      channels: 1,
      sampleRate: 44100,
      blockAlignRaw: 0,
      bits16: true,
      payload,
    });
    const header = readHeader(bank);
    expect(header.entryCount).toBe(1);
    const [entry] = readEntries(bank, header.entryCount, header.metaOffset);
    expect(entry).toMatchObject({
      index: 0,
      tag: "PCM",
      channels: 1,
      sample_rate: 44100,
      bits: 16,
      offset: 0,
      length: 4,
    });
  });
});

describe("buildWav", () => {
  test("wraps PCM payload in a RIFF WAVE", () => {
    const entry: WaveEntry = {
      index: 0,
      tag: "PCM",
      channels: 1,
      sample_rate: 44100,
      block_align_raw: 0,
      bits: 16,
      offset: 0,
      length: 4,
    };
    const payload = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const wav = buildWav(entry, payload);
    expect(asciiAt(wav, 0, 4)).toBe("RIFF");
    expect(asciiAt(wav, 8, 4)).toBe("WAVE");
    expect(asciiAt(wav, 12, 4)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(asciiAt(wav, wav.length - 12, 4)).toBe("data");
    expect(wav.readUInt32LE(wav.length - 8)).toBe(4);
    expect([...wav.subarray(wav.length - 4)]).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  test("writes MS-ADPCM coefficients and a fact chunk", () => {
    const entry: WaveEntry = {
      index: 0,
      tag: "ADPCM",
      channels: 2,
      sample_rate: 44100,
      block_align_raw: 10,
      bits: 16,
      offset: 0,
      length: 64,
    };
    const wav = buildWav(entry, new Uint8Array(64));
    expect(wav.readUInt16LE(20)).toBe(0x0002);
    expect(asciiAt(wav, 12, 4)).toBe("fmt ");
    const fmtSize = wav.readUInt32LE(16);
    const extra = wav.subarray(20 + 16 + 2, 20 + fmtSize);
    const coeffCount = extra.readUInt16LE(2);
    expect(coeffCount).toBe(ADPCM_COEFFICIENTS.length);
    expect(extra.readInt16LE(4)).toBe(256);
    expect(extra.readInt16LE(6)).toBe(0);
    expect(asciiAt(wav, 20 + fmtSize, 4)).toBe("fact");
  });
});

describe("parseExtractArgs", () => {
  test("requires a bank path and --out", () => {
    expect(() => parseExtractArgs([])).toThrow("missing wave bank path");
    expect(() => parseExtractArgs(["bank.xwb"])).toThrow("missing --out");
    expect(parseExtractArgs(["bank.xwb", "--out", "dest", "--bitrate", "64k", "--jobs", "2"])).toEqual({
      bank: "bank.xwb",
      out: "dest",
      bitrate: "64k",
      jobs: 2,
    });
  });
});
