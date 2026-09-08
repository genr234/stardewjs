import { join } from "node:path";
import * as vm from "node:vm";

const wwwroot = join(import.meta.dir, "../src/web/wwwroot");

export const html = await Bun.file(join(wwwroot, "index.html")).text();
export const hostJs = await Bun.file(join(wwwroot, "js/host.js")).text();
export const jigsawJs = await Bun.file(join(wwwroot, "js/boot-jigsaw.js")).text();
export const runtimeJs = await Bun.file(join(wwwroot, "js/runtime.js")).text();
export const workerJs = await Bun.file(join(wwwroot, "js/game.worker.js")).text();

export const RUNTIME_SCRIPTS = [
  "js/save-storage.js",
  "js/audio.js",
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
  search?: string;
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
};

export function runHost(options: HostOptions = {}): HostRun {
  const fallback = options.fallback === true;
  const elements = new Map<string, any>();
  const scheduled: Array<() => void> = [];
  const events: string[] = [];
  const readyListeners: Array<() => void> = [];
  const appended: any[] = [];
  const fetches: string[] = [];
  const workers: any[] = [];
  const windowListeners: Record<string, Array<(event: any) => void>> = {};
  const profiler = {
    id: "profiler",
    hidden: true,
    textContent: "",
  };
  const canvas: Record<string, any> = {
    id: "theCanvas",
    clientWidth: 1280,
    clientHeight: 720,
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
    dispatchEvent: (event: { type: string }) => events.push(event.type),
  };
  const context = vm.createContext(
    Object.assign(window, {
      window,
      document,
      Event,
      URLSearchParams,
      location: { search: options.search || "", href: "http://localhost/" },
      console: { error() {} },
      Promise,
      Error,
      Object,
      fetch(url: string) {
        fetches.push(url);
        return Promise.resolve({ json: () => Promise.resolve({ resources: {} }) });
      },
      requestAnimationFrame: (callback: () => void) => scheduled.push(callback),
      setTimeout: (callback: () => void) => scheduled.push(callback),
      XMLHttpRequest,
      HTMLCanvasElement,
      Worker: fallback ? undefined : Worker,
    }),
  );
  vm.runInContext(hostJs, context);
  return {
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
