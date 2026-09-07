import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { runInNewContext } from 'node:vm';

const source = await Bun.file(new URL('../src/web/wwwroot/js/save-storage.js', import.meta.url)).text();
function page(indexedDB: IDBFactory) {
  const context: any = { indexedDB };
  runInNewContext(source, context);
  return context.browserSaves;
}

describe('browser save persistence', () => {
  test('restores both save files in a fresh page and persists deletion', async () => {
    const db = new IDBFactory();
    const first = page(db);
    expect(await first.read()).toEqual({});
    const files = { 'browser_123/browser_123': 'ZmFybQ==', 'browser_123/SaveGameInfo': 'ZmFybWVy' };
    await first.write(files);
    const reloaded = page(db);
    expect(await reloaded.read()).toEqual(files);
    await reloaded.write({});
    expect(await page(db).read()).toEqual({});
  });

  test('an aborted save rejects and preserves the previous complete pair', async () => {
    const db = new IDBFactory();
    const saves = page(db);
    const old = { 'farm/farm': 'b2xk', 'farm/SaveGameInfo': 'b2xk' };
    await saves.write(old);
    const connection: any = await new Promise((resolve) => {
      const request = db.open('stardew-web-saves', 1);
      request.onsuccess = () => resolve(request.result);
    });
    const prototype = Object.getPrototypeOf(connection);
    const original = prototype.transaction;
    prototype.transaction = function (...args: any[]) {
      const tx = original.apply(this, args);
      if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
      return tx;
    };
    try {
      await expect(saves.write({ 'farm/farm': 'bmV3' })).rejects.toThrow();
    } finally {
      prototype.transaction = original;
      connection.close();
    }
    expect(await page(db).read()).toEqual(old);
  });
});
