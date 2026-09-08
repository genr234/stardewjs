using System;
using System.Collections.Generic;
using Microsoft.JSInterop;
using Microsoft.Xna.Framework.Audio;
using StardewValley.Audio;

namespace StardewValley.Web;

/// <summary>
/// Web Audio in place of XACT, which KNI's Blazor backend can't decode (ADPCM).
/// Forwards to js/audio.js, which plays wave bank entries extracted to Opus.
/// </summary>
public static class BrowserAudio
{
	private static IJSInProcessRuntime _js;

	public static void Initialize(IJSInProcessRuntime js, int cueCount)
	{
		_js = js;
		Console.WriteLine("[audio] " + cueCount + " cues available through Web Audio.");
	}

	internal static TResult Invoke<TResult>(string identifier, params object[] args)
	{
		return _js.Invoke<TResult>(identifier, args);
	}

	internal static void InvokeVoid(string identifier, params object[] args)
	{
		_js.InvokeVoid(identifier, args);
	}
}

public class BrowserAudioEngine : IAudioEngine
{
	private readonly Dictionary<string, IAudioCategory> _categories = new Dictionary<string, IAudioCategory>();

	public AudioEngine Engine => null;

	/// <inheritdoc />
	public bool IsDisposed { get; private set; }

	/// <inheritdoc />
	public void Update()
	{
	}

	/// <inheritdoc />
	public IAudioCategory GetCategory(string name)
	{
		if (!_categories.TryGetValue(name, out IAudioCategory category))
		{
			category = new BrowserAudioCategory(name);
			_categories[name] = category;
		}
		return category;
	}

	/// <inheritdoc />
	public int GetCategoryIndex(string name)
	{
		return -1;
	}

	public void Dispose()
	{
		IsDisposed = true;
	}
}

public class BrowserAudioCategory : IAudioCategory
{
	private readonly string _name;

	public BrowserAudioCategory(string name)
	{
		_name = name;
	}

	/// <inheritdoc />
	public void SetVolume(float volume)
	{
		BrowserAudio.InvokeVoid("browserAudio.setCategoryVolume", _name, volume);
	}
}

public class BrowserSoundBank : ISoundBank
{
	/// <summary>Only Data/AudioChanges adds cues, and it ships empty, so these stay silent.</summary>
	private readonly Dictionary<string, CueDefinition> _added = new Dictionary<string, CueDefinition>();

	/// <inheritdoc />
	public bool IsInUse => false;

	/// <inheritdoc />
	public bool IsDisposed { get; private set; }

	/// <inheritdoc />
	public bool Exists(string name)
	{
		return _added.ContainsKey(name) || BrowserAudio.Invoke<bool>("browserAudio.exists", name);
	}

	/// <inheritdoc />
	public ICue GetCue(string name)
	{
		return new BrowserCue(name);
	}

	/// <inheritdoc />
	public void PlayCue(string name)
	{
		new BrowserCue(name).Play();
	}

	/// <inheritdoc />
	public void PlayCue(string name, AudioListener listener, AudioEmitter emitter)
	{
		// 3D panning is not modelled; the game already scaled the volume.
		PlayCue(name);
	}

	/// <inheritdoc />
	public void AddCue(CueDefinition definition)
	{
		_added[definition.name] = definition;
	}

	/// <inheritdoc />
	public CueDefinition GetCueDefinition(string name)
	{
		return _added.TryGetValue(name, out CueDefinition definition) ? definition : null;
	}

	public void Dispose()
	{
		IsDisposed = true;
		BrowserAudio.InvokeVoid("browserAudio.stopAll");
	}
}

public class BrowserCue : ICue
{
	/// <summary>0 when not playing.</summary>
	private int _handle;

	private float _volume = 1f;

	private float _pitch;

	private bool _stopped;

	/// <summary>
	/// The game reads these back and RPC curves evaluate against them; ambient
	/// loops are silenced via "Volume" and rain is muffled via "Frequency".
	/// </summary>
	private readonly Dictionary<string, float> _variables = new Dictionary<string, float>();

	public BrowserCue(string name)
	{
		Name = name;
	}

	/// <inheritdoc />
	public string Name { get; }

	private string State => _handle == 0 ? "stopped" : BrowserAudio.Invoke<string>("browserAudio.state", _handle);

	/// <inheritdoc />
	public bool IsPlaying => State == "playing";

	/// <inheritdoc />
	public bool IsPaused => State == "paused";

	/// <summary>
	/// Paused must not count as stopped: MineShaft replays bugLevelLoop whenever
	/// it reports stopped, which would stack a new loop every frame.
	/// </summary>
	public bool IsStopped => _stopped || State == "stopped";

	/// <inheritdoc />
	public bool IsStopping => false;

	public bool IsPitchBeingControlledByRPC =>
		BrowserAudio.Invoke<bool>("browserAudio.pitchControlledByRpc", Name);

	/// <inheritdoc />
	public float Volume
	{
		get => _volume;
		set
		{
			_volume = value;
			PushVolume();
		}
	}

	/// <summary>-1 to 1, an octave either way.</summary>
	public float Pitch
	{
		get => _pitch;
		set
		{
			_pitch = value;
			if (_handle != 0)
			{
				BrowserAudio.InvokeVoid("browserAudio.setPitch", _handle, _pitch);
			}
		}
	}

	/// <inheritdoc />
	public void Play()
	{
		if (_handle != 0)
		{
			Stop(AudioStopOptions.Immediate);
		}
		_stopped = false;
		_handle = BrowserAudio.Invoke<int>("browserAudio.play", Name, _volume, _pitch, _variables);
	}

	/// <inheritdoc />
	public void Pause()
	{
		if (_handle != 0)
		{
			BrowserAudio.InvokeVoid("browserAudio.pause", _handle);
		}
	}

	/// <inheritdoc />
	public void Resume()
	{
		if (_handle != 0)
		{
			BrowserAudio.InvokeVoid("browserAudio.resume", _handle);
		}
	}

	/// <inheritdoc />
	public void Stop(AudioStopOptions options)
	{
		_stopped = true;
		if (_handle != 0)
		{
			BrowserAudio.InvokeVoid("browserAudio.stop", _handle);
			_handle = 0;
		}
	}

	/// <inheritdoc />
	public void SetVariable(string var, int val)
	{
		SetVariable(var, (float)val);
	}

	/// <inheritdoc />
	public void SetVariable(string var, float val)
	{
		_variables[var] = val;
		if (_handle != 0)
		{
			BrowserAudio.InvokeVoid("browserAudio.setVariable", _handle, var, val);
		}
	}

	private void PushVolume()
	{
		if (_handle != 0)
		{
			BrowserAudio.InvokeVoid("browserAudio.setVolume", _handle, _volume);
		}
	}

	/// <summary>Unset variables read as 0, matching the bank's starting values.</summary>
	public float GetVariable(string var)
	{
		return _variables.TryGetValue(var, out float value) ? value : 0f;
	}

	public void Dispose()
	{
		Stop(AudioStopOptions.Immediate);
	}
}
