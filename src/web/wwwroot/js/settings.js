// The settings menu hangs off the title screen. It holds the choices the page
// makes on the player's behalf - sound levels, how hard to work the machine,
// where multiplayer dials - as opposed to the ones the game itself keeps in
// its own options menu.
//
// What the menu holds outlives the tab. `values` is the bag every option will
// live in, loaded from localStorage at startup and written back on each change,
// so a setting picked once stays picked. `visible` is not part of that: which
// half of the title panel is drawn is this visit's business.
//
// Alpine's store is a proxy around this object, and only a write through the
// proxy redraws the page, so every read goes through settingsState() rather
// than closing over the plain object.
(function (root) {
  const STORAGE_KEY = 'stardew.settings';
  // Fired on window whenever a setting changes. Each feature listens for its
  // own name from wherever it lives: audio in js/audio-output.js, the rest in
  // js/host.js, which is also where the worker is told.
  const EVENT = 'settings-change';

  // What the game does when the player has never said otherwise. Everything the
  // menu can change is listed here, so a read is answered the same way whether
  // or not it has ever been written, and so this file is the one place to look
  // for what the menu holds.
  const DEFAULTS = {
    // Levels the page applies on top of the game's own sliders, 0 to 1.
    'audio.master': 1,
    'audio.music': 1,
    'audio.effects': 1,
    // 0 leaves the loop on the display's own refresh rate.
    'pacing.fpsCap': 0,
    'pacing.pauseWhenHidden': false,
    // A fraction of the device's pixels to render into. Below 1 the game draws
    // fewer pixels and the browser stretches them, which buys frames.
    'display.renderScale': 1,
    'display.crisp': true,
    // Where the relay lives. Empty means the host that served this page.
    'net.relay': '',
    // Axis travel ignored around the stick's centre, as a fraction of full.
    // Off by default: a pad that does not drift should reach the game exactly
    // as the browser reported it.
    'input.deadzone': 0,
    'input.pointerLock': true,
    'profiler': false,
  };

  // Private browsing and blocked site data both throw rather than return
  // nothing, and a half-written value parses as garbage. None of that is worth
  // a broken title screen, so a bad read is simply an empty menu.
  function load() {
    try {
      const raw = root.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      /* fall through to the defaults */
    }
    return {};
  }

  function save(values) {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch (err) {
      /* a setting that cannot be kept still applies to this tab */
    }
  }

  const settings = { visible: false, values: load() };

  function current() {
    if (root.Alpine) {
      const stored = root.Alpine.store('settings');
      if (stored) return stored;
    }
    return settings;
  }

  settings.open = function () {
    current().visible = true;
  };

  settings.close = function () {
    current().visible = false;
  };

  // `fallback` is for a caller that wants something other than the documented
  // default; almost nobody does, and the menu never passes one.
  settings.get = function (name, fallback) {
    const values = current().values;
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    if (fallback !== undefined) return fallback;
    return DEFAULTS[name];
  };

  settings.defaults = function () {
    return Object.assign({}, DEFAULTS);
  };

  settings.set = function (name, value) {
    const state = current();
    state.values[name] = value;
    save(state.values);
    // Each feature wires itself to its own setting from wherever it lives,
    // rather than this file growing a list of everything the menu can change.
    announce(name, value);
    return value;
  };

  // Back to the defaults, announced one name at a time so every listener sees
  // the same kind of change it would see from the menu.
  settings.forget = function () {
    const state = current();
    const had = Object.keys(state.values);
    state.values = {};
    save(state.values);
    for (const name of had) announce(name, DEFAULTS[name]);
  };

  // A page without CustomEvent is a page too old to run the game; a listener
  // that throws is its own problem and must not cost the caller its setting.
  function announce(name, value) {
    try {
      root.dispatchEvent(new root.CustomEvent(EVENT, { detail: { name: name, value: value } }));
    } catch (err) {
      /* the value is stored either way */
    }
  }

  root.settingsState = current;

  root.document.addEventListener('alpine:init', function () {
    root.Alpine.store('settings', settings);
  });
})(window);
