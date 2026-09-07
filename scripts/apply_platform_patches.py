#!/usr/bin/env python3
"""Guard the places where the game's assumptions do not hold off its home platform.

Two kinds of difference live here:

  * `#if KNI` - where KNI and ConcernedApe's MonoGame fork disagree. Only the KNI
    and browser projects define the symbol; the MonoGame build keeps compiling
    the original code, so it stays usable as a reference to diff against.
  * unconditional fixes - where the original code is simply wrong off Windows or
    macOS and the correction is harmless everywhere.

All three builds compile the same decompiled tree, so these are directives rather
than a second copy of the source.

Run after scripts/apply_fixes.py. Idempotent - re-running is a no-op.
"""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "src", "decompiled", "StardewValley")


def patch(relative_path, original, replacement, expected=1):
    """Replace `original` with `replacement`, asserting it appears `expected` times."""
    path = os.path.join(SRC, relative_path)
    source = open(path).read()
    if replacement in source:
        print(f"already patched {relative_path}")
        return
    if source.count(original) != expected:
        sys.exit(f"{relative_path}: expected {expected} match(es), found {source.count(original)}")
    open(path, "w").write(source.replace(original, replacement))
    print(f"patched {relative_path}")


# --- Game.OnActivated lost its sender parameter upstream ---------------------
# ConcernedApe's fork passes (sender, args); stock MonoGame and KNI pass (args).
patch(
    "StardewValley/GameRunner.cs",
    """	protected override void OnActivated(object sender, EventArgs args)
	{
		ExecuteForInstances(delegate(Game1 instance)
		{
			instance.Instance_OnActivated(sender, args);
		});
	}""",
    """#if KNI
	protected override void OnActivated(EventArgs args)
	{
		object sender = this;
		ExecuteForInstances(delegate(Game1 instance)
		{
			instance.Instance_OnActivated(sender, args);
		});
	}
#else
	protected override void OnActivated(object sender, EventArgs args)
	{
		ExecuteForInstances(delegate(Game1 instance)
		{
			instance.Instance_OnActivated(sender, args);
		});
	}
#endif""",
)

# --- SoundBank's cue-editing members are fork-only ---------------------------
# See src/platform/XactCompat.cs for why these are shimmed rather than forked.
patch(
    "StardewValley/SoundBankWrapper.cs",
    """	public void AddCue(CueDefinition definition)
	{
		soundBank.AddCue(definition);
	}""",
    """	public void AddCue(CueDefinition definition)
	{
#if KNI
		XactCompat.AddCue(soundBank, definition);
#else
		soundBank.AddCue(definition);
#endif
	}""",
)

patch(
    "StardewValley/SoundBankWrapper.cs",
    """	public bool Exists(string name)
	{
		return soundBank.Exists(name);
	}""",
    """	public bool Exists(string name)
	{
#if KNI
		return XactCompat.Exists(soundBank, name);
#else
		return soundBank.Exists(name);
#endif
	}""",
)

patch(
    "StardewValley/SoundBankWrapper.cs",
    """	public CueDefinition GetCueDefinition(string name)
	{
		return soundBank.GetCueDefinition(name);
	}""",
    """	public CueDefinition GetCueDefinition(string name)
	{
#if KNI
		return XactCompat.GetCueDefinition(soundBank, name);
#else
		return soundBank.GetCueDefinition(name);
#endif
	}""",
)


# --- ConcernedApe's Texture2D image-size tracking ----------------------------
# The fork records an "actual" size separate from the allocated texture size, for
# textures padded to a power of two. KNI has no such notion, so the allocated size
# is the actual size.
patch(
    "StardewValley.Extensions/FrameworkExtensions.cs",
    """	public static int GetElementCount(this Texture2D texture)
	{
		return texture.ActualWidth * texture.ActualHeight;
	}

	public static int GetActualWidth(this Texture2D texture)
	{
		return texture.ActualWidth;
	}

	public static int GetActualHeight(this Texture2D texture)
	{
		return texture.ActualHeight;
	}

	public static void SetContentSize(this Texture2D texture, int width, int height)
	{
		texture.SetImageSize(width, height);
	}""",
    """	public static int GetElementCount(this Texture2D texture)
	{
#if KNI
		return texture.Width * texture.Height;
#else
		return texture.ActualWidth * texture.ActualHeight;
#endif
	}

	public static int GetActualWidth(this Texture2D texture)
	{
#if KNI
		return texture.Width;
#else
		return texture.ActualWidth;
#endif
	}

	public static int GetActualHeight(this Texture2D texture)
	{
#if KNI
		return texture.Height;
#else
		return texture.ActualHeight;
#endif
	}

	public static void SetContentSize(this Texture2D texture, int width, int height)
	{
#if !KNI
		texture.SetImageSize(width, height);
#endif
	}""",
)

