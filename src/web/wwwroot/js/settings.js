// Settings the page manages itself, as opposed to the game's own options menu.
// Persisted to localStorage. Alpine wraps this object in a proxy and only writes
// through the proxy redraw, so reads go through settingsState().
const STORAGE_KEY = 'stardew.settings';
const EVENT = 'settings-change';

// Every setting the menu can change, with its default.
const DEFAULTS = {
  // Levels the page applies on top of the game's own sliders, 0 to 1.
  'audio.master': 1,
  'audio.music': 1,
  'audio.effects': 1,
  // 0 leaves the loop on the display's own refresh rate.
  'pacing.fpsCap': 0,
  'pacing.pauseWhenHidden': false,
  // Fraction of device pixels to render into; below 1 trades sharpness for frames.
  'display.renderScale': 1,
  'display.crisp': true,
  // Where the relay lives. Empty means the host that served this page.
  'net.relay': '',
  // Stick deadzone as a fraction of full travel.
  'input.deadzone': 0,
  'input.pointerLock': true,
  'profiler': false,
};

// Private browsing throws and a half-written value won't parse; either way,
// start from an empty menu rather than break the title screen.
function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (err) {
    /* fall through to the defaults */
  }
  return {};
}

function save(values) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch (err) {
    /* a setting that cannot be kept still applies to this tab */
  }
}

const settings = { visible: false, values: load() };

function current() {
  if (window.Alpine) {
    const stored = window.Alpine.store('settings');
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
  announce(name, value);
  return value;
};

// Announce each reset name so listeners see the same change the menu makes.
settings.forget = function () {
  const state = current();
  const had = Object.keys(state.values);
  state.values = {};
  save(state.values);
  for (const name of had) announce(name, DEFAULTS[name]);
};

// A throwing listener must not cost the caller its setting.
function announce(name, value) {
  try {
    window.dispatchEvent(new window.CustomEvent(EVENT, { detail: { name: name, value: value } }));
  } catch (err) {
    /* the value is stored either way */
  }
}

// The window copy is for Alpine expressions in index.html and for the tests.
export { current as settingsState };
window.settingsState = current;

window.document.addEventListener('alpine:init', function () {
  window.Alpine.store('settings', settings);
});
