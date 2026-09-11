import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

import { bundle } from './harness.ts';

const cueSource = await Bun.file(new URL('../src/web/wwwroot/js/audio.js', import.meta.url)).text();
const outputSource = await bundle('js/audio-output.js');

const CUES = {
  Cues: {
    coin: { Category: 'Sound', Loop: false, Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 5 }] },
    wind: { Category: 'Ambient', Loop: true, Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 85 }] },
    junimoMeep1: { Category: 'Sound', Loop: false, Tracks: [{ Bank: 'Wave Bank(1.4)', BankIndex: 1, Track: 3 }] },
    silent: { Category: 'Sound', Loop: false, Tracks: [] },
    // A sound the bank mixes down; the level is baked into the cue table.
    quiet: { Category: 'Sound', Loop: false, Volume: 0.25, Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 9 }] },
    // Shaped like the real rain (filtered by "Frequency") and waterfall (gated by "Volume").
    rain: {
      Category: 'Ambient',
      Loop: true,
      Volume: 1,
      Filter: { Mode: 'LowPass', Q: 2.42, Frequency: 20000 },
      Rpc: [{ Variable: 'Frequency', Parameter: 'FilterFrequency', Global: false, Points: [[0, 20], [100, 20000]] }],
      Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 116 }],
    },
    waterfall: {
      Category: 'Ambient',
      Loop: true,
      Volume: 1,
      Rpc: [{
        Variable: 'Volume',
        Parameter: 'Volume',
        Global: false,
        Points: [[0, -9600], [1.724138, -2541.1765], [3.940887, -1447.0588], [96.79803, 141.17647], [100, 600]],
      }],
      Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 20 }],
    },
    dwoop: {
      Category: 'Sound',
      Loop: false,
      Volume: 1,
      Rpc: [{ Variable: 'Pitch', Parameter: 'Pitch', Global: false, Points: [[0, 0], [100, 1200]] }],
      Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 30 }],
    },
  },
};

/** The cue half as the worker sees it: no AudioContext, commands posted to the page. */
function worker() {
  const posted: any[] = [];
  const context: any = {
    postMessage: (message: any) => posted.push(message),
    fetch: async () => ({ ok: true, json: async () => CUES }),
  };
  runInNewContext(cueSource, context);
  return { audio: context.browserAudio, posted };
}

describe('cue table', () => {
  test('resolves a cue to its extracted track, category and loop flag', async () => {
    const { audio, posted } = worker();
    expect(await audio.init('Audio/cues.json', 'Audio')).toBe(8);

    audio.play('wind', 0.5, 0);
    expect(posted).toEqual([
      {
        type: 'audio',
        command: { op: 'play', handle: 1, url: 'Audio/main/0085.opus', loop: true, category: 'Ambient', volume: 0.5, rate: 1, filter: null },
      },
    ]);
  });

  test('numbers tracks per wave bank folder', async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    audio.play('junimoMeep1', 1, 0);
    expect(posted[0].command.url).toBe('Audio/1.4/0003.opus');
  });

  test('an unknown or trackless cue plays nothing and returns no handle', async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    expect(audio.play('nosuchcue', 1, 0)).toBe(0);
    expect(audio.play('silent', 1, 0)).toBe(0);
    expect(posted).toEqual([]);
    expect(audio.exists('coin')).toBe(true);
    expect(audio.exists('nosuchcue')).toBe(false);
  });

  test('a one-shot plays until the page reports it ended', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    const shot = audio.play('coin', 1, 0);
    expect(audio.state(shot)).toBe('playing');
    audio.noteEnded(shot);
    expect(audio.state(shot)).toBe('stopped');
  });

  test('a paused loop reports paused, not stopped, until it is stopped', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');

    const loop = audio.play('wind', 1, 0);
    expect(audio.state(loop)).toBe('playing');
    audio.pause(loop);
    expect(audio.state(loop)).toBe('paused');
    audio.resume(loop);
    expect(audio.state(loop)).toBe('playing');
    audio.stop(loop);
    expect(audio.state(loop)).toBe('stopped');
  });

  test('an unknown handle is stopped rather than playing', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    expect(audio.state(0)).toBe('stopped');
    expect(audio.state(99)).toBe('stopped');
  });

  test('handles are distinct so the same cue can overlap itself', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    expect(audio.play('coin', 1, 0)).not.toBe(audio.play('coin', 1, 0));
    expect(audio.stats()).toEqual({ cues: 8, playing: 2 });
  });

  test('on the main thread it drives the output directly instead of posting', async () => {
    const applied: any[] = [];
    const context: any = {
      browserAudioOutput: { apply: (command: any) => applied.push(command) },
      postMessage: () => { throw new Error('should not post to itself'); },
      fetch: async () => ({ ok: true, json: async () => CUES }),
    };
    runInNewContext(cueSource, context);
    await context.browserAudio.init('Audio/cues.json', 'Audio');
    context.browserAudio.play('coin', 1, 0);
    expect(applied[0].url).toBe('Audio/main/0005.opus');
  });
});

