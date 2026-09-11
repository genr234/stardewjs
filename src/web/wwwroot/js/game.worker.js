// Game thread: KNI interop, Blazor, and the Tick loop. The UI thread keeps
// Alpine and the <canvas> element; WebGL follows the WASM onto this worker.
self.window = self;
self.__errs = [];
self.__bootFailed = false;
self.__canvas = null;
self.__listeners = {};

var nativeAddEventListener = self.addEventListener.bind(self);
var nativeRemoveEventListener = self.removeEventListener.bind(self);

function isNativeEvent(type) {
  return type === 'message' || type === 'error' || type === 'unhandledrejection' || type === 'offline' || type === 'online';
}

self.addEventListener = function (type, fn, options) {
  if (isNativeEvent(type)) return nativeAddEventListener(type, fn, options);
  var list = self.__listeners[type] || (self.__listeners[type] = []);
  list.push(fn);
};

self.removeEventListener = function (type, fn, options) {
  if (isNativeEvent(type)) return nativeRemoveEventListener(type, fn, options);
  var list = self.__listeners[type];
  if (!list) return;
  self.__listeners[type] = list.filter(function (item) { return item !== fn; });
};

self.dispatchEvent = function (event) {
  var type = event && event.type;
  var list = self.__listeners[type] || [];
  for (var i = 0; i < list.length; i++) {
    list[i](event);
  }
  return true;
};

self.Node = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_FRAGMENT_NODE: 11,
};
function Document() {}
function Element() {}
function HTMLElement() {}
function Comment() {}
function Text() {}
function DocumentFragment() {}
self.Document = Document;
self.Element = Element;
self.HTMLElement = HTMLElement;
self.Comment = Comment;
self.Text = Text;
self.DocumentFragment = DocumentFragment;
HTMLElement.prototype = Object.create(Element.prototype);

function fakeStyle() {
  return {
    setProperty: function (name, value) { this[name] = value; },
    getPropertyValue: function (name) { return this[name] || ''; },
    removeProperty: function (name) {
      var value = this[name];
      delete this[name];
      return value || '';
    },
  };
}

function fakeElement() {
  var el = Object.create(HTMLElement.prototype);
  el.nodeType = 1;
  el.parentNode = null;
  el.style = fakeStyle();
  el.childNodes = [];
  el.children = [];
  el.classList = { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} };
  el.setAttribute = function () {};
  el.getAttribute = function () { return null; };
  el.hasAttribute = function () { return false; };
  el.appendChild = function (child) {
    this.childNodes.push(child);
    if (child) child.parentNode = this;
    return child;
  };
  el.removeChild = function (child) {
    this.childNodes = this.childNodes.filter(function (node) { return node !== child; });
    if (child) child.parentNode = null;
    return child;
  };
  el.hasChildNodes = function () { return this.childNodes.length > 0; };
  el.addEventListener = function () {};
  el.removeEventListener = function () {};
  el.querySelector = function () { return null; };
  el.querySelectorAll = function () { return []; };
  el.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  };
  el.focus = function () {};
  return el;
}

self.document = new Document();
self.document.nodeType = 9;
self.document.parentNode = null;
self.document.baseURI = '/';
self.document.hidden = false;
self.document.title = '';
self.document.currentScript = null;
self.document.readyState = 'complete';
self.document.body = fakeElement();
self.document.head = fakeElement();
self.document.documentElement = fakeElement();
self.document.hasChildNodes = function () { return this.childNodes.length > 0; };
self.document.getElementById = function (id) {
  return id === 'theCanvas' ? self.__canvas : null;
};
self.document.querySelector = function (selector) {
  if (selector === '#theCanvas' || selector === 'canvas') return self.__canvas;
  return null;
};
self.document.querySelectorAll = function (selector) {
  var found = this.querySelector(selector);
  return found ? [found] : [];
};
self.document.createElement = function () { return fakeElement(); };
self.document.createElementNS = function () { return fakeElement(); };
self.document.createComment = function (text) {
  var node = new Comment();
  node.nodeType = 8;
  node.data = text || '';
  node.textContent = text || '';
  node.childNodes = [];
  node.hasChildNodes = function () { return false; };
  return node;
};
self.document.createTextNode = function (text) {
  var node = new Text();
  node.nodeType = 3;
  node.data = text || '';
  node.textContent = text || '';
  node.childNodes = [];
  node.hasChildNodes = function () { return false; };
  return node;
};
self.document.createDocumentFragment = function () {
  var node = new DocumentFragment();
  node.childNodes = [];
  node.appendChild = function (child) { this.childNodes.push(child); return child; };
  node.hasChildNodes = function () { return this.childNodes.length > 0; };
  return node;
};
self.document.createRange = function () {
  return {
    selectNodeContents: function () {},
    setStart: function () {},
    setEnd: function () {},
    collapse: function () {},
    deleteContents: function () {},
    insertNode: function () {},
    cloneRange: function () { return this; },
  };
};
self.document.addEventListener = function () {};
self.document.removeEventListener = function () {};
self.document.hasFocus = function () { return !this.hidden; };
self.document.location = self.location;
self.document.URL = self.location && self.location.href;
self.document.documentElement.appendChild(self.document.head);
self.document.documentElement.appendChild(self.document.body);
self.document.childNodes = [self.document.documentElement];

