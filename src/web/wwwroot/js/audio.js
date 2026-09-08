// Cue table and handles, beside the managed runtime. Sound is made by
// js/audio-output.js on the page, because a worker has no AudioContext.
(function (root) {
  // Wave bank folders, indexed by the sound bank's BankIndex.
  const BANK_DIRECTORIES = ['main', '1.4'];

  const FILTER_TYPES = {
    LowPass: 'lowpass',
    BandPass: 'bandpass',
    HighPass: 'highpass',
    Notch: 'notch',
  };

  let cues = new Map();
  // Not all zero: wind's pitch curve defaults an octave down, as on desktop.
  let variableDefaults = Object.create(null);
  let audioRoot = 'Audio';
  let nextHandle = 1;
  const playing = new Map();
  const categoryVolumes = Object.create(null);

  function send(command) {
    if (root.browserAudioOutput) root.browserAudioOutput.apply(command);
    else root.postMessage({ type: 'audio', command: command });
  }

  function trackUrl(track) {
    const directory = BANK_DIRECTORIES[track.BankIndex] || BANK_DIRECTORIES[0];
    return audioRoot + '/' + directory + '/' + String(track.Track).padStart(4, '0') + '.opus';
  }

  // Linear between points, as MonoGame does regardless of XACT's point types.
  function evaluateCurve(points, position) {
    if (!points || points.length === 0) return 0;
    if (position <= points[0][0]) return points[0][1];
    const last = points[points.length - 1];
    if (position >= last[0]) return last[1];
    for (let i = 1; i < points.length; i++) {
      const to = points[i];
      if (to[0] >= position) {
        const from = points[i - 1];
        const span = to[0] - from[0];
        const t = span > 0 ? (position - from[0]) / span : 0;
        return from[1] + (to[1] - from[1]) * t;
      }
    }
    return last[1];
  }

  function decibelsToAmplitude(decibels) {
    return Math.pow(10, decibels / 20);
  }

  function categoryVolume(cue) {
    const name = cue.Category || 'Sound';
    return name in categoryVolumes ? categoryVolumes[name] : 1;
  }

  function mix(cue, variables, gameVolume, gamePitch) {
    let volume = (cue.Volume == null ? 1 : cue.Volume) * gameVolume * categoryVolume(cue);
    let pitch = gamePitch;
    let frequency = cue.Filter ? cue.Filter.Frequency : null;
    let q = cue.Filter ? cue.Filter.Q : null;

    for (const curve of cue.Rpc || []) {
      const value = evaluateCurve(curve.Points, variables[curve.Variable] || 0);
      switch (curve.Parameter) {
        case 'Volume':
          volume *= decibelsToAmplitude(value / 100);
          break;
        case 'Pitch':
          pitch += value / 1200;
          break;
        case 'FilterFrequency':
          frequency = value;
          break;
        case 'FilterQFactor':
          q = value;
          break;
        // ReverbSend is not modelled; the browser build has no reverb bus.
      }
    }

    return {
      // XACT clamps the product; a GainNode above 1 would clip where OpenAL holds.
      volume: Math.max(0, Math.min(1, volume)),
      rate: Math.pow(2, Math.max(-1, Math.min(1, pitch))),
      filter: cue.Filter
        ? { type: FILTER_TYPES[cue.Filter.Mode] || 'lowpass', frequency: frequency, q: q }
        : null,
    };
  }

  function pushParameters(handle) {
    const voice = playing.get(handle);
    if (!voice) return;
    const mixed = mix(voice.cue, voice.variables, voice.volume, voice.pitch);
    send({ op: 'params', handle: handle, volume: mixed.volume, rate: mixed.rate, filter: mixed.filter });
  }

  root.browserAudio = {
    async init(cuesUrl, root_) {
      audioRoot = root_ || audioRoot;
      const response = await fetch(cuesUrl);
      if (!response.ok) throw new Error('cue map ' + response.status + ' for ' + cuesUrl);
      const document_ = await response.json();
      cues = new Map(Object.entries(document_.Cues || {}));
      variableDefaults = Object.assign(Object.create(null), document_.CueVariables || null);
      return cues.size;
    },

    exists(name) {
      return cues.has(name);
    },

    // Returns 0 for an unknown or trackless cue.
    play(name, volume, pitch, variables) {
      const cue = cues.get(name);
      if (!cue || !cue.Tracks || cue.Tracks.length === 0) return 0;
      // Variant weights aren't preserved, so pick uniformly.
      const track = cue.Tracks[Math.floor(Math.random() * cue.Tracks.length)];
      const handle = nextHandle++;
      const state = {
        name: name,
        cue: cue,
        loop: !!cue.Loop,
        volume: volume == null ? 1 : volume,
        pitch: pitch || 0,
        variables: Object.assign(Object.create(null), variableDefaults, variables || null),
      };
      playing.set(handle, state);
      const mixed = mix(cue, state.variables, state.volume, state.pitch);
      send({
        op: 'play',
        handle: handle,
        url: trackUrl(track),
        loop: !!cue.Loop,
        category: cue.Category || 'Sound',
        volume: mixed.volume,
        rate: mixed.rate,
        filter: mixed.filter,
      });
      return handle;
    },

    stop(handle) {
      playing.delete(handle);
      send({ op: 'stop', handle: handle });
    },

    pause(handle) {
      const voice = playing.get(handle);
      if (voice) voice.paused = true;
      send({ op: 'pause', handle: handle });
    },

    resume(handle) {
      const voice = playing.get(handle);
      if (voice) voice.paused = false;
      send({ op: 'resume', handle: handle });
    },

    setVolume(handle, volume) {
      const voice = playing.get(handle);
      if (!voice) return;
      voice.volume = volume;
      pushParameters(handle);
    },

    setPitch(handle, pitch) {
      const voice = playing.get(handle);
      if (!voice) return;
      voice.pitch = pitch;
      pushParameters(handle);
    },

    setVariable(handle, name, value) {
      const voice = playing.get(handle);
      if (!voice) return;
      voice.variables[name] = value;
      pushParameters(handle);
    },

    pitchControlledByRpc(name) {
      const cue = cues.get(name);
      return !!cue && (cue.Rpc || []).some((curve) => curve.Parameter === 'Pitch');
    },

    // Applied per voice rather than on a bus, because XACT clamps the product.
    setCategoryVolume(category, volume) {
      categoryVolumes[category] = volume;
      for (const [handle, voice] of playing) {
        if ((voice.cue.Category || 'Sound') === category) pushParameters(handle);
      }
    },

    stopAll() {
      playing.clear();
      send({ op: 'stopAll' });
    },

    // Tracked here because interop is synchronous and asked every frame.
    // Paused is not stopped: the game re-plays anything it finds stopped.
    state(handle) {
      const voice = playing.get(handle);
      if (!voice) return 'stopped';
      return voice.paused ? 'paused' : 'playing';
    },

    noteEnded(handle) {
      playing.delete(handle);
    },

    // Test seams.
    stats() {
      return { cues: cues.size, playing: playing.size };
    },

    mixOf(name, variables, volume, pitch) {
      const cue = cues.get(name);
      if (!cue) return null;
      const values = Object.assign(Object.create(null), variableDefaults, variables || null);
      return mix(cue, values, volume == null ? 1 : volume, pitch || 0);
    },
  };
})(globalThis);
