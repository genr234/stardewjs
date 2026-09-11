import { join } from "node:path";
import * as vm from "node:vm";

const wwwroot = join(import.meta.dir, "../src/web/wwwroot");

export const html = await Bun.file(join(wwwroot, "index.html")).text();

/** Bundles an ES module entry into an IIFE the sandbox can run. */
export async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(wwwroot, entry)], format: "iife", target: "browser" });
  if (!built.success) throw new Error(`could not bundle ${entry}: ${built.logs.join("\n")}`);
  return await built.outputs[0]!.text();
}

const pageBundle = await bundle("js/host.js");
export const hostJs = await Bun.file(join(wwwroot, "js/host.js")).text();
export const ownershipJs = await Bun.file(join(wwwroot, "js/ownership.js")).text();
export const settingsJs = await Bun.file(join(wwwroot, "js/settings.js")).text();
export const jigsawJs = await Bun.file(join(wwwroot, "js/boot-jigsaw.js")).text();
export const runtimeJs = await Bun.file(join(wwwroot, "js/runtime.js")).text();
export const workerJs = await Bun.file(join(wwwroot, "js/game.worker.js")).text();

export const RUNTIME_SCRIPTS = [
  "js/save-storage.js",
  "js/audio.js",
  "js/input.js",
  "js/net.js",
  "js/exit.js",
  "_content/nkast.Wasm.JSInterop/js/JSObject.10.0.3.js",
  "_content/nkast.Wasm.Dom/js/Window.10.0.3.js",
  "_content/nkast.Wasm.Dom/js/Document.10.0.3.js",
  "_content/nkast.Wasm.Dom/js/Navigator.10.0.3.js",
  "_content/nkast.Wasm.Dom/js/Gamepad.10.0.3.js",
  "_content/nkast.Wasm.Dom/js/Media.10.0.3.js",
  "_content/nkast.Wasm.Canvas/js/Canvas.10.0.3.js",
  "_content/nkast.Wasm.Canvas/js/Canvas2dContext.10.0.3.js",
  "_content/nkast.Wasm.Canvas/js/CanvasGLContext.10.0.3.js",
  "_content/nkast.Wasm.Audio/js/Audio.10.0.3.js",
  "_content/nkast.Wasm.XHR/js/XHR.10.0.3.js",
  "_content/nkast.Wasm.XR/js/XR.10.0.3.js",
  "_framework/blazor.webassembly.js",
];

export type HostOptions = {
  fallback?: boolean;
  /** Whether the host already counts this page as verified. */
  owned?: boolean;
  search?: string;
  /** Backs a navigator.getGamepads(); mutate it to plug pads in and out. */
  gamepads?: any[];
  /** Settings already stored in this browser, as js/settings.js would find them. */
  settings?: Record<string, unknown>;
  /** Site data blocked, the way a private window refuses it: by throwing. */
  storageThrows?: boolean;
};

export type HostRun = {
  window: vm.Context & Record<string, any>;
  document: Record<string, any>;
  elements: Map<string, any>;
  scheduled: Array<() => void>;
  events: string[];
  readyListeners: Array<() => void>;
  appended: any[];
  fetches: string[];
  workers: any[];
  windowListeners: Record<string, Array<(event: any) => void>>;
  canvas: Record<string, any>;
  profiler: Record<string, any>;
  /** The page's localStorage, so a test can read back what a setting wrote. */
  stored: Map<string, string>;
};

