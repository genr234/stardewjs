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

  window.startBlazor = function () {
    if (typeof Blazor === 'undefined') return;
    function begin(expected) {
      if (expected > 0) window.__boot.setRuntime(0, expected);
      var started = Blazor.start({
        loadBootResource: function (type, name, defaultUri, integrity) {
          if (type === 'dotnetjs') return defaultUri;
          var init = {};
          if (integrity) init.integrity = integrity;
          var request = fetch(defaultUri, init);
          if (expected <= 0) window.__boot.expectRuntime();
          request.then(function () { window.__boot.addRuntime(); }, function () { window.__boot.addRuntime(); });
          return request;
        }
      });
      Promise.resolve(started).then(function () {
        window.__boot.finishRuntime();
      }, function (err) {
        window.reportBootError(String((err && err.stack) || err));
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

// The game asks to be driven from here: KNI's Blazor platform does not start
// its own loop, and pacing it from managed code starves on Blazor's
// synchronization context.
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

function tryStartBlazor() {
  if (typeof Blazor !== 'undefined') startBlazor();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryStartBlazor);
} else {
  tryStartBlazor();
}
