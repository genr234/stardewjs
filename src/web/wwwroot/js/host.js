// Surface managed exceptions on the page instead of only in the console;
// a WASM failure otherwise looks like a blank canvas.
window.__errs = [];
window.reportBootError = function (message) {
  window.__bootFailed = true;
  window.__errs.push(message);
  var text = message.slice(0, 2000);
  if (typeof window.bootState === 'function') {
    var state = window.bootState();
    state.failed = true;
    state.error = text;
    state.visible = true;
  }
  // Tests and pre-Alpine failures still need a readable overlay.
  if (!window.Alpine) {
    var overlay = document.getElementById('boot');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'boot';
      document.body.appendChild(overlay);
    }
    overlay.setAttribute('role', 'alert');
    overlay.textContent = text;
  }
};
window.addEventListener('error', function (e) {
  reportBootError(String((e.error && e.error.stack) || e.message));
});
window.addEventListener('unhandledrejection', function (e) {
  reportBootError('unhandled rejection: ' + String((e.reason && e.reason.stack) || e.reason));
});
// Blazor reports managed exceptions through console.error, not the error event.
var nativeConsoleError = console.error.bind(console);
console.error = function () {
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    if (a && (a.stack || a.message)) {
      reportBootError(String(a.message || '') + '\n\n' + String(a.stack || ''));
    } else if (typeof a === 'string' && a.indexOf('   at ') >= 0) {
      // Console.Error.WriteLine of a managed exception arrives as a plain string.
      reportBootError(a);
    }
  }
  return nativeConsoleError.apply(null, arguments);
};