describe('xact mixing', () => {
  test("a sound's baked mix level scales the volume the game asks for", async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    audio.play('quiet', 0.5, 0);
    expect(posted[0].command.volume).toBeCloseTo(0.125, 5);
  });

  test('an ambient loop is silenced by its Volume curve, not by stopping', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');

    // -96 dB at the bottom of the curve, +6 dB at the top.
    expect(audio.mixOf('waterfall', { Volume: 0 }).volume).toBeCloseTo(0.0000158, 6);
    // +6 dB is above full scale, and XACT leaves the platform to hold it there.
    expect(audio.mixOf('waterfall', { Volume: 100 }).volume).toBe(1);
    expect(audio.mixOf('waterfall', { Volume: 50 }).volume).toBeCloseTo(0.4681, 3);
    expect(audio.mixOf('waterfall', { Volume: 2 }).volume).toBeCloseTo(0.0627, 3);
  });

  test('rain is muffled indoors by winding its filter cutoff down', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');

    const outdoors = audio.mixOf('rain', { Frequency: 100 });
    const indoors = audio.mixOf('rain', { Frequency: 15 });
    expect(outdoors.filter).toEqual({ type: 'lowpass', frequency: 20000, q: 2.42 });
    expect(indoors.filter.frequency).toBeCloseTo(3017, 0);
    // The muffling is the filter; the rain does not get quieter.
    expect(indoors.volume).toBeCloseTo(outdoors.volume, 6);
  });

  test('a cue with no curve for a variable ignores it', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    // MineShaft sets "Frequency" on bugLevelLoop, which has no filter at all.
    expect(audio.mixOf('coin', { Frequency: 0 })).toEqual(audio.mixOf('coin', { Frequency: 100 }));
  });

  test('moving a variable mid-play repushes the mix', async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    const handle = audio.play('rain', 1, 0, { Frequency: 100 });
    audio.setVariable(handle, 'Frequency', 15);

    const params = posted[1].command;
    expect(params.op).toBe('params');
    expect(params.handle).toBe(handle);
    expect(params.filter.frequency).toBeCloseTo(3017, 0);
  });

  test('a category slider scales every cue in that category, live', async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    const ambient = audio.play('rain', 1, 0, { Frequency: 100 });
    audio.play('coin', 1, 0);

    audio.setCategoryVolume('Ambient', 0.25);
    const params = posted.filter((message: any) => message.command.op === 'params');
    expect(params).toHaveLength(1);
    expect(params[0].command.handle).toBe(ambient);
    expect(params[0].command.volume).toBeCloseTo(0.25, 5);

    audio.play('rain', 1, 0, { Frequency: 100 });
    expect(posted[posted.length - 1].command.volume).toBeCloseTo(0.25, 5);
  });

  test('the mix is clamped rather than amplified past full scale', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    // darkCaveLoop reaches 3.96 in the real bank; a GainNode would clip there.
    expect(audio.mixOf('quiet', {}, 100).volume).toBe(1);
    audio.setCategoryVolume('Sound', 0.5);
    expect(audio.mixOf('quiet', {}, 1).volume).toBeCloseTo(0.125, 5);
  });

  test('cue variables start at the values the bank declares', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    expect(audio.mixOf('waterfall').volume).toBeCloseTo(audio.mixOf('waterfall', { Volume: 0 }).volume, 9);
  });

  test('a pitch curve reports that it owns the pitch', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    expect(audio.pitchControlledByRpc('dwoop')).toBe(true);
    expect(audio.pitchControlledByRpc('coin')).toBe(false);
    // Curve pitch is in cents and adds to whatever the game set.
    expect(audio.mixOf('dwoop', { Pitch: 100 }, 1, 0).rate).toBeCloseTo(2, 5);
  });
});