self.innerWidth = 1280;
self.innerHeight = 720;
self.devicePixelRatio = 1;
self.parent = self;
self.opener = null;
self.frameElement = null;
self.scrollTo = function () {};
self.history = {
  state: null,
  pushState: function () {},
  replaceState: function () {},
  go: function () {},
  back: function () {},
  forward: function () {},
};

function post(data) {
  self.postMessage(data);
}

self.reportBootError = function (message) {
  self.__bootFailed = true;
  self.__errs.push(message);
  post({ type: 'error', message: String(message).slice(0, 2000) });
};

self.reportBootStage = function (name) {
  self.__stages = self.__stages || [];
  self.__stages.push(name);
  if (self.__boot) self.__boot.finishRuntime();
  post({ type: 'stage', name: name });
};

self.clearBoot = function () {
  if (self.__boot) self.__boot.finishRuntime();
  post({ type: 'clear' });
};

self.__boot = {
  setRuntime: function (loaded, total) { post({ type: 'setRuntime', loaded: loaded, total: total }); },
  expectRuntime: function () { post({ type: 'expectRuntime' }); },
  addRuntime: function () { post({ type: 'addRuntime' }); },
  finishRuntime: function () { post({ type: 'finishRuntime' }); },
  setAssets: function (loaded, total) { post({ type: 'setAssets', loaded: loaded, total: total }); },
  addAsset: function () { post({ type: 'addAsset' }); },
};

self.addEventListener('error', function (e) {
  self.reportBootError(String((e.error && e.error.stack) || e.message || e));
});
self.addEventListener('unhandledrejection', function (e) {
  self.reportBootError('unhandled rejection: ' + String((e.reason && e.reason.stack) || e.reason));
});

var nativeConsoleError = console.error.bind(console);
console.error = function () {
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    if (a && (a.stack || a.message)) {
      self.reportBootError(String(a.message || '') + '\n\n' + String(a.stack || ''));
    } else if (typeof a === 'string' && a.indexOf('   at ') >= 0) {
      self.reportBootError(a);
    }
  }
  return nativeConsoleError.apply(null, arguments);
};

function attachCanvas(canvas, metrics) {
  self.__canvas = canvas;
  applyMetrics(metrics);
  canvas.style = canvas.style || {};
  canvas.focus = canvas.focus || function () {};
  canvas.clientLeft = 0;
  canvas.clientTop = 0;
  canvas.getBoundingClientRect = function () {
    var rect = self.__boundingRect || {
      x: 0,
      y: 0,
      width: this.clientWidth || this.width || 0,
      height: this.clientHeight || this.height || 0,
    };
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    };
  };
}

function applyMetrics(data) {
  if (!data) return;
  if (typeof data.innerWidth === 'number') self.innerWidth = data.innerWidth;
  if (typeof data.innerHeight === 'number') self.innerHeight = data.innerHeight;
  if (typeof data.devicePixelRatio === 'number') self.devicePixelRatio = data.devicePixelRatio;
  if (typeof data.hidden === 'boolean') self.document.hidden = data.hidden;
  if (data.baseURI) {
    self.document.baseURI = data.baseURI;
    try {
      self.document.location = new URL(data.baseURI);
      self.document.URL = self.document.location.href;
    } catch (err) {}
  }
  if (data.boundingRect) self.__boundingRect = data.boundingRect;
  if (self.__canvas) {
    if (typeof data.clientWidth === 'number') self.__canvas.clientWidth = data.clientWidth;
    if (typeof data.clientHeight === 'number') self.__canvas.clientHeight = data.clientHeight;
  }
}