// Combined bar: runtime downloads occupy the first half, game asset XHRs the second.
// Alpine.store('boot') owns the overlay; this script only mutates that state.
(function () {
  var boot = {
    runtimeLoaded: 0,
    runtimeTotal: 0,
    assetsLoaded: 0,
    assetsTotal: 1262,
    runtimeDone: false,
    failed: false,
    error: '',
    visible: true,
    get percent() {
      var runtimeFrac = this.runtimeTotal > 0 ? this.runtimeLoaded / this.runtimeTotal : (this.runtimeDone ? 1 : 0);
      if (!this.runtimeDone && runtimeFrac > 0.95) runtimeFrac = 0.95;
      var assetFrac = this.assetsTotal > 0 ? Math.min(this.assetsLoaded, this.assetsTotal) / this.assetsTotal : 0;
      return Math.round((Math.min(runtimeFrac, 1) * 0.5 + (this.runtimeDone ? Math.min(assetFrac, 1) : 0) * 0.5) * 100);
    },
    get status() {
      if (this.runtimeDone) return this.assetsLoaded > 0 ? 'loading game assets' : 'starting the game';
      return 'loading the .NET runtime';
    },
    get detail() {
      if (this.runtimeDone && this.assetsLoaded > 0) return this.assetsLoaded + ' / ' + this.assetsTotal + ' files';
      if (!this.runtimeDone && this.runtimeTotal > 0) return this.runtimeLoaded + ' / ' + this.runtimeTotal + ' files';
      return 'this takes a while on a cold cache';
    },
  };

  window.bootState = function () {
    if (window.Alpine) {
      var stored = Alpine.store('boot');
      if (stored) return stored;
    }
    return boot;
  };

  document.addEventListener('alpine:init', function () {
    Alpine.store('boot', boot);
  });

  function isGameAsset(url) {
    var value = String(url);
    return /(?:^|\/)Content\//.test(value) || /ContentHashes\.json/i.test(value);
  }

  window.__boot = {
    getState: function () {
      var state = window.bootState();
      return {
        runtimeLoaded: state.runtimeLoaded,
        runtimeTotal: state.runtimeTotal,
        assetsLoaded: state.assetsLoaded,
        assetsTotal: state.assetsTotal,
        runtimeDone: state.runtimeDone,
        failed: state.failed,
        visible: state.visible,
        percent: state.percent,
        status: state.status,
        detail: state.detail,
      };
    },
    setRuntime: function (loaded, total) {
      var state = window.bootState();
      if (state.failed) return;
      state.runtimeLoaded = loaded;
      if (typeof total === 'number') state.runtimeTotal = total;
    },
    expectRuntime: function () {
      var state = window.bootState();
      if (state.failed) return;
      state.runtimeTotal += 1;
    },
    addRuntime: function () {
      var state = window.bootState();
      if (state.failed) return;
      state.runtimeLoaded += 1;
      if (state.runtimeTotal > 0 && state.runtimeLoaded > state.runtimeTotal) {
        state.runtimeLoaded = state.runtimeTotal;
      }
    },
    finishRuntime: function () {
      var state = window.bootState();
      if (state.failed) return;
      state.runtimeDone = true;
      if (state.runtimeTotal < state.runtimeLoaded) state.runtimeTotal = state.runtimeLoaded;
      if (state.runtimeTotal > 0) state.runtimeLoaded = state.runtimeTotal;
    },
    setAssets: function (loaded, total) {
      var state = window.bootState();
      if (state.failed) return;
      state.assetsLoaded = loaded;
      if (typeof total === 'number') state.assetsTotal = total;
    },
    addAsset: function () {
      var state = window.bootState();
      if (state.failed) return;
      state.assetsLoaded += 1;
      if (state.assetsLoaded > state.assetsTotal) state.assetsTotal = state.assetsLoaded;
    },
  };

  window.reportBootStage = function (name) {
    window.__stages = window.__stages || [];
    window.__stages.push(name);
    window.__boot.finishRuntime();
  };

  window.clearBoot = function () {
    window.__boot.finishRuntime();
    var state = window.bootState();
    state.assetsLoaded = Math.max(state.assetsLoaded, state.assetsTotal);
    state.visible = false;
    var overlay = document.getElementById('boot');
    if (overlay && overlay.remove) overlay.remove();
  };

  // Fallback path: Content XHRs run on this thread. The worker patches XHR itself.
  if (typeof XMLHttpRequest !== 'undefined') {
    var nativeOpen = XMLHttpRequest.prototype.open;
    var nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._bootUrl = url;
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var result = nativeSend.apply(this, arguments);
      if (!window.__bootFailed && isGameAsset(this._bootUrl || '')) {
        window.__boot.addAsset();
      }
      return result;
    };
  }

  function handleWorkerMessage(data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'error':
        window.reportBootError(data.message);
        break;
      case 'stage':
        window.reportBootStage(data.name);
        break;
      case 'clear':
        window.clearBoot();
        break;
      case 'setRuntime':
        window.__boot.setRuntime(data.loaded, data.total);
        break;
      case 'expectRuntime':
        window.__boot.expectRuntime();
        break;
      case 'addRuntime':
        window.__boot.addRuntime();
        break;
      case 'finishRuntime':
        window.__boot.finishRuntime();
        break;
      case 'setAssets':
        window.__boot.setAssets(data.loaded, data.total);
        break;
      case 'addAsset':
        window.__boot.addAsset();
        break;
    }
  }

  function canvasMetrics(canvas) {
    var rect = canvas && canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : { x: 0, y: 0, width: 0, height: 0 };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      hidden: !!(document && document.hidden),
      clientWidth: canvas && canvas.clientWidth,
      clientHeight: canvas && canvas.clientHeight,
      boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  function forwardInput(worker, canvas) {
    function postEvent(name, event, extra) {
      var payload = {
        type: 'event',
        name: name,
        clientX: event && event.clientX,
        clientY: event && event.clientY,
        buttons: event && event.buttons,
        deltaX: event && event.deltaX,
        deltaY: event && event.deltaY,
        deltaZ: event && event.deltaZ,
        deltaMode: event && event.deltaMode,
        key: event && event.key,
        keyCode: event && event.keyCode,
        location: event && event.location,
        gamepadIndex: event && event.gamepad && event.gamepad.index,
      };
      if (event && event.changedTouches) {
        payload.touches = [];
        for (var i = 0; i < event.changedTouches.length; i++) {
          var touch = event.changedTouches[i];
          payload.touches.push({
            clientX: touch.clientX,
            clientY: touch.clientY,
            identifier: touch.identifier,
          });
        }
      }
      if (extra) {
        Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
      }
      worker.postMessage(payload);
    }

    window.addEventListener('resize', function () {
      postEvent('resize', null, canvasMetrics(canvas));
    });
    window.addEventListener('focus', function () { postEvent('focus', null); });
    window.addEventListener('blur', function () { postEvent('blur', null); });
    window.addEventListener('mousemove', function (event) { postEvent('mousemove', event); });
    window.addEventListener('mousedown', function (event) { postEvent('mousedown', event); });
    window.addEventListener('mouseup', function (event) { postEvent('mouseup', event); });
    window.addEventListener('wheel', function (event) { postEvent('wheel', event); });
    window.addEventListener('keydown', function (event) { postEvent('keydown', event); });
    window.addEventListener('keyup', function (event) { postEvent('keyup', event); });
    window.addEventListener('touchstart', function (event) {
      event.preventDefault();
      postEvent('touchstart', event);
    }, { passive: false });
    window.addEventListener('touchmove', function (event) {
      event.preventDefault();
      postEvent('touchmove', event);
    }, { passive: false });
    window.addEventListener('touchend', function (event) {
      event.preventDefault();
      postEvent('touchend', event);
    }, { passive: false });
    window.addEventListener('touchcancel', function (event) { postEvent('touchcancel', event); });
    window.addEventListener('gamepadconnected', function (event) { postEvent('gamepadconnected', event); });
    window.addEventListener('gamepaddisconnected', function (event) { postEvent('gamepaddisconnected', event); });
    document.addEventListener('visibilitychange', function () {
      worker.postMessage({ type: 'visibility', hidden: document.hidden });
    });
  }

  function canUseWorker(canvas) {
    return typeof Worker === 'function'
      && canvas
      && typeof canvas.transferControlToOffscreen === 'function';
  }

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

  function loadMainThreadRuntime() {
    return loadScript('js/runtime.js').then(function () {
      return window.loadRuntimeScripts();
    }).then(function () {
      window.startBlazor();
    });
  }

  function startWorkerRuntime(canvas) {
    var offscreen;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch (err) {
      return loadMainThreadRuntime();
    }
    var worker;
    try {
      worker = new Worker('js/game.worker.js');
    } catch (err) {
      return loadMainThreadRuntime();
    }
    window.__gameWorker = worker;
    worker.onerror = function (event) {
      window.reportBootError(String((event && (event.message || event.error)) || 'game worker failed'));
    };
    worker.onmessage = function (event) {
      handleWorkerMessage(event.data);
    };
    var boot = canvasMetrics(canvas);
    boot.type = 'boot';
    boot.canvas = offscreen;
    boot.debug = new URLSearchParams(location.search).has('debug');
    boot.baseURI = document.baseURI || location.href;
    worker.postMessage(boot, [offscreen]);
    forwardInput(worker, canvas);
    return Promise.resolve();
  }

  window.loadRuntime = function () {
    if (window.__runtimeLoad) return window.__runtimeLoad;
    var canvas = document.getElementById('theCanvas');
    window.__runtimeLoad = (canUseWorker(canvas) ? startWorkerRuntime(canvas) : loadMainThreadRuntime()).catch(function (err) {
      window.reportBootError(String((err && err.stack) || err));
    });
    return window.__runtimeLoad;
  };
})();

