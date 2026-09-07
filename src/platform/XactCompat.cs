#if KNI
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;

namespace Microsoft.Xna.Framework.Audio;

/// <summary>
/// XACT extensions from ConcernedApe's MonoGame fork that KNI lacks, used by
/// Data/AudioChanges. Vanilla leaves that asset empty, so only Exists is hot.
/// </summary>
public class CueDefinition
{
	public string name;

	public SoundEffect[] sounds = Array.Empty<SoundEffect>();

	public int categoryID;

	public bool loop;

	public bool useReverb;

	public Action OnModified;

	public void SetSound(SoundEffect[] soundEffects, int categoryId, bool loop = false, bool useReverb = false)
	{
		sounds = soundEffects ?? Array.Empty<SoundEffect>();
		categoryID = categoryId;
		this.loop = loop;
		this.useReverb = useReverb;
	}
}

public static class XactCompat
{
	/// <summary>KNI's private cue table.</summary>
	private static readonly FieldInfo SoundsField =
		typeof(SoundBank).GetField("_sounds", BindingFlags.NonPublic | BindingFlags.Instance);

	private static readonly Dictionary<SoundBank, Dictionary<string, CueDefinition>> Added = new();

	public static bool CueTableAvailable => SoundsField != null;

	public static bool Exists(SoundBank soundBank, string name)
	{
		if (name == null)
		{
			return false;
		}
		if (Added.TryGetValue(soundBank, out var added) && added.ContainsKey(name))
		{
			return true;
		}
		if (SoundsField?.GetValue(soundBank) is IDictionary cues)
		{
			return cues.Contains(name);
		}

		// Answering "no" makes the game fall back and mutes everything.
		return true;
	}

	/// <summary>Kept alongside KNI's table; playback of added cues is not wired up.</summary>
	public static void AddCue(SoundBank soundBank, CueDefinition definition)
	{
		if (definition?.name == null)
		{
			return;
		}
		if (!Added.TryGetValue(soundBank, out var added))
		{
			Added[soundBank] = added = new Dictionary<string, CueDefinition>(StringComparer.Ordinal);
		}
		added[definition.name] = definition;
	}

	public static CueDefinition GetCueDefinition(SoundBank soundBank, string name)
	{
		if (Added.TryGetValue(soundBank, out var added) && added.TryGetValue(name, out var definition))
		{
			return definition;
		}
		return new CueDefinition { name = name };
	}
}
#endif
