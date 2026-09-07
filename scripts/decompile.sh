#!/usr/bin/env bash
# Reproduce the decompiled source tree from the vendored game backup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DOTNET_ROOT=/opt/homebrew/opt/dotnet/libexec
ILSPY="$HOME/.dotnet/tools/ilspycmd"
G="$ROOT/vendor/game/MacOS"

rm -rf "$ROOT/src/decompiled/StardewValley"
mkdir -p "$ROOT/src/decompiled/StardewValley" "$ROOT/logs"
"$ILSPY" -p -o "$ROOT/src/decompiled/StardewValley" -r "$G" "$G/Stardew Valley.dll" \
  > "$ROOT/logs/decompile-main.log" 2>&1
python3 "$ROOT/scripts/apply_fixes.py"
python3 "$ROOT/scripts/apply_platform_patches.py"
cp "$ROOT/scripts/StardewValley.csproj" "$ROOT/src/decompiled/StardewValley/StardewValley.csproj"
rm -f "$ROOT/src/decompiled/StardewValley/Stardew Valley.csproj"
echo "Decompiled + patched. Build with: dotnet build '$ROOT/src/decompiled/StardewValley/StardewValley.csproj'"
