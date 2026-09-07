// Run with node scripts/test_web_host.mjs. No browser or game assets required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/web/wwwroot/index.html', import.meta.url), 'utf8');
const hostJs = readFileSync(new URL('../src/web/wwwroot/js/host.js', import.meta.url), 'utf8');
const runtimeJs = readFileSync(new URL('../src/web/wwwroot/js/runtime.js', import.meta.url), 'utf8');
const workerJs = readFileSync(new URL('../src/web/wwwroot/js/game.worker.js', import.meta.url), 'utf8');
assert.equal([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].length, 0);

function runHost(options = {}) {
  const fallback = options.fallback === true;
  const elements = new Map();
  const scheduled = [];
  const events = [];
  const readyListeners = [];
  const appended = [];
  const fetches = [];
  const workers = [];
  const windowListeners = {};
  const canvas = {
    id: 'theCanvas',
    clientWidth: 1280,
    clientHeight: 720,
    listeners: {},
    lockCalls: 0,
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1280, height: 720 };
    },
    addEventListener(type, fn) {
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
  elements.set('theCanvas', canvas);
  const document = {
    hidden: false,
    readyState: 'loading',
    baseURI: 'http://localhost/',
    pointerLockElement: null,
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') readyListeners.push(fn);
    },
    getElementById: id => elements.get(id),
    createElement() {
      return {
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; this[name] = value; },
      };
    },
    body: {
      appendChild(element) {
        appended.push(element);
        if (element.id) elements.set(element.id, element);
        return element;
      },
    },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function (method, url) { this.url = url; };
  XMLHttpRequest.prototype.send = function () {};
  function Worker(url) {
    this.url = url;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    workers.push(this);
  }
  Worker.prototype.postMessage = function (data, transfer) {
    this.posted.push({ data, transfer: transfer || [] });
  };
  function HTMLCanvasElement() {}
  HTMLCanvasElement.prototype.getContext = function () { return null; };
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    dispatchEvent: event => events.push(event.type),
  };
  const context = vm.createContext(Object.assign(window, {
    window, document, Event, URLSearchParams, location: { search: '', href: 'http://localhost/' },
    console: { error() {} },
    Promise,
    Error,
    Object,
    fetch(url) {
      fetches.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ resources: {} }) });
    },
    requestAnimationFrame: callback => scheduled.push(callback),
    setTimeout: callback => scheduled.push(callback),
    XMLHttpRequest,
    HTMLCanvasElement,
    Worker: fallback ? undefined : Worker,
  }));
  vm.runInContext(hostJs, context);
  return {
    window, document, elements, scheduled, events, readyListeners, appended, fetches,
    workers, windowListeners, canvas,
  };
}

const RUNTIME_SCRIPTS = [
  '_content/nkast.Wasm.JSInterop/js/JSObject.10.0.3.js',
  '_content/nkast.Wasm.Dom/js/Window.10.0.3.js',
  '_content/nkast.Wasm.Dom/js/Document.10.0.3.js',
  '_content/nkast.Wasm.Dom/js/Navigator.10.0.3.js',
  '_content/nkast.Wasm.Dom/js/Gamepad.10.0.3.js',
  '_content/nkast.Wasm.Dom/js/Media.10.0.3.js',
  '_content/nkast.Wasm.Canvas/js/Canvas.10.0.3.js',
  '_content/nkast.Wasm.Canvas/js/Canvas2dContext.10.0.3.js',
  '_content/nkast.Wasm.Canvas/js/CanvasGLContext.10.0.3.js',
  '_content/nkast.Wasm.Audio/js/Audio.10.0.3.js',
  '_content/nkast.Wasm.XHR/js/XHR.10.0.3.js',
  '_content/nkast.Wasm.XR/js/XR.10.0.3.js',
  '_framework/blazor.webassembly.js',
];

