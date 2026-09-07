// Available in both the game worker and the main-thread fallback.
(function (root) {
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = root.indexedDB.open('stardew-web-saves', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Save storage is blocked by another tab.'));
    });
    return database;
  }
  root.browserSaves = {
    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly');
        const request = tx.objectStore('snapshots').get('files');
        tx.oncomplete = () => resolve(request.result || {});
        tx.onabort = () => reject(tx.error || new Error('Could not read browser saves.'));
        tx.onerror = () => reject(tx.error);
      });
    },
    async write(files) {
      const db = await open();
      return new Promise((resolve, reject) => {
        // One atomic put, so a failed write leaves the previous save intact.
        const tx = db.transaction('snapshots', 'readwrite', { durability: 'strict' });
        tx.objectStore('snapshots').put(files, 'files');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('Could not persist browser saves.'));
        tx.onerror = () => reject(tx.error);
      });
    }
  };
})(globalThis);
