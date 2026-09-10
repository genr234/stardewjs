import { describe, expect, test } from "bun:test";
import {
  cliHeaderOffset,
  COMIMAGE_FLAGS_ILONLY,
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_I386,
  retargetToAnyCpu,
} from "../scripts/make_anycpu.ts";

function u16(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint16(offset, value, true);
}

function u32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value, true);
}

function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

type PeOptions = {
  machine: number;
  ilonly?: boolean;
  managed?: boolean;
};

function makePe(options: PeOptions): Uint8Array {
  const pe = 0x80;
  const optionalSize = 0xf0;
  const data = new Uint8Array(0x400);
  data[0] = 0x4d;
  data[1] = 0x5a;
  u32(data, 0x3c, pe);
  data[pe] = 0x50;
  data[pe + 1] = 0x45;
  u16(data, pe + 4, options.machine);
  u16(data, pe + 6, 1);
  u16(data, pe + 20, optionalSize);
  u16(data, pe + 24, 0x20b);
  const directories = pe + 24 + 0x70;
  if (options.managed !== false) {
    u32(data, directories + 14 * 8, 0x2000);
    u32(data, directories + 14 * 8 + 4, 72);
  }
  const section = pe + 24 + optionalSize;
  u32(data, section + 8, 0x200);
  u32(data, section + 12, 0x2000);
  u32(data, section + 16, 0x200);
  u32(data, section + 20, 0x200);
  u32(data, 0x200 + 16, options.ilonly === false ? 0 : COMIMAGE_FLAGS_ILONLY);
  return data;
}

describe("cliHeaderOffset", () => {
  test("finds the COR20 header in a PE32+ image", () => {
    const pe = makePe({ machine: IMAGE_FILE_MACHINE_AMD64 });
    expect(cliHeaderOffset(pe)).toBe(0x200);
  });

  test("returns null when the CLI directory is empty", () => {
    const pe = makePe({ machine: IMAGE_FILE_MACHINE_AMD64, managed: false });
    expect(cliHeaderOffset(pe)).toBeNull();
  });
});

describe("retargetToAnyCpu", () => {
  test("rewrites AMD64 ILONLY to I386", () => {
    const pe = makePe({ machine: IMAGE_FILE_MACHINE_AMD64, ilonly: true });
    const result = retargetToAnyCpu(pe);
    expect(result.action).toBe("patched");
    expect(readU16(result.bytes, 0x80 + 4)).toBe(IMAGE_FILE_MACHINE_I386);
    expect(readU16(pe, 0x80 + 4)).toBe(IMAGE_FILE_MACHINE_AMD64);
  });

  test("copies an assembly that is already AnyCPU", () => {
    const pe = makePe({ machine: IMAGE_FILE_MACHINE_I386 });
    const result = retargetToAnyCpu(pe);
    expect(result.action).toBe("copied");
    expect(result.bytes).toBe(pe);
  });

  test("skips mixed-mode AMD64 assemblies", () => {
    const pe = makePe({ machine: IMAGE_FILE_MACHINE_AMD64, ilonly: false });
    const result = retargetToAnyCpu(pe);
    expect(result.action).toBe("skipped");
    expect(readU16(result.bytes, 0x80 + 4)).toBe(IMAGE_FILE_MACHINE_AMD64);
  });
});
