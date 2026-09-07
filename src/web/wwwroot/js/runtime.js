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
  root.startGameLoop = function (dotnetRef) {
    root.dispatchEvent(new Event('resize'));
    function frame() {
      try {
        if (!dotnetRef.invokeMethod('Tick')) { return; }
        root.__frames++;
      } catch (e) {
        console.error(e);
        return;
      }
      schedule(frame);
    }
    function schedule(fn) {
      var hidden = !!(root.document && root.document.hidden);
      if (hidden) { setTimeout(fn, 16); } else { requestAnimationFrame(fn); }
    }
    schedule(frame);
  };
})(typeof self !== 'undefined' ? self : window);
