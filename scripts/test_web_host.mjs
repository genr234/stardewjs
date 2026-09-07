// Run with node scripts/test_web_host.mjs. No browser or game assets required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/web/wwwroot/index.html', import.meta.url), 'utf8');
const hostJs = readFileSync(new URL('../src/web/wwwroot/js/host.js', import.meta.url), 'utf8');
assert.equal([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].length, 0);

function runHost() {
  const elements = new Map();
  const scheduled = [];
  const events = [];
  const readyListeners = [];
  const appended = [];
  const fetches = [];
  const document = {
    hidden: false,
    readyState: 'loading',
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
  const window = {
    addEventListener() {},
    dispatchEvent: event => events.push(event.type),
  };
  const context = vm.createContext(Object.assign(window, {
    window, document, Event, URLSearchParams, location: { search: '' },
    console: { error() {} },
    Promise,
    Error,
    fetch(url) {
      fetches.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ resources: {} }) });
    },
    requestAnimationFrame: callback => scheduled.push(callback),
    setTimeout: callback => scheduled.push(callback),
    XMLHttpRequest,
  }));
  vm.runInContext(hostJs, context);
  return { window, document, elements, scheduled, events, readyListeners, appended, fetches };
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
assert.match(hostJs, /autostart/);
assert.match(hostJs, /blazor\.webassembly\.js/);

const first = runHost();
const { window, elements, scheduled, events } = first;

// A failure after startup must restore a visible message, preserving full logs.
window.reportBootError('runtime failure');
assert.equal(elements.get('boot').textContent, 'runtime failure');
assert.equal(elements.get('boot').role, 'alert');
window.reportBootError('next failure');
assert.equal(elements.size, 1);
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

// The first document is the UI; runtime scripts are injected after parse.
const runtime = runHost();
assert.equal(runtime.appended.length, 0);
assert.equal(runtime.readyListeners.length, 1);
runtime.readyListeners[0]();
let started = false;
for (const src of RUNTIME_SCRIPTS) {
  const index = runtime.appended.length;
  await waitUntil(() => runtime.appended.length === index + 1);
  const script = runtime.appended[index];
  assert.equal(script.src, src);
  if (src.indexOf('blazor.webassembly.js') >= 0) {
    assert.equal(script.attributes.autostart, 'false');
    runtime.window.Blazor = { start() { started = true; return Promise.resolve(); } };
  }
  script.onload();
}
await waitUntil(() => started && runtime.fetches[0] === '_framework/blazor.boot.json');
assert.equal(runtime.appended.length, RUNTIME_SCRIPTS.length);
runtime.window.loadRuntime();
assert.equal(runtime.appended.length, RUNTIME_SCRIPTS.length);

console.log('Web host regression checks passed.');
