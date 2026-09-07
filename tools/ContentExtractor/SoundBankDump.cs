using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Microsoft.Xna.Framework.Audio;

namespace ContentExtractor;

/// <summary>
/// Dumps cue name -> wave bank entries from the XACT sound bank, since the wave
/// bank has no names. MonoGame parses the bank; this walks the object graph.
/// </summary>
public static class SoundBankDump
{
	private const BindingFlags AllMembers =
		BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

	public static void Run(string xactDirectory, string outputPath)
	{
		// TitleContainer rejects rooted paths, so stage copies in the app directory.
		string staging = Path.Combine(AppContext.BaseDirectory, "xact-staging");
		Directory.CreateDirectory(staging);
		foreach (string name in new[] { "FarmerSounds.xgs", "Sound Bank.xsb" })
		{
			File.Copy(Path.Combine(xactDirectory, name), Path.Combine(staging, name), overwrite: true);
		}
		string settings = Path.Combine("xact-staging", "FarmerSounds.xgs");
		string soundBankPath = Path.Combine("xact-staging", "Sound Bank.xsb");

		var engine = new AudioEngine(settings);
		var soundBank = new SoundBank(engine, soundBankPath);

		string[] bankNames = (string[])Field(soundBank, "_waveBankNames");
		var cues = (IDictionary)Field(soundBank, "_cues");
		var categoryNames = (Dictionary<string, int>)Field(engine, "_categoryLookup");
		string[] categoriesByIndex = new string[categoryNames.Count];
		foreach (KeyValuePair<string, int> category in categoryNames)
		{
			categoriesByIndex[category.Value] = category.Key;
		}

		var mapped = new SortedDictionary<string, object>(StringComparer.Ordinal);
		int withWaves = 0;
		int looping = 0;
		foreach (DictionaryEntry entry in cues)
		{
			var cue = new CueInfo();
			Collect(entry.Value, cue, new HashSet<object>(ReferenceEqualityComparer.Instance), 0);

			if (cue.References.Count > 0)
			{
				withWaves++;
			}
			if (cue.Loop)
			{
				looping++;
			}
			mapped[(string)entry.Key] = new
			{
				Category = cue.Category.HasValue && cue.Category < categoriesByIndex.Length
					? categoriesByIndex[(int)cue.Category.Value]
					: null,
				Loop = cue.Loop,
				Tracks = cue.References
					.Distinct()
					.Select(reference => new
					{
						Bank = reference.Bank >= 0 && reference.Bank < bankNames.Length ? bankNames[reference.Bank] : null,
						BankIndex = reference.Bank,
						Track = reference.Track
					})
					.ToArray()
			};
		}

		var document = new { WaveBanks = bankNames, Cues = mapped };
		Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
		File.WriteAllText(outputPath, JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = true }));

		Console.WriteLine($"wave banks: {string.Join(", ", bankNames)}");
		Console.WriteLine($"{mapped.Count} cues, {withWaves} resolved to wave entries, {looping} looping -> {outputPath}");
	}

	/// <summary>What a single cue turned out to be made of.</summary>
	private sealed class CueInfo
	{
		public readonly List<(int Bank, int Track)> References = new List<(int, int)>();

		public uint? Category;

		public bool Loop;
	}

	/// <summary>
	/// Collects wave references without encoding MonoGame's nesting of simple
	/// and complex sounds.
	/// </summary>
	private static void Collect(object node, CueInfo found, HashSet<object> seen, int depth)
	{
		if (node is null || depth > 12 || node is string || node.GetType().IsPrimitive || !seen.Add(node))
		{
			return;
		}

		// Back-references to the bank and engine would walk every cue.
		if (node is SoundBank || node is AudioEngine || node is SoundEffect)
		{
			return;
		}

		switch (node)
		{
			case PlayWaveVariant variant:
				if (variant.track >= 0)
				{
					found.References.Add((variant.waveBank, variant.track));
				}
				return;

			case XactSoundBankSound sound:
				found.Category ??= sound.categoryID;
				if (!sound.complexSound)
				{
					found.References.Add((sound.waveBankIndex, sound.trackIndex));
				}
				foreach (object clip in sound.soundClips ?? Array.Empty<XactClip>())
				{
					Collect(clip, found, seen, depth + 1);
				}
				return;

			case IEnumerable sequence:
				foreach (object item in sequence)
				{
					Collect(item, found, seen, depth + 1);
				}
				return;
		}

		// Loop count 255 means forever.
		if (node.GetType().Name == "PlayWaveEvent"
			&& node.GetType().GetField("_loopCount", AllMembers)?.GetValue(node) is uint loopCount)
		{
			found.Loop |= loopCount == 255u;
		}

		foreach (FieldInfo field in node.GetType().GetFields(AllMembers))
		{
			if (!field.FieldType.IsPrimitive && field.FieldType != typeof(string))
			{
				Collect(field.GetValue(node), found, seen, depth + 1);
			}
		}
	}

	private static object Field(object instance, string name) =>
		instance.GetType().GetField(name, AllMembers)?.GetValue(instance)
			?? throw new MissingFieldException(instance.GetType().Name, name);
}
