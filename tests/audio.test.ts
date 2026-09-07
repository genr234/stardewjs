import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

const cueSource = await Bun.file(new URL('../src/web/wwwroot/js/audio.js', import.meta.url)).text();
const outputSource = await Bun.file(new URL('../src/web/wwwroot/js/audio-output.js', import.meta.url)).text();

const CUES = {
  Cues: {
    coin: { Category: 'Sound', Loop: false, Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 5 }] },
    wind: { Category: 'Ambient', Loop: true, Tracks: [{ Bank: 'Wave Bank', BankIndex: 0, Track: 85 }] },
    junimoMeep1: { Category: 'Sound', Loop: false, Tracks: [{ Bank: 'Wave Bank(1.4)', BankIndex: 1, Track: 3 }] },
    silent: { Category: 'Sound', Loop: false, Tracks: [] },
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
    expect(await audio.init('Audio/cues.json', 'Audio')).toBe(4);

    audio.play('wind', 0.5, 1);
    expect(posted).toEqual([
      {
        type: 'audio',
        command: { op: 'play', handle: 1, url: 'Audio/main/0085.opus', loop: true, category: 'Ambient', volume: 0.5, rate: 1 },
      },
    ]);
  });

  test('numbers tracks per wave bank folder', async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    audio.play('junimoMeep1', 1, 1);
    expect(posted[0].command.url).toBe('Audio/1.4/0003.opus');
  });

  test('an unknown or trackless cue plays nothing and returns no handle', async () => {
    const { audio, posted } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    expect(audio.play('nosuchcue', 1, 1)).toBe(0);
    expect(audio.play('silent', 1, 1)).toBe(0);
    expect(posted).toEqual([]);
    expect(audio.exists('coin')).toBe(true);
    expect(audio.exists('nosuchcue')).toBe(false);
  });

  test('a one-shot plays until the page reports it ended', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');
    const shot = audio.play('coin', 1, 1);
    expect(audio.state(shot)).toBe('playing');
    audio.noteEnded(shot);
    expect(audio.state(shot)).toBe('stopped');
  });

  test('a paused loop reports paused, not stopped, until it is stopped', async () => {
    const { audio } = worker();
    await audio.init('Audio/cues.json', 'Audio');

    const loop = audio.play('wind', 1, 1);
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
    expect(audio.play('coin', 1, 1)).not.toBe(audio.play('coin', 1, 1));
    expect(audio.stats()).toEqual({ cues: 4, playing: 2 });
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
    context.browserAudio.play('coin', 1, 1);
    expect(applied[0].url).toBe('Audio/main/0005.opus');
  });
});

/** A minimal Web Audio stand-in that records what was built and connected. */
function page(decode: { fail?: boolean } = {}) {
  const started: any[] = [];
  const gains: any[] = [];
  let resolveDecode: ((buffer: any) => void) | null = null;
  const audioContext: any = {
    state: 'suspended',
    currentTime: 10,
    destination: { id: 'destination' },
    resume() {
      audioContext.state = 'running';
    },
    createGain() {
      const gain = { gain: { value: 1 }, connectedTo: null as any, connect(to: any) { gain.connectedTo = to; }, disconnect() {} };
      gains.push(gain);
      return gain;
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
  const context: any = {
    AudioContext: function () { return audioContext; },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    console: { warn() {} },
    addEventListener() {},
  };
  runInNewContext(outputSource, context);
  return {
    output: context.browserAudioOutput,
    audioContext,
    started,
    gains,
    finishDecode: (duration = 2) => resolveDecode?.({ duration }),
  };
}

/** Lets the fetch/decode promise chain inside the output run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PLAY = { op: 'play', handle: 7, url: 'Audio/main/0005.opus', loop: false, category: 'Sound', volume: 0.5, rate: 1.5 };

describe('web audio output', () => {
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

  test('category volume applies to sounds started later', async () => {
    const { output, started, finishDecode } = page();
    output.apply({ op: 'category', category: 'Sound', volume: 0.25 });
    output.apply(PLAY);
    await flush();
    finishDecode();
    await flush();
    // cue gain -> category gain -> destination
    const categoryGain = started[0].source.connectedTo.connectedTo;
    expect(categoryGain.gain.value).toBe(0.25);
    expect(categoryGain.connectedTo).toEqual({ id: 'destination' });
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