function resolveRuntimeUrl(src) {
  return new URL(self.versionedRuntimeUrl(src), self.document.baseURI).href;
}

function resolveAgainstPage(url) {
  if (typeof url !== 'string' || /^(?:[a-z]+:)?\/\//i.test(url) || url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) {
    return url;
  }
  return new URL(url, self.document.baseURI).href;
}

function installPageUrls() {
  if (self.__pageUrlsPatched) return;
  self.__pageUrlsPatched = true;
  var nativeFetch = self.fetch;
  self.fetch = function (input, init) {
    if (typeof input === 'string') input = resolveAgainstPage(input);
    return nativeFetch.call(self, input, init);
  };
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string') arguments[1] = resolveAgainstPage(url);
    return nativeOpen.apply(this, arguments);
  };
}

function applyPacing(pacing) {
  if (!pacing) return;
  self.__frameCap = Number(pacing.fps) || 0;
  self.__pauseWhenHidden = !!pacing.pauseWhenHidden;
}

function startRuntime(data) {
  applyMetrics(data);
  attachCanvas(data.canvas, data);
  self.__profilerEnabled = !!data.profiler;
  applyPacing(data.pacing);
  self.__relayUrl = typeof data.relay === 'string' ? data.relay : '';
  if (data.debug && typeof OffscreenCanvas !== 'undefined') {
    self.installDebugContext(OffscreenCanvas);
  }
  installPageUrls();
  self.installAssetProgress();
  try {
    importScripts.apply(self, self.RUNTIME_SCRIPTS.map(resolveRuntimeUrl));
  } catch (err) {
    self.reportBootError(String((err && err.stack) || err));
    return;
  }
  self.startBlazor();
}

// A worker has no getGamepads, so this answers KNI's poll from the page's latest
// snapshot. Pads are updated in place: KNI registers each object it sees, and it
// polls four times a frame.
var gamepadSlots = [];
var gamepadList = [null, null, null, null];

function gamepadSlot(index) {
  var pad = gamepadSlots[index];
  if (!pad) {
    pad = gamepadSlots[index] = {
      index: index,
      id: '',
      mapping: '',
      connected: false,
      timestamp: 0,
      axes: [],
      buttons: [],
    };
  }
  return pad;
}

function attachVibration(pad, snapshot) {
  if (pad.vibrationActuator) return;
  if (!snapshot.hasPulse && !snapshot.hasPlayEffect) return;
  var actuator = {};
  if (snapshot.hasPulse) {
    actuator.pulse = function (value, duration) {
      post({ type: 'gamepad-vibrate', index: pad.index, effect: 'pulse', value: value, duration: duration });
      return true;
    };
  }
  if (snapshot.hasPlayEffect) {
    actuator.playEffect = function (effectType, params) {
      post({ type: 'gamepad-vibrate', index: pad.index, effect: 'playEffect', effectType: effectType, params: params });
      return true;
    };
  }
  pad.vibrationActuator = actuator;
}

function applyGamepadSnapshot(snapshot) {
  var pad = gamepadSlot(snapshot.index);
  pad.id = snapshot.id || '';
  pad.mapping = snapshot.mapping || '';
  pad.connected = snapshot.connected !== false;
  pad.timestamp = snapshot.timestamp || 0;
  pad.axes = snapshot.axes || [];
  var values = snapshot.values || [];
  pad.buttons.length = values.length;
  for (var i = 0; i < values.length; i++) {
    var button = pad.buttons[i] || (pad.buttons[i] = { value: 0, pressed: false, touched: false });
    button.value = values[i];
    button.pressed = !!(snapshot.pressed && snapshot.pressed[i]);
    button.touched = !!(snapshot.touched && snapshot.touched[i]);
    pad.buttons[i] = button;
  }
  attachVibration(pad, snapshot);
  return pad;
}

