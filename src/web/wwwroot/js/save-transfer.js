// Saves live in this browser and nowhere else: js/save-storage.js keeps them in
// IndexedDB, the runtime unpacks them into its virtual filesystem at boot and
// writes them back when the game saves. Clearing site data takes a farm with
// it, and another browser has never heard of it.
//
// So the settings menu offers a way out and back in. This runs on the page,
// beside the same store the worker uses, and moves the whole snapshot as one
// JSON file: exactly what browserSaves.read() returns, which is what
// browserSaves.write() expects.
//
// Importing replaces everything, and is offered only from the title screen -
// before the runtime has read the saves in - so there is no live game holding
// files that are about to be swapped underneath it.
(function (root) {
  const FORMAT = 'stardew-web-saves';
  const VERSION = 1;

  function stamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes());
  }

  // The count the menu reports, and the check that stops an empty export from
  // looking like a successful backup.
  function countFarms(files) {
    const farms = new Set();
    for (const path of Object.keys(files || {})) {
      const folder = String(path).split(/[/\\]/)[0];
      if (folder) farms.add(folder);
    }
    return farms.size;
  }

  function download(text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = root.document.createElement('a');
    link.href = url;
    link.download = filename;
    root.document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking immediately can beat the download in some browsers; a minute is
    // longer than any click needs and the page is not holding much.
    root.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  root.saveTransfer = {
    /// Writes every save file in this browser to one JSON file on disk.
    async export_() {
      const files = await root.browserSaves.read();
      const farms = countFarms(files);
      if (farms === 0) throw new Error('This browser holds no saves yet.');
      download(
        JSON.stringify({ format: FORMAT, version: VERSION, saved: new Date().toISOString(), files: files }),
        'stardew-web-saves-' + stamp() + '.json',
      );
      return farms;
    },

    /// Reads one back, replacing what is here. The file is parsed and checked
    /// before anything is written, so a wrong file leaves the saves alone.
    async import_(file) {
      if (!file) throw new Error('Choose a save file to load.');
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        throw new Error('That is not a save file this page wrote.');
      }
      if (!payload || payload.format !== FORMAT || !payload.files || typeof payload.files !== 'object') {
        throw new Error('That is not a save file this page wrote.');
      }
      const files = payload.files;
      for (const [path, contents] of Object.entries(files)) {
        // The runtime refuses a path that escapes the saves folder, but it
        // should never get the chance: this is the point the file stops being
        // something a stranger wrote.
        if (typeof contents !== 'string' || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path) || /^([a-zA-Z]:)?[/\\]/.test(path)) {
          throw new Error('That save file contains a path this page will not write: ' + path);
        }
      }
      const farms = countFarms(files);
      if (farms === 0) throw new Error('That save file is empty.');
      await root.browserSaves.write(files);
      return farms;
    },

    /// How many farms are in this browser, for the menu to show.
    async count() {
      const files = await root.browserSaves.read().catch(function () { return {}; });
      return countFarms(files);
    },
  };

  // The menu's half of it: one place for the button state and whatever the last
  // attempt has to say, so the markup stays a description of the panel.
  const saves = {
    busy: false,
    note: '',
    error: '',

    async refresh() {
      const farms = await root.saveTransfer.count();
      patch({ note: farms ? farms + plural(farms) + ' in this browser' : 'no saves in this browser' });
    },

    async runExport() {
      if (current().busy) return;
      patch({ busy: true, error: '', note: '' });
      try {
        const farms = await root.saveTransfer.export_();
        patch({ note: 'wrote ' + farms + plural(farms) + ' to your downloads' });
      } catch (err) {
        patch({ error: String(err.message || err) });
      } finally {
        patch({ busy: false });
      }
    },

    async runImport(event) {
      const input = event && event.target;
      const file = input && input.files && input.files[0];
      // Clearing it lets the same file be chosen again after a failure.
      if (input) input.value = '';
      if (!file || current().busy) return;
      // Everything here belongs to whoever is at the keyboard, but replacing a
      // farm is not undoable and a mis-click should not cost one.
      if (typeof root.confirm === 'function' &&
        !root.confirm('Loading a save file replaces every farm in this browser. Continue?')) {
        return;
      }
      patch({ busy: true, error: '', note: '' });
      try {
        const farms = await root.saveTransfer.import_(file);
        patch({ note: 'loaded ' + farms + plural(farms) + ' - they are ready when you press Play' });
      } catch (err) {
        patch({ error: String(err.message || err) });
      } finally {
        patch({ busy: false });
      }
    },
  };

  function plural(count) {
    return count === 1 ? ' farm' : ' farms';
  }

  // Alpine's store is a proxy around this object and only a write through the
  // proxy redraws the panel, so every write lands after its await rather than
  // on whatever was current when the call began.
  function current() {
    if (root.Alpine) {
      const stored = root.Alpine.store('saves');
      if (stored) return stored;
    }
    return saves;
  }

  function patch(values) {
    const state = current();
    for (const key of Object.keys(values)) state[key] = values[key];
    return state;
  }

  root.savesState = current;

  root.document.addEventListener('alpine:init', function () {
    root.Alpine.store('saves', saves);
  });
})(window);
