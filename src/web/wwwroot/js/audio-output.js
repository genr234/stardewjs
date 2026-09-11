// Web Audio playback, on the page because a worker has no AudioContext.
// js/audio.js forwards commands here; it's a classic script, so it reaches
// this by the global name rather than an import.
import { settingsState } from './settings.js';

var context = null;
var buffers = new Map();
var voices = new Map();
// The player's menu levels, on top of the game's own sliders.
var master = null;
var music = null;
var effects = null;

function settingsValue(name) {
  var settings = settingsState();
  if (!settings || typeof settings.get !== 'function') return 1;
  var value = Number(settings.get(name));
  return isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function buildBuses() {
  master = context.createGain();
  master.gain.value = settingsValue('audio.master');
  master.connect(context.destination);
  music = context.createGain();
  music.gain.value = settingsValue('audio.music');
  music.connect(master);
  effects = context.createGain();
  effects.gain.value = settingsValue('audio.effects');
  effects.connect(master);
}

function busFor(category) {
  return category === 'Music' ? music : effects;
}

// Autoplay policy: the context can only start after a user gesture.
function ensureContext() {
  if (!context) {
    var Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    buildBuses();
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

function applyFilter(voice, filter) {
  if (!filter || !voice.filter) return;
  if (filter.frequency != null) {
    // Web Audio rejects cutoffs above Nyquist.
    var ceiling = context.sampleRate / 2 - 1;
    voice.filter.frequency.value = Math.max(1, Math.min(ceiling, filter.frequency));
  }
  if (filter.q != null) voice.filter.Q.value = filter.q;
}

// Decoding is async, so a voice may be stopped or restarted before its buffer
// arrives; `generation` discards stale starts.
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
      // Ambient loops are paused the same frame they start, often before decode.
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
      // The game's category volume is already in command.volume (XACT clamps
      // the product); the bus only applies the player's menu level.
      gain.connect(busFor(command.category));
      source.onended = function () {
        if (voices.get(handle) === current) {
          voices.delete(handle);
          if (typeof browserAudioOutput.onEnded === 'function') {
            browserAudioOutput.onEnded(handle);
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
      if (typeof globalThis.console !== 'undefined') console.warn('[audio] ' + err);
    });
}

export const browserAudioOutput = {
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

      // Sources are single-use, so pause tears down and remembers the offset.
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

  unlock: function () {
    ensureContext();
  },

  applyLevels: function () {
    if (!context) return;
    master.gain.value = settingsValue('audio.master');
    music.gain.value = settingsValue('audio.music');
    effects.gain.value = settingsValue('audio.effects');
  },

  stats: function () {
    return {
      voices: voices.size,
      buffers: buffers.size,
      state: context ? context.state : 'none',
      levels: context
        ? { master: master.gain.value, music: music.gain.value, effects: effects.gain.value }
        : null,
    };
  },
};

globalThis.browserAudioOutput = browserAudioOutput;

if (globalThis.addEventListener) {
  globalThis.addEventListener('pointerdown', browserAudioOutput.unlock, { once: false });
  globalThis.addEventListener('keydown', browserAudioOutput.unlock, { once: false });
  globalThis.addEventListener('settings-change', function (event) {
    var name = event && event.detail && event.detail.name;
    if (typeof name === 'string' && name.indexOf('audio.') === 0) {
      browserAudioOutput.applyLevels();
    }
  });
}
