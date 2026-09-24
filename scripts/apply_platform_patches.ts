/**
 * Patches for where the game's assumptions don't hold off its home platform:
 * `#if KNI` where KNI and ConcernedApe's MonoGame fork differ (the MonoGame
 * build keeps the original), plus unconditional fixes that are harmless
 * everywhere. Run after scripts/apply_fixes.ts. Idempotent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patch, PatchError } from "./patch.ts";

export const repoRoot = join(import.meta.dir, "..");
export const defaultSrc = join(repoRoot, "src", "decompiled", "StardewValley");

function wrapDisplayModes(srcRoot: string, rel: string, expected: number): void {
  const path = join(srcRoot, rel);
  let source = readFileSync(path, "utf8");
  const marker = "#if KNI // Display modes";
  if (source.includes(marker)) return;
  source = source.replaceAll(".Adapter.GetSupportedDisplayModes()", ".Adapter.SupportedDisplayModes");
  const lines = source.split("\n").filter((line) => line.includes(".Adapter.SupportedDisplayModes"));
  if (lines.length !== expected) {
    throw new PatchError(`${rel}: expected ${expected} display-mode lines, found ${lines.length}`);
  }
  for (const line of lines) {
    const kniLine = line.replaceAll(".Adapter.SupportedDisplayModes", ".Adapter.GetSupportedDisplayModes()");
    source = source.replaceAll(line, `${marker}\n${kniLine}\n#else\n${line}\n#endif`);
  }
  writeFileSync(path, source);
  console.log(`patched ${rel}`);
}

export function applyPlatformPatches(srcRoot = defaultSrc): void {
  // --- Game.OnActivated lost its sender parameter upstream ---------------------
  // The fork passes (sender, args); KNI passes (args).
  patch(
    srcRoot,
    "StardewValley/GameRunner.cs",
    `\tprotected override void OnActivated(object sender, EventArgs args)
\t{
\t\tExecuteForInstances(delegate(Game1 instance)
\t\t{
\t\t\tinstance.Instance_OnActivated(sender, args);
\t\t});
\t}`,
    `#if KNI
\tprotected override void OnActivated(EventArgs args)
\t{
\t\tobject sender = this;
\t\tExecuteForInstances(delegate(Game1 instance)
\t\t{
\t\t\tinstance.Instance_OnActivated(sender, args);
\t\t});
\t}
#else
\tprotected override void OnActivated(object sender, EventArgs args)
\t{
\t\tExecuteForInstances(delegate(Game1 instance)
\t\t{
\t\t\tinstance.Instance_OnActivated(sender, args);
\t\t});
\t}
#endif`,
  );

  // --- SoundBank's cue-editing members are fork-only ---------------------------
  patch(
    srcRoot,
    "StardewValley/SoundBankWrapper.cs",
    `\tpublic void AddCue(CueDefinition definition)
\t{
\t\tsoundBank.AddCue(definition);
\t}`,
    `\tpublic void AddCue(CueDefinition definition)
\t{
#if KNI
\t\tXactCompat.AddCue(soundBank, definition);
#else
\t\tsoundBank.AddCue(definition);
#endif
\t}`,
  );

  patch(
    srcRoot,
    "StardewValley/SoundBankWrapper.cs",
    `\tpublic bool Exists(string name)
\t{
\t\treturn soundBank.Exists(name);
\t}`,
    `\tpublic bool Exists(string name)
\t{
#if KNI
\t\treturn XactCompat.Exists(soundBank, name);
#else
\t\treturn soundBank.Exists(name);
#endif
\t}`,
  );

  patch(
    srcRoot,
    "StardewValley/SoundBankWrapper.cs",
    `\tpublic CueDefinition GetCueDefinition(string name)
\t{
\t\treturn soundBank.GetCueDefinition(name);
\t}`,
    `\tpublic CueDefinition GetCueDefinition(string name)
\t{
#if KNI
\t\treturn XactCompat.GetCueDefinition(soundBank, name);
#else
\t\treturn soundBank.GetCueDefinition(name);
#endif
\t}`,
  );

  // --- ConcernedApe's Texture2D image-size tracking ----------------------------
  // KNI has no padded-texture "actual" size, so the allocated size is it.
  patch(
    srcRoot,
    "StardewValley.Extensions/FrameworkExtensions.cs",
    `\tpublic static int GetElementCount(this Texture2D texture)
\t{
\t\treturn texture.ActualWidth * texture.ActualHeight;
\t}

\tpublic static int GetActualWidth(this Texture2D texture)
\t{
\t\treturn texture.ActualWidth;
\t}

\tpublic static int GetActualHeight(this Texture2D texture)
\t{
\t\treturn texture.ActualHeight;
\t}

\tpublic static void SetContentSize(this Texture2D texture, int width, int height)
\t{
\t\ttexture.SetImageSize(width, height);
\t}`,
    `\tpublic static int GetElementCount(this Texture2D texture)
\t{
#if KNI
\t\treturn texture.Width * texture.Height;
#else
\t\treturn texture.ActualWidth * texture.ActualHeight;
#endif
\t}

\tpublic static int GetActualWidth(this Texture2D texture)
\t{
#if KNI
\t\treturn texture.Width;
#else
\t\treturn texture.ActualWidth;
#endif
\t}

\tpublic static int GetActualHeight(this Texture2D texture)
\t{
#if KNI
\t\treturn texture.Height;
#else
\t\treturn texture.ActualHeight;
#endif
\t}

\tpublic static void SetContentSize(this Texture2D texture, int width, int height)
\t{
#if !KNI
\t\ttexture.SetImageSize(width, height);
#endif
\t}`,
  );

  // --- Cue.Volume / Pitch are property wrappers over XACT cue variables ---------
  patch(
    srcRoot,
    "StardewValley/CueWrapper.cs",
    `\tpublic float Volume
\t{
\t\tget
\t\t{
\t\t\treturn cue.Volume;
\t\t}
\t\tset
\t\t{
\t\t\tcue.Volume = value;
\t\t}
\t}

\tpublic float Pitch
\t{
\t\tget
\t\t{
\t\t\treturn cue.Pitch;
\t\t}
\t\tset
\t\t{
\t\t\tcue.Pitch = value;
\t\t}
\t}

\tpublic bool IsPitchBeingControlledByRPC => cue.IsPitchBeingControlledByRPC;`,
    `\tpublic float Volume
\t{
\t\tget
\t\t{
#if KNI
\t\t\treturn cue.GetVolume();
#else
\t\t\treturn cue.Volume;
#endif
\t\t}
\t\tset
\t\t{
#if KNI
\t\t\tcue.SetVolume(value);
#else
\t\t\tcue.Volume = value;
#endif
\t\t}
\t}

\tpublic float Pitch
\t{
\t\tget
\t\t{
#if KNI
\t\t\treturn cue.GetPitch();
#else
\t\t\treturn cue.Pitch;
#endif
\t\t}
\t\tset
\t\t{
#if KNI
\t\t\tcue.SetPitch(value);
#else
\t\t\tcue.Pitch = value;
#endif
\t\t}
\t}

#if KNI
\tpublic bool IsPitchBeingControlledByRPC => cue.GetIsPitchBeingControlledByRPC();
#else
\tpublic bool IsPitchBeingControlledByRPC => cue.IsPitchBeingControlledByRPC;
#endif`,
  );

  // --- SpriteBatch.TextureTuckAmount is a fork-only static ---------------------
  // Without it, tile seams may appear at some zoom levels.
  patch(
    srcRoot,
    "StardewValley/GameRunner.cs",
    "\t\tSpriteBatch.TextureTuckAmount = 0.001f;",
    `#if !KNI
\t\tSpriteBatch.TextureTuckAmount = 0.001f;
#endif`,
  );

  // --- Streaming Vorbis is a fork type, on a mods-only path --------------------
  // Only reached from Data/AudioChanges, which ships empty.
  patch(
    srcRoot,
    "StardewValley.Audio/AudioCueModificationManager.cs",
    `\t\t\t\t\t\tSoundEffect soundEffect;
\t\t\t\t\t\tif (flag2 && value.StreamedVorbis)
\t\t\t\t\t\t{
\t\t\t\t\t\t\tsoundEffect = new OggStreamSoundEffect(filePath);
\t\t\t\t\t\t}
\t\t\t\t\t\telse
\t\t\t\t\t\t{
\t\t\t\t\t\t\tusing FileStream stream = new FileStream(filePath, FileMode.Open);
\t\t\t\t\t\t\tsoundEffect = SoundEffect.FromStream(stream, flag2);
\t\t\t\t\t\t}`,
    `\t\t\t\t\t\tSoundEffect soundEffect;
#if KNI
\t\t\t\t\t\tusing (FileStream stream = new FileStream(filePath, FileMode.Open))
\t\t\t\t\t\t{
\t\t\t\t\t\t\tsoundEffect = SoundEffect.FromStream(stream);
\t\t\t\t\t\t}
#else
\t\t\t\t\t\tif (flag2 && value.StreamedVorbis)
\t\t\t\t\t\t{
\t\t\t\t\t\t\tsoundEffect = new OggStreamSoundEffect(filePath);
\t\t\t\t\t\t}
\t\t\t\t\t\telse
\t\t\t\t\t\t{
\t\t\t\t\t\t\tusing FileStream stream = new FileStream(filePath, FileMode.Open);
\t\t\t\t\t\t\tsoundEffect = SoundEffect.FromStream(stream, flag2);
\t\t\t\t\t\t}
#endif`,
  );

  // --- Named arguments that differ only in spelling ----------------------------
  // The positional form compiles against both, so no #if.
  for (const [rel, before, after] of [
    [
      "StardewValley/Game1.cs",
      "new Texture2D(game1.GraphicsDevice, width, height, mipmap: false, SurfaceFormat.Color)",
      "new Texture2D(game1.GraphicsDevice, width, height, false, SurfaceFormat.Color)",
    ],
    [
      "StardewValley/Game1.cs",
      "new Texture2D(base.GraphicsDevice, 1, 1, mipmap: false, SurfaceFormat.Color)",
      "new Texture2D(base.GraphicsDevice, 1, 1, false, SurfaceFormat.Color)",
    ],
    [
      "StardewValley/DebugMetricsComponent.cs",
      "new Texture2D(base.GraphicsDevice, num, num2, mipmap: false, SurfaceFormat.Color)",
      "new Texture2D(base.GraphicsDevice, num, num2, false, SurfaceFormat.Color)",
    ],
  ] as const) {
    patch(srcRoot, rel, before, after);
  }

  // Vector2.Dot's parameters are value1/value2 in the fork and left/right in KNI.
  patch(
    srcRoot,
    "StardewValley.Menus/EmoteMenu.cs",
    "Vector2.Dot(value2: new Vector2((float)_emoteButtons[i].bounds.Center.X - ((float)xPositionOnScreen + (float)width / 2f), (float)_emoteButtons[i].bounds.Center.Y - ((float)yPositionOnScreen + (float)height / 2f)), value1: value)",
    "Vector2.Dot(value, new Vector2((float)_emoteButtons[i].bounds.Center.X - ((float)xPositionOnScreen + (float)width / 2f), (float)_emoteButtons[i].bounds.Center.Y - ((float)yPositionOnScreen + (float)height / 2f)))",
  );

  patch(
    srcRoot,
    "StardewValley/Options.cs",
    "using Microsoft.Xna.Framework.Graphics;\nusing Microsoft.Xna.Framework.Input;",
    "using Microsoft.Xna.Framework;\nusing Microsoft.Xna.Framework.Graphics;\nusing Microsoft.Xna.Framework.Input;",
  );

  // --- The game reflects into MonoGame's internals for the content root ---------
  // A private static in the fork; KNI has no equivalent.
  patch(
    srcRoot,
    "StardewValley/LocalizedContentManager.cs",
    `\t\tif (_CachedContentRoot == null)
\t\t{
\t\t\tstring path = ((string)(typeof(TitleContainer).GetProperty("Location", BindingFlags.Static | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Can't get TitleContainer.Location property from MonoGame")).GetValue(null, null)) ?? throw new InvalidOperationException("Can't get value of TitleContainer.Location property from MonoGame");
\t\t\t_CachedContentRoot = Path.Combine(path, base.RootDirectory);
\t\t}`,
    `\t\tif (_CachedContentRoot == null)
\t\t{
#if KNI
\t\t\tstring path = KniContentRoot.Resolve();
#else
\t\t\tstring path = ((string)(typeof(TitleContainer).GetProperty("Location", BindingFlags.Static | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Can't get TitleContainer.Location property from MonoGame")).GetValue(null, null)) ?? throw new InvalidOperationException("Can't get value of TitleContainer.Location property from MonoGame");
#endif
\t\t\t_CachedContentRoot = Path.Combine(path, base.RootDirectory);
\t\t}`,
  );

  // --- Graphics profile ---------------------------------------------------------
  // The fork defaults to HiDef; KNI's Reach caps textures at 2048 and fails on
  // the first tilesheet.
  patch(
    srcRoot,
    "StardewValley/GameRunner.cs",
    `\t\tGame1.graphics = new GraphicsDeviceManager(this);`,
    `\t\tGame1.graphics = new GraphicsDeviceManager(this);
#if KNI
\t\tGame1.graphics.GraphicsProfile = GraphicsProfile.HiDef;
#endif`,
  );

  // --- Win32 IME hook on a platform that is neither Windows nor Unix ------------
  // WASM reports PlatformID.Other, which took the Win32 hook path and failed to
  // marshal HookProc.
  patch(
    srcRoot,
    "StardewValley/KeyboardDispatcher.cs",
    `\t\tif (Environment.OSVersion.Platform == PlatformID.Unix || Environment.OSVersion.Platform == PlatformID.Win32NT)
\t\t{`,
    `\t\tif (Environment.OSVersion.Platform == PlatformID.Unix || Environment.OSVersion.Platform == PlatformID.Win32NT || OperatingSystem.IsBrowser())
\t\t{`,
    // Both the constructor and Cleanup test this, and they have to agree.
    2,
  );

  // --- Display-mode enumeration -------------------------------------------------
  wrapDisplayModes(srcRoot, "StardewValley/Options.cs", 2);
  wrapDisplayModes(srcRoot, "StardewValley/Game1.cs", 3);

  // --- The content manifest is read off disk ------------------------------------
  // File.Exists is always false in a browser, so every asset looked missing.
  // TitleContainer works in both (synchronous XHR on the web).
  patch(
    srcRoot,
    "StardewValley/LocalizedContentManager.cs",
    `\t\t_manifest = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
\t\tstring text = Path.Combine(GetContentRoot(), "ContentHashes.json");`,
    `\t\t_manifest = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
#if KNI
\t\tif (OperatingSystem.IsBrowser())
\t\t{
\t\t\tstring manifestUrl = base.RootDirectory + "/ContentHashes.json";
\t\t\ttry
\t\t\t{
\t\t\t\tusing Stream manifestStream = TitleContainer.OpenStream(manifestUrl);
\t\t\t\tusing StreamReader manifestReader = new StreamReader(manifestStream);
\t\t\t\tif (CHJsonParser.ParseJson(manifestReader.ReadToEnd()) is Dictionary<string, object> manifest)
\t\t\t\t{
\t\t\t\t\t_manifest.UnionWith(manifest.Keys);
\t\t\t\t\tGame1.log.Verbose($"Loaded ContentHashes.json over HTTP containing {manifest.Count} file(s).");
\t\t\t\t}
\t\t\t}
\t\t\tcatch (Exception manifestException)
\t\t\t{
\t\t\t\tGame1.log.Error("Could not fetch ContentHashes.json over HTTP.", manifestException);
\t\t\t}
\t\t\treturn;
\t\t}
#endif
\t\tstring text = Path.Combine(GetContentRoot(), "ContentHashes.json");`,
  );

  // --- Blazor's XACT ADPCM initializer is an empty stub -------------------------
  // KNI's PlatformInitializeXactAdpcm is a stub, so the first cue crashes.
  // The browser build swaps in BrowserAudio (see src/web/BrowserAudio.cs).
  patch(
    srcRoot,
    "StardewValley/Game1.cs",
    `\t\t\t\tstring rootDirectory = base.Content.RootDirectory;
\t\t\t\tAudioEngine obj = new AudioEngine(Path.Combine(rootDirectory, "XACT", "FarmerSounds.xgs"));`,
    `#if WEB
\t\t\t\taudioEngine = new StardewValley.Web.BrowserAudioEngine();
\t\t\t\tsoundBank = new StardewValley.Web.BrowserSoundBank();
#else
\t\t\t\tstring rootDirectory = base.Content.RootDirectory;
\t\t\t\tAudioEngine obj = new AudioEngine(Path.Combine(rootDirectory, "XACT", "FarmerSounds.xgs"));`,
  );
  patch(
    srcRoot,
    "StardewValley/Game1.cs",
    `\t\t\t\tsoundBank = new SoundBankWrapper(new SoundBank(audioEngine.Engine, Path.Combine(rootDirectory, "XACT", "Sound Bank.xsb")));`,
    `\t\t\t\tsoundBank = new SoundBankWrapper(new SoundBank(audioEngine.Engine, Path.Combine(rootDirectory, "XACT", "Sound Bank.xsb")));
#endif`,
  );

  // Commit saves before reporting completion, yielding while IndexedDB runs.
  patch(
    srcRoot,
    "StardewValley/SaveGame.cs",
    "\t\tGame1.player.sleptInTemporaryBed.Value = false;\n\t\tif (CancelToTitle)",
    `\t\tGame1.player.sleptInTemporaryBed.Value = false;
#if WEB
\t\tTask persistTask = StardewValley.Web.BrowserSaveStorage.FlushAsync();
\t\twhile (!persistTask.IsCompleted)
\t\t{
\t\t\tyield return 2;
\t\t}
\t\tpersistTask.GetAwaiter().GetResult();
#endif
\t\tif (CancelToTitle)`,
  );

  // Use the incremental save path on WEB so IndexedDB can finish between ticks.
  patch(
    srcRoot,
    "StardewValley/SaveGame.cs",
    "\t\tIsProcessing = true;\n\t\tif (LocalMultiplayer.IsLocalMultiplayer())",
    `\t\tIsProcessing = true;
#if WEB
\t\tbool incrementalSave = true;
#else
\t\tbool incrementalSave = LocalMultiplayer.IsLocalMultiplayer();
#endif
\t\tif (incrementalSave)`,
  );
  patch(
    srcRoot,
    "StardewValley/SaveGame.cs",
    "\t\t\t\tyield return save.Current;\n\t\t\t}\n\t\t\tyield return 100;",
    "\t\t\t\tyield return save.Current;\n\t\t\t}\n\t\t\tIsProcessing = false;\n\t\t\tyield return 100;",
  );

  // Farm deletion must reach IndexedDB before the menu removes the slot.
  patch(
    srcRoot,
    "StardewValley.Menus/LoadGameMenu.cs",
    '\t\t\t\t\tGame1.hooks.StartTask(_deleteTask, "Farm_Delete");',
    `\t\t\t\t\tGame1.hooks.StartTask(_deleteTask, "Farm_Delete");
#if WEB
\t\t\t\t\t_deleteTask = _deleteTask.ContinueWith(async deleted =>
\t\t\t\t\t{
\t\t\t\t\t\tdeleted.GetAwaiter().GetResult();
\t\t\t\t\t\tawait StardewValley.Web.BrowserSaveStorage.FlushAsync();
\t\t\t\t\t}).Unwrap();
#endif`,
  );
  patch(
    srcRoot,
    "StardewValley.Menus/LoadGameMenu.cs",
    "\t\t\t\tif (!_deleteTask.IsCompleted)",
    `#if WEB
\t\t\t\t_deleteTask.GetAwaiter().GetResult();
#endif
\t\t\t\tif (!_deleteTask.IsCompleted)`,
  );

  // browser-wasm has no ApplicationData folder, so save paths came out relative
  // and LoadGameMenu doubled them. Root them at "/".
  patch(
    srcRoot,
    "StardewValley/Program.cs",
    '\t\tstring folderPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);\n\t\tstring text = ((subfolder != null) ? Path.Combine(folderPath, "StardewValley", subfolder) : Path.Combine(folderPath, "StardewValley"));',
    `\t\tstring folderPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
#if WEB
\t\tif (string.IsNullOrEmpty(folderPath))
\t\t{
\t\t\tfolderPath = "/";
\t\t}
#endif
\t\tstring text = ((subfolder != null) ? Path.Combine(folderPath, "StardewValley", subfolder) : Path.Combine(folderPath, "StardewValley"));`,
  );

  // --- multiplayer has no transport in a browser -------------------------------
  // Replaced by WebSocket via scripts/relay.ts; see src/web/BrowserMultiplayer.cs.
  patch(
    srcRoot,
    "StardewValley.Network/GameServer.cs",
    "\t\tservers.Add(Game1.multiplayer.InitServer(new LidgrenServer(this)));",
    `#if WEB
\t\tservers.Add(Game1.multiplayer.InitServer(new StardewValley.Web.WebSocketServer(this)));
#else
\t\tservers.Add(Game1.multiplayer.InitServer(new LidgrenServer(this)));
#endif`,
  );

  // The IP field takes the relay's invite code instead.
  patch(
    srcRoot,
    "StardewValley.Menus/CoopMenu.cs",
    "\t\t\tsetMenu(new FarmhandMenu(Game1.multiplayer.InitClient(new LidgrenClient(address))));",
    `#if WEB
\t\t\tsetMenu(new FarmhandMenu(Game1.multiplayer.InitClient(new StardewValley.Web.WebSocketClient(address))));
#else
\t\t\tsetMenu(new FarmhandMenu(Game1.multiplayer.InitClient(new LidgrenClient(address))));
#endif`,
  );

  // The game's "Enter Invite Code" slot needs an SDK; relabel the LAN one.
  patch(
    srcRoot,
    "StardewValley.Menus/CoopMenu.cs",
    `\t\t\t: base(menu, Game1.content.LoadString("Strings\\\\UI:CoopMenu_JoinLANGame"))`,
    `#if WEB
\t\t\t: base(menu, Game1.content.LoadString("Strings\\\\UI:CoopMenu_EnterInviteCode"))
#else
\t\t\t: base(menu, Game1.content.LoadString("Strings\\\\UI:CoopMenu_JoinLANGame"))
#endif`,
  );
  patch(
    srcRoot,
    "StardewValley.Menus/CoopMenu.cs",
    `\t\tstring title = Game1.content.LoadString("Strings\\\\UI:CoopMenu_EnterIP");`,
    `#if WEB
\t\tstring title = Game1.content.LoadString("Strings\\\\UI:CoopMenu_EnterInviteCode");
#else
\t\tstring title = Game1.content.LoadString("Strings\\\\UI:CoopMenu_EnterIP");
#endif`,
  );

  // Split-screen joins over loopback, which doesn't exist; wait for the invite code.
  patch(
    srcRoot,
    "StardewValley/Game1.cs",
    `\t\t\t\tactiveClickableMenu = new FarmhandMenu(multiplayer.InitClient(new LidgrenClient("localhost")));`,
    `#if WEB
\t\t\t\tstring inviteCode = server?.getInviteCode();
\t\t\t\tif (inviteCode == null)
\t\t\t\t{
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tactiveClickableMenu = new FarmhandMenu(multiplayer.InitClient(new StardewValley.Web.WebSocketClient(inviteCode)));
#else
\t\t\t\tactiveClickableMenu = new FarmhandMenu(multiplayer.InitClient(new LidgrenClient("localhost")));
#endif`,
  );

  // Invite-code buttons need an SDK, so show the relay code whenever hosting.
  patch(
    srcRoot,
    "StardewValley.Menus/OptionsPage.cs",
    `\t\tif (Game1.multiplayerMode == 2 && Game1.server != null && !Game1.server.IsLocalMultiplayerInitiatedServer() && Program.sdk.Networking != null)
\t\t{
\t\t\toptions.Add(new OptionsButton(Game1.content.LoadString("Strings\\\\UI:GameMenu_ServerInvite"), offerInvite));
\t\t\tif (Program.sdk.Networking.SupportsInviteCodes())
\t\t\t{
\t\t\t\toptions.Add(new OptionsButton(Game1.content.LoadString("Strings\\\\UI:OptionsPage_ShowInviteCode"), showInviteCode));
\t\t\t}
\t\t}`,
    `#if WEB
\t\tif (Game1.multiplayerMode == 2 && Game1.server != null && Game1.server.getInviteCode() != null)
\t\t{
\t\t\toptions.Add(new OptionsButton(Game1.content.LoadString("Strings\\\\UI:OptionsPage_ShowInviteCode"), showInviteCode));
\t\t}
#else
\t\tif (Game1.multiplayerMode == 2 && Game1.server != null && !Game1.server.IsLocalMultiplayerInitiatedServer() && Program.sdk.Networking != null)
\t\t{
\t\t\toptions.Add(new OptionsButton(Game1.content.LoadString("Strings\\\\UI:GameMenu_ServerInvite"), offerInvite));
\t\t\tif (Program.sdk.Networking.SupportsInviteCodes())
\t\t\t{
\t\t\t\toptions.Add(new OptionsButton(Game1.content.LoadString("Strings\\\\UI:OptionsPage_ShowInviteCode"), showInviteCode));
\t\t\t}
\t\t}
#endif`,
  );

  // --- a browser tab cannot exit ----------------------------------------------
  // See src/web/BrowserExit.cs.
  patch(
    srcRoot,
    "StardewValley/InstanceGame.cs",
    `\tpublic void Exit()
\t{
\t\tGameRunner.instance.Exit();
\t}`,
    `\tpublic void Exit()
\t{
#if WEB
\t\tStardewValley.Web.BrowserExit.Request();
#else
\t\tGameRunner.instance.Exit();
#endif
\t}`,
  );

  // --- Mouse.SetPosition does not exist in a browser --------------------------
  // A page can't move the pointer; see src/web/BrowserMouse.cs.
  patch(
    srcRoot,
    "StardewValley/InputState.cs",
    `\t\t\tMouse.SetPosition(x, y);`,
    `#if WEB
\t\t\tStardewValley.Web.BrowserMouse.SetPosition(x, y);
#else
\t\t\tMouse.SetPosition(x, y);
#endif`,
  );
}

function runCli(): void {
  try {
    applyPlatformPatches();
    console.log("platform patches applied");
  } catch (error) {
    if (error instanceof PatchError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

if (import.meta.main) runCli();