function updateGamepads(pads) {
  var snapshots = pads || [];
  var length = 4;
  for (var i = 0; i < snapshots.length; i++) {
    if (snapshots[i].index + 1 > length) length = snapshots[i].index + 1;
  }
  // Absent slots must be null, not undefined, and the array is reused for the
  // same registration reason as the pads.
  gamepadList.length = length;
  for (var j = 0; j < length; j++) gamepadList[j] = null;
  for (var k = 0; k < snapshots.length; k++) {
    var pad = applyGamepadSnapshot(snapshots[k]);
    gamepadList[pad.index] = pad;
  }
}

function installGamepads() {
  if (!self.navigator) self.navigator = {};
  function getGamepads() {
    return gamepadList;
  }
  try {
    self.navigator.getGamepads = getGamepads;
    if (typeof self.navigator.getGamepads === 'function') return;
  } catch (err) {}
  var navigator = Object.create(self.navigator);
  navigator.getGamepads = getGamepads;
  Object.defineProperty(self, 'navigator', { value: navigator, configurable: true });
}

installGamepads();

function dispatchForwardedEvent(data) {
  applyMetrics(data);
  var event = {
    type: data.name,
    clientX: data.clientX || 0,
    clientY: data.clientY || 0,
    buttons: data.buttons || 0,
    deltaX: data.deltaX || 0,
    deltaY: data.deltaY || 0,
    deltaZ: data.deltaZ || 0,
    deltaMode: data.deltaMode || 0,
    key: data.key || '',
    keyCode: data.keyCode || 0,
    location: data.location || 0,
    gamepad: { index: data.gamepadIndex || 0 },
    changedTouches: data.touches || [],
    preventDefault: function () {},
  };
  self.dispatchEvent(event);
}

// Carry the page's cache-busting token on to runtime.js and its imports.
self.__runtimeVersion = new URLSearchParams(self.location.search).get('v') || '';

try {
  importScripts(self.__runtimeVersion ? 'runtime.js?v=' + self.__runtimeVersion : 'runtime.js');
} catch (err) {
  self.reportBootError(String((err && err.stack) || err));
}

function postProfilerSnapshot() {
  var mem = typeof self.profilerMemory === 'function' ? self.profilerMemory() : {};
  var managed = null;
  if (self.__gameLoop && typeof self.readManagedSnapshot === 'function') {
    managed = self.readManagedSnapshot(self.__gameLoop);
  } else if (self.__gameLoop && typeof self.__gameLoop.invokeMethod === 'function') {
    try {
      var raw = self.__gameLoop.invokeMethod('Snapshot');
      managed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {}
  }
  var gcBytes = managed && (managed.gcBytes != null ? managed.gcBytes : managed.GcBytes);
  var payload = {
    type: 'profiler',
    frames: self.__frames || 0,
    loopAlive: true,
    hidden: !!(self.document && self.document.hidden),
    schedule: self.document && self.document.hidden ? 'timeout' : 'raf',
  };
  if (mem && mem.jsBytes != null) payload.jsBytes = mem.jsBytes;
  if (mem && mem.wasmBytes != null) payload.wasmBytes = mem.wasmBytes;
  if (managed) payload.managed = managed;
  if (gcBytes != null) payload.gcBytes = gcBytes;
  post(payload);
}

nativeAddEventListener('message', function (e) {
  var data = e.data;
  if (data && data.type === 'profiler-query') postProfilerSnapshot();
});

self.onmessage = function (e) {
  var data = e.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'boot') {
    startRuntime(data);
    return;
  }
  if (data.type === 'event') {
    dispatchForwardedEvent(data);
    return;
  }
  if (data.type === 'gamepads') {
    updateGamepads(data.pads);
    return;
  }
  if (data.type === 'audio-ended') {
    if (self.browserAudio) self.browserAudio.noteEnded(data.handle);
    return;
  }
  if (data.type === 'visibility') {
    self.document.hidden = !!data.hidden;
    return;
  }
  if (data.type === 'profiler-query') {
    postProfilerSnapshot();
    return;
  }
  if (data.type === 'profiler-enable') {
    self.__profilerEnabled = !!data.enabled;
    return;
  }
  if (data.type === 'pacing') {
    applyPacing(data);
  }
};
