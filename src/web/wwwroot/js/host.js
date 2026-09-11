// Identifies this page load, and is stamped onto the scripts the game worker
// imports. The worker reads them through importScripts, which uses the HTTP
// cache and is not reliably bypassed by reloading the page, so without a token
// an edited js/*.js can keep running as its previous version.
window.__runtimeVersion = window.__runtimeVersion || String(Date.now());

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

// Nothing downloads until Play; the click is also the gesture audio needs.
(function () {
  var title = { visible: true };

  window.titleState = function () {
    if (window.Alpine) {
      var stored = Alpine.store('title');
      if (stored) return stored;
    }
    return title;
  };

  document.addEventListener('alpine:init', function () {
    Alpine.store('title', title);
  });

  title.play = function () {
    window.startGame();
  };

  window.startGame = function () {
    var state = window.titleState();
    if (!state.visible) return;
    // js/ownership.js unlocks this once the player has produced their own copy
    // of the game assembly. A missing script means no unlock, so a failure to
    // load it closes the gate rather than opening it.
    var owner = typeof window.ownershipState === 'function' ? window.ownershipState() : null;
    if (!owner || !owner.unlocked) return;
    state.visible = false;
    var overlay = document.getElementById('title');
    if (overlay && overlay.remove) overlay.remove();
    if (typeof window.loadRuntime === 'function') window.loadRuntime();
  };
})();

// Quit overlay (see src/web/BrowserExit.cs). Only a reload restarts the game.
(function () {
  var exit = {
    visible: false,
    done: false,
    error: '',
    get status() {
      if (this.error) return 'the game closed, but the save could not be written';
      return this.done ? 'the game has closed' : 'closing the game';
    },
    get detail() {
      if (this.error) return this.error;
      return this.done ? 'your farm is saved in this browser' : 'writing your farm to this browser';
    },
    again: function () {
      location.reload();
    },
  };

  window.exitState = function () {
    if (window.Alpine) {
      var stored = Alpine.store('exit');
      if (stored) return stored;
    }
    return exit;
  };

  document.addEventListener('alpine:init', function () {
    Alpine.store('exit', exit);
  });

  window.browserExitPage = {
    apply: function (message) {
      var state = window.exitState();
      state.visible = true;
      state.done = message.phase === 'exited';
      state.error = message.error || '';
      // Tests and a pre-Alpine page still need something readable on screen.
      if (!window.Alpine) {
        var overlay = document.getElementById('exit');
        if (overlay) {
          overlay.hidden = false;
          overlay.textContent = state.status;
        }
      }
    },
  };
})();