assert.doesNotMatch(html, /_content\//);
assert.doesNotMatch(html, /_framework\//);
assert.doesNotMatch(html, /blazor\.webassembly/);
assert.match(html, /js\/alpine\.min\.js/);
assert.match(html, /js\/host\.js/);
assert.match(html, /x-data/);
assert.match(html, /\$store\.boot\.percent/);
assert.match(html, /x-text="\$store\.boot\.status"/);
assert.match(hostJs, /game\.worker\.js/);
assert.match(hostJs, /transferControlToOffscreen/);
assert.match(runtimeJs, /autostart/);
assert.match(runtimeJs, /blazor\.webassembly\.js/);
for (const src of RUNTIME_SCRIPTS) {
  assert.match(runtimeJs, new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const first = runHost();
const { window, elements, scheduled, events } = first;

// A failure after startup must restore a visible message, preserving full logs.
window.reportBootError('runtime failure');
assert.equal(elements.get('boot').textContent, 'runtime failure');
assert.equal(elements.get('boot').role, 'alert');
window.reportBootError('next failure');
assert.equal(elements.get('boot').textContent, 'next failure');
assert.equal(window.__errs.length, 2);
assert.equal(window.__bootFailed, true);
assert.equal(window.__boot.getState().failed, true);

// Count only completed ticks and stop scheduling when managed execution stops.
let calls = 0;
window.startGameLoop({ invokeMethod: () => ++calls === 1 });
assert.deepEqual(events, ['resize']);
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.equal(window.__frames, 1);
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.equal(window.__frames, 1);
assert.equal(scheduled.length, 0);

// An interop exception also stops the loop without counting a failed frame.
window.startGameLoop({ invokeMethod() { throw new Error('interop failure'); } });
scheduled.shift()();
assert.equal(window.__frames, 1);
assert.equal(scheduled.length, 0);

// Progress updates after an error must not resurrect the loading bar.
const errorText = elements.get('boot').textContent;
window.__boot.setRuntime(4, 10);
assert.equal(elements.get('boot').textContent, errorText);
assert.equal(window.__boot.getState().runtimeLoaded, 0);

const progress = runHost();
progress.window.__boot.setRuntime(4, 10);
assert.equal(progress.window.__boot.getState().percent, 20);
assert.equal(progress.window.__boot.getState().status, 'loading the .NET runtime');
assert.equal(progress.window.__boot.getState().detail, '4 / 10 files');

progress.window.reportBootStage('running');
assert.equal(progress.window.__stages.length, 1);
assert.equal(progress.window.__stages[0], 'running');
assert.equal(progress.window.__boot.getState().runtimeDone, true);
assert.equal(progress.window.__boot.getState().percent, 50);
assert.equal(progress.window.__boot.getState().status, 'starting the game');

progress.window.__boot.setAssets(631, 1262);
assert.equal(progress.window.__boot.getState().percent, 75);
assert.equal(progress.window.__boot.getState().status, 'loading game assets');
assert.equal(progress.window.__boot.getState().detail, '631 / 1262 files');

const xhr = new progress.window.XMLHttpRequest();
xhr.open('GET', 'Content/Maps/Town.xnb');
xhr.send();
assert.equal(progress.window.__boot.getState().assetsLoaded, 632);

const ignored = new progress.window.XMLHttpRequest();
ignored.open('GET', '_framework/dotnet.native.wasm');
ignored.send();
assert.equal(progress.window.__boot.getState().assetsLoaded, 632);

progress.elements.set('boot', { remove() { progress.elements.delete('boot'); } });
progress.window.clearBoot();
assert.equal(progress.window.__boot.getState().percent, 100);
assert.equal(progress.window.__boot.getState().visible, false);
assert.equal(progress.elements.has('boot'), false);

async function waitUntil(predicate) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('timed out waiting for host state');
}

// The UI thread starts a worker and transfers the canvas; it does not inject runtime scripts.
const runtime = runHost();
assert.equal(runtime.appended.length, 0);
assert.equal(runtime.readyListeners.length, 1);
runtime.readyListeners[0]();
assert.equal(runtime.appended.length, 0);
assert.equal(runtime.workers.length, 1);
assert.equal(runtime.workers[0].url, 'js/game.worker.js');
assert.equal(runtime.canvas.transferred, true);
assert.equal(runtime.workers[0].posted.length, 1);
assert.equal(runtime.workers[0].posted[0].data.type, 'boot');
assert.equal(runtime.workers[0].posted[0].data.canvas.transferred, true);
assert.equal(runtime.workers[0].posted[0].transfer.length, 1);
assert.equal(runtime.workers[0].posted[0].data.baseURI, 'http://localhost/');
runtime.window.loadRuntime();
assert.equal(runtime.workers.length, 1);

runtime.workers[0].onmessage({ data: { type: 'setRuntime', loaded: 4, total: 10 } });
assert.equal(runtime.window.__boot.getState().percent, 20);
runtime.workers[0].onmessage({ data: { type: 'stage', name: 'running' } });
assert.equal(runtime.window.__stages[0], 'running');
runtime.workers[0].onmessage({ data: { type: 'addAsset' } });
assert.equal(runtime.window.__boot.getState().assetsLoaded, 1);
runtime.workers[0].onmessage({ data: { type: 'error', message: 'worker failure' } });
assert.equal(runtime.window.__boot.getState().failed, true);
assert.match(runtime.elements.get('boot').textContent, /worker failure/);

const move = runtime.windowListeners.mousemove[0];
move({ clientX: 12, clientY: 34, buttons: 1 });
const forwarded = runtime.workers[0].posted[runtime.workers[0].posted.length - 1];
assert.equal(forwarded.data.type, 'event');
assert.equal(forwarded.data.name, 'mousemove');
assert.equal(forwarded.data.clientX, 12);
assert.equal(forwarded.data.clientY, 34);

runtime.canvas.listeners.mousedown[0]({ button: 0, clientX: 100, clientY: 50 });
assert.equal(runtime.canvas.lockCalls, 1);
assert.equal(runtime.document.pointerLockElement, runtime.canvas);
runtime.windowListeners.mousemove[0]({
  clientX: 0,
  clientY: 0,
  movementX: 10,
  movementY: -4,
  buttons: 0,
});
const lockedMove = runtime.workers[0].posted[runtime.workers[0].posted.length - 1];
assert.equal(lockedMove.data.clientX, 110);
assert.equal(lockedMove.data.clientY, 46);

// Without OffscreenCanvas, the host falls back to injecting scripts on this thread.
const fallback = runHost({ fallback: true });
fallback.readyListeners[0]();
assert.equal(fallback.workers.length, 0);
let started = false;
const fallbackScripts = ['js/runtime.js', ...RUNTIME_SCRIPTS];
for (let i = 0; i < fallbackScripts.length; i++) {
  const src = fallbackScripts[i];
  await waitUntil(() => fallback.appended.length === i + 1);
  const script = fallback.appended[i];
  assert.equal(script.src, src);
  if (src.indexOf('runtime.js') >= 0) {
    vm.runInContext(runtimeJs, fallback.window);
  }
  if (src.indexOf('blazor.webassembly.js') >= 0) {
    assert.equal(script.attributes.autostart, 'false');
    fallback.window.Blazor = { start() { started = true; return Promise.resolve(); } };
  }
  script.onload();
}
await waitUntil(() => started && fallback.fetches[0] === '_framework/blazor.boot.json');
assert.equal(fallback.appended.length, fallbackScripts.length);

function runWorker() {
  const imported = [];
  const posted = [];
  const scheduled = [];
  const fetches = [];
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function (method, url) { this.method = method; this.url = url; };
  XMLHttpRequest.prototype.send = function () {};
  let context;
  context = vm.createContext({
    console: { error() {} },
    Promise,
    Error,
    Object,
    URL,
    Event,
    URLSearchParams,
    location: { href: 'http://localhost/js/game.worker.js', origin: 'http://localhost' },
    fetch(url) {
      fetches.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ resources: {} }) });
    },
    requestAnimationFrame: callback => scheduled.push(callback),
    setTimeout: callback => scheduled.push(callback),
    XMLHttpRequest,
    importScripts() {
      for (let i = 0; i < arguments.length; i++) {
        const url = String(arguments[i]);
        imported.push(url);
        if (url === 'runtime.js' || url.endsWith('/runtime.js')) {
          vm.runInContext(runtimeJs, context);
        }
        if (url.indexOf('blazor.webassembly.js') >= 0) {
          context.Blazor = { start() { context.__blazorStarted = true; return Promise.resolve(); } };
        }
      }
    },
    postMessage(data) { posted.push(data); },
    addEventListener() {},
    removeEventListener() {},
  });
  context.self = context;
  vm.runInContext(workerJs, context);
  return { context, imported, posted, fetches, scheduled };
}

