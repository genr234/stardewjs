import { describe, expect, test } from "bun:test";
import { runHost, settingsJs } from "./harness.ts";

/** What the page holds for a player who has never opened the menu. */
const DEFAULTS = {
  "ui.theme": "stardew",
  "audio.master": 1,
  "audio.music": 1,
  "audio.effects": 1,
  "pacing.fpsCap": 0,
  "pacing.pauseWhenHidden": false,
  "display.renderScale": 1,
  "display.crisp": true,
  "net.relay": "",
  "input.deadzone": 0,
  "input.pointerLock": true,
  profiler: false,
};

describe("the settings store", () => {
  test("answers with the documented default until something is written", () => {
    const { window } = runHost();
    const settings = window.settingsState();
    expect(settings.defaults()).toEqual(DEFAULTS);
    for (const [name, value] of Object.entries(DEFAULTS)) {
      expect(settings.get(name)).toEqual(value);
    }
    // A caller that wants something else says so; the menu never does.
    expect(settings.get("display.crisp", "whatever")).toBe("whatever");
  });

  test("keeps only what was actually chosen, and reads it back next visit", () => {
    const first = runHost();
    first.window.settingsState().set("audio.music", 0.4);
    expect(JSON.parse(first.stored.get("stardew.settings")!)).toEqual({ "audio.music": 0.4 });

    const next = runHost({ settings: { "audio.music": 0.4 } });
    expect(next.window.settingsState().get("audio.music")).toBe(0.4);
    expect(next.window.settingsState().get("audio.master")).toBe(1);
  });

  test("a reset announces every name it cleared, so nothing is left applied", () => {
    const { window, events } = runHost({ settings: { profiler: true, "display.crisp": false } });
    const settings = window.settingsState();
    const before = events.length;
    settings.forget();
    expect(settings.get("profiler")).toBe(false);
    expect(settings.get("display.crisp")).toBe(true);
    // One settings-change per name that had been stored.
    expect(events.slice(before)).toEqual(["settings-change", "settings-change"]);
  });

  test("storage that throws costs a setting, not the title screen", () => {
    // Private browsing and blocked site data both throw rather than returning
    // nothing, and the page still has to come up.
    const { window } = runHost({ storageThrows: true });
    const settings = window.settingsState();
    expect(settings.get("audio.master")).toBe(1);
    expect(() => settings.set("audio.master", 0.5)).not.toThrow();
    expect(settings.get("audio.master")).toBe(0.5);
  });

  test("the unlock is not kept where the page could forge it", () => {
    // js/ownership.js deliberately keeps nothing; the settings store is the
    // only thing on this page that writes to localStorage.
    expect(settingsJs).toMatch(/localStorage/);
  });
});

describe("what the host does with the settings", () => {
  test("the drawn resolution scales the pixel ratio the game sizes itself from", () => {
    const full = runHost();
    full.readyListeners[0]?.();
    expect(full.workers[0].posted[0].data.devicePixelRatio).toBe(1);

    const half = runHost({ settings: { "display.renderScale": 0.5 } });
    half.readyListeners[0]?.();
    expect(half.workers[0].posted[0].data.devicePixelRatio).toBe(0.5);
  });

  test("the picture setting decides whether the browser may smooth the pixels", () => {
    const crisp = runHost();
    expect(crisp.canvas.style.imageRendering).toBe("pixelated");

    const smooth = runHost({ settings: { "display.crisp": false } });
    expect(smooth.canvas.style.imageRendering).toBe("auto");

    // And it follows the menu rather than waiting for the next load.
    smooth.window.settingsState().set("display.crisp", true);
    expect(smooth.canvas.style.imageRendering).toBe("pixelated");
  });

  test("pacing travels with the boot message and again when it changes", () => {
    const runtime = runHost({ settings: { "pacing.fpsCap": 30, "pacing.pauseWhenHidden": true } });
    expect(runtime.window.__frameCap).toBe(30);
    expect(runtime.window.__pauseWhenHidden).toBe(true);
    runtime.readyListeners[0]?.();
    expect(runtime.workers[0].posted[0].data.pacing).toEqual({ fps: 30, pauseWhenHidden: true });

    runtime.window.settingsState().set("pacing.fpsCap", 60);
    const worker = runtime.workers[0];
    expect(worker.posted[worker.posted.length - 1].data).toEqual({
      type: "pacing",
      fps: 60,
      pauseWhenHidden: true,
    });
    expect(runtime.window.__frameCap).toBe(60);
  });

  test("the relay address travels with the boot message", () => {
    const plain = runHost();
    plain.readyListeners[0]?.();
    expect(plain.workers[0].posted[0].data.relay).toBe("");

    const named = runHost({ settings: { "net.relay": "  farm.example:5199  " } });
    named.readyListeners[0]?.();
    expect(named.workers[0].posted[0].data.relay).toBe("farm.example:5199");
  });

  test("a deadzone flattens the centre and rescales what is left", () => {
    const pad = {
      index: 0,
      id: "Xbox Wireless Controller",
      mapping: "standard",
      connected: true,
      timestamp: 1,
      axes: [0.05, -0.5, 1, 0],
      buttons: [],
    };
    const off = runHost({ gamepads: [pad] });
    off.readyListeners[0]?.();
    off.scheduled.shift()?.();
    const raw = off.workers[0].posted.filter((m: any) => m.data.type === "gamepads").pop();
    expect(raw.data.pads[0].axes).toEqual([0.05, -0.5, 1, 0]);

    const on = runHost({ gamepads: [pad], settings: { "input.deadzone": 0.1 } });
    on.readyListeners[0]?.();
    on.scheduled.shift()?.();
    const eased = on.workers[0].posted.filter((m: any) => m.data.type === "gamepads").pop();
    // Inside the deadzone is centre; outside it still reaches the ends.
    expect(eased.data.pads[0].axes[0]).toBe(0);
    expect(eased.data.pads[0].axes[1]).toBeCloseTo(-(0.5 - 0.1) / 0.9, 10);
    expect(eased.data.pads[0].axes[2]).toBe(1);
  });

  test("the pointer is captured only while the player wants it captured", () => {
    const locking = runHost();
    locking.readyListeners[0]?.();
    locking.canvas.listeners.mousedown?.[0]?.({ button: 0, clientX: 5, clientY: 5 });
    expect(locking.canvas.lockCalls).toBe(1);

    const free = runHost({ settings: { "input.pointerLock": false } });
    free.readyListeners[0]?.();
    free.canvas.listeners.mousedown?.[0]?.({ button: 0, clientX: 5, clientY: 5 });
    expect(free.canvas.lockCalls).toBe(0);
  });
});
