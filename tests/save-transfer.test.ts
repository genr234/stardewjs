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
    Array,
    Uint8Array,
    btoa,
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

describe("bringing a farm over from the desktop game", () => {
  const WORLD = '\uFEFF<?xml version="1.0" encoding="utf-8"?><SaveGame xmlns:xsi="x"><player/></SaveGame>';
  const FARMER = '\uFEFF<?xml version="1.0" encoding="utf-8"?><Farmer xmlns:xsi="x"><name>Ricky</name></Farmer>';

  /** A pick of the whole Saves folder, as the folder picker hands it over. */
  function savesFolder(farm = "Pine_371154313") {
    return [
      pcFile(`Saves/${farm}/${farm}`, WORLD),
      pcFile(`Saves/${farm}/${farm}_old`, WORLD),
      pcFile(`Saves/${farm}/SaveGameInfo`, FARMER),
      pcFile(`Saves/${farm}/SaveGameInfo_old`, FARMER),
      pcFile(`Saves/${farm}/.DS_Store`, "junk"),
      pcFile("Saves/steam_autocloud.vdf", "junk"),
    ];
  }

  test("a picked Saves folder becomes the same files the browser build writes", async () => {
    const { transfer, storage } = page();
    const imported = await transfer.readPc(savesFolder());
    expect(imported.folders).toEqual(["Pine_371154313"]);
    expect(Object.keys(imported.files).sort()).toEqual([
      "Pine_371154313/Pine_371154313",
      "Pine_371154313/Pine_371154313_old",
      "Pine_371154313/SaveGameInfo",
      "Pine_371154313/SaveGameInfo_old",
    ]);
    expect(Buffer.from(imported.files["Pine_371154313/SaveGameInfo"], "base64").toString()).toBe(FARMER);

    await storage.write(FILES);
    expect(await transfer.addFarms(imported)).toBe(1);
    const held = await storage.read();
    expect(held["browser_123/browser_123"]).toBe(FILES["browser_123/browser_123"]);
    expect(held["Pine_371154313/Pine_371154313"]).toBe(imported.files["Pine_371154313/Pine_371154313"]);
  });

  test("the farm folder itself, or its files picked loose, work too", async () => {
    const { transfer } = page();
    const inFolder = await transfer.readPc([
      pcFile("Pine_1/Pine_1", WORLD),
      pcFile("Pine_1/SaveGameInfo", FARMER),
    ]);
    expect(inFolder.folders).toEqual(["Pine_1"]);
    const loose = await transfer.readPc([pcFile("", WORLD, "Pine_1"), pcFile("", FARMER, "SaveGameInfo")]);
    expect(loose.files).toEqual(inFolder.files);
  });

  test("a farm of the same name is replaced whole, and only after asking", async () => {
    const declined = page({ confirm: false });
    await declined.storage.write({ "Pine_1/Pine_1": "b2xk", "Pine_1/Pine_1_old": "b2xkZXI=" });
    await declined.saves.runPcImport({ target: { files: [pcFile("Pine_1/Pine_1", WORLD), pcFile("Pine_1/SaveGameInfo", FARMER)] } });
    expect(await declined.storage.read()).toEqual({ "Pine_1/Pine_1": "b2xk", "Pine_1/Pine_1_old": "b2xkZXI=" });
    expect(declined.saves.note).toMatch(/kept/);

    const accepted = page();
    await accepted.storage.write({ "Pine_1/Pine_1": "b2xk", "Pine_1/Pine_1_old": "b2xkZXI=" });
    await accepted.saves.runPcImport({ target: { files: [pcFile("Pine_1/Pine_1", WORLD), pcFile("Pine_1/SaveGameInfo", FARMER)] } });
    expect(Object.keys(await accepted.storage.read()).sort()).toEqual(["Pine_1/Pine_1", "Pine_1/SaveGameInfo"]);
    expect(accepted.saves.note).toBe("added Pine - ready when you press Play");
  });

  test("a folder with no farm, or a damaged one, says so and writes nothing", async () => {
    const { transfer, saves, storage } = page();
    await storage.write(FILES);
    await expect(transfer.readPc([pcFile("Documents/notes.txt", "hi")])).rejects.toThrow(/AppData/);
    await expect(transfer.readPc([pcFile("Pine_1/Pine_1", "not xml"), pcFile("Pine_1/SaveGameInfo", FARMER)]))
      .rejects.toThrow(/Pine_1.*damaged/);
    // Half a farm is no farm: the load menu needs SaveGameInfo to list it.
    await expect(transfer.readPc([pcFile("Pine_1/Pine_1", WORLD)])).rejects.toThrow(/Pine_1.*incomplete/);

    await saves.runPcImport({ target: { files: [pcFile("Documents/notes.txt", "hi")] } });
    expect(saves.error).toMatch(/No farm/);
    expect(saves.busy).toBe(false);
    expect(await storage.read()).toEqual(FILES);
  });
});

/** A File from a folder pick: webkitRelativePath is empty for a loose pick. */
function pcFile(relativePath: string, text: string, name = relativePath.split("/").pop()!) {
  const bytes = new TextEncoder().encode(text);
  const blob = (from: Uint8Array) => ({
    text: async () => new TextDecoder().decode(from),
    arrayBuffer: async () => from.slice().buffer,
  });
  return {
    name,
    webkitRelativePath: relativePath,
    ...blob(bytes),
    slice: (start: number, end: number) => blob(bytes.subarray(start, end)),
  };
}

/** Enough of a File for the transfer: it only ever reads text(). */
function file(text: string) {
  return { text: async () => text };
}