// Progress bar: runtime downloads fill the first half, game assets the second.
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
      case 'audio':
        if (window.browserAudioOutput) window.browserAudioOutput.apply(data.command);
        break;
      case 'exit':
        window.browserExitPage.apply(data);
        break;
      case 'gamepad-vibrate':
        vibrateGamepad(data);
        break;
      case 'profiler':
        if (window.__profiler && typeof window.__profiler.update === 'function') {
          window.__profiler.update(data);
        }
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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Locked mouse events stop updating clientX/clientY, so movement deltas are
  // accumulated into a virtual pointer.
  function bindPointerLock(canvas, options) {
    var pointerX = 0;
    var pointerY = 0;
    var supported = !!(canvas && typeof canvas.requestPointerLock === 'function');
    var rewrite = !!(options && options.rewriteWindowEvents && supported);
    var rewriting = false;

    function isLocked() {
      return supported && document.pointerLockElement === canvas;
    }

    function bounds() {
      var rect = canvas.getBoundingClientRect
        ? canvas.getBoundingClientRect()
        : { x: 0, y: 0, width: 0, height: 0 };
      return {
        left: rect.x || 0,
        top: rect.y || 0,
        width: rect.width || canvas.clientWidth || window.innerWidth || 0,
        height: rect.height || canvas.clientHeight || window.innerHeight || 0,
      };
    }

    function clientPoint(event) {
      if (!event) return { clientX: pointerX, clientY: pointerY };
      if (isLocked()) {
        var box = bounds();
        pointerX = clamp(pointerX + (event.movementX || 0), box.left, box.left + Math.max(box.width - 1, 0));
        pointerY = clamp(pointerY + (event.movementY || 0), box.top, box.top + Math.max(box.height - 1, 0));
      } else if (typeof event.clientX === 'number') {
        pointerX = event.clientX;
        pointerY = event.clientY;
      }
      return { clientX: pointerX, clientY: pointerY };
    }

    function setLockedStyle(locked) {
      if (canvas.style) canvas.style.cursor = locked ? 'none' : '';
      if (canvas.classList) {
        if (locked) canvas.classList.add('pointer-locked');
        else canvas.classList.remove('pointer-locked');
      }
    }

    function requestLock() {
      if (!supported || isLocked()) return;
      var result;
      try {
        result = canvas.requestPointerLock({ unadjustedMovement: true });
      } catch (err) {
        result = canvas.requestPointerLock();
      }
      if (result && typeof result.catch === 'function') {
        result.catch(function () {
          try { canvas.requestPointerLock(); } catch (ignored) {}
        });
      }
    }

    if (supported) {
      canvas.addEventListener('mousedown', function (event) {
        if (event && event.button != null && event.button !== 0) return;
        if (!isLocked() && event && typeof event.clientX === 'number') {
          pointerX = event.clientX;
          pointerY = event.clientY;
        }
        requestLock();
      });
      document.addEventListener('pointerlockchange', function () {
        setLockedStyle(isLocked());
      });
    }

    if (rewrite) {
      ['mousemove', 'mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu', 'wheel'].forEach(function (type) {
        window.addEventListener(type, function (event) {
          if (rewriting || !isLocked() || (event && event.__fromPointerLock)) return;
          var point = clientPoint(event);
          event.stopImmediatePropagation();
          rewriting = true;
          try {
            var Ctor = type === 'wheel' && typeof WheelEvent === 'function' ? WheelEvent : MouseEvent;
            var synth = new Ctor(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: point.clientX,
              clientY: point.clientY,
              screenX: point.clientX,
              screenY: point.clientY,
              buttons: event.buttons,
              button: event.button,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              deltaZ: event.deltaZ,
              deltaMode: event.deltaMode,
              movementX: event.movementX,
              movementY: event.movementY,
            });
            synth.__fromPointerLock = true;
            window.dispatchEvent(synth);
          } finally {
            rewriting = false;
          }
        }, true);
      });
    }

    return { clientPoint: clientPoint, isLocked: isLocked };
  }

  function forwardInput(worker, canvas) {
    var pointer = bindPointerLock(canvas);
    function postEvent(name, event, extra) {
      var point = event && (name === 'mousemove' || name === 'mousedown' || name === 'mouseup' || name === 'wheel')
        ? pointer.clientPoint(event)
        : null;
      var payload = {
        type: 'event',
        name: name,
        clientX: point ? point.clientX : (event && event.clientX),
        clientY: point ? point.clientY : (event && event.clientY),
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
    function bootOverlayOpen() {
      return !!document.getElementById('boot');
    }
    window.addEventListener('mousemove', function (event) {
      if (bootOverlayOpen()) return;
      postEvent('mousemove', event);
    });
    window.addEventListener('mousedown', function (event) {
      if (bootOverlayOpen()) return;
      postEvent('mousedown', event);
    });
    window.addEventListener('mouseup', function (event) {
      if (bootOverlayOpen()) return;
      postEvent('mouseup', event);
    });
    window.addEventListener('wheel', function (event) {
      if (bootOverlayOpen()) return;
      postEvent('wheel', event);
    });
    window.addEventListener('keydown', function (event) { postEvent('keydown', event); });
    window.addEventListener('keyup', function (event) { postEvent('keyup', event); });
    window.addEventListener('touchstart', function (event) {
      if (bootOverlayOpen()) return;
      event.preventDefault();
      postEvent('touchstart', event);
    }, { passive: false });
    window.addEventListener('touchmove', function (event) {
      if (bootOverlayOpen()) return;
      event.preventDefault();
      postEvent('touchmove', event);
    }, { passive: false });
    window.addEventListener('touchend', function (event) {
      if (bootOverlayOpen()) return;
      event.preventDefault();
      postEvent('touchend', event);
    }, { passive: false });
    window.addEventListener('touchcancel', function (event) { postEvent('touchcancel', event); });
    document.addEventListener('visibilitychange', function () {
      worker.postMessage({ type: 'visibility', hidden: document.hidden });
    });
    forwardGamepads(worker, postEvent);
  }

  // A worker has no getGamepads, so the page polls and ships snapshots. Connects
  // come from the poll too: KNI only registers pads on 'gamepadconnected', and
  // its startup scan is broken, so a pad connected before load would be missed.
  function forwardGamepads(worker, postEvent) {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    var announced = {};
    var posted = false;

    function snapshot(pad) {
      var buttons = pad.buttons || [];
      var values = [];
      var pressed = [];
      var touched = [];
      for (var i = 0; i < buttons.length; i++) {
        var button = buttons[i];
        var isObject = button && typeof button === 'object';
        values.push(isObject ? button.value : button || 0);
        pressed.push(isObject ? (button.pressed ? 1 : 0) : (button ? 1 : 0));
        touched.push(isObject && button.touched ? 1 : 0);
      }
      var actuator = pad.vibrationActuator;
      return {
        index: pad.index,
        id: pad.id,
        mapping: pad.mapping,
        connected: !!pad.connected,
        timestamp: pad.timestamp,
        axes: Array.prototype.slice.call(pad.axes || []),
        values: values,
        pressed: pressed,
        touched: touched,
        // KNI uses whichever of playEffect/pulse exists, so mirror this pad's.
        hasPulse: !!(actuator && typeof actuator.pulse === 'function'),
        hasPlayEffect: !!(actuator && typeof actuator.playEffect === 'function'),
      };
    }

    function poll() {
      var pads = navigator.getGamepads() || [];
      var snapshots = [];
      var live = {};
      for (var i = 0; i < pads.length; i++) {
        var pad = pads[i];
        if (!pad || !pad.connected) continue;
        live[pad.index] = true;
        snapshots.push(snapshot(pad));
      }
      // Snapshot before connect: KNI reads the pad back immediately and doesn't
      // null-check it.
      if (snapshots.length || posted) {
        worker.postMessage({ type: 'gamepads', pads: snapshots });
        posted = snapshots.length > 0;
      }
      for (var j = 0; j < snapshots.length; j++) {
        var index = snapshots[j].index;
        if (announced[index]) continue;
        announced[index] = true;
        postEvent('gamepadconnected', null, { gamepadIndex: index });
      }
      Object.keys(announced).forEach(function (key) {
        if (live[key]) return;
        delete announced[key];
        postEvent('gamepaddisconnected', null, { gamepadIndex: Number(key) });
      });
      requestAnimationFrame(poll);
    }

    requestAnimationFrame(poll);
  }

  function vibrateGamepad(data) {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    var pads = navigator.getGamepads() || [];
    var pad = null;
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].index === data.index) pad = pads[i];
    }
    var actuator = pad && pad.vibrationActuator;
    if (!actuator) return;
    try {
      if (data.effect === 'pulse' && typeof actuator.pulse === 'function') {
        actuator.pulse(data.value, data.duration);
      } else if (typeof actuator.playEffect === 'function') {
        actuator.playEffect(data.effectType || 'dual-rumble', data.params || {});
      }
    } catch (ignored) {}
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

  // KNI only registers a pad on 'gamepadconnected', which may fire before it
  // listens, so re-announce what the poll sees.
  function announceGamepads() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    var announced = {};
    function dispatch(name, pad) {
      var event = new Event(name);
      event.gamepad = pad;
      window.dispatchEvent(event);
    }
    function poll() {
      var pads = navigator.getGamepads() || [];
      var live = {};
      for (var i = 0; i < pads.length; i++) {
        var pad = pads[i];
        if (!pad || !pad.connected) continue;
        live[pad.index] = true;
        if (announced[pad.index]) continue;
        announced[pad.index] = pad;
        dispatch('gamepadconnected', pad);
      }
      Object.keys(announced).forEach(function (key) {
        if (live[key]) return;
        var gone = announced[key];
        delete announced[key];
        dispatch('gamepaddisconnected', gone);
      });
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  }

  function loadMainThreadRuntime() {
    bindPointerLock(document.getElementById('theCanvas'), { rewriteWindowEvents: true });
    announceGamepads();
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
      worker = new Worker(
        window.__runtimeVersion
          ? 'js/game.worker.js?v=' + window.__runtimeVersion
          : 'js/game.worker.js',
      );
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
    // A one-shot cue is over when its source ends, which only the page can see.
    // The runtime needs to know so it can retire the cue the game still holds.
    if (window.browserAudioOutput) {
      window.browserAudioOutput.onEnded = function (handle) {
        worker.postMessage({ type: 'audio-ended', handle: handle });
      };
    }
    var boot = canvasMetrics(canvas);
    boot.type = 'boot';
    boot.canvas = offscreen;
    boot.debug = new URLSearchParams(location.search).has('debug');
    boot.profiler = new URLSearchParams(location.search).has('profiler');
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

(function () {
  var profilerOn = false;
  try {
    profilerOn = new URLSearchParams(location.search).has('profiler');
  } catch (err) {}

  function round1(n) {
    return Math.round(Number(n) * 10) / 10;
  }
  function bytesToMb(bytes) {
    if (bytes == null || bytes === '' || !isFinite(Number(bytes))) return null;
    return Number(bytes) / 1048576;
  }
  function pageJsBytes() {
    try {
      var mem = typeof performance !== 'undefined' && performance.memory;
      if (mem && typeof mem.usedJSHeapSize === 'number' && mem.usedJSHeapSize > 0) {
        return mem.usedJSHeapSize;
      }
    } catch (err) {}
    return null;
  }
  function managedGcBytes(stats) {
    if (stats && stats.gcBytes != null && isFinite(Number(stats.gcBytes))) return Number(stats.gcBytes);
    var managed = stats && stats.managed;
    if (typeof managed === 'string') {
      try { managed = JSON.parse(managed); } catch (err) { managed = null; }
    }
    if (!managed) return null;
    var bytes = managed.gcBytes != null ? managed.gcBytes : managed.GcBytes;
    return bytes == null ? null : Number(bytes);
  }

  var profilerStyle = [
    'position:fixed',
    'top:8px',
    'left:8px',
    'z-index:2147483647',
    'margin:0',
    'padding:8px 10px',
    'max-width:min(28rem, calc(100vw - 16px))',
    'max-height:calc(100vh - 16px)',
    'overflow:auto',
    'pointer-events:none',
    'color:#e8e0c8',
    'background:rgba(14,13,11,0.82)',
    'font:11px/1.4 ui-monospace, Menlo, monospace',
    'display:block',
    'transform:translateZ(0)',
    '-webkit-transform:translateZ(0)',
  ].join(';');

  var HISTORY = 90;
  var history = { fps: [], ms: [], wasm: [], js: [], gc: [] };

  function pushHistory(series, value) {
    if (value == null || value === '' || !isFinite(Number(value))) return;
    var list = history[series];
    if (!list) return;
    list.push(Number(value));
    if (list.length > HISTORY) list.shift();
  }

  function seriesMax(list) {
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i] > max) max = list[i];
    }
    return max;
  }

  function drawSeries(ctx, values, w, h, max, color, fill) {
    if (!values.length) return;
    function point(index) {
      var x = values.length === 1 ? 0 : (index / (values.length - 1)) * (w - 1);
      var y = h - 1 - (Math.min(values[index], max) / max) * (h - 2);
      return { x: x, y: y };
    }
    if (fill) {
      ctx.beginPath();
      for (var j = 0; j < values.length; j++) {
        var p = point(j);
        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      var lastPt = point(values.length - 1);
      ctx.lineTo(lastPt.x, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.beginPath();
    for (var k = 0; k < values.length; k++) {
      var q = point(k);
      if (k === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawChart(canvas, seriesList, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var w = canvas.width || 240;
    var h = canvas.height || 48;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e0d0b';
    ctx.fillRect(0, 0, w, h);
    var max = opts.max;
    if (!(max > 0)) {
      max = 1;
      for (var s = 0; s < seriesList.length; s++) {
        var peak = seriesMax(seriesList[s].values || []);
        if (peak > max) max = peak;
      }
    }
    if (opts.hline > 0 && opts.hline > max) max = opts.hline;
    function yFor(value) {
      return h - 1 - (Math.min(value, max) / max) * (h - 2);
    }
    function dashed(y, color) {
      if (typeof ctx.setLineDash !== 'function') return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (opts.guide > 0) dashed(yFor(opts.guide), '#3a3832');
    if (opts.hline > 0) dashed(yFor(opts.hline), '#d9d2c3');
    for (var i = 0; i < seriesList.length; i++) {
      drawSeries(ctx, seriesList[i].values, w, h, max, seriesList[i].color, seriesList[i].fill);
    }
  }

  function fmtInd(value) {
    return value == null ? 'n/a' : String(round1(value));
  }

  function paintCharts() {
    var root = document.getElementById('profiler');
    if (!root || typeof root.querySelector !== 'function') return;
    var last = window.__profiler.last || {};
    var windowMaxMs = seriesMax(history.ms);
    var maxMs = last.maxMs > windowMaxMs ? last.maxMs : windowMaxMs;
    drawChart(root.querySelector('[data-series="fps"]'), [
      { values: history.fps, color: '#e6c35c', fill: 'rgba(230,195,92,0.22)' },
    ], { max: 75, guide: 60 });
    drawChart(root.querySelector('[data-series="ms"]'), [
      { values: history.ms, color: '#8ec8c8', fill: 'rgba(142,200,200,0.22)' },
    ], { max: 50, guide: 16.7, hline: maxMs });
    drawChart(root.querySelector('[data-series="mem"]'), [
      { values: history.wasm, color: '#e6c35c' },
      { values: history.js, color: '#8ec8c8' },
      { values: history.gc, color: '#c9a0dc' },
    ], { max: 0 });
    var fpsLabel = root.querySelector('[data-label="fps"]');
    var msLabel = root.querySelector('[data-label="ms"]');
    if (fpsLabel) fpsLabel.textContent = 'fps  ' + round1(last.fps || 0);
    if (msLabel) msLabel.textContent = 'frame ms  ' + round1(last.lastMs || 0);
    function setInd(key, value) {
      var el = root.querySelector('.profiler-ind[data-key="' + key + '"]');
      if (el) el.textContent = key + ' ' + fmtInd(value);
    }
    setInd('wasm', history.wasm.length ? history.wasm[history.wasm.length - 1] : null);
    setInd('js', history.js.length ? history.js[history.js.length - 1] : null);
    setInd('gc', history.gc.length ? history.gc[history.gc.length - 1] : null);
  }

  function ensureOverlay() {
    var el = document.getElementById('profiler');
    if (!el && document.createElement) {
      el = document.createElement('div');
      el.id = 'profiler';
      var parent = document.body || document.documentElement;
      if (parent && parent.appendChild) parent.appendChild(el);
    }
    if (!el) return null;
    el.hidden = false;
    if (el.removeAttribute) el.removeAttribute('hidden');
    if (el.style) el.style.cssText = profilerStyle;
    return el;
  }

  var tickMark = { frames: -1, at: 0, avgFps: 0 };

  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function mergeLoopStats(stats) {
    var last = window.__profiler.last;
    Object.keys(stats).forEach(function (key) {
      if (stats[key] == null) return;
      last[key] = stats[key];
    });
    if (last.jsBytes == null) last.jsBytes = pageJsBytes();
    pushHistory('wasm', bytesToMb(last.wasmBytes));
    pushHistory('js', bytesToMb(last.jsBytes));
    pushHistory('gc', bytesToMb(managedGcBytes(last)));
    if (typeof last.frames !== 'number') return;
    var at = nowMs();
    function sampleFrame() {
      pushHistory('fps', last.fps);
      pushHistory('ms', last.lastMs);
    }
    if (tickMark.frames < 0) {
      tickMark.frames = last.frames;
      tickMark.at = at;
      sampleFrame();
      return;
    }
    if (last.frames === tickMark.frames || at <= tickMark.at) return;
    var dt = at - tickMark.at;
    var df = last.frames - tickMark.frames;
    tickMark.frames = last.frames;
    tickMark.at = at;
    if (stats.fps == null && dt > 0 && df >= 0) {
      last.fps = df * 1000 / dt;
      last.fpsAvg = tickMark.avgFps ? tickMark.avgFps * 0.6 + last.fps * 0.4 : last.fps;
      tickMark.avgFps = last.fpsAvg;
      if (df > 0) {
        last.lastMs = dt / df;
        if (!last.avgMs) last.avgMs = last.lastMs;
        if (!last.maxMs || last.lastMs > last.maxMs) last.maxMs = last.lastMs;
      }
    }
    sampleFrame();
  }

  window.__profiler = {
    enabled: profilerOn,
    last: {},
    update: function (stats) {
      if (!this.enabled) return;
      if (stats) mergeLoopStats(stats);
      var el = ensureOverlay();
      if (!el) return;
      paintCharts();
    },
  };

  function pollWorker() {
    if (!window.__gameWorker || typeof window.__gameWorker.postMessage !== 'function') return;
    try {
      window.__gameWorker.postMessage({ type: 'profiler-query' });
    } catch (err) {}
  }

  if (profilerOn) {
    window.__profiler.update({});
    if (typeof setInterval === 'function') {
      setInterval(function () {
        pollWorker();
        window.__profiler.update();
      }, 250);
    }
  }
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
  function profilerOn() {
    return !!(window.__profiler && window.__profiler.enabled);
  }
  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }
  function emitProfiler(stats) {
    if (stats.loopAlive && profilerOn() && dotnetRef && typeof dotnetRef.invokeMethod === 'function') {
      try {
        var raw = dotnetRef.invokeMethod('Snapshot');
        stats.managed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (err) {}
    }
    var mem = window.profilerMemory && window.profilerMemory();
    if (mem) {
      if (mem.jsBytes != null) stats.jsBytes = mem.jsBytes;
      if (mem.wasmBytes != null) stats.wasmBytes = mem.wasmBytes;
    }
    if (window.__profiler && typeof window.__profiler.update === 'function') {
      window.__profiler.update(stats);
    }
  }
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
        if (profilerOn()) {
          emitProfiler({
            type: 'profiler',
            frames: window.__frames,
            fps: 0,
            fpsAvg: avgFps,
            lastMs: lastMs,
            avgMs: samples ? sumMs / samples : 0,
            maxMs: maxMs,
            loopAlive: false,
            schedule: scheduleMode,
            hidden: !!(document && document.hidden),
          });
        }
        return;
      }
      window.__frames++;
    } catch (e) {
      console.error(e);
      if (profilerOn()) {
        emitProfiler({
          type: 'profiler',
          frames: window.__frames,
          fps: 0,
          fpsAvg: avgFps,
          lastMs: lastMs,
          avgMs: samples ? sumMs / samples : 0,
          maxMs: maxMs,
          loopAlive: false,
          schedule: scheduleMode,
          hidden: !!(document && document.hidden),
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
    if (profilerOn() && t1 - sampleAt >= 250) {
      sampleAt = t1;
      try {
        emitProfiler({
          type: 'profiler',
          frames: window.__frames,
          fps: instantFps,
          fpsAvg: avgFps,
          lastMs: lastMs,
          avgMs: samples ? sumMs / samples : 0,
          maxMs: maxMs,
          loopAlive: true,
          schedule: scheduleMode,
          hidden: !!(document && document.hidden),
        });
      } catch (err) {}
    }
    schedule(frame);
  }
  // requestAnimationFrame does not fire while the page is hidden, which stops
  // the game entirely rather than pausing it. Fall back to a timer so a
  // background tab keeps running (slowly, as the browser clamps it).
  function schedule(fn) {
    if (document.hidden) {
      scheduleMode = 'timeout';
      setTimeout(fn, 16);
    } else {
      scheduleMode = 'raf';
      requestAnimationFrame(fn);
    }
  }
  schedule(frame);
};

function tryLoadRuntime() {
  // With a title screen on the page the Play button starts the load instead.
  if (document.getElementById('title')) return;
  if (typeof window.loadRuntime === 'function') window.loadRuntime();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryLoadRuntime);
} else {
  tryLoadRuntime();
}
