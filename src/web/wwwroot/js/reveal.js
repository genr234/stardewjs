// The page starts as <html class="ui-pending">, which keeps the title screen
// hidden. Left alone, the first frames would show the raw markup - the settings
// menu and every x-show element before Alpine hides them - then the theme's
// colours arriving, the wallpaper popping in, and the host's answer swapping
// the placeholder for a button. So the page waits until Alpine has drawn it,
// the wallpaper has decoded and the host has said whether this player is
// verified, then fades the finished screen in.
import { THEMES, themes } from './theme.js';

// Whatever hasn't arrived by then (a slow wallpaper, a host not answering)
// shows up late rather than keeping the screen blank.
const WAIT_MS = 2500;

function wallpaperLoaded() {
  const chosen = THEMES.find(function (theme) { return theme.id === themes.chosen; });
  const src = chosen && chosen.wallpaper && chosen.wallpaper.src;
  if (!src) return Promise.resolve();
  const image = new Image();
  image.src = src;
  // decode() also waits for the pixels, not just the bytes; a failure is still "done".
  return image.decode().catch(function () {});
}

function alpineDrawn() {
  return new Promise(function (resolve) {
    document.addEventListener('alpine:initialized', resolve, { once: true });
  });
}

function hostAnswered() {
  return new Promise(function (resolve) {
    window.Alpine.effect(function () {
      if (window.Alpine.store('ownership').ready) resolve();
    });
  });
}

function reveal() {
  document.documentElement.classList.remove('ui-pending');
}

Promise.race([
  Promise.all([wallpaperLoaded(), alpineDrawn().then(hostAnswered)]),
  new Promise(function (resolve) { setTimeout(resolve, WAIT_MS); }),
]).then(reveal, reveal);