/** A minimal Web Audio stand-in that records what was built and connected. */
function page(options: { fail?: boolean; settings?: Record<string, number> } = {}) {
  const decode = options;
  const started: any[] = [];
  const gains: any[] = [];
  const filters: any[] = [];
  let resolveDecode: ((buffer: any) => void) | null = null;
  const audioContext: any = {
    state: 'suspended',
    currentTime: 10,
    sampleRate: 48000,
    destination: { id: 'destination' },
    resume() {
      audioContext.state = 'running';
    },
    createGain() {
      const gain = { gain: { value: 1 }, connectedTo: null as any, connect(to: any) { gain.connectedTo = to; }, disconnect() {} };
      gains.push(gain);
      return gain;
    },
    createBiquadFilter() {
      const filter = {
        type: '',
        frequency: { value: 0 },
        Q: { value: 0 },
        connectedTo: null as any,
        connect(to: any) { filter.connectedTo = to; },
        disconnect() {},
      };
      filters.push(filter);
      return filter;
    },
    createBufferSource() {
      const source: any = {
        buffer: null,
        loop: false,
        playbackRate: { value: 1 },
        onended: null,
        connectedTo: null,
        stopped: false,
        connect(to: any) { source.connectedTo = to; },
        disconnect() {},
        start(when: number, offset: number) { started.push({ source, offset }); },
        stop() { source.stopped = true; },
      };
      return source;
    },
    decodeAudioData(_bytes: any) {
      return new Promise((resolve, reject) => {
        if (decode.fail) reject(new Error('bad opus'));
        else resolveDecode = resolve;
      });
    },
  };
  const stored = JSON.stringify(options.settings || {});
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const context: any = {
    AudioContext: function () { return audioContext; },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    console: { warn() {} },
    localStorage: { getItem: () => stored, setItem() {}, removeItem() {} },
    document: { addEventListener() {} },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    addEventListener(type: string, fn: (event: any) => void) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent(event: { type: string }) {
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    },
  };
  context.window = context;
  runInNewContext(outputSource, context);
  return {
    output: context.browserAudioOutput,
    context,
    audioContext,
    started,
    gains,
    filters,
    finishDecode: (duration = 2) => resolveDecode?.({ duration }),
  };
}

