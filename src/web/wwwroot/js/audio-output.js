// Web Audio playback for the game's cues. AudioContext does not exist in a
// worker, so the runtime cannot own this: js/audio.js runs beside the managed
// code and forwards commands here, where the page can actually make sound.
// In the main-thread fallback both halves share this global directly.
(function (root) {
  var context = null;
  var buffers = new Map();
  var voices = new Map();

  // A cue asked for before the first gesture would be dropped by the browser's
  // autoplay policy, so hold the context until one arrives and let the queued
  // commands start it.
  function ensureContext() {
    if (!context) {
      var Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    if (context.state === 'suspended') context.resume();
    return context;
  }

  function load(url) {
    var pending = buffers.get(url);
    if (!pending) {
      pending = fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error('audio ' + response.status + ' for ' + url);
          return response.arrayBuffer();
        })
        .then(function (bytes) {
          return context.decodeAudioData(bytes);
        });
      buffers.set(url, pending);
    }
    return pending;
  }

  function disconnect(voice) {
    try {
      voice.source.stop();
    } catch (err) {}
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
    if (voice.filter) voice.filter.disconnect();
  }

  // A cue's XACT filter, rebuilt each time the voice starts. The cutoff and Q
  // are whatever the RPC curves last evaluated to - this is what muffles indoor
  // rain rather than merely quieting it.
  function applyFilter(voice, filter) {
    if (!filter || !voice.filter) return;
    if (filter.frequency != null) {
      // Web Audio rejects a cutoff above Nyquist, which XACT's 20 kHz ceiling
      // can exceed on a 32 kHz context.
      var ceiling = context.sampleRate / 2 - 1;
      voice.filter.frequency.value = Math.max(1, Math.min(ceiling, filter.frequency));
    }
    if (filter.q != null) voice.filter.Q.value = filter.q;
  }

  // Playback starts a decode behind the game's back, so a cue can be stopped
  // before its buffer arrives. `generation` marks that: a start whose voice has
  // moved on is discarded rather than played late.
  function start(command, offset) {
    var handle = command.handle;
    var voice = voices.get(handle);
    var generation = voice ? voice.generation + 1 : 0;
    var placeholder = {
      generation: generation,
      command: command,
      offset: offset || 0,
      startedAt: 0,
      source: null,
      gain: null,
      filter: null,
    };
    if (voice && voice.source) disconnect(voice);
    voices.set(handle, placeholder);

    load(command.url)
      .then(function (buffer) {
        var current = voices.get(handle);
        if (!current || current.generation !== generation) return;
        // The game pauses a cue in the same frame it starts one - the ambient
        // loops are played once and then held paused - which can easily land
        // before the file has decoded. Honour it instead of starting anyway.
        if (current.paused) return;
        var source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = !!command.loop;
        source.playbackRate.value = command.rate || 1;
        var gain = context.createGain();
        gain.gain.value = command.volume == null ? 1 : command.volume;
        if (command.filter) {
          current.filter = context.createBiquadFilter();
          current.filter.type = command.filter.type;
          applyFilter(current, command.filter);
          source.connect(current.filter);
          current.filter.connect(gain);
        } else {
          source.connect(gain);
        }
        // The category slider is already folded into command.volume, so there is
        // no bus here: XACT clamps the product, and a bus would clamp only the
        // half of it that came before.
        gain.connect(context.destination);
        source.onended = function () {
          if (voices.get(handle) === current) {
            voices.delete(handle);
            if (typeof root.browserAudioOutput.onEnded === 'function') {
              root.browserAudioOutput.onEnded(handle);
            }
          }
        };
        current.source = source;
        current.gain = gain;
        current.duration = buffer.duration;
        current.startedAt = context.currentTime - current.offset;
        source.start(0, current.offset);
      })
      .catch(function (err) {
        voices.delete(handle);
        if (typeof root.console !== 'undefined') console.warn('[audio] ' + err);
      });
  }

  root.browserAudioOutput = {
    /// Called with each ended handle so the runtime can retire its cue.
    onEnded: null,

    apply: function (command) {
      if (!ensureContext()) return;
      var voice;
      switch (command.op) {
        case 'play':
          start(command, 0);
          break;

        case 'stop':
          voice = voices.get(command.handle);
          if (voice) {
            voices.delete(command.handle);
            if (voice.source) disconnect(voice);
          }
          break;

        // Web Audio sources are single-use, so pausing means tearing the source
        // down and remembering how far in it had played.
        case 'pause':
          voice = voices.get(command.handle);
          if (voice) {
            if (voice.source) {
              var elapsed = context.currentTime - voice.startedAt;
              voice.offset = voice.duration ? elapsed % voice.duration : elapsed;
              disconnect(voice);
              voice.source = null;
            }
            voice.paused = true;
          }
          break;

        case 'resume':
          voice = voices.get(command.handle);
          if (voice && voice.paused) {
            voice.paused = false;
            start(voice.command, voice.offset);
          }
          break;

        // Volume, rate and filter move together: they are all outputs of the same
        // mix, recomputed whenever the game changes a cue variable.
        case 'params':
          voice = voices.get(command.handle);
          if (voice) {
            voice.command.volume = command.volume;
            voice.command.rate = command.rate;
            voice.command.filter = command.filter;
            if (voice.gain) voice.gain.gain.value = command.volume;
            if (voice.source) voice.source.playbackRate.value = command.rate;
            applyFilter(voice, command.filter);
          }
          break;

        case 'stopAll':
          voices.forEach(function (entry) {
            if (entry.source) disconnect(entry);
          });
          voices.clear();
          break;
      }
    },

    /// Resumes the context from a user gesture, which browsers require before
    /// any sound plays. Safe to call repeatedly.
    unlock: function () {
      ensureContext();
    },

    /// Test seam: the live voice count, and the decoded buffer cache size.
    stats: function () {
      return { voices: voices.size, buffers: buffers.size, state: context ? context.state : 'none' };
    },
  };

  if (root.addEventListener) {
    root.addEventListener('pointerdown', root.browserAudioOutput.unlock, { once: false });
    root.addEventListener('keydown', root.browserAudioOutput.unlock, { once: false });
  }
})(globalThis);
