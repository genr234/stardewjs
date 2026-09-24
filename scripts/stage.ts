// Assembles build/deploy: everything the public host needs, with real files
// where the local build has symlinks, ready for `docker build`.
//
//   app/        serve.ts and what it imports, the page, and the _framework build
//               with the NuGet packages' _content folded in beside it
//   game/       Content (less XACT), the extracted Opus audio, the reference dll
//   Dockerfile  from deploy/
//
// XACT is left out: the web build plays the Opus files through
// BrowserAudioEngine and never opens a wave bank, and the banks are 475 of
// Content's 544 MB.
//
// Needs a Release build of src/web and tools/audio/extract_wavebank.ts to have run.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_REFERENCE, findFrameworkRoot, packageAssets } from "./serve.ts";

const repoRoot = join(import.meta.dir, "..");
const out = join(repoRoot, "build/deploy");
const vendorContent = join(repoRoot, "vendor/game/Content");
const extractedAudio = join(repoRoot, "build/web-content/audio");
const reference = process.env.OWNERSHIP_REFERENCE ?? join(repoRoot, DEFAULT_REFERENCE);
/** The host's modules; the rest of scripts/ is build tooling. */
const HOST_SCRIPTS = ["serve.ts", "ownership.ts", "relay.ts"];

function need(path: string, hint: string) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}. ${hint}`);
    process.exit(1);
  }
}

const frameworkRoot = findFrameworkRoot(join(repoRoot, "src/web"));
if (!frameworkRoot?.includes("/Release/")) {
  console.error("No Release build. Run `dotnet build -c Release src/web/StardewValley.Web.csproj` first.");
  process.exit(1);
}
need(vendorContent, "The game's Content folder is expected under vendor/game.");
need(extractedAudio, "Run `bun run extract-audio` first.");
need(reference, "Set OWNERSHIP_REFERENCE to your own `Stardew Valley.dll`.");

await $`rm -rf ${out}`;
await mkdir(join(out, "app/scripts"), { recursive: true });
await mkdir(join(out, "game"), { recursive: true });

for (const name of HOST_SCRIPTS) await $`cp ${join(repoRoot, "scripts", name)} ${join(out, "app/scripts")}`;
// The local Content/Audio symlinks stay behind; the Dockerfile points them at /game.
await $`rsync -a --exclude=/Content --exclude=/Audio ${join(repoRoot, "src/web/wwwroot")}/ ${join(out, "app/wwwroot")}/`;
await $`rsync -a ${frameworkRoot}/ ${join(out, "app/framework")}/`;
// The manifest that finds these points into this machine's NuGet cache.
for (const [urlPath, file] of packageAssets(frameworkRoot)) {
  const target = join(out, "app/framework", urlPath);
  await mkdir(dirname(target), { recursive: true });
  await $`cp ${file} ${target}`;
}

await $`rsync -aL --exclude=/XACT ${vendorContent}/ ${join(out, "game/Content")}/`;
await $`rsync -aL ${extractedAudio}/ ${join(out, "game/Audio")}/`;
await $`cp ${reference} ${join(out, "game/Stardew Valley.dll")}`;
await $`cp ${join(repoRoot, "deploy/Dockerfile")} ${out}`;

const size = (await $`du -sh ${out}`.text()).split("\t")[0];
console.log(`Staged ${size} in ${out}`);
console.log("It holds the game's files: build it into an image for a private registry only.");
