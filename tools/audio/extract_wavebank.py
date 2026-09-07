#!/usr/bin/env python3
"""Unpack an XACT wave bank (.xwb) and transcode every entry to Opus.

Stardew's audio is 475 MB of the 544 MB content tree, almost all of it MS-ADPCM
stereo at ~44.1 kHz. ADPCM is a fixed 4:1 ratio with no perceptual coding, so
re-encoding to Opus is where nearly all of the web payload savings live.

The bank has no entry-name table (that segment is empty); entries are addressed
by index from the Sound Bank, so files are named by index here and the cue
mapping is resolved separately.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

FORMAT_TAGS = {0: "PCM", 1: "XMA", 2: "ADPCM", 3: "WMA"}

# The fixed MS-ADPCM predictor coefficients. Every encoder uses this table, and
# it has to be written into each WAV header for a decoder to make sense of it.
ADPCM_COEFFICIENTS = [(256, 0), (512, -256), (0, 0), (192, 64), (240, 0), (460, -208), (392, -232)]


def read_header(data):
    if data[:4] != b"WBND":
        sys.exit("not an XACT wave bank (missing WBND magic)")
    segments = [struct.unpack_from("<II", data, 12 + 8 * i) for i in range(5)]
    bank_offset = segments[0][0]
    entry_count = struct.unpack_from("<I", data, bank_offset + 4)[0]
    meta_offset = segments[1][0]
    data_offset = segments[4][0]
    return entry_count, meta_offset, data_offset


def read_entries(data, entry_count, meta_offset):
    entries = []
    for i in range(entry_count):
        offset = meta_offset + i * 24
        _duration, packed, play_offset, play_length, _loop_o, _loop_l = struct.unpack_from("<6I", data, offset)
        entries.append({
            "index": i,
            "tag": FORMAT_TAGS.get(packed & 0x3, packed & 0x3),
            "channels": (packed >> 2) & 0x7,
            "sample_rate": (packed >> 5) & 0x3FFFF,
            # XACT stores block align divided by channels and biased by 22.
            "block_align_raw": (packed >> 23) & 0xFF,
            "bits": 16 if (packed >> 31) & 0x1 else 8,
            "offset": play_offset,
            "length": play_length,
        })
    return entries


def build_wav(entry, payload):
    """Wrap raw bank bytes in a RIFF header so ffmpeg can decode them."""
    channels = entry["channels"]
    rate = entry["sample_rate"]

    if entry["tag"] == "ADPCM":
        block_align = (entry["block_align_raw"] + 22) * channels
        samples_per_block = ((block_align - 7 * channels) * 8) // (4 * channels) + 2
        avg_bytes = (rate // samples_per_block) * block_align
        extra = struct.pack("<HH", samples_per_block, len(ADPCM_COEFFICIENTS))
        extra += b"".join(struct.pack("<hh", a, b) for a, b in ADPCM_COEFFICIENTS)
        fmt = struct.pack("<HHIIHH", 0x0002, channels, rate, avg_bytes, block_align, 4)
        fmt += struct.pack("<H", len(extra)) + extra
        fact = struct.pack("<4sI", b"fact", 4) + struct.pack("<I", len(payload) // block_align * samples_per_block)
    else:
        bits = entry["bits"]
        block_align = channels * bits // 8
        fmt = struct.pack("<HHIIHH", 0x0001, channels, rate, rate * block_align, block_align, bits)
        fmt += struct.pack("<H", 0)
        fact = b""

    chunks = struct.pack("<4sI", b"fmt ", len(fmt)) + fmt + fact
    chunks += struct.pack("<4sI", b"data", len(payload)) + payload
    if len(payload) % 2:
        chunks += b"\x00"
    return struct.pack("<4sI4s", b"RIFF", 4 + len(chunks), b"WAVE") + chunks


def ffmpeg_env():
    """
    Homebrew's ffmpeg here is linked against libx265.216 (x265 4.2) while 4.3 is
    the linked keg, which only provides .217. Both are in the Cellar, so point
    the loader at the older one for our own subprocesses rather than touching
    the system install. Harmless when the library resolves normally.
    """
    env = dict(os.environ)
    extra = [p for p in ("/opt/homebrew/Cellar/x265/4.2/lib", "/opt/homebrew/lib") if os.path.isdir(p)]
    if extra:
        existing = env.get("DYLD_FALLBACK_LIBRARY_PATH", "")
        env["DYLD_FALLBACK_LIBRARY_PATH"] = ":".join(extra + ([existing] if existing else []))
    return env


def encode(entry, wav, out_dir, bitrate):
    path = os.path.join(out_dir, f"{entry['index']:04d}.opus")
    process = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0",
         "-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", "-application", "audio", path],
        input=wav, capture_output=True, env=FFMPEG_ENV,
    )
    if process.returncode != 0:
        return None, process.stderr.decode(errors="replace").strip()
    return os.path.getsize(path), None


FFMPEG_ENV = None


def main():
    global FFMPEG_ENV
    FFMPEG_ENV = ffmpeg_env()
    parser = argparse.ArgumentParser()
    parser.add_argument("bank")
    parser.add_argument("--out", required=True)
    parser.add_argument("--bitrate", default="96k")
    parser.add_argument("--jobs", type=int, default=os.cpu_count())
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    with open(args.bank, "rb") as handle:
        data = handle.read()

    entry_count, meta_offset, data_offset = read_header(data)
    entries = read_entries(data, entry_count, meta_offset)
    print(f"{entry_count} entries, {sum(e['length'] for e in entries) / 1048576:.1f} MB of wave data")

    failures = []
    total = 0

    def work(entry):
        payload = data[data_offset + entry["offset"]: data_offset + entry["offset"] + entry["length"]]
        if entry["tag"] not in ("ADPCM", "PCM"):
            return entry, None, f"unsupported format {entry['tag']}"
        size, error = encode(entry, build_wav(entry, payload), args.out, args.bitrate)
        return entry, size, error

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, (entry, size, error) in enumerate(pool.map(work, entries), 1):
            if error:
                failures.append(f"{entry['index']}: {error}")
            else:
                total += size
                entry["opus_bytes"] = size
            if done % 100 == 0:
                print(f"  {done}/{entry_count}")

    with open(os.path.join(args.out, "index.json"), "w") as handle:
        json.dump(entries, handle, indent=1)

    source = sum(e["length"] for e in entries)
    print(f"\n{entry_count - len(failures)} encoded, {len(failures)} failed")
    print(f"{source / 1048576:.1f} MB -> {total / 1048576:.1f} MB  ({source / max(total, 1):.1f}x smaller)")
    for failure in failures[:10]:
        print(f"  {failure}")


if __name__ == "__main__":
    main()
