#if KNI
using System;

namespace Microsoft.Xna.Framework
{

/// <summary>
/// Matches KNI's TitleContainer: inside a macOS .app the executable is in
/// Contents/MacOS but assets are read from Contents/Resources.
/// </summary>
public static class KniContentRoot
{
	public static string Resolve()
	{
		string baseDirectory = AppContext.BaseDirectory.TrimEnd(System.IO.Path.DirectorySeparatorChar);
		if (baseDirectory.EndsWith(System.IO.Path.Combine("Contents", "MacOS"), StringComparison.Ordinal))
		{
			string resources = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(baseDirectory), "Resources");
			if (System.IO.Directory.Exists(resources))
			{
				return resources;
			}
		}
		return baseDirectory;
	}
}

public static class KniWindowShims
{
	/// <summary>KNI can't query the display holding the window, so assume one display.</summary>
	public static int GetDisplayIndex(this GameWindow window) => 0;

	public static Rectangle GetDisplayBounds(this GameWindow window, int displayIndex) => window.ClientBounds;

	/// <summary>False is the fork's own "not moved" signal.</summary>
	public static bool CenterOnDisplay(this GameWindow window, int displayIndex) => false;
}

}

namespace Microsoft.Xna.Framework.Audio
{

public static class KniAudioShims
{
	/// <summary>Only used by Data/AudioChanges cues, which vanilla leaves empty.</summary>
	public static int GetCategoryIndex(this AudioEngine engine, string name) => 0;

	/// <summary>KNI has no reverb block; a scratch array absorbs the game's writes.</summary>
	public static float[] GetReverbSettings(this AudioEngine engine) => ReverbScratch;

	private static readonly float[] ReverbScratch = new float[32];

	public static float GetVolume(this Cue cue) => cue.GetVariable("Volume");

	public static void SetVolume(this Cue cue, float value) => cue.SetVariable("Volume", value);

	public static float GetPitch(this Cue cue) => cue.GetVariable("Pitch");

	public static void SetPitch(this Cue cue, float value) => cue.SetVariable("Pitch", value);

	/// <summary>False leaves the game handling pitch itself.</summary>
	public static bool GetIsPitchBeingControlledByRPC(this Cue cue) => false;
}

}
#endif
