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
  const document = {
    hidden: false,
    readyState: 'loading',
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') readyListeners.push(fn);
    },
    getElementById: id => elements.get(id),
    createElement: () => ({ setAttribute(name, value) { this[name] = value; } }),
    body: { appendChild: element => elements.set(element.id, element) },
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
    requestAnimationFrame: callback => scheduled.push(callback),
    setTimeout: callback => scheduled.push(callback),
    XMLHttpRequest,
  }));
  vm.runInContext(hostJs, context);
  return { window, document, elements, scheduled, events, readyListeners };
}

assert.match(html, /autostart="false"/);
assert.match(html, /js\/alpine\.min\.js/);
assert.match(html, /js\/host\.js/);
assert.match(html, /x-data/);
assert.match(html, /\$store\.boot\.percent/);
assert.match(html, /x-text="\$store\.boot\.status"/);

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

console.log('Web host regression checks passed.');