# --- Cue.Volume / Pitch are property wrappers over XACT cue variables ---------
patch(
    "StardewValley/CueWrapper.cs",
    """	public float Volume
	{
		get
		{
			return cue.Volume;
		}
		set
		{
			cue.Volume = value;
		}
	}

	public float Pitch
	{
		get
		{
			return cue.Pitch;
		}
		set
		{
			cue.Pitch = value;
		}
	}

	public bool IsPitchBeingControlledByRPC => cue.IsPitchBeingControlledByRPC;""",
    """	public float Volume
	{
		get
		{
#if KNI
			return cue.GetVolume();
#else
			return cue.Volume;
#endif
		}
		set
		{
#if KNI
			cue.SetVolume(value);
#else
			cue.Volume = value;
#endif
		}
	}

	public float Pitch
	{
		get
		{
#if KNI
			return cue.GetPitch();
#else
			return cue.Pitch;
#endif
		}
		set
		{
#if KNI
			cue.SetPitch(value);
#else
			cue.Pitch = value;
#endif
		}
	}

#if KNI
	public bool IsPitchBeingControlledByRPC => cue.GetIsPitchBeingControlledByRPC();
#else
	public bool IsPitchBeingControlledByRPC => cue.IsPitchBeingControlledByRPC;
#endif""",
)

# --- SpriteBatch.TextureTuckAmount is a fork-only static ---------------------
# It insets sampling by a fraction of a texel to stop neighbouring tiles bleeding
# in. Without it, seams may appear between tiles at some zoom levels - cosmetic,
# and worth revisiting once something is rendering.
patch(
    "StardewValley/GameRunner.cs",
    "		SpriteBatch.TextureTuckAmount = 0.001f;",
    """#if !KNI
		SpriteBatch.TextureTuckAmount = 0.001f;
#endif""",
)

# --- Streaming Vorbis is a fork type, on a mods-only path --------------------
# Both branches here are reached only from Data/AudioChanges, which ships empty.
patch(
    "StardewValley.Audio/AudioCueModificationManager.cs",
    """						SoundEffect soundEffect;
						if (flag2 && value.StreamedVorbis)
						{
							soundEffect = new OggStreamSoundEffect(filePath);
						}
						else
						{
							using FileStream stream = new FileStream(filePath, FileMode.Open);
							soundEffect = SoundEffect.FromStream(stream, flag2);
						}""",
    """						SoundEffect soundEffect;
#if KNI
						using (FileStream stream = new FileStream(filePath, FileMode.Open))
						{
							soundEffect = SoundEffect.FromStream(stream);
						}
#else
						if (flag2 && value.StreamedVorbis)
						{
							soundEffect = new OggStreamSoundEffect(filePath);
						}
						else
						{
							using FileStream stream = new FileStream(filePath, FileMode.Open);
							soundEffect = SoundEffect.FromStream(stream, flag2);
						}
#endif""",
)

# --- Named arguments that differ only in spelling ----------------------------
# Positional form compiles against both frameworks, so these need no #if.
for path, before, after in [
    ("StardewValley/Game1.cs",
     "new Texture2D(game1.GraphicsDevice, width, height, mipmap: false, SurfaceFormat.Color)",
     "new Texture2D(game1.GraphicsDevice, width, height, false, SurfaceFormat.Color)"),
    ("StardewValley/Game1.cs",
     "new Texture2D(base.GraphicsDevice, 1, 1, mipmap: false, SurfaceFormat.Color)",
     "new Texture2D(base.GraphicsDevice, 1, 1, false, SurfaceFormat.Color)"),
    ("StardewValley/DebugMetricsComponent.cs",
     "new Texture2D(base.GraphicsDevice, num, num2, mipmap: false, SurfaceFormat.Color)",
     "new Texture2D(base.GraphicsDevice, num, num2, false, SurfaceFormat.Color)"),
]:
    patch(path, before, after)

# Vector2.Dot's parameters are value1/value2 in the fork and left/right in KNI.
patch(
    "StardewValley.Menus/EmoteMenu.cs",
    "Vector2.Dot(value2: new Vector2((float)_emoteButtons[i].bounds.Center.X - ((float)xPositionOnScreen + (float)width / 2f), (float)_emoteButtons[i].bounds.Center.Y - ((float)yPositionOnScreen + (float)height / 2f)), value1: value)",
    "Vector2.Dot(value, new Vector2((float)_emoteButtons[i].bounds.Center.X - ((float)xPositionOnScreen + (float)width / 2f), (float)_emoteButtons[i].bounds.Center.Y - ((float)yPositionOnScreen + (float)height / 2f)))",
)

# Options.cs reaches GameWindow through Game1 without importing the namespace the
# shims live in.
patch(
    "StardewValley/Options.cs",
    "using Microsoft.Xna.Framework.Graphics;\nusing Microsoft.Xna.Framework.Input;",
    "using Microsoft.Xna.Framework;\nusing Microsoft.Xna.Framework.Graphics;\nusing Microsoft.Xna.Framework.Input;",
)

