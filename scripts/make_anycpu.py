#!/usr/bin/env python3
"""Rewrite the vendored assemblies' PE headers from x86-64 to AnyCPU.

Stardew ships xTile, StardewValley.GameData, BmFont, Lidgren.Network and
Steamworks.NET built with PlatformTarget=x64, so their PE machine field says
AMD64. CoreCLR refuses to load them on arm64, which is why the desktop builds
were pinned to osx-x64 and Rosetta.

None of them contain native code - every one is ILONLY - so the marking is
metadata, not substance. Flipping the machine field to I386 makes them AnyCPU
and loadable on any architecture. This is what corflags(.exe) does on Windows;
there is no equivalent shipped with the .NET SDK on macOS.

Patched copies go to build/anycpu/. The originals under vendor/ are never
touched. The PE checksum is left alone: it is zero in these files, and the
loader does not verify it for managed assemblies.

Assemblies that are already AnyCPU are copied through unchanged.
"""
import os
import shutil
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SOURCE = os.path.join(ROOT, "vendor", "game", "MacOS")
DESTINATION = os.path.join(ROOT, "build", "anycpu")

# Everything the desktop and web projects reference from the vendored install.
ASSEMBLIES = [
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
]

IMAGE_FILE_MACHINE_I386 = 0x014C
IMAGE_FILE_MACHINE_AMD64 = 0x8664
COMIMAGE_FLAGS_ILONLY = 0x0001


def cli_header_offset(data):
    """File offset of the CLI (COR20) header, or None if this is not managed."""
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    section_count = struct.unpack_from("<H", data, pe + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    # Data directories sit after the optional header's fixed part, whose size
    # differs between PE32 (0x60) and PE32+ (0x70).
    directories = optional + (0x60 if magic == 0x10B else 0x70)
    rva = struct.unpack_from("<I", data, directories + 14 * 8)[0]
    if rva == 0:
        return None

    sections = optional + optional_size
    for i in range(section_count):
        entry = sections + i * 40
        virtual_size, virtual_address, raw_size, raw_pointer = struct.unpack_from("<IIII", data, entry + 8)
        if virtual_address <= rva < virtual_address + max(virtual_size, raw_size):
            return raw_pointer + (rva - virtual_address)
    return None


def convert(name):
    source = os.path.join(SOURCE, name + ".dll")
    destination = os.path.join(DESTINATION, name + ".dll")
    if not os.path.exists(source):
        return f"missing  {name}"

    data = bytearray(open(source, "rb").read())
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    machine = struct.unpack_from("<H", data, pe + 4)[0]

    if machine != IMAGE_FILE_MACHINE_AMD64:
        shutil.copy2(source, destination)
        return f"copied   {name} (already AnyCPU)"

    header = cli_header_offset(data)
    if header is None:
        shutil.copy2(source, destination)
        return f"copied   {name} (not a managed assembly - left as-is)"

    flags = struct.unpack_from("<I", data, header + 16)[0]
    if not flags & COMIMAGE_FLAGS_ILONLY:
        # Mixed-mode: the x64 marking is real and the assembly cannot be retargeted.
        shutil.copy2(source, destination)
        return f"SKIPPED  {name} (contains native code, still x64)"

    struct.pack_into("<H", data, pe + 4, IMAGE_FILE_MACHINE_I386)
    open(destination, "wb").write(data)
    return f"patched  {name} (AMD64 -> AnyCPU)"


def main():
    if not os.path.isdir(SOURCE):
        sys.exit(f"vendored assemblies not found: {SOURCE}")
    os.makedirs(DESTINATION, exist_ok=True)

    for name in ASSEMBLIES:
        print("  " + convert(name))
    print(f"-> {DESTINATION}")


if __name__ == "__main__":
    main()
