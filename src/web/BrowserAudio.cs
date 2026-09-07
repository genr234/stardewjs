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

	/// <summary>XACT cue variables the game sets, kept because it reads them back.</summary>
	private readonly Dictionary<string, float> _variables = new Dictionary<string, float>();

	/// <summary>
	/// The "Volume" cue variable, 0-100, defaulting to full.
	///
	/// In XACT this drives an RPC curve on the sound's volume, and the game leans
	/// on it heavily: ambient loops like crickets, rain and waterfalls are started
	/// once and left running, then made audible or silent through this variable
	/// rather than being stopped. It also folds in the ambient volume option, so a
	/// cue that ignores it plays at full volume even with that slider at zero.
	/// The curve itself is not modelled - this scales amplitude linearly.
	/// </summary>
	private float _volumeVariable = 100f;

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

	/// <summary>No RPC curves are modelled, so the game's pitch always applies.</summary>
	public bool IsPitchBeingControlledByRPC => false;

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
				BrowserAudio.InvokeVoid("browserAudio.setRate", _handle, PlaybackRate);
			}
		}
	}

	private float PlaybackRate => (float)Math.Pow(2.0, _pitch);

	private float EffectiveVolume => _volume * Math.Clamp(_volumeVariable / 100f, 0f, 1f);

	/// <inheritdoc />
	public void Play()
	{
		if (_handle != 0)
		{
			Stop(AudioStopOptions.Immediate);
		}
		_stopped = false;
		_handle = BrowserAudio.Invoke<int>("browserAudio.play", Name, EffectiveVolume, PlaybackRate);
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
		if (var == "Volume")
		{
			_volumeVariable = val;
			PushVolume();
		}
	}

	private void PushVolume()
	{
		if (_handle != 0)
		{
			BrowserAudio.InvokeVoid("browserAudio.setVolume", _handle, EffectiveVolume);
		}
	}

	/// <inheritdoc />
	public float GetVariable(string var)
	{
		return _variables.TryGetValue(var, out float value) ? value : 0f;
	}

	public void Dispose()
	{
		Stop(AudioStopOptions.Immediate);
	}
}
