// Themes for the page around the game: a palette written as --ui-* custom
// properties on the root element, and a wallpaper from themes/.
import { settingsState } from './settings.js';

const SETTING = 'ui.theme';

// Tile wallpapers are laid at half their `width` so every source pixel lands on
// exactly two; a `scene` covers the page instead.
const THEMES = [
  {
    id: 'stardew',
    name: 'Stardew',
    palette: {
      bg: '#1b1a17',
      fg: '#cfc6a8',
      accent: '#e6c35c',
      accentLight: '#f4e19a',
      onAccent: '#1b1a17',
      muted: '#8a8370',
      sunken: '#0e0d0b',
      line: '#6b6455',
      rule: '#3a3832',
      error: '#d98b6a',
    },
    wallpaper: { src: 'themes/stardew.jpg', fit: 'scene' },
  },
  {
    id: 'blueberry',
    name: 'Blueberry',
    palette: {
      bg: '#2e33b4',
      fg: '#e9ecff',
      accent: '#7fe6ff',
      accentLight: '#c8f4ff',
      onAccent: '#161a6e',
      muted: '#a9aef0',
      sunken: '#20248f',
      line: '#5f65d8',
      rule: '#454ac4',
      error: '#ffb7a2',
    },
    wallpaper: { src: 'themes/blueberry.png', fit: 'tile', width: 3156 },
  },
  {
    id: 'pepper',
    name: 'Hot Pepper',
    palette: {
      bg: '#c01818',
      fg: '#ffe9d6',
      accent: '#ffd166',
      accentLight: '#ffe7b0',
      onAccent: '#5c0a0a',
      muted: '#f0a294',
      sunken: '#8f1010',
      line: '#e4604e',
      rule: '#d4483a',
      error: '#ffd8c8',
    },
    wallpaper: { src: 'themes/pepper.png', fit: 'tile', width: 3156 },
  },
  {
    id: 'blossom',
    name: 'Blossom',
    palette: {
      bg: '#f7ced9',
      fg: '#4a2b38',
      accent: '#d94f7e',
      accentLight: '#ee85a6',
      onAccent: '#fff2f6',
      muted: '#95697b',
      sunken: '#fde7ef',
      line: '#dd9db3',
      rule: '#e8b8c8',
      error: '#a3253d',
    },
    wallpaper: { src: 'themes/blossom.png', fit: 'tile', width: 3156 },
  },
  {
    id: 'coop',
    name: 'Coop',
    palette: {
      bg: '#f8c81a',
      fg: '#402f10',
      accent: '#a8440e',
      accentLight: '#cc5f22',
      onAccent: '#ffe9b0',
      muted: '#8a6b22',
      sunken: '#ffdf88',
      line: '#c39a24',
      rule: '#e0b83a',
      error: '#8c2312',
    },
    wallpaper: { src: 'themes/coop.png', fit: 'tile', width: 384 },
  },
];

const BY_ID = new Map(THEMES.map(function (theme) { return [theme.id, theme]; }));
const DEFAULT_ID = THEMES[0].id;

function theme(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_ID);
}

// Until the player picks a theme, each visit rolls a random one. The null
// fallback distinguishes "never picked" from the documented default.
function chosenId() {
  const settings = settingsState();
  const stored = settings && typeof settings.get === 'function' ? settings.get(SETTING, null) : null;
  if (BY_ID.has(stored)) return stored;
  // A stored theme this build no longer ships falls back to the default.
  return stored === null ? THEMES[Math.floor(Math.random() * THEMES.length)].id : DEFAULT_ID;
}

// Separate properties because tiles and scenes need different background rules.
function backdrop(chosen, scale) {
  const paper = chosen.wallpaper;
  if (!paper) return { image: 'none', size: 'auto', repeat: 'repeat', rendering: 'auto' };
  const image = 'url("' + paper.src + '")';
  if (paper.fit === 'scene') {
    // Nearest-neighbour at an arbitrary cover scale makes pixel art crawl, so smooth it.
    return { image: image, size: 'cover', repeat: 'no-repeat', rendering: 'auto' };
  }
  return {
    image: image,
    size: Math.round(paper.width * scale) + 'px auto',
    repeat: 'repeat',
    rendering: 'pixelated',
  };
}

function apply(id) {
  const chosen = theme(id);
  // Through the Alpine store so the menu redraws.
  state().chosen = chosen.id;
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return chosen;
  for (const [name, value] of Object.entries(chosen.palette)) {
    root.style.setProperty('--ui-' + name.replace(/[A-Z]/g, function (letter) {
      return '-' + letter.toLowerCase();
    }), value);
  }
  const paper = backdrop(chosen, 0.5);
  root.style.setProperty('--ui-pattern', paper.image);
  root.style.setProperty('--ui-pattern-size', paper.size);
  root.style.setProperty('--ui-pattern-repeat', paper.repeat);
  root.style.setProperty('--ui-pattern-rendering', paper.rendering);
  if (root.setAttribute) root.setAttribute('data-theme', chosen.id);
  return chosen;
}

function preview(id) {
  const chosen = theme(id);
  const paper = backdrop(chosen, 0.16);
  return {
    backgroundColor: chosen.palette.bg,
    backgroundImage: paper.image,
    backgroundSize: paper.size,
    backgroundRepeat: paper.repeat,
    backgroundPosition: 'center',
    imageRendering: paper.rendering,
    borderColor: chosen.palette.line,
  };
}

const themes = {
  list: THEMES,
  // The theme actually shown, which may be this visit's roll rather than a stored choice.
  chosen: DEFAULT_ID,
  preview: preview,
  apply: apply,
  current: function () { return theme(chosenId()); },
};

function state() {
  if (typeof window !== 'undefined' && window.Alpine) {
    const stored = window.Alpine.store('themes');
    if (stored) return stored;
  }
  return themes;
}

apply(chosenId());

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('settings-change', function (event) {
    const detail = event && event.detail;
    if (!detail || detail.name !== SETTING) return;
    // Re-read rather than trust the event: a reset should re-roll.
    apply(chosenId());
  });
}

export { themes, THEMES, apply as applyTheme };
window.themeState = function () { return themes; };

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('alpine:init', function () {
    window.Alpine.store('themes', themes);
  });
}
