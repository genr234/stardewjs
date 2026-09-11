// Asks the player for their own `Stardew Valley.dll` (`.exe` before 1.6) before
// booting. The local checks here are only for quick feedback; the real gate is
// scripts/serve.ts, which issues a challenge over byte ranges of the file and
// withholds Content, Audio and _framework until it passes. Only a hash is sent.
const ENDPOINT = 'ownership';
// Bounds reject stray small files and avoid reading a disk image into memory.
const MIN_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;
const MARKERS = ['Stardew Valley', 'StardewValley', 'ConcernedApe'];
const PE_SIGNATURE = 'PE\u0000\u0000';

function fail(message) {
  const error = new Error(message);
  error.ownershipCheck = true;
  return error;
}

async function post(route, body) {
  const response = await window.fetch(ENDPOINT + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    // The gate's answer is a cookie the worker's asset requests must carry.
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(function () {
    return {};
  });
  return { ok: response.ok, status: response.status, payload: payload };
}

async function digestOf(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  const hash = await window.crypto.subtle.digest('SHA-256', joined);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

function versionOf(text) {
  const found = text.match(/1\.\d+\.\d+\.\d+/g) || [];
  return found.find((value) => value !== '1.0.0.0') || null;
}

async function inspect(file) {
  if (!file) throw fail('Choose your Stardew Valley.dll to continue.');
  if (file.size < MIN_BYTES || file.size > MAX_BYTES) {
    throw fail('That file is the wrong size for the game assembly. Pick "Stardew Valley.dll" out of your own installation.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Latin-1 keeps text offsets equal to byte offsets.
  const text = new TextDecoder('latin1').decode(bytes);
  if (text.slice(0, 2) !== 'MZ' || text.indexOf(PE_SIGNATURE) < 0) {
    throw fail('That is not a .NET assembly. Pick "Stardew Valley.dll" out of your own installation.');
  }
  if (!MARKERS.every((marker) => text.indexOf(marker) >= 0)) {
    throw fail('That assembly is not Stardew Valley. Pick "Stardew Valley.dll" out of the folder Steam or GOG installed the game into.');
  }
  return { version: versionOf(text), name: String(file.name || 'Stardew Valley.dll'), size: file.size };
}

async function answerFor(file, challenge) {
  const parts = [new TextEncoder().encode(challenge.id)];
  for (const range of challenge.ranges) {
    const start = range[0];
    const end = start + range[1];
    parts.push(new Uint8Array(await file.slice(start, end).arrayBuffer()));
  }
  return digestOf(parts);
}

async function prove(file, local) {
  const challenge = await post('/challenge');
  if (!challenge.ok || !challenge.payload.ranges) {
    throw fail(challenge.payload.error || 'This host cannot check copies of the game right now.');
  }
  if (file.size !== challenge.payload.size) {
    throw fail('That is a different build of the game than the one this host streams (' +
      challenge.payload.size + ' bytes). Both halves have to be the same version.');
  }
  const answered = await post('/answer', { id: challenge.payload.id, digest: await answerFor(file, challenge.payload) });
  if (!answered.ok || !answered.payload.verified) {
    throw fail(answered.payload.error || 'The host did not accept that copy of the game.');
  }
  return local;
}

const ownership = {
  // Stay undecided until the host answers, so verified players see no prompt flash.
  ready: false,
  unlocked: false,
  checking: false,
  error: '',
  proof: null,
  get detail() {
    if (!this.proof) return 'verified with this host';
    return this.proof.version
      ? 'verified Stardew Valley ' + this.proof.version
      : 'verified your copy of Stardew Valley';
  },
  async refresh() {
    try {
      const response = await window.fetch(ENDPOINT, { credentials: 'same-origin' });
      const payload = await response.json();
      patch({ unlocked: payload.verified === true, ready: true });
    } catch (err) {
      patch({ unlocked: false, ready: true });
    }
    return current().unlocked;
  },
  async accept(file) {
    if (current().checking) return null;
    patch({ checking: true, error: '' });
    try {
      const record = await prove(file, await inspect(file));
      patch({ proof: record, unlocked: true, checking: false, ready: true });
      return record;
    } catch (err) {
      patch({
        error: err && err.ownershipCheck
          ? err.message
          : 'Could not check that file: ' + String((err && err.message) || err),
        unlocked: false,
        checking: false,
        ready: true,
      });
      return null;
    }
  },
  submit(event) {
    const input = event && event.target;
    const file = input && input.files && input.files[0];
    const done = this.accept(file);
    // Lets the same file be picked again after a failure.
    if (input) input.value = '';
    return done;
  },
  async forget() {
    patch({ proof: null, unlocked: false, error: '' });
    await post('/forget').catch(function () {});
  },
};

// Alpine may start while a request is in flight, so writes resolve the store
// after the await; only writes through its proxy redraw.
function current() {
  if (window.Alpine) {
    const stored = window.Alpine.store('ownership');
    if (stored) return stored;
  }
  return ownership;
}

function patch(values) {
  const state = current();
  for (const key of Object.keys(values)) state[key] = values[key];
  return state;
}

// The window copies are for Alpine expressions and the tests.
export { current as ownershipState };
window.ownership = ownership;
window.ownershipState = current;

window.document.addEventListener('alpine:init', function () {
  window.Alpine.store('ownership', ownership);
});

ownership.refresh();
