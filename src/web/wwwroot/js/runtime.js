// Shared by the game worker (importScripts) and the main-thread fallback.
// Assumes globalThis.__boot and globalThis.reportBootError already exist.
(function (root) {
  var RUNTIME_SCRIPTS = [
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
  root.RUNTIME_SCRIPTS = RUNTIME_SCRIPTS;

  function isGameAsset(url) {
    var value = String(url);
    return /(?:^|\/)Content\//.test(value) || /ContentHashes\.json/i.test(value);
  }
  root.isGameAsset = isGameAsset;

  function countBootResources(manifest) {
    var resources = (manifest && manifest.resources) || {};
    var n = 0;
    function walk(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      var keys = Object.keys(value);
      if (keys.length && keys.every(function (key) { return typeof value[key] === 'string'; })) {
        n += keys.length;
        return;
      }
      keys.forEach(function (key) { walk(value[key]); });
    }
    walk(resources);
    return n;
  }
  root.countBootResources = countBootResources;

  root.installAssetProgress = function () {
    if (typeof XMLHttpRequest === 'undefined' || XMLHttpRequest.prototype.__bootPatched) return;
    var nativeOpen = XMLHttpRequest.prototype.open;
    var nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._bootUrl = url;
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var result = nativeSend.apply(this, arguments);
      if (!root.__bootFailed && isGameAsset(this._bootUrl || '') && root.__boot) {
        root.__boot.addAsset();
      }
      return result;
    };
    XMLHttpRequest.prototype.__bootPatched = true;
  };

  root.installDebugContext = function (ctor) {
    if (!ctor || !ctor.prototype || typeof ctor.prototype.getContext !== 'function') return;
    var originalGetContext = ctor.prototype.getContext;
    ctor.prototype.getContext = function (type, attrs) {
      if (type === 'webgl2' || type === 'webgl') {
        attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
      }
      return originalGetContext.call(this, type, attrs);
    };
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      if (src.indexOf('blazor.webassembly.js') >= 0) {
        script.setAttribute('autostart', 'false');
      }
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.body.appendChild(script);
    });
  }

  root.loadRuntimeScripts = function () {
    return RUNTIME_SCRIPTS.reduce(function (chain, src) {
      return chain.then(function () { return loadScript(src); });
    }, Promise.resolve());
  };

  root.startBlazor = function () {
    if (typeof root.Blazor === 'undefined') return;
    function begin(expected) {
      if (expected > 0) root.__boot.setRuntime(0, expected);
      var started = root.Blazor.start({
        loadBootResource: function (type, name, defaultUri, integrity) {
          if (type === 'dotnetjs') return defaultUri;
          var init = {};
          if (integrity) init.integrity = integrity;
          var request = fetch(defaultUri, init);
          if (expected <= 0) root.__boot.expectRuntime();
          request.then(function () { root.__boot.addRuntime(); }, function () { root.__boot.addRuntime(); });
          return request;
        }
      });
      Promise.resolve(started).then(function () {
        root.__boot.finishRuntime();
      }, function (err) {
        root.reportBootError(String((err && err.stack) || err));
      });
    }
    fetch('_framework/blazor.boot.json').then(function (response) {
      return response.json();
    }).then(function (manifest) {
      begin(countBootResources(manifest));
    }).catch(function () {
      begin(0);
    });
  };

  // KNI's Blazor platform does not start its own loop. Pacing Tick() from
  // managed code starves on Blazor's synchronization context, so JS drives it.
  root.__frames = 0;
  function profilerEnabled() {
    if (root.__profilerEnabled) return true;
    try {
      return !!(root.location && new URLSearchParams(root.location.search).has('profiler'));
    } catch (err) {
      return false;
    }
  }
  function nowMs() {
    return (root.performance && typeof root.performance.now === 'function')
      ? root.performance.now()
      : Date.now();
  }
  function wasmByteLength() {
    var best = 0;
    function consider(bytes) {
      if (typeof bytes === 'number' && isFinite(bytes) && bytes > best) best = bytes;
    }
    function fromMemory(mem) {
      try {
        if (mem && mem.buffer && typeof mem.buffer.byteLength === 'number') consider(mem.buffer.byteLength);
      } catch (err) {}
    }
    try {
      fromMemory(root.wasmMemory);
      var module = root.Module;
      if (module) {
        fromMemory(module.wasmMemory);
        fromMemory(module.asm && module.asm.memory);
        if (module.HEAP8 && module.HEAP8.buffer) consider(module.HEAP8.buffer.byteLength);
        if (module.HEAPU8 && module.HEAPU8.buffer) consider(module.HEAPU8.buffer.byteLength);
      }
      var runtime = root.Blazor && root.Blazor.runtime;
      if (runtime) {
        fromMemory(runtime.memory);
        fromMemory(runtime.wasmMemory);
        if (typeof runtime.getMemory === 'function') {
          try { fromMemory(runtime.getMemory()); } catch (err) {}
        }
        module = runtime.Module || runtime.module || module;
        if (module) {
          fromMemory(module.wasmMemory);
          if (module.HEAPU8 && module.HEAPU8.buffer) consider(module.HEAPU8.buffer.byteLength);
          if (module.HEAP8 && module.HEAP8.buffer) consider(module.HEAP8.buffer.byteLength);
        }
      }
      if (typeof root.getDotnetRuntime === 'function') {
        try {
          var dotnet = root.getDotnetRuntime(0);
          fromMemory(dotnet && dotnet.getMemory && dotnet.getMemory());
          module = dotnet && (dotnet.Module || dotnet.module);
          if (module && module.HEAPU8) consider(module.HEAPU8.buffer.byteLength);
        } catch (err) {}
      }
    } catch (err) {}
    return best || null;
  }
  root.profilerMemory = function () {
    var jsBytes = null;
    try {
      var mem = root.performance && root.performance.memory;
      if (mem && typeof mem.usedJSHeapSize === 'number' && mem.usedJSHeapSize > 0) {
        jsBytes = mem.usedJSHeapSize;
      }
    } catch (err) {}
    return { jsBytes: jsBytes, wasmBytes: wasmByteLength() };
  };
  root.__gameLoop = null;
  function readManaged(dotnetRef) {
    if (!dotnetRef || typeof dotnetRef.invokeMethod !== 'function') return null;
    try {
      var raw = dotnetRef.invokeMethod('Snapshot');
      if (raw == null || raw === '') return null;
      if (typeof raw === 'string') return JSON.parse(raw);
      return JSON.parse(JSON.stringify(raw));
    } catch (err) {
      return null;
    }
  }
  root.readManagedSnapshot = readManaged;
  function emitProfiler(dotnetRef, stats) {
    if (stats.loopAlive) stats.managed = readManaged(dotnetRef);
    if (stats.managed && stats.managed.gcBytes != null) stats.gcBytes = stats.managed.gcBytes;
    else if (stats.managed && stats.managed.GcBytes != null) stats.gcBytes = stats.managed.GcBytes;
    var mem = root.profilerMemory && root.profilerMemory();
    if (mem) {
      if (mem.jsBytes != null) stats.jsBytes = mem.jsBytes;
      if (mem.wasmBytes != null) stats.wasmBytes = mem.wasmBytes;
    }
    var payload = stats;
    try {
      payload = JSON.parse(JSON.stringify(stats));
    } catch (err) {
      payload = {
        type: 'profiler',
        frames: stats.frames || 0,
        fps: stats.fps || 0,
        fpsAvg: stats.fpsAvg || 0,
        lastMs: stats.lastMs || 0,
        avgMs: stats.avgMs || 0,
        maxMs: stats.maxMs || 0,
        loopAlive: !!stats.loopAlive,
        schedule: stats.schedule,
        hidden: !!stats.hidden,
        jsBytes: stats.jsBytes,
        wasmBytes: stats.wasmBytes,
      };
    }
    try {
      if (typeof importScripts === 'function' && typeof root.postMessage === 'function') {
        root.postMessage(payload);
        return;
      }
    } catch (err) {}
    if (root.__profiler && typeof root.__profiler.update === 'function') {
      root.__profiler.update(payload);
    }
  }
  root.startGameLoop = function (dotnetRef) {
    root.__gameLoop = dotnetRef;
    root.dispatchEvent(new Event('resize'));
    var last = nowMs();
    var sampleAt = last;
    var windowStart = last;
    var windowFrames = 0;
    var lastMs = 0;
    var sumMs = 0;
    var maxMs = 0;
    var samples = 0;
    var avgFps = 0;
    var scheduleMode = 'raf';
    function frame() {
      var t0 = nowMs();
      try {
        if (!dotnetRef.invokeMethod('Tick')) {
          if (profilerEnabled()) {
            emitProfiler(dotnetRef, {
              type: 'profiler',
              frames: root.__frames,
              fps: 0,
              fpsAvg: avgFps,
              lastMs: lastMs,
              avgMs: samples ? sumMs / samples : 0,
              maxMs: maxMs,
              loopAlive: false,
              schedule: scheduleMode,
              hidden: !!(root.document && root.document.hidden),
            });
          }
          return;
        }
        root.__frames++;
      } catch (e) {
        console.error(e);
        if (profilerEnabled()) {
          emitProfiler(dotnetRef, {
            type: 'profiler',
            frames: root.__frames,
            fps: 0,
            fpsAvg: avgFps,
            lastMs: lastMs,
            avgMs: samples ? sumMs / samples : 0,
            maxMs: maxMs,
            loopAlive: false,
            schedule: scheduleMode,
            hidden: !!(root.document && root.document.hidden),
          });
        }
        return;
      }
      var t1 = nowMs();
      lastMs = t1 - t0;
      sumMs += lastMs;
      samples += 1;
      if (lastMs > maxMs) maxMs = lastMs;
      var dt = t1 - last;
      last = t1;
      var instantFps = dt > 0 ? 1000 / dt : 0;
      windowFrames += 1;
      if (t1 - windowStart >= 1000) {
        avgFps = windowFrames * 1000 / (t1 - windowStart);
        windowFrames = 0;
        windowStart = t1;
      }
      try {
        if (profilerEnabled() && t1 - sampleAt >= 250) {
          sampleAt = t1;
          emitProfiler(dotnetRef, {
            type: 'profiler',
            frames: root.__frames,
            fps: instantFps,
            fpsAvg: avgFps,
            lastMs: lastMs,
            avgMs: samples ? sumMs / samples : 0,
            maxMs: maxMs,
            loopAlive: true,
            schedule: scheduleMode,
            hidden: !!(root.document && root.document.hidden),
          });
        }
      } catch (err) {}
      schedule(frame);
    }
    function schedule(fn) {
      var hidden = !!(root.document && root.document.hidden);
      if (hidden) {
        scheduleMode = 'timeout';
        setTimeout(fn, 16);
      } else {
        scheduleMode = 'raf';
        requestAnimationFrame(fn);
      }
    }
    schedule(frame);
  };
})(typeof self !== 'undefined' ? self : window);
