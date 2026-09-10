/**
 * Rewrite the vendored x64 assemblies (all ILONLY) as AnyCPU so CoreCLR loads
 * them on arm64 - what corflags does on Windows. Copies go to build/anycpu/;
 * vendor/ is untouched. The PE checksum is zero and not verified, so it's left.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..");
export const defaultSource = join(repoRoot, "vendor", "game", "MacOS");
export const defaultDestination = join(repoRoot, "build", "anycpu");

export const ASSEMBLIES = [
  "xTile",
  "StardewValley.GameData",
  "BmFont",
  "CPExtBmFont",
  "Lidgren.Network",
  "TextCopy",
  "SkiaSharp",
  "Steamworks.NET",
  "GalaxyCSharp",
  "System.Data.HashFunction.Core",
  "System.Data.HashFunction.Interfaces",
  "System.Data.HashFunction.xxHash",
] as const;

export const IMAGE_FILE_MACHINE_I386 = 0x014c;
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const COMIMAGE_FLAGS_ILONLY = 0x0001;

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u16(data: Uint8Array, offset: number): number {
  return viewOf(data).getUint16(offset, true);
}

function u32(data: Uint8Array, offset: number): number {
  return viewOf(data).getUint32(offset, true);
}

function setU16(data: Uint8Array, offset: number, value: number): void {
  viewOf(data).setUint16(offset, value, true);
}

/** File offset of the CLI (COR20) header, or null if this is not managed. */
export function cliHeaderOffset(data: Uint8Array): number | null {
  const pe = u32(data, 0x3c);
  const sectionCount = u16(data, pe + 6);
  const optionalSize = u16(data, pe + 20);
  const optional = pe + 24;
  const magic = u16(data, optional);
  // The optional header's fixed part is 0x60 in PE32, 0x70 in PE32+.
  const directories = optional + (magic === 0x10b ? 0x60 : 0x70);
  const rva = u32(data, directories + 14 * 8);
  if (rva === 0) return null;

  const sections = optional + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const entry = sections + i * 40;
    const virtualSize = u32(data, entry + 8);
    const virtualAddress = u32(data, entry + 12);
    const rawSize = u32(data, entry + 16);
    const rawPointer = u32(data, entry + 20);
    if (virtualAddress <= rva && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return rawPointer + (rva - virtualAddress);
    }
  }
  return null;
}

export type RetargetAction = "patched" | "copied" | "skipped";

export type RetargetResult = {
  bytes: Uint8Array;
  action: RetargetAction;
  reason: string;
};

export function retargetToAnyCpu(data: Uint8Array): RetargetResult {
  const pe = u32(data, 0x3c);
  const machine = u16(data, pe + 4);

  if (machine !== IMAGE_FILE_MACHINE_AMD64) {
    return { bytes: data, action: "copied", reason: "already AnyCPU" };
  }

  const header = cliHeaderOffset(data);
  if (header === null) {
    return { bytes: data, action: "copied", reason: "not a managed assembly - left as-is" };
  }

  const flags = u32(data, header + 16);
  if (!(flags & COMIMAGE_FLAGS_ILONLY)) {
    return { bytes: data, action: "skipped", reason: "contains native code, still x64" };
  }

  const patched = data.slice();
  setU16(patched, pe + 4, IMAGE_FILE_MACHINE_I386);
  return { bytes: patched, action: "patched", reason: "AMD64 -> AnyCPU" };
}

export function convertAssembly(
  name: string,
  sourceDir: string,
  destinationDir: string,
): string {
  const source = join(sourceDir, `${name}.dll`);
  const destination = join(destinationDir, `${name}.dll`);
  if (!existsSync(source)) return `missing  ${name}`;

  const data = new Uint8Array(readFileSync(source));
  const result = retargetToAnyCpu(data);
  if (result.action === "patched") {
    writeFileSync(destination, result.bytes);
    return `patched  ${name} (${result.reason})`;
  }
  copyFileSync(source, destination);
  if (result.action === "skipped") return `SKIPPED  ${name} (${result.reason})`;
  return `copied   ${name} (${result.reason})`;
}

export function makeAnyCpu(
  sourceDir = defaultSource,
  destinationDir = defaultDestination,
): void {
  if (!existsSync(sourceDir)) {
    console.error(`vendored assemblies not found: ${sourceDir}`);
    process.exit(1);
  }
  mkdirSync(destinationDir, { recursive: true });
  for (const name of ASSEMBLIES) {
    console.log(`  ${convertAssembly(name, sourceDir, destinationDir)}`);
  }
  console.log(`-> ${destinationDir}`);
}

if (import.meta.main) makeAnyCpu();