// ?debug=1 preserves the framebuffer for readback. Keep the tab visible:
// preserving pixels does not make a hidden page run at normal frame rates.
// Off by default because preserveDrawingBuffer costs real performance.
if (new URLSearchParams(location.search).has('debug') && typeof HTMLCanvasElement !== 'undefined') {
  var originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return originalGetContext.call(this, type, attrs);
  };
}

// Main-thread fallback loop.
window.__frames = 0;
window.startGameLoop = function (dotnetRef) {
  // Without an initial resize, KNI keeps a 1280x720 buffer stretched over the
  // window and hit targets are misaligned.
  window.dispatchEvent(new Event('resize'));
  function frame() {
    try {
      if (!dotnetRef.invokeMethod('Tick')) { return; }
      window.__frames++;
    } catch (e) {
      console.error(e);
      return;
    }
    schedule(frame);
  }
  // requestAnimationFrame does not fire while the page is hidden, which stops
  // the game entirely rather than pausing it. Fall back to a timer so a
  // background tab keeps running (slowly, as the browser clamps it).
  function schedule(fn) {
    if (document.hidden) { setTimeout(fn, 16); } else { requestAnimationFrame(fn); }
  }
  schedule(frame);
};

function tryLoadRuntime() {
  if (typeof window.loadRuntime === 'function') window.loadRuntime();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryLoadRuntime);
} else {
  tryLoadRuntime();
}
