import { $ } from "bun";
import { join } from "node:path";
import { DEFAULT_PORT, findFrameworkRoot, hostBinding, openGate, startHost } from "./serve.ts";

const repoRoot = join(import.meta.dir, "..");
const wwwroot = join(repoRoot, "src/web/wwwroot");
const contentLink = join(wwwroot, "Content");
const vendorContent = join(repoRoot, "vendor/game/Content");
// The browser plays the wave banks as Opus; extract them with
// tools/audio/extract_wavebank.ts before expecting sound.
const audioLink = join(wwwroot, "Audio");
const extractedAudio = join(repoRoot, "build/web-content/audio");

await $`ln -sfn ${vendorContent} ${contentLink}`;
await $`ln -sfn ${extractedAudio} ${audioLink}`;
await $`dotnet build src/web/StardewValley.Web.csproj`.cwd(repoRoot);

const frameworkRoot = findFrameworkRoot(join(repoRoot, "src/web"));
if (!frameworkRoot) {
  console.error("Build succeeded but _framework was not found under src/web/bin.");
  process.exit(1);
}

const gate = await openGate(repoRoot).catch((err) => {
  console.error(String(err));
  console.error("Set OWNERSHIP_REFERENCE to your own `Stardew Valley.dll` to serve the game.");
  process.exit(1);
});

const server = startHost({
  wwwroot,
  frameworkRoot,
  port: Number(process.env.PORT || DEFAULT_PORT),
  gate,
  ...hostBinding(),
});
console.log(`Web host at ${server.url}`);
console.log(`Players verify against ${gate.referencePath}`);