export function runHost(options: HostOptions = {}): HostRun {
  const fallback = options.fallback === true;
  const owned = options.owned !== false;

  const elements = new Map<string, any>();
  const scheduled: Array<() => void> = [];
  const events: string[] = [];
  const readyListeners: Array<() => void> = [];
  const appended: any[] = [];
  const fetches: string[] = [];
  const workers: any[] = [];
  const windowListeners: Record<string, Array<(event: any) => void>> = {};
  const stored = new Map<string, string>();
  if (options.settings) stored.set("stardew.settings", JSON.stringify(options.settings));
  const localStorage = options.storageThrows
    ? {
        getItem() {
          throw new Error("The operation is insecure.");
        },
        setItem() {
          throw new Error("The operation is insecure.");
        },
        removeItem() {
          throw new Error("The operation is insecure.");
        },
      }
    : {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, String(value)),
        removeItem: (key: string) => void stored.delete(key),
      };
  const profiler = {
    id: "profiler",
    hidden: true,
    textContent: "",
    style: { cssText: "", display: "" },
    setAttribute(name: string, value: string) {
    // The DOM reflects `hidden` as a boolean property.
      (this as unknown as Record<string, unknown>)[name] = name === "hidden" ? true : value;
    },
    removeAttribute(name: string) {
      if (name === "hidden") this.hidden = false;
    },
  };
  const canvas: Record<string, any> = {
    id: "theCanvas",
    clientWidth: 1280,
    clientHeight: 720,
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {} },
    listeners: {} as Record<string, Array<(event: any) => void>>,
    lockCalls: 0,
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1280, height: 720 };
    },
    addEventListener(type: string, fn: (event: any) => void) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    requestPointerLock() {
      this.lockCalls += 1;
      document.pointerLockElement = this;
    },
  };
  if (!fallback) {
    canvas.transferControlToOffscreen = function () {
      this.transferred = true;
      return { width: 1280, height: 720, transferred: true };
    };
  }
  elements.set("theCanvas", canvas);
  elements.set("profiler", profiler);
  const document: Record<string, any> = {
    hidden: false,
    readyState: "loading",
    baseURI: "http://localhost/",
    pointerLockElement: null,
    addEventListener(type: string, fn: () => void) {
      if (type === "DOMContentLoaded") readyListeners.push(fn);
    },
    getElementById: (id: string) => elements.get(id),
    createElement() {
      return {
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          this.attributes[name] = value;
          (this as unknown as Record<string, string>)[name] = value;
        },
      };
    },
    body: {
      appendChild(element: any) {
        appended.push(element);
        if (element.id) elements.set(element.id, element);
        return element;
      },
    },
  };
  function XMLHttpRequest(this: { url?: string }) {}
  XMLHttpRequest.prototype.open = function (this: { url?: string }, _method: string, url: string) {
    this.url = url;
  };
  XMLHttpRequest.prototype.send = function () {};
  function Worker(this: { url: string; posted: any[]; onmessage: null; onerror: null }, url: string) {
    this.url = url;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    workers.push(this);
  }
  Worker.prototype.postMessage = function (this: { posted: any[] }, data: unknown, transfer?: unknown[]) {
    this.posted.push({ data, transfer: transfer || [] });
  };
  function HTMLCanvasElement() {}
  HTMLCanvasElement.prototype.getContext = function () {
    return null;
  };
  const window: Record<string, any> = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener(type: string, fn: (event: any) => void) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    dispatchEvent(event: { type: string }) {
      events.push(event.type);
      for (const fn of windowListeners[event.type] || []) fn(event);
      return true;
    },
  };
  const context = vm.createContext(
    Object.assign(window, {
      window,
      document,
      Event,
      URLSearchParams,
      location: { search: options.search || "", href: "http://localhost/" },
      localStorage,
      CustomEvent: class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      setInterval: () => 1,
      clearInterval: () => {},
      console: { error() {} },
      Promise,
      Error,
      Object,
      fetch(url: string) {
        fetches.push(url);
        if (String(url).startsWith("ownership")) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ verified: owned }) });
        }
        return Promise.resolve({ json: () => Promise.resolve({ resources: {} }) });
      },
      requestAnimationFrame: (callback: () => void) => scheduled.push(callback),
      setTimeout: (callback: () => void) => scheduled.push(callback),
      XMLHttpRequest,
      HTMLCanvasElement,
      TextDecoder,
      TextEncoder,
      crypto,
      Worker: fallback ? undefined : Worker,
      navigator: options.gamepads
        ? { getGamepads: () => options.gamepads }
        : undefined,
    }),
  );
  vm.runInContext(pageBundle, context);
  // The real unlock arrives a microtask later.
  if (owned) {
    context.ownership.unlocked = true;
    context.ownership.ready = true;
  }
  return {
    stored,
    window: window as HostRun["window"],
    document,
    elements,
    scheduled,
    events,
    readyListeners,
    appended,
    fetches,
    workers,
    windowListeners,
    canvas,
    profiler,
  };
}

export function runInHost(code: string, sandbox: vm.Context) {
  vm.runInContext(code, sandbox);
}

export type WorkerRun = {
  context: vm.Context & Record<string, any>;
  imported: string[];
  posted: any[];
  fetches: string[];
  scheduled: Array<() => void>;
};

export function runWorker(options: { search?: string } = {}): WorkerRun {
  const imported: string[] = [];
  const posted: any[] = [];
  const scheduled: Array<() => void> = [];
  const fetches: string[] = [];
  function XMLHttpRequest(this: { method?: string; url?: string }) {}
  XMLHttpRequest.prototype.open = function (
    this: { method?: string; url?: string },
    method: string,
    url: string,
  ) {
    this.method = method;
    this.url = url;
  };
  XMLHttpRequest.prototype.send = function () {};
  let context: vm.Context & Record<string, any>;
  context = vm.createContext({
    console: { error() {} },
    Promise,
    Error,
    Object,
    URL,
    Event,
    URLSearchParams,
    location: {
      href: "http://localhost/js/game.worker.js" + (options.search ?? ""),
      origin: "http://localhost",
      search: options.search ?? "",
    },
    fetch(url: string) {
      fetches.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ resources: {} }) });
    },
    requestAnimationFrame: (callback: () => void) => scheduled.push(callback),
    setTimeout: (callback: () => void) => scheduled.push(callback),
    XMLHttpRequest,
    importScripts(...urls: string[]) {
      for (const raw of urls) {
        const url = String(raw);
        imported.push(url);
        // The build token rides along as a query; match on the path.
        const path = url.split("?")[0]!;
        if (path === "runtime.js" || path.endsWith("/runtime.js")) {
          vm.runInContext(runtimeJs, context);
        }
        if (url.includes("blazor.webassembly.js")) {
          context.Blazor = {
            start() {
              context.__blazorStarted = true;
              return Promise.resolve();
            },
          };
        }
      }
    },
    postMessage(data: unknown) {
      posted.push(data);
    },
    addEventListener() {},
    removeEventListener() {},
  }) as WorkerRun["context"];
  context.self = context;
  vm.runInContext(workerJs, context);
  return { context, imported, posted, fetches, scheduled };
}

export async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for host state");
}
