// The title screen will not start a boot until the player has produced a file
// only an owner of the game has: their own `Stardew Valley.dll` (the game
// assembly, named `Stardew Valley.exe` before 1.6).
//
// What happens here is only half of it, and the less important half. This
// script reads the file to give a useful answer quickly - is it an assembly at
// all, is it Stardew, which version - but the decision belongs to the host. The
// page asks for a challenge, hashes the byte ranges the host names, and the
// host compares them against its own copy. Until that passes, `scripts/serve.ts`
// serves nothing under Content, Audio or _framework, so walking past this
// script in devtools gets you a title screen with no game behind it.
//
// The file itself is never uploaded: only a hash of a few kilobytes of it. The
// host's answer is an HttpOnly cookie this script cannot read and does not need
// to - the browser attaches it to the worker's asset requests on its own.
(function (root) {
  const ENDPOINT = 'ownership';
  // The 1.6 assembly is ~6 MB. The bounds only exist so a stray small file
  // fails before it is decoded, and a disk image is not read into memory.
  const MIN_BYTES = 2 * 1024 * 1024;
  const MAX_BYTES = 128 * 1024 * 1024;
  // Every build carries these in its metadata: the assembly name, the type
  // namespace, and the company. A .NET PE file with all three is the game's.
  const MARKERS = ['Stardew Valley', 'StardewValley', 'ConcernedApe'];
  const PE_SIGNATURE = 'PE\u0000\u0000';

  function fail(message) {
    const error = new Error(message);
    error.ownershipCheck = true;
    return error;
  }

  async function post(route, body) {
    const response = await root.fetch(ENDPOINT + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // The gate's whole answer is a cookie, and a worker's asset requests
      // carry it; say so rather than relying on the default.
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
    const hash = await root.crypto.subtle.digest('SHA-256', joined);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function versionOf(text) {
    // AssemblyFileVersion, alongside the 1.0.0.0 the referenced libraries carry.
    const found = text.match(/1\.\d+\.\d+\.\d+/g) || [];
    return found.find((value) => value !== '1.0.0.0') || null;
  }

  /** The quick local read: enough to answer "that is not the game" without a round trip. */
  async function inspect(file) {
    if (!file) throw fail('Choose your Stardew Valley.dll to continue.');
    if (file.size < MIN_BYTES || file.size > MAX_BYTES) {
      throw fail('That file is the wrong size for the game assembly. Pick "Stardew Valley.dll" out of your own installation.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Latin-1 keeps one character per byte, so a marker cannot straddle a
    // decoding boundary and an offset in the text is an offset in the file.
    const text = new TextDecoder('latin1').decode(bytes);
    if (text.slice(0, 2) !== 'MZ' || text.indexOf(PE_SIGNATURE) < 0) {
      throw fail('That is not a .NET assembly. Pick "Stardew Valley.dll" out of your own installation.');
    }
    if (!MARKERS.every((marker) => text.indexOf(marker) >= 0)) {
      throw fail('That assembly is not Stardew Valley. Pick "Stardew Valley.dll" out of the folder Steam or GOG installed the game into.');
    }
    return { version: versionOf(text), name: String(file.name || 'Stardew Valley.dll'), size: file.size };
  }

  /** Hash the windows the host named, out of the player's own file. */
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
    // Nothing is decided until the host has been asked, so the title screen
    // waits rather than flashing a prompt at a player who is already verified.
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
        const response = await root.fetch(ENDPOINT, { credentials: 'same-origin' });
        const payload = await response.json();
        patch({ unlocked: payload.verified === true, ready: true });
      } catch (err) {
        // An unreachable host is not an unlock; the player sees the prompt and
        // the failure surfaces when they try.
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
    // Bound to the file input, which hands back a fresh FileList on each pick.
    submit(event) {
      const input = event && event.target;
      const file = input && input.files && input.files[0];
      const done = this.accept(file);
      // Clearing it lets the same file be picked again after a failure.
      if (input) input.value = '';
      return done;
    },
    async forget() {
      patch({ proof: null, unlocked: false, error: '' });
      await post('/forget').catch(function () {});
    },
  };

  // Alpine's store is a proxy around this object, and only a write through the
  // proxy redraws the page. Alpine may well start up while the first request to
  // the host is still in flight, so every write is aimed after the await rather
  // than at whatever was current when the call began.
  function current() {
    if (root.Alpine) {
      const stored = root.Alpine.store('ownership');
      if (stored) return stored;
    }
    return ownership;
  }

  function patch(values) {
    const state = current();
    for (const key of Object.keys(values)) state[key] = values[key];
    return state;
  }

  root.ownership = ownership;
  root.ownershipState = current;

  root.document.addEventListener('alpine:init', function () {
    root.Alpine.store('ownership', ownership);
  });

  ownership.refresh();
})(window);