# --- The game reflects into MonoGame's internals for the content root ---------
# TitleContainer.Location is a private static in ConcernedApe's fork; KNI moved
# title access behind a factory and exposes no equivalent. On desktop the value
# is just the app directory. This is also the hook the web build will need, since
# content there comes over HTTP rather than off a disk.
patch(
    "StardewValley/LocalizedContentManager.cs",
    """		if (_CachedContentRoot == null)
		{
			string path = ((string)(typeof(TitleContainer).GetProperty("Location", BindingFlags.Static | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Can't get TitleContainer.Location property from MonoGame")).GetValue(null, null)) ?? throw new InvalidOperationException("Can't get value of TitleContainer.Location property from MonoGame");
			_CachedContentRoot = Path.Combine(path, base.RootDirectory);
		}""",
    """		if (_CachedContentRoot == null)
		{
#if KNI
			string path = KniContentRoot.Resolve();
#else
			string path = ((string)(typeof(TitleContainer).GetProperty("Location", BindingFlags.Static | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Can't get TitleContainer.Location property from MonoGame")).GetValue(null, null)) ?? throw new InvalidOperationException("Can't get value of TitleContainer.Location property from MonoGame");
#endif
			_CachedContentRoot = Path.Combine(path, base.RootDirectory);
		}""",
)

# --- Graphics profile ---------------------------------------------------------
# The game never sets one because ConcernedApe's fork defaults to HiDef. KNI
# follows stock MonoGame and defaults to Reach, which caps textures at 2048 and
# fails on the first tilesheet. HiDef is also what the .xnb files were built for
# (their header flags say so) and what maps onto WebGL2 later.
patch(
    "StardewValley/GameRunner.cs",
    """		Game1.graphics = new GraphicsDeviceManager(this);""",
    """		Game1.graphics = new GraphicsDeviceManager(this);
#if KNI
		Game1.graphics.GraphicsProfile = GraphicsProfile.HiDef;
#endif""",
)

# --- Win32 IME hook on a platform that is neither Windows nor Unix ------------
# The dispatcher routes to window.TextInput on Unix and Win32NT, and otherwise
# installs a Win32 keyboard hook. WASM reports PlatformID.Other, so it took the
# hook path and the runtime refused to marshal HookProc to a native callback.
patch(
    "StardewValley/KeyboardDispatcher.cs",
    """		if (Environment.OSVersion.Platform == PlatformID.Unix || Environment.OSVersion.Platform == PlatformID.Win32NT)
		{""",
    """		if (Environment.OSVersion.Platform == PlatformID.Unix || Environment.OSVersion.Platform == PlatformID.Win32NT || OperatingSystem.IsBrowser())
		{""",
    # Both the constructor and Cleanup test this, and they have to agree.
    expected=2,
)

# --- Display-mode enumeration -------------------------------------------------
# KNI's Blazor adapter throws from SupportedDisplayModes - a canvas has no modes
# to list - while CurrentDisplayMode works. The shim returns just that one on the
# web and delegates everywhere else, so both builds share the call sites.
for _path, _count in [("StardewValley/Options.cs", 2), ("StardewValley/Game1.cs", 3)]:
    patch(_path, ".Adapter.SupportedDisplayModes", ".Adapter.GetSupportedDisplayModes()", expected=_count)

# --- The content manifest is read off disk ------------------------------------
# ContentHashes.json lists every shipped asset, and DoesAssetExist consults it
# before any load is attempted. In a browser File.Exists is always false, so the
# manifest stayed empty and every single asset was reported missing - the load
# never even issued a request. TitleContainer is the one reader that works in
# both places (it is synchronous XHR on the web).
patch(
    "StardewValley/LocalizedContentManager.cs",
    """		_manifest = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		string text = Path.Combine(GetContentRoot(), "ContentHashes.json");""",
    """		_manifest = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
#if KNI
		if (OperatingSystem.IsBrowser())
		{
			string manifestUrl = base.RootDirectory + "/ContentHashes.json";
			try
			{
				using Stream manifestStream = TitleContainer.OpenStream(manifestUrl);
				using StreamReader manifestReader = new StreamReader(manifestStream);
				if (CHJsonParser.ParseJson(manifestReader.ReadToEnd()) is Dictionary<string, object> manifest)
				{
					_manifest.UnionWith(manifest.Keys);
					Game1.log.Verbose($"Loaded ContentHashes.json over HTTP containing {manifest.Count} file(s).");
				}
			}
			catch (Exception manifestException)
			{
				Game1.log.Error("Could not fetch ContentHashes.json over HTTP.", manifestException);
			}
			return;
		}
#endif
		string text = Path.Combine(GetContentRoot(), "ContentHashes.json");""",
)

print("platform patches applied")
