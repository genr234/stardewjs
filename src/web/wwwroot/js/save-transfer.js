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

// A desktop farm folder is <farm>_<id>, holding the world file, SaveGameInfo,
// and an _old copy of each. The player may pick the farm, Saves, or the folder
// above, so files are placed by their own parent and everything else is dropped.
const PC_SAVES = 'PC saves live in %AppData%\\StardewValley\\Saves on Windows, ' +
  '~/.config/StardewValley/Saves on a Mac or Linux.';
const FARM_FOLDER = /^[^/\\]+_\d+$/;

function farmFileName(folder, name) {
  return name === folder || name === folder + '_old' || name === 'SaveGameInfo' || name === 'SaveGameInfo_old';
}

// Both files are XmlSerializer output; checking the root element in the first
// 1 KB tells a save apart without reading a 7 MB world twice.
async function rootElement(file) {
  const head = await file.slice(0, 1024).text();
  const match = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?<([A-Za-z]+)/.exec(head);
  return match ? match[1] : '';
}

async function base64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  // Sliced to stay under String.fromCharCode's argument limit.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/// Returns { folder: { name: File } }. Loose files (no folder in their path)
/// form a farm only if exactly one of them is a world file.
function groupFarms(fileList) {
  const picked = Array.from(fileList || []);
  const farms = {};
  const loose = [];
  for (const file of picked) {
    const parts = String(file.webkitRelativePath || '').split(/[/\\]/).filter(Boolean);
    const name = file.name;
    const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (!folder) {
      loose.push(file);
      continue;
    }
    if (!FARM_FOLDER.test(folder) || !farmFileName(folder, name)) continue;
    (farms[folder] = farms[folder] || {})[name] = file;
  }
  const worlds = loose.filter(function (file) { return FARM_FOLDER.test(file.name); });
  if (worlds.length === 1) {
    const folder = worlds[0].name;
    for (const file of loose) {
      if (farmFileName(folder, file.name)) (farms[folder] = farms[folder] || {})[file.name] = file;
    }
  }
  return farms;
}

function farmLabel(folder) {
  return folder.replace(/_\d+$/, '');
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

  /// Reads farms from a desktop save folder without writing anything.
  async readPc(fileList) {
    const farms = groupFarms(fileList);
    const files = {};
    const folders = [];
    const refused = [];
    for (const folder of Object.keys(farms).sort()) {
      const found = farms[folder];
      if (!found[folder] || !found.SaveGameInfo ||
        await rootElement(found[folder]) !== 'SaveGame' || await rootElement(found.SaveGameInfo) !== 'Farmer') {
        refused.push(folder);
        continue;
      }
      for (const name of Object.keys(found)) files[folder + '/' + name] = await base64(found[name]);
      folders.push(folder);
    }
    if (folders.length === 0) {
      throw new Error(refused.length
        ? 'Could not read the farm in ' + refused.join(', ') + ' - the save is incomplete or damaged.'
        : 'No farm in that folder. ' + PC_SAVES);
    }
    return { files: files, folders: folders };
  },

  async existing(folders) {
    const held = await window.browserSaves.read();
    const present = new Set(Object.keys(held).map(function (path) { return String(path).split(/[/\\]/)[0]; }));
    return folders.filter(function (folder) { return present.has(folder); });
  },

  /// A farm with the same folder is replaced whole, so no stale _old survives.
  async addFarms(imported) {
    const held = await window.browserSaves.read();
    const replacing = new Set(imported.folders);
    const files = {};
    for (const [path, contents] of Object.entries(held)) {
      if (!replacing.has(String(path).split(/[/\\]/)[0])) files[path] = contents;
    }
    Object.assign(files, imported.files);
    await window.browserSaves.write(files);
    return imported.folders.length;
  },

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

  async runPcImport(event) {
    const input = event && event.target;
    const picked = input && input.files ? Array.from(input.files) : [];
    if (input) input.value = '';
    if (picked.length === 0 || current().busy) return;
    patch({ busy: true, error: '', note: '' });
    try {
      const imported = await saveTransfer.readPc(picked);
      const clashes = await saveTransfer.existing(imported.folders);
      if (clashes.length && typeof window.confirm === 'function' &&
        !window.confirm('This browser already has ' + clashes.map(farmLabel).join(', ') +
          '. Replace it with the copy from your PC?')) {
        patch({ note: 'kept the farms already in this browser' });
        return;
      }
      await saveTransfer.addFarms(imported);
      patch({ note: 'added ' + imported.folders.map(farmLabel).join(', ') + ' - ready when you press Play' });
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