const worker = runWorker();
assert.equal(typeof worker.context.window.dispatchEvent, 'function');
assert.equal(typeof worker.context.document.getElementById, 'function');
assert.equal(typeof worker.context.document.childNodes.length, 'number');
assert.equal(worker.context.document.hasChildNodes(), true);
assert.equal(worker.context.Node.COMMENT_NODE, 8);
assert.equal(worker.context.document instanceof worker.context.Document, true);
assert.ok(worker.context.document.location);
assert.equal(typeof worker.context.history.state, 'object');
assert.ok(worker.imported.includes('runtime.js'));
assert.equal(typeof worker.context.startBlazor, 'function');
assert.equal(JSON.stringify(worker.context.RUNTIME_SCRIPTS), JSON.stringify(RUNTIME_SCRIPTS));

const offscreen = { width: 1280, height: 720 };
worker.context.onmessage({
  data: {
    type: 'boot',
    canvas: offscreen,
    debug: false,
    baseURI: 'http://localhost/',
    innerWidth: 800,
    innerHeight: 600,
    clientWidth: 800,
    clientHeight: 600,
    boundingRect: { x: 0, y: 0, width: 800, height: 600 },
  },
});
assert.equal(worker.context.document.getElementById('theCanvas'), offscreen);
assert.equal(worker.context.innerWidth, 800);
assert.equal(offscreen.clientWidth, 800);
const asset = new worker.context.XMLHttpRequest();
asset.open('GET', 'Content/Data/BigCraftables.xnb');
assert.equal(asset.url, 'http://localhost/Content/Data/BigCraftables.xnb');
assert.ok(RUNTIME_SCRIPTS.every(src => worker.imported.some(url => url.endsWith(src) || url.indexOf(src) >= 0)));
await waitUntil(() => worker.context.__blazorStarted && String(worker.fetches[0] || '').indexOf('blazor.boot.json') >= 0);

worker.context.reportBootError('runtime.js missing');
assert.equal(worker.posted.some(item => item.type === 'error' && String(item.message).indexOf('runtime.js missing') >= 0), true);

const before = worker.posted.length;
worker.context.onmessage({ data: { type: 'event', name: 'mousemove', clientX: 9, clientY: 8 } });
let sawMove = false;
worker.context.addEventListener('mousemove', function (event) {
  sawMove = event.clientX === 9 && event.clientY === 8;
});
worker.context.onmessage({ data: { type: 'event', name: 'mousemove', clientX: 9, clientY: 8 } });
assert.equal(sawMove, true);
assert.equal(worker.posted.length, before);

console.log('Web host regression checks passed.');
