// Cue table and handles, beside the managed runtime. Sound is made by
// js/audio-output.js on the page, because a worker has no AudioContext.
(function (root) {
  // Wave bank folders, indexed by the sound bank's BankIndex.
  const BANK_DIRECTORIES = ['main', '1.4'];

  let cues = new Map();
  let audioRoot = 'Audio';
  let nextHandle = 1;
  const playing = new Map();

  function send(command) {
    if (root.browserAudioOutput) root.browserAudioOutput.apply(command);
    else root.postMessage({ type: 'audio', command: command });
  }

  function trackUrl(track) {
    const directory = BANK_DIRECTORIES[track.BankIndex] || BANK_DIRECTORIES[0];
    return audioRoot + '/' + directory + '/' + String(track.Track).padStart(4, '0') + '.opus';
  }

  root.browserAudio = {
    async init(cuesUrl, root_) {
      audioRoot = root_ || audioRoot;
      const response = await fetch(cuesUrl);
      if (!response.ok) throw new Error('cue map ' + response.status + ' for ' + cuesUrl);
      const document_ = await response.json();
      cues = new Map(Object.entries(document_.Cues || {}));
      return cues.size;
    },

    exists(name) {
      return cues.has(name);
    },

    /// Starts a cue and returns the handle the game holds it by, or 0 when the
    /// cue is unknown or carries no playable track.
    play(name, volume, rate) {
      const cue = cues.get(name);
      if (!cue || !cue.Tracks || cue.Tracks.length === 0) return 0;
      // XACT picks between a cue's variants each time it plays; the variation
      // type is not preserved here, so choose uniformly.
      const track = cue.Tracks[Math.floor(Math.random() * cue.Tracks.length)];
      const handle = nextHandle++;
      playing.set(handle, { name: name, loop: !!cue.Loop });
      send({
        op: 'play',
        handle: handle,
        url: trackUrl(track),
        loop: !!cue.Loop,
        category: cue.Category || 'Sound',
        volume: volume == null ? 1 : volume,
        rate: rate || 1,
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
      send({ op: 'volume', handle: handle, volume: volume });
    },

    setRate(handle, rate) {
      send({ op: 'rate', handle: handle, rate: rate });
    },

    setCategoryVolume(category, volume) {
      send({ op: 'category', category: category, volume: volume });
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
  };
})(globalThis);
