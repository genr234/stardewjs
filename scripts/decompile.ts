#!/usr/bin/env bun
/**
 * Reproduce the decompiled source tree from the vendored game backup.
 */
import { copyFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyFixes } from "./apply_fixes.ts";
import { applyPlatformPatches } from "./apply_platform_patches.ts";

export const repoRoot = join(import.meta.dir, "..");

export async function decompile(root = repoRoot): Promise<void> {
  process.env.DOTNET_ROOT ||= "/opt/homebrew/opt/dotnet/libexec";
  const ilspy = join(homedir(), ".dotnet/tools/ilspycmd");
  const gameDir = join(root, "vendor/game/MacOS");
  const outDir = join(root, "src/decompiled/StardewValley");
  const logsDir = join(root, "logs");
  const log = join(logsDir, "decompile-main.log");
  const assembly = join(gameDir, "Stardew Valley.dll");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const proc = Bun.spawn([ilspy, "-p", "-o", outDir, "-r", gameDir, assembly], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await Bun.write(log, `${stdout}${stderr}`);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(await Bun.file(log).text());
    process.exit(exitCode);
  }

  applyFixes(outDir);
  applyPlatformPatches(outDir);

  copyFileSync(join(root, "scripts/StardewValley.csproj"), join(outDir, "StardewValley.csproj"));
  try {
    unlinkSync(join(outDir, "Stardew Valley.csproj"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  console.log(`Decompiled + patched. Build with: dotnet build '${join(outDir, "StardewValley.csproj")}'`);
}

if (import.meta.main) await decompile();
