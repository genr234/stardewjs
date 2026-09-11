import { describe, expect, test } from "bun:test";
import { runHost, runWorker, RUNTIME_SCRIPTS, waitUntil } from "./harness.ts";

describe("worker host", () => {
  test("the UI thread starts a worker and transfers the canvas", () => {
    const runtime = runHost();
    expect(runtime.appended).toHaveLength(0);
    expect(runtime.readyListeners).toHaveLength(1);
    runtime.readyListeners[0]?.();
    expect(runtime.appended).toHaveLength(0);
    expect(runtime.workers).toHaveLength(1);
    expect(runtime.workers[0].url).toMatch(/^js\/game\.worker\.js\?v=\d+$/);
    expect(runtime.canvas.transferred).toBe(true);
    expect(runtime.workers[0].posted).toHaveLength(1);
    expect(runtime.workers[0].posted[0].data.type).toBe("boot");
    expect(runtime.workers[0].posted[0].data.canvas.transferred).toBe(true);
    expect(runtime.workers[0].posted[0].transfer).toHaveLength(1);
    expect(runtime.workers[0].posted[0].data.baseURI).toBe("http://localhost/");
    expect(runtime.workers[0].posted[0].data.profiler).toBe(false);
    expect(runtime.profiler.hidden).toBe(true);
    expect(runtime.profiler.textContent).toBe("");
    runtime.window.loadRuntime();
    expect(runtime.workers).toHaveLength(1);
  });

  test("a title screen holds the boot until Play starts it", () => {
    const runtime = runHost();
    runtime.elements.set("title", { id: "title" });
    runtime.readyListeners[0]?.();
    expect(runtime.workers).toHaveLength(0);
    expect(runtime.window.titleState().visible).toBe(true);
    runtime.window.startGame();
    expect(runtime.window.titleState().visible).toBe(false);
    expect(runtime.workers).toHaveLength(1);
    // A second click cannot start a second worker.
    runtime.window.startGame();
    expect(runtime.workers).toHaveLength(1);
  });

  test("worker messages update boot state, errors, and input forwarding", () => {
    const runtime = runHost();
    runtime.readyListeners[0]?.();
    runtime.workers[0].onmessage({ data: { type: "setRuntime", loaded: 4, total: 10 } });
    expect(runtime.window.__boot.getState().percent).toBe(20);
    runtime.workers[0].onmessage({ data: { type: "stage", name: "running" } });
    expect(runtime.window.__stages[0]).toBe("running");
    runtime.workers[0].onmessage({ data: { type: "addAsset" } });
    expect(runtime.window.__boot.getState().assetsLoaded).toBe(1);
    runtime.workers[0].onmessage({ data: { type: "error", message: "worker failure" } });
    expect(runtime.window.__boot.getState().failed).toBe(true);
    expect(runtime.elements.get("boot")?.textContent).toMatch(/worker failure/);

    const move = runtime.windowListeners.mousemove?.[0];
    move?.({ clientX: 12, clientY: 34, buttons: 1 });
    expect(runtime.workers[0].posted.some((item: any) => item.data && item.data.type === "event")).toBe(false);

    runtime.elements.delete("boot");
    move?.({ clientX: 12, clientY: 34, buttons: 1 });
    const forwarded = runtime.workers[0].posted[runtime.workers[0].posted.length - 1];
    expect(forwarded.data.type).toBe("event");
    expect(forwarded.data.name).toBe("mousemove");
    expect(forwarded.data.clientX).toBe(12);
    expect(forwarded.data.clientY).toBe(34);

    runtime.elements.set("boot", { id: "boot" });
    const postedBeforeBoot = runtime.workers[0].posted.length;
    move?.({ clientX: 99, clientY: 88, buttons: 1 });
    expect(runtime.workers[0].posted).toHaveLength(postedBeforeBoot);
    runtime.elements.delete("boot");

    runtime.canvas.listeners.mousedown[0]({ button: 0, clientX: 100, clientY: 50 });
    expect(runtime.canvas.lockCalls).toBe(1);
    expect(runtime.document.pointerLockElement).toBe(runtime.canvas);
    runtime.windowListeners.mousemove?.[0]?.({
      clientX: 0,
      clientY: 0,
      movementX: 10,
      movementY: -4,
      buttons: 0,
    });
    const lockedMove = runtime.workers[0].posted[runtime.workers[0].posted.length - 1];
    expect(lockedMove.data.clientX).toBe(110);
    expect(lockedMove.data.clientY).toBe(46);
  });

  test("profiler overlay stays after boot and can be recreated", () => {
    const profiled = runHost({ search: "?profiler" });
    expect(profiled.window.__profiler.enabled).toBe(true);
    expect(profiled.profiler.hidden).toBe(false);
    profiled.readyListeners[0]?.();
    expect(profiled.workers[0].posted[0].data.profiler).toBe(true);
    profiled.workers[0].onmessage({
      data: {
        type: "profiler",
        frames: 12,
        fps: 47.2,
        fpsAvg: 46.8,
        lastMs: 21.1,
        avgMs: 21.4,
        maxMs: 28,
        loopAlive: true,
        schedule: "raf",
        hidden: false,
        wasmBytes: 8 * 1048576,
        jsBytes: 4 * 1048576,
        managed: { frames: 12, gcBytes: 1048576, gen0: 3, gen1: 1, gen2: 0, runningSlowly: false },
      },
    });
    expect(profiled.window.__profiler.last.fps).toBe(47.2);
    expect(profiled.window.__profiler.last.maxMs).toBe(28);
    expect(profiled.window.__profiler.last.wasmBytes).toBe(8 * 1048576);
    expect(profiled.window.__profiler.last.jsBytes).toBe(4 * 1048576);
    profiled.workers[0].onmessage({
      data: { type: "profiler", frames: 13, jsBytes: null, wasmBytes: null, managed: null },
    });
    expect(profiled.window.__profiler.last.jsBytes).toBe(4 * 1048576);
    expect(profiled.window.__profiler.last.wasmBytes).toBe(8 * 1048576);
    expect(profiled.elements.has("profiler")).toBe(true);
    profiled.elements.set("boot", {
      remove() {
        profiled.elements.delete("boot");
      },
    });
    profiled.window.clearBoot();
    expect(profiled.elements.has("boot")).toBe(false);
    expect(profiled.elements.has("profiler")).toBe(true);
    profiled.elements.delete("profiler");
    profiled.window.__profiler.update({ fps: 12, frames: 4, loopAlive: true, schedule: "raf" });
    expect(profiled.elements.has("profiler")).toBe(true);
    expect(profiled.window.__profiler.last.fps).toBe(12);
  });

  test("a stored setting turns the profiler on without the query string", () => {
    const off = runHost();
    expect(off.window.__profiler.enabled).toBe(false);
    off.readyListeners[0]?.();
    expect(off.workers[0].posted[0].data.profiler).toBe(false);

    const on = runHost({ settings: { profiler: true } });
    expect(on.window.__profiler.enabled).toBe(true);
    on.readyListeners[0]?.();
    expect(on.workers[0].posted[0].data.profiler).toBe(true);
  });

  test("toggling the setting turns the overlay on and off while the game runs", () => {
    const runtime = runHost();
    runtime.readyListeners[0]?.();
    const worker = runtime.workers[0];
    expect(runtime.profiler.hidden).toBe(true);

    runtime.window.settingsState().set("profiler", true);
    expect(runtime.window.__profiler.enabled).toBe(true);
    expect(runtime.profiler.hidden).toBe(false);
    expect(worker.posted[worker.posted.length - 1].data).toEqual({ type: "profiler-enable", enabled: true });
    expect(JSON.parse(runtime.stored.get("stardew.settings")!)).toEqual({ profiler: true });

    runtime.window.settingsState().set("profiler", false);
    expect(runtime.window.__profiler.enabled).toBe(false);
    expect(runtime.profiler.hidden).toBe(true);
    // The inline display the overlay is drawn with outranks [hidden].
    expect(runtime.profiler.style.display).toBe("none");
    expect(worker.posted[worker.posted.length - 1].data).toEqual({ type: "profiler-enable", enabled: false });
  });

  test("?profiler wins for one load without rewriting the setting", () => {
    const runtime = runHost({ search: "?profiler", settings: { profiler: false } });
    expect(runtime.window.__profiler.enabled).toBe(true);
    expect(runtime.window.settingsState().get("profiler")).toBe(false);
  });

  test("the worker shims a document and boots Blazor on the offscreen canvas", async () => {
    const worker = runWorker();
    expect(typeof worker.context.window.dispatchEvent).toBe("function");
    expect(typeof worker.context.document.getElementById).toBe("function");
    expect(typeof worker.context.document.childNodes.length).toBe("number");
    expect(worker.context.document.hasChildNodes()).toBe(true);
    expect(worker.context.Node.COMMENT_NODE).toBe(8);
    expect(worker.context.document instanceof worker.context.Document).toBe(true);
    expect(worker.context.document.location).toBeTruthy();
    expect(typeof worker.context.history.state).toBe("object");
    expect(worker.imported.includes("runtime.js")).toBe(true);
    expect(typeof worker.context.startBlazor).toBe("function");
    expect(JSON.stringify(worker.context.RUNTIME_SCRIPTS)).toBe(JSON.stringify(RUNTIME_SCRIPTS));

    const offscreen = { width: 1280, height: 720 } as Record<string, unknown>;
    worker.context.onmessage({
      data: {
        type: "boot",
        canvas: offscreen,
        debug: false,
        baseURI: "http://localhost/",
        innerWidth: 800,
        innerHeight: 600,
        clientWidth: 800,
        clientHeight: 600,
        boundingRect: { x: 0, y: 0, width: 800, height: 600 },
      },
    });
    expect(worker.context.document.getElementById("theCanvas")).toBe(offscreen);
    expect(worker.context.innerWidth).toBe(800);
    expect(offscreen.clientWidth).toBe(800);
    const asset = new worker.context.XMLHttpRequest();
    asset.open("GET", "Content/Data/BigCraftables.xnb");
    expect(asset.url).toBe("http://localhost/Content/Data/BigCraftables.xnb");
    expect(
      RUNTIME_SCRIPTS.every((src) =>
        worker.imported.some((url) => url.endsWith(src) || url.includes(src)),
      ),
    ).toBe(true);
    await waitUntil(
      () => worker.context.__blazorStarted && String(worker.fetches[0] || "").includes("blazor.boot.json"),
    );

    worker.context.reportBootError("runtime.js missing");
    expect(
      worker.posted.some(
        (item) => item.type === "error" && String(item.message).includes("runtime.js missing"),
      ),
    ).toBe(true);

    const before = worker.posted.length;
    worker.context.onmessage({ data: { type: "event", name: "mousemove", clientX: 9, clientY: 8 } });
    let sawMove = false;
    worker.context.addEventListener("mousemove", (event: { clientX: number; clientY: number }) => {
      sawMove = event.clientX === 9 && event.clientY === 8;
    });
    worker.context.onmessage({ data: { type: "event", name: "mousemove", clientX: 9, clientY: 8 } });
    expect(sawMove).toBe(true);
    expect(worker.posted).toHaveLength(before);

    worker.context.__frames = 44;
    worker.context.__gameLoop = {
      invokeMethod(name: string) {
        if (name === "Snapshot") return { frames: 44, gcBytes: 2 * 1048576 };
        return true;
      },
    };
    worker.context.onmessage({ data: { type: "profiler-query" } });
    const queried = worker.posted[worker.posted.length - 1];
    expect(queried.type).toBe("profiler");
    expect(queried.frames).toBe(44);
    expect(queried.gcBytes).toBe(2 * 1048576);

    worker.context.onmessage({ data: { type: "profiler-enable", enabled: true } });
    expect(worker.context.__profilerEnabled).toBe(true);
    worker.context.onmessage({ data: { type: "profiler-enable", enabled: false } });
    expect(worker.context.__profilerEnabled).toBe(false);

    worker.context.onmessage({ data: { type: "pacing", fps: 30, pauseWhenHidden: true } });
    expect(worker.context.__frameCap).toBe(30);
    expect(worker.context.__pauseWhenHidden).toBe(true);
  });

  test("a timed worker posts profiler samples after the interval", () => {
    const timedWorker = runWorker();
    timedWorker.context.__profilerEnabled = true;
    let now = 0;
    timedWorker.context.performance = { now() { return now; } };
    let ticks = 0;
    timedWorker.context.startGameLoop({
      invokeMethod(name: string) {
        if (name === "Snapshot") {
          return { frames: ticks, gcBytes: 2048, gen0: 1, gen1: 0, gen2: 0, runningSlowly: false };
        }
        ticks += 1;
        return true;
      },
    });
    timedWorker.scheduled.shift()?.();
    expect(timedWorker.context.__frames).toBe(1);
    expect(timedWorker.posted.some((item) => item.type === "profiler")).toBe(false);
    now = 300;
    timedWorker.scheduled.shift()?.();
    expect(timedWorker.context.__frames).toBe(2);
    const sample = timedWorker.posted.find((item) => item.type === "profiler");
    expect(sample).toBeTruthy();
    expect(sample.frames).toBe(2);
    expect(sample.loopAlive).toBe(true);
    expect(sample.managed.frames).toBe(2);
  });

  test("the worker carries the page's build token onto everything it imports", () => {
    const worker = runWorker({ search: "?v=12345" });
    worker.context.startRuntime({ canvas: {}, baseURI: "http://localhost/" });

    expect(worker.imported).toContain("runtime.js?v=12345");
    for (const src of RUNTIME_SCRIPTS.filter((script) => script.startsWith("js/"))) {
      expect(worker.imported).toContain("http://localhost/" + src + "?v=12345");
    }
    expect(worker.imported.some((url) => url.includes("_framework/") && url.includes("?v="))).toBe(false);
  });
});
