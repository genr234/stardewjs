import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { runInNewContext } from "node:vm";

import { bundle } from "./harness.ts";

// js/save-storage.js is a classic script, shared with the game worker through
// importScripts; js/save-transfer.js is a module, so it is bundled to be run.
const storageSource = await Bun.file(new URL("../src/web/wwwroot/js/save-storage.js", import.meta.url)).text();
const transferSource = await bundle("js/save-transfer.js");

/** The page's half of the saves panel, with the download and the confirm faked. */
function page(options: { indexedDB?: IDBFactory; confirm?: boolean } = {}) {
  const downloads: Array<{ name: string; text: string }> = [];
  const link: any = {
    href: "",
    download: "",
    click() {
      downloads.push({ name: link.download, text: link.blobText });
    },
    remove() {},
  };
  const context: any = {
    indexedDB: options.indexedDB ?? new IDBFactory(),
    Blob: class {
      text: string;
      constructor(parts: string[]) {
        this.text = parts.join("");
      }
    },
    URL: {
      createObjectURL(blob: any) {
        link.blobText = blob.text;
        return "blob:saves";
      },
      revokeObjectURL() {},
    },
    setTimeout() {},
    confirm: () => options.confirm !== false,
    document: {
      createElement: () => link,
      body: { appendChild() {} },
      addEventListener() {},
    },
    Promise,
    Error,
    Object,
    JSON,
    Date,
    Set,
    Number,
    String,
    RegExp,
    console,
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  runInNewContext(storageSource, context);
  runInNewContext(transferSource, context);
  return { transfer: context.saveTransfer, saves: context.savesState(), storage: context.browserSaves, downloads };
}

const FILES = {
  "browser_123/browser_123": "ZmFybQ==",
  "browser_123/SaveGameInfo": "ZmFybWVy",
};

describe("moving saves in and out of the browser", () => {
  test("an export writes exactly what the store holds", async () => {
    const { transfer, storage, downloads } = page();
    await storage.write(FILES);

    expect(await transfer.export_()).toBe(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^stardew-web-saves-\d{8}-\d{4}\.json$/);
    const payload = JSON.parse(downloads[0].text);
    expect(payload.format).toBe("stardew-web-saves");
    expect(payload.files).toEqual(FILES);
  });

  test("an empty browser refuses to write a file that would look like a backup", async () => {
    const { transfer, downloads } = page();
    await expect(transfer.export_()).rejects.toThrow(/no saves/i);
    expect(downloads).toEqual([]);
  });

  test("an import round-trips a file the export wrote", async () => {
    const source = page();
    await source.storage.write(FILES);
    await source.transfer.export_();

    const target = page();
    expect(await target.transfer.import_(file(source.downloads[0].text))).toBe(1);
    expect(await target.storage.read()).toEqual(FILES);
  });

  test("a file from somewhere else leaves the saves alone", async () => {
    const { transfer, storage } = page();
    await storage.write(FILES);

    for (const bad of ["not json at all", JSON.stringify({ format: "something-else", files: {} })]) {
      await expect(transfer.import_(file(bad))).rejects.toThrow(/not a save file/i);
    }
    await expect(transfer.import_(file(JSON.stringify({ format: "stardew-web-saves", files: {} }))))
      .rejects.toThrow(/empty/i);
    expect(await storage.read()).toEqual(FILES);
  });

  test("a path that would escape the saves folder is refused before anything is written", async () => {
    const { transfer, storage } = page();
    await storage.write(FILES);
    for (const path of ["../../etc/passwd", "/etc/passwd", "farm/../../escape"]) {
      const payload = JSON.stringify({ format: "stardew-web-saves", files: { [path]: "ZmFybQ==" } });
      await expect(transfer.import_(file(payload))).rejects.toThrow(/will not write/i);
    }
    expect(await storage.read()).toEqual(FILES);
  });

  test("the panel reports what happened, and a refused confirm writes nothing", async () => {
    const { saves, storage, transfer, downloads } = page({ confirm: false });
    await storage.write(FILES);
    await saves.refresh();
    expect(saves.note).toBe("1 farm in this browser");

    await saves.runExport();
    expect(saves.note).toBe("wrote 1 farm to your downloads");
    expect(saves.error).toBe("");
    expect(saves.busy).toBe(false);

    // Replacing a farm is not undoable, so a refused confirm stops there.
    const other = page();
    await other.storage.write({ "other_9/other_9": "b3RoZXI=" });
    await saves.runImport({ target: { files: [file(downloads[0].text)], value: "x" } });
    expect(await storage.read()).toEqual(FILES);

    // And a failure is reported rather than thrown at the page.
    const failing = page();
    await failing.saves.runImport({ target: { files: [file("junk")], value: "" } });
    expect(failing.saves.error).toMatch(/not a save file/i);
    expect(failing.saves.busy).toBe(false);
  });
});

/** Enough of a File for the transfer: it only ever reads text(). */
function file(text: string) {
  return { text: async () => text };
}
