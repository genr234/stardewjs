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

		RpcCurveInfo[] rpcCurves = ReadRpcCurves(engine);

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
				Volume = (cue.SoundVolume ?? 1f) * (cue.ClipVolume ?? 1f),
				Filter = cue.Filter,
				Rpc = cue.RpcCurves?
					.Where(index => index >= 0 && index < rpcCurves.Length)
					.Select(index => rpcCurves[index])
					.Where(curve => curve != null)
					.ToArray(),
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

		var document = new { WaveBanks = bankNames, CueVariables = ReadCueVariableDefaults(engine), Cues = mapped };
		Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
		File.WriteAllText(outputPath, JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = true, IncludeFields = true }));

		Console.WriteLine($"wave banks: {string.Join(", ", bankNames)}");
		Console.WriteLine($"{mapped.Count} cues, {withWaves} resolved to wave entries, {looping} looping -> {outputPath}");
	}

	/// <summary>Not all zero: wind's pitch curve depends on "Pitch"'s default.</summary>
	private static SortedDictionary<string, float> ReadCueVariableDefaults(AudioEngine engine)
	{
		var defaults = new SortedDictionary<string, float>(StringComparer.Ordinal);
		foreach (object variable in (Array)Field(engine, "_cueVariables"))
		{
			defaults[(string)FieldOf(variable, "Name")] = (float)FieldOf(variable, "InitValue");
		}
		return defaults;
	}

	private static RpcCurveInfo[] ReadRpcCurves(AudioEngine engine)
	{
		Array curves = (Array)Field(engine, "RpcCurves");
		var globals = (Array)Field(engine, "_variables");
		var cueScoped = (Array)Field(engine, "_cueVariables");

		string VariableName(Array table, int index)
		{
			if (index < 0 || index >= table.Length)
			{
				return null;
			}
			object variable = table.GetValue(index);
			return (string)variable.GetType().GetField("Name", AllMembers)!.GetValue(variable);
		}

		var result = new RpcCurveInfo[curves.Length];
		for (int i = 0; i < curves.Length; i++)
		{
			object curve = curves.GetValue(i);
			bool isGlobal = (bool)FieldOf(curve, "IsGlobal");
			int variable = (int)FieldOf(curve, "Variable");
			var points = (Array)FieldOf(curve, "Points");
			if (points == null || points.Length == 0)
			{
				continue;
			}

			var mappedPoints = new List<float[]>(points.Length);
			foreach (object point in points)
			{
				mappedPoints.Add(new[]
				{
					(float)FieldOf(point, "Position"),
					(float)FieldOf(point, "Value")
				});
			}

			result[i] = new RpcCurveInfo
			{
				Variable = VariableName(isGlobal ? globals : cueScoped, variable),
				Parameter = FieldOf(curve, "Parameter").ToString(),
				Global = isGlobal,
				Points = mappedPoints.ToArray()
			};
		}
		return result;
	}

	private static object FieldOf(object instance, string name) =>
		instance.GetType().GetField(name, AllMembers | BindingFlags.Static)?.GetValue(instance)
			?? throw new MissingFieldException(instance.GetType().Name, name);

	private sealed class RpcCurveInfo
	{
		public string Variable;

		public string Parameter;

		public bool Global;

		public float[][] Points;
	}

	private sealed class CueInfo
	{
		public readonly List<(int Bank, int Track)> References = new List<(int, int)>();

		public uint? Category;

		public bool Loop;

	/// <summary>Linear amplitude.</summary>
		public float? SoundVolume;

		public float? ClipVolume;

		public FilterInfo Filter;

		public int[] RpcCurves;
	}

	private sealed class FilterInfo
	{
		public string Mode;

		public float Q;

		public int Frequency;
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

		if (node is XactClip xactClip)
		{
			found.ClipVolume ??= xactClip.DefaultVolume;
			if (xactClip.FilterEnabled && found.Filter == null)
			{
				found.Filter = new FilterInfo
				{
					Mode = xactClip.FilterMode.ToString(),
					Q = xactClip.FilterQ,
					Frequency = xactClip.FilterFrequency
				};
			}
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
				found.SoundVolume ??= sound.volume;
				if (found.RpcCurves == null && sound.rpcCurves is { Length: > 0 })
				{
					found.RpcCurves = sound.rpcCurves;
				}
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
