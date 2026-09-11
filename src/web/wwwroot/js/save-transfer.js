// Export, import and PC import of saves for the settings menu. The whole
// IndexedDB snapshot moves as one JSON file (browserSaves.read()/write()).
// browserSaves is a classic script shared with the worker, so it's read off
// window. Import replaces everything and is only offered before boot.
const FORMAT = 'stardew-web-saves';
const VERSION = 1;

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '-' + pad(now.getHours()) + pad(now.getMinutes());
}

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
  const link = window.document.createElement('a');
  link.href = url;
  link.download = filename;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}

export const saveTransfer = {
  async export_() {
    const files = await window.browserSaves.read();
    const farms = countFarms(files);
    if (farms === 0) throw new Error('This browser holds no saves yet.');
    download(
      JSON.stringify({ format: FORMAT, version: VERSION, saved: new Date().toISOString(), files: files }),
      'stardew-web-saves-' + stamp() + '.json',
    );
    return farms;
  },

  /// Validates everything before writing, so a wrong file leaves saves alone.
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
      if (typeof contents !== 'string' || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path) || /^([a-zA-Z]:)?[/\\]/.test(path)) {
        throw new Error('That save file contains a path this page will not write: ' + path);
      }
    }
    const farms = countFarms(files);
    if (farms === 0) throw new Error('That save file is empty.');
    await window.browserSaves.write(files);
    return farms;
  },

  /// How many farms are in this browser, for the menu to show.
  async count() {
    const files = await window.browserSaves.read().catch(function () { return {}; });
    return countFarms(files);
  },
};

const saves = {
  busy: false,
  note: '',
  error: '',

  async refresh() {
    const farms = await saveTransfer.count();
    patch({ note: farms ? farms + plural(farms) + ' in this browser' : 'no saves in this browser' });
  },

  async runExport() {
    if (current().busy) return;
    patch({ busy: true, error: '', note: '' });
    try {
      const farms = await saveTransfer.export_();
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
    if (input) input.value = '';
    if (!file || current().busy) return;
    if (typeof window.confirm === 'function' &&
      !window.confirm('Loading a save file replaces every farm in this browser. Continue?')) {
      return;
    }
    patch({ busy: true, error: '', note: '' });
    try {
      const farms = await saveTransfer.import_(file);
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

// Writes resolve the Alpine store after each await; only writes through its proxy redraw.
function current() {
  if (window.Alpine) {
    const stored = window.Alpine.store('saves');
    if (stored) return stored;
  }
  return saves;
}

function patch(values) {
  const state = current();
  for (const key of Object.keys(values)) state[key] = values[key];
  return state;
}

export { current as savesState };
window.saveTransfer = saveTransfer;
window.savesState = current;

window.document.addEventListener('alpine:init', function () {
  window.Alpine.store('saves', saves);
});
