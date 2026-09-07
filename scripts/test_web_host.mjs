// Run with node scripts/test_web_host.mjs. No browser or game assets required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/web/wwwroot/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const elements = new Map();
const scheduled = [];
const events = [];
const document = {
  hidden: false,
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
for (const script of scripts) vm.runInContext(script, context);

assert.match(html, /autostart="false"/);
assert.match(html, /id="boot-fill"/);

// A failure after startup must restore a visible message, preserving full logs.
window.reportBootError('runtime failure');
assert.equal(elements.get('boot').textContent, 'runtime failure');
assert.equal(elements.get('boot').role, 'alert');
window.reportBootError('next failure');
assert.equal(elements.size, 1);
assert.equal(window.__errs.length, 2);
assert.equal(window.__bootFailed, true);

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
assert.ok(!elements.has('boot-fill'));

// Rebuild a fresh host context to exercise the bar without an error overlay.
const progressElements = new Map();
const fill = { style: {} };
const status = { textContent: '' };
const detail = { textContent: '' };
const bar = { setAttribute(name, value) { this[name] = value; } };
const boot = { remove() { progressElements.delete('boot'); } };
progressElements.set('boot-fill', fill);
progressElements.set('boot-status', status);
progressElements.set('boot-detail', detail);
progressElements.set('boot-bar', bar);
progressElements.set('boot', boot);
function ProgressXHR() {}
ProgressXHR.prototype.open = function (method, url) { this.url = url; };
ProgressXHR.prototype.send = function () {};
const progressDocument = {
  hidden: false,
  getElementById: id => progressElements.get(id),
  createElement: () => ({ setAttribute(name, value) { this[name] = value; } }),
  body: { appendChild: element => progressElements.set(element.id, element) },
};
const progressWindow = { addEventListener() {}, dispatchEvent() {} };
const progress = vm.createContext(Object.assign(progressWindow, {
  window: progressWindow,
  document: progressDocument,
  Event,
  URLSearchParams,
  location: { search: '' },
  console: { error() {} },
  requestAnimationFrame() {},
  setTimeout() {},
  XMLHttpRequest: ProgressXHR,
}));
for (const script of scripts) vm.runInContext(script, progress);

progressWindow.__boot.setRuntime(4, 10);
assert.equal(fill.style.width, '20%');
assert.equal(bar['aria-valuenow'], '20');
assert.equal(status.textContent, 'loading the .NET runtime');
assert.equal(detail.textContent, '4 / 10 files');

progressWindow.reportBootStage('running');
assert.equal(progressWindow.__stages.length, 1);
assert.equal(progressWindow.__stages[0], 'running');
assert.equal(progressWindow.__boot.getState().runtimeDone, true);
assert.equal(fill.style.width, '50%');
assert.equal(status.textContent, 'starting the game');

progressWindow.__boot.setAssets(631, 1262);
assert.equal(fill.style.width, '75%');
assert.equal(status.textContent, 'loading game assets');
assert.equal(detail.textContent, '631 / 1262 files');

const xhr = new progressWindow.XMLHttpRequest();
xhr.open('GET', 'Content/Maps/Town.xnb');
xhr.send();
assert.equal(progressWindow.__boot.getState().assetsLoaded, 632);

const ignored = new progressWindow.XMLHttpRequest();
ignored.open('GET', '_framework/dotnet.native.wasm');
ignored.send();
assert.equal(progressWindow.__boot.getState().assetsLoaded, 632);

progressWindow.clearBoot();
assert.equal(fill.style.width, '100%');
assert.equal(progressElements.has('boot'), false);

console.log('Web host regression checks passed.');