/** Lets the fetch/decode promise chain inside the output run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PLAY = { op: 'play', handle: 7, url: 'Audio/main/0005.opus', loop: false, category: 'Sound', volume: 0.5, rate: 1.5 };

describe('web audio output', () => {
  test('a filtered cue is played through a biquad, and retuned in place', async () => {
    const { output, started, filters, finishDecode } = page();
    output.apply({
      ...PLAY,
      filter: { type: 'lowpass', frequency: 20000, q: 2.42 },
    });
    await flush();
    finishDecode();
    await flush();

    expect(filters).toHaveLength(1);
    expect(filters[0].type).toBe('lowpass');
    expect(filters[0].frequency.value).toBe(20000);
    expect(filters[0].Q.value).toBe(2.42);
    // source -> filter -> gain, rather than straight to the gain.
    expect(started[0].source.connectedTo).toBe(filters[0]);
    expect(filters[0].connectedTo.gain.value).toBe(0.5);

    output.apply({ op: 'params', handle: 7, volume: 0.5, rate: 1.5, filter: { type: 'lowpass', frequency: 3017, q: 1.2 } });
    expect(filters[0].frequency.value).toBe(3017);
    expect(filters[0].Q.value).toBe(1.2);
    // Retuning must not rebuild the voice - the loop would restart.
    expect(started).toHaveLength(1);
  });

  test('a cutoff above Nyquist is clamped rather than rejected', async () => {
    const { output, filters, finishDecode, audioContext } = page();
    audioContext.sampleRate = 32000;
    output.apply({ ...PLAY, filter: { type: 'lowpass', frequency: 20000, q: 1 } });
    await flush();
    finishDecode();
    await flush();
    expect(filters[0].frequency.value).toBe(15999);
  });

  test('plays a decoded cue through its category, and reports the end', async () => {
    const { output, started, audioContext, finishDecode } = page();
    let ended: number | null = null;
    output.onEnded = (handle: number) => { ended = handle; };

    output.apply(PLAY);
    expect(audioContext.state).toBe('running');
    await flush();
    finishDecode();
    await flush();

    expect(started).toHaveLength(1);
    const source = started[0].source;
    expect(source.playbackRate.value).toBe(1.5);
    expect(source.loop).toBe(false);
    expect(source.connectedTo.gain.value).toBe(0.5);
    expect(output.stats().voices).toBe(1);

    source.onended();
    expect(ended).toBe(7);
    expect(output.stats().voices).toBe(0);
  });

  test('a cue stopped while still decoding never starts', async () => {
    const { output, started, finishDecode } = page();
    output.apply(PLAY);
    await flush();
    output.apply({ op: 'stop', handle: 7 });
    finishDecode();
    await flush();
    expect(started).toEqual([]);
    expect(output.stats().voices).toBe(0);
  });

  test("a voice hangs off the menu's buses, which only ever attenuate", async () => {
    const { output, started, finishDecode } = page();
    output.apply(PLAY);
    await flush();
    finishDecode();
    await flush();
    // cue gain -> effects -> master -> destination.
    const effects = started[0].source.connectedTo.connectedTo;
    const master = effects.connectedTo;
    expect(master.connectedTo).toEqual({ id: 'destination' });
    expect(output.stats().levels).toEqual({ master: 1, music: 1, effects: 1 });
  });

  test('music and effects are carried on separate buses', async () => {
    const { output, started, finishDecode } = page();
    output.apply({ ...PLAY, category: 'Music' });
    await flush();
    finishDecode();
    await flush();
    const music = started[0].source.connectedTo.connectedTo;
    const master = music.connectedTo;
    expect(master.connectedTo).toEqual({ id: 'destination' });
    expect(music).not.toBe(master);
  });

  test('the levels come from the settings store, and follow it', async () => {
    const { output, context } = page({
      settings: { 'audio.master': 0.5, 'audio.music': 0.25, 'audio.effects': 0 },
    });
    output.unlock();
    expect(output.stats().levels).toEqual({ master: 0.5, music: 0.25, effects: 0 });
    context.settingsState().set('audio.master', 0.75);
    expect(output.stats().levels.master).toBe(0.75);
  });

  test('pausing remembers the offset and resuming starts from it', async () => {
    const { output, started, audioContext, finishDecode } = page();
    output.apply(PLAY);
    await flush();
    finishDecode(2);
    await flush();

    audioContext.currentTime = 10.75;
    output.apply({ op: 'pause', handle: 7 });
    expect(started[0].source.stopped).toBe(true);

    output.apply({ op: 'resume', handle: 7 });
    await flush();
    finishDecode(2);
    await flush();
    expect(started).toHaveLength(2);
    expect(started[1].offset).toBeCloseTo(0.75, 5);
  });

  test('a cue paused while still decoding does not start, and resumes later', async () => {
    const { output, started, finishDecode } = page();
    output.apply(PLAY);
    output.apply({ op: 'pause', handle: 7 });
    await flush();
    finishDecode();
    await flush();
    expect(started).toEqual([]);

    output.apply({ op: 'resume', handle: 7 });
    await flush();
    finishDecode();
    await flush();
    expect(started).toHaveLength(1);
    expect(started[0].offset).toBe(0);
  });

  test('a file that fails to decode drops the voice instead of throwing', async () => {
    const { output } = page({ fail: true });
    output.apply(PLAY);
    await flush();
    expect(output.stats().voices).toBe(0);
  });
});
