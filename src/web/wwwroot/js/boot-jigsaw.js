// A jigsaw to play with while the game downloads. Mounts itself on the boot
// overlay's canvas. The board is always full: dropping a tile on another swaps
// the two, and a tile that reaches its home locks there.

// Sprites from the game's Content/Animals, cut from their right-facing frame
// and scaled by whole pixels. Every page load shuffles the order.
var DEFAULTS = {
  pictures: [
    { src: 'boot-jigsaw/puzzle.png', name: 'chicken' },
    { src: 'boot-jigsaw/void-chicken.png', name: 'void chicken' },
    { src: 'boot-jigsaw/golden-chicken.png', name: 'golden chicken' },
    { src: 'boot-jigsaw/duck.png', name: 'duck' },
    { src: 'boot-jigsaw/rabbit.png', name: 'rabbit' },
    { src: 'boot-jigsaw/dinosaur.png', name: 'dinosaur' },
    { src: 'boot-jigsaw/cow.png', name: 'cow' },
    { src: 'boot-jigsaw/goat.png', name: 'goat' },
    { src: 'boot-jigsaw/sheep.png', name: 'sheep' },
    { src: 'boot-jigsaw/pig.png', name: 'pig' },
    { src: 'boot-jigsaw/ostrich.png', name: 'ostrich' },
    { src: 'boot-jigsaw/cat.png', name: 'cat' },
    { src: 'boot-jigsaw/dog.png', name: 'dog' },
    { src: 'boot-jigsaw/turtle.png', name: 'turtle' },
  ],
  // Each solve moves to the next grid; the last one repeats.
  grids: [3, 4],
};

var STORAGE_KEY = 'stardew.jigsaw';
// A press that travels less than this is a tap, which selects instead of drags.
var TAP_SLOP = 5;
var LIFT = 1.06;

function prefersReducedMotion() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

function shuffleInPlace(items) {
  for (var i = items.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

function loadBest() {
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY);
    var parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function saveBest(best) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(best));
  } catch (err) {}
}

// The page's theme, read on every paint so the board follows a theme change.
function readPalette(el) {
  var style = null;
  try { style = getComputedStyle(el); } catch (err) {}
  function pick(name, fallback) {
    var value = style ? style.getPropertyValue('--ui-' + name).trim() : '';
    return value || fallback;
  }
  return {
    bg: pick('bg', '#1b1a17'),
    fg: pick('fg', '#cfc6a8'),
    accent: pick('accent', '#e6c35c'),
    accentLight: pick('accent-light', '#f4e19a'),
    sunken: pick('sunken', '#0e0d0b'),
    line: pick('line', '#6b6455'),
    rule: pick('rule', '#3a3832'),
  };
}

export function mountBootJigsaw(canvas, options) {
  options = options || {};
  var pictures = options.pictures ||
    (options.src ? [{ src: options.src, name: '' }] : DEFAULTS.pictures);
  var grids = options.grids || DEFAULTS.grids;
  var note = options.note || null;
  var ctx = canvas.getContext('2d');
  if (!ctx) return function () {};

  // Logical size is the canvas's own attributes; the backing store is scaled
  // up for the screen so tile edges stay sharp.
  var size = { w: canvas.width, h: canvas.height };
  var dpr = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
  canvas.width = size.w * dpr;
  canvas.height = size.h * dpr;

  var image = null;
  var picture = null;
  var order = shuffleInPlace(pictures.slice());
  var turn = 0;
  var upcoming = null;
  var ready = false;
  var pieces = [];
  var slots = [];
  var cols = 0;
  var rows = 0;
  var cellW = 0;
  var cellH = 0;
  var level = 0;
  var moves = 0;
  var best = loadBest();
  var press = null;
  var drag = null;
  var selected = null;
  var cursor = 0;
  var keyboard = false;
  var celebrateAt = 0;
  var scrambleTimer = 0;
  var frame = 0;
  var lastTick = 0;
  var destroyed = false;
  var reduced = prefersReducedMotion();

  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', 'tile puzzle');
  canvas.setAttribute('aria-label',
    'Picture puzzle. Drag a tile onto another to swap them, or tap two tiles. ' +
    'With the keyboard, arrow keys move, Enter or Space picks up and swaps, Escape drops.');

  function stopEvent(event) {
    if (!event) return;
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (event.preventDefault) event.preventDefault();
  }

  // Maps into the content box: the page draws a border and padding around
  // the canvas as its frame.
  function localPoint(event) {
    var rect = canvas.getBoundingClientRect();
    var style = getComputedStyle(canvas);
    var left = rect.left + canvas.clientLeft + (parseFloat(style.paddingLeft) || 0);
    var top = rect.top + canvas.clientTop + (parseFloat(style.paddingTop) || 0);
    var width = canvas.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    var height = canvas.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    return {
      x: (event.clientX - left) * size.w / Math.max(width, 1),
      y: (event.clientY - top) * size.h / Math.max(height, 1),
    };
  }

  function slotX(slot) { return (slot % cols) * cellW; }
  function slotY(slot) { return Math.floor(slot / cols) * cellH; }

  function slotAt(x, y) {
    var c = Math.floor(x / cellW);
    var r = Math.floor(y / cellH);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
    return r * cols + c;
  }

  function placedCount() {
    var n = 0;
    for (var i = 0; i < pieces.length; i++) if (pieces[i].locked) n++;
    return n;
  }

  function isSolved() {
    return pieces.length > 0 && placedCount() === pieces.length;
  }

  function setNote(text) {
    if (note && note.textContent !== text) note.textContent = text;
  }

  function updateNote() {
    if (!ready) return;
    var key = cols + 'x' + rows;
    if (isSolved()) {
      var record = best[key] === moves ? ' — a new best!' : ' — best ' + best[key];
      var what = picture && picture.name ? 'the ' + picture.name + ' ' : '';
      setNote('solved ' + what + 'in ' + moves + (moves === 1 ? ' move' : ' moves') + record);
      return;
    }
    var text = placedCount() + '/' + pieces.length + ' in place · ' +
      moves + (moves === 1 ? ' move' : ' moves');
    if (best[key]) text += ' · best ' + best[key];
    setNote(text);
  }

  // Fully transparent tiles all look alike, so any of them belongs in any
  // blank home; otherwise the player would have to guess between them.
  function fits(piece, slot) {
    return slot === piece.home || (piece.blank && pieces[slot].blank);
  }

  function lockIfHome(piece) {
    if (!piece.locked && fits(piece, piece.slot)) {
      piece.locked = true;
      piece.flashAt = performance.now();
    }
  }

  function placeAll(instant) {
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      if (instant || reduced) {
        piece.x = slotX(piece.slot);
        piece.y = slotY(piece.slot);
      }
    }
  }

  function scramble() {
    var n = cols * rows;
    var deal = [];
    for (var i = 0; i < n; i++) deal.push(i);
    // A derangement, so every tile starts somewhere it can be moved from.
    do {
      shuffleInPlace(deal);
    } while (n > 1 && deal.some(function (slot, home) { return slot === home; }));
    slots = new Array(n);
    for (var k = 0; k < pieces.length; k++) {
      var piece = pieces[k];
      piece.slot = deal[piece.home];
      piece.flashAt = 0;
      slots[piece.slot] = piece;
      // Blank tiles dealt onto a blank home are already right.
      piece.locked = fits(piece, piece.slot);
    }
    moves = 0;
    selected = null;
    celebrateAt = 0;
    placeAll(false);
    updateNote();
    wake();
  }

  function buildPieces() {
    var grid = grids[Math.min(level, grids.length - 1)];
    cols = grid;
    rows = grid;
    cellW = size.w / cols;
    cellH = size.h / rows;
    var srcW = image.width / cols;
    var srcH = image.height / rows;
    var blank = blankCells(srcW, srcH);
    var centreX = size.w / 2 - cellW / 2;
    var centreY = size.h / 2 - cellH / 2;
    pieces = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        pieces.push({
          home: r * cols + c,
          slot: r * cols + c,
          sx: c * srcW,
          sy: r * srcH,
          sw: srcW,
          sh: srcH,
          // New tiles deal out from the middle of the board.
          x: centreX,
          y: centreY,
          blank: blank[r * cols + c],
          locked: false,
          flashAt: 0,
        });
      }
    }
    cursor = Math.min(cursor, pieces.length - 1);
    scramble();
  }

  function blankCells(srcW, srcH) {
    var blank = [];
    var data = null;
    try {
      var probe = document.createElement('canvas');
      probe.width = image.width;
      probe.height = image.height;
      var pctx = probe.getContext('2d');
      pctx.drawImage(image, 0, 0);
      data = pctx.getImageData(0, 0, image.width, image.height).data;
    } catch (err) {}
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var empty = !!data;
        var x1 = Math.ceil((c + 1) * srcW);
        var y1 = Math.ceil((r + 1) * srcH);
        for (var y = Math.floor(r * srcH); empty && y < y1; y++) {
          for (var x = Math.floor(c * srcW); x < x1; x++) {
            if (data[(y * image.width + x) * 4 + 3]) { empty = false; break; }
          }
        }
        blank.push(empty);
      }
    }
    return blank;
  }

  // Moves `piece` into `target`, sending whatever was there to the slot it
  // left. Returns whether anything moved.
  function swapInto(piece, target) {
    if (target < 0 || target === piece.slot) return false;
    var other = slots[target];
    if (other && other.locked) return false;
    var from = piece.slot;
    slots[from] = other;
    slots[target] = piece;
    piece.slot = target;
    if (other) other.slot = from;
    moves++;
    lockIfHome(piece);
    if (other) lockIfHome(other);
    if (isSolved()) onSolved();
    updateNote();
    return true;
  }

  // -- drawing --------------------------------------------------------------

  function drawTile(piece, x, y, w, h, colours) {
    // The picture has a transparent background, so tiles get a card of their
    // own to read as tiles against the board.
    ctx.fillStyle = colours.bg;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colours.line;
    ctx.globalAlpha = piece.locked ? 0.18 : 0.32;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    if (ready) ctx.drawImage(image, piece.sx, piece.sy, piece.sw, piece.sh, x, y, w, h);
    if (piece.locked) return;
    // A bevel marks the tiles that still move.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(x, y, w, 2);
    ctx.fillRect(x, y, 2, h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(x, y + h - 2, w, 2);
    ctx.fillRect(x + w - 2, y, 2, h);
  }

  function strokeCell(slot, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.strokeRect(slotX(slot) + width / 2 + 1, slotY(slot) + width / 2 + 1,
      cellW - width - 2, cellH - width - 2);
  }

  function draw(now) {
    var colours = readPalette(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = colours.sunken;
    ctx.fillRect(0, 0, size.w, size.h);
    if (!ready) return;

    // Loose tiles under moving ones, the held tile over everything.
    var order = pieces.slice().sort(function (a, b) {
      return rank(a) - rank(b);
    });
    for (var i = 0; i < order.length; i++) {
      var piece = order[i];
      if (drag && piece === drag.piece) continue;
      drawTile(piece, piece.x, piece.y, cellW, cellH, colours);
      if (piece.flashAt) {
        var t = (now - piece.flashAt) / 420;
        if (t >= 1 || reduced) {
          piece.flashAt = 0;
        } else {
          ctx.fillStyle = colours.accentLight;
          ctx.globalAlpha = 0.55 * (1 - t);
          ctx.fillRect(piece.x, piece.y, cellW, cellH);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Seams between locked neighbours vanish; the rest keep a faint grid.
    ctx.fillStyle = colours.rule;
    ctx.globalAlpha = 0.5;
    for (var c = 1; c < cols; c++) ctx.fillRect(Math.round(c * cellW), 0, 1, size.h);
    for (var r = 1; r < rows; r++) ctx.fillRect(0, Math.round(r * cellH), size.w, 1);
    ctx.globalAlpha = 1;

    if (selected) {
      var pulse = reduced ? 1 : 0.65 + 0.35 * Math.sin(now / 140);
      ctx.globalAlpha = pulse;
      // A dark ring under the accent keeps it visible on light themes.
      strokeCell(selected.slot, 'rgba(0, 0, 0, 0.6)', 5);
      strokeCell(selected.slot, colours.accentLight, 3);
      ctx.globalAlpha = 1;
    }

    if (drag) {
      var target = slotAt(drag.piece.x + cellW / 2, drag.piece.y + cellH / 2);
      var occupant = target >= 0 ? slots[target] : null;
      if (target >= 0 && target !== drag.piece.slot && !(occupant && occupant.locked)) {
        ctx.setLineDash([4, 3]);
        strokeCell(target, colours.accentLight, 2);
        ctx.setLineDash([]);
      }
      var w = cellW * LIFT;
      var h = cellH * LIFT;
      var x = drag.piece.x - (w - cellW) / 2;
      var y = drag.piece.y - (h - cellH) / 2;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(x + 4, y + 5, w, h);
      drawTile(drag.piece, x, y, w, h, colours);
      ctx.strokeStyle = colours.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }

    if (keyboard && !drag) strokeCell(cursor, colours.fg, 2);

    if (celebrateAt) drawCelebration(now, colours);
  }

  function rank(piece) {
    if (piece === selected) return 3;
    if (piece.x !== slotX(piece.slot) || piece.y !== slotY(piece.slot)) return 2;
    return piece.locked ? 0 : 1;
  }

  // A band of light sweeps across the finished picture.
  function drawCelebration(now, colours) {
    var t = (now - celebrateAt) / 900;
    if (reduced) t = 0.5;
    if (t > 1) return;
    var span = size.w + size.h;
    var edge = -size.h + t * (span + size.h);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = colours.accentLight;
    ctx.beginPath();
    ctx.moveTo(edge, 0);
    ctx.lineTo(edge + 36, 0);
    ctx.lineTo(edge + 36 - size.h, size.h);
    ctx.lineTo(edge - size.h, size.h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = colours.accent;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, size.w - 4, size.h - 4);
  }

  // -- animation ------------------------------------------------------------

  function tick(now) {
    frame = 0;
    if (destroyed) return;
    var dt = Math.min(64, lastTick ? now - lastTick : 16);
    lastTick = now;
    var ease = 1 - Math.pow(0.001, dt / 260);
    var busy = false;
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      if (drag && piece === drag.piece) continue;
      var tx = slotX(piece.slot);
      var ty = slotY(piece.slot);
      if (reduced) {
        piece.x = tx;
        piece.y = ty;
      } else {
        piece.x += (tx - piece.x) * ease;
        piece.y += (ty - piece.y) * ease;
        if (Math.abs(tx - piece.x) < 0.3 && Math.abs(ty - piece.y) < 0.3) {
          piece.x = tx;
          piece.y = ty;
        } else {
          busy = true;
        }
      }
      if (piece.flashAt) busy = true;
    }
    if (selected && !reduced) busy = true;
    if (celebrateAt && now - celebrateAt < 900) busy = true;
    draw(now);
    if (busy) wake();
    else lastTick = 0;
  }

  // Frames only run while something moves, so an idle board costs nothing.
  function wake() {
    if (!frame && !destroyed) frame = requestAnimationFrame(tick);
  }

  function onSolved() {
    var key = cols + 'x' + rows;
    if (!best[key] || moves < best[key]) {
      best[key] = moves;
      saveBest(best);
    }
    selected = null;
    celebrateAt = performance.now();
    if (scrambleTimer) clearTimeout(scrambleTimer);
    scrambleTimer = setTimeout(function () {
      if (destroyed) return;
      level++;
      showNext(0);
    }, reduced ? 1400 : 2200);
    wake();
  }

  // -- input ----------------------------------------------------------------

  function selectOrSwap(piece) {
    if (!piece || celebrateAt) return;
    if (!selected) {
      if (!piece.locked) selected = piece;
    } else if (piece === selected) {
      selected = null;
    } else if (piece.locked) {
      selected = null;
    } else {
      swapInto(selected, piece.slot);
      selected = null;
    }
    wake();
  }

  function onPointerDown(event) {
    stopEvent(event);
    if (canvas.focus) {
      try { canvas.focus({ preventScroll: true }); } catch (err) {}
    }
    keyboard = false;
    if (!ready || celebrateAt || (event.button != null && event.button > 0)) return;
    var point = localPoint(event);
    var slot = slotAt(point.x, point.y);
    var piece = slot >= 0 ? slots[slot] : null;
    if (!piece) return;
    // Measured from the cell, not the drawn tile, which may still be sliding.
    press = {
      piece: piece,
      x: point.x,
      y: point.y,
      dx: point.x - slotX(piece.slot),
      dy: point.y - slotY(piece.slot),
    };
    if (canvas.setPointerCapture && event.pointerId != null) {
      try { canvas.setPointerCapture(event.pointerId); } catch (err) {}
    }
  }

  function onPointerMove(event) {
    var point = localPoint(event);
    if (!press) {
      updateCursor(point);
      return;
    }
    stopEvent(event);
    if (!drag) {
      if (press.piece.locked) return;
      if (Math.abs(point.x - press.x) < TAP_SLOP && Math.abs(point.y - press.y) < TAP_SLOP) return;
      drag = { piece: press.piece, dx: press.dx, dy: press.dy };
      selected = null;
      canvas.style.cursor = 'grabbing';
    }
    drag.piece.x = Math.max(-cellW / 2, Math.min(size.w - cellW / 2, point.x - drag.dx));
    drag.piece.y = Math.max(-cellH / 2, Math.min(size.h - cellH / 2, point.y - drag.dy));
    draw(performance.now());
  }

  function finishPress() {
    var tapped = press && !drag ? press.piece : null;
    if (drag) {
      var piece = drag.piece;
      drag = null;
      swapInto(piece, slotAt(piece.x + cellW / 2, piece.y + cellH / 2));
    }
    press = null;
    canvas.style.cursor = '';
    if (tapped) selectOrSwap(tapped);
    wake();
  }

  function onPointerUp(event) {
    if (!press) return;
    stopEvent(event);
    finishPress();
  }

  function onLostCapture() {
    if (press) finishPress();
  }

  function updateCursor(point) {
    if (!ready || celebrateAt) {
      canvas.style.cursor = 'default';
      return;
    }
    var slot = slotAt(point.x, point.y);
    var piece = slot >= 0 ? slots[slot] : null;
    canvas.style.cursor = piece && !piece.locked ? 'grab' : 'default';
  }

  function onKeyDown(event) {
    if (!ready) return;
    var col = cursor % cols;
    var row = Math.floor(cursor / cols);
    switch (event.key) {
      case 'ArrowLeft': col = Math.max(0, col - 1); break;
      case 'ArrowRight': col = Math.min(cols - 1, col + 1); break;
      case 'ArrowUp': row = Math.max(0, row - 1); break;
      case 'ArrowDown': row = Math.min(rows - 1, row + 1); break;
      case 'Enter':
      case ' ':
        stopEvent(event);
        keyboard = true;
        selectOrSwap(slots[cursor]);
        return;
      case 'Escape':
        if (!selected) return;
        stopEvent(event);
        selected = null;
        wake();
        return;
      default:
        return;
    }
    stopEvent(event);
    keyboard = true;
    cursor = row * cols + col;
    wake();
  }

  function onKeyUp(event) {
    if (/^(Arrow|Enter$| $|Escape$)/.test(event.key)) stopEvent(event);
  }

  function onBlur() {
    keyboard = false;
    wake();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', onBlur);
  canvas.addEventListener('contextmenu', stopEvent);
  canvas.addEventListener('dragstart', stopEvent);

  function fetchPicture(pic) {
    var entry = { pic: pic, img: new Image(), state: 'loading', waiters: [] };
    function settle(state) {
      entry.state = state;
      var waiters = entry.waiters;
      entry.waiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i]();
    }
    entry.img.onload = function () { settle('ready'); };
    entry.img.onerror = function () { settle('failed'); };
    entry.img.src = pic.src;
    return entry;
  }

  function whenSettled(entry, fn) {
    if (entry.state === 'loading') entry.waiters.push(fn);
    else fn();
  }

  // Deals the next picture, and starts fetching the one after so the board
  // never waits between solves. A picture that fails to load is skipped.
  function showNext(failures) {
    var entry = upcoming || fetchPicture(order[turn % order.length]);
    turn++;
    upcoming = order.length > 1 ? fetchPicture(order[turn % order.length]) : null;
    whenSettled(entry, function () {
      if (destroyed) return;
      if (entry.state === 'ready') {
        image = entry.img;
        picture = entry.pic;
        ready = true;
        buildPieces();
      } else if (failures + 1 < order.length) {
        upcoming = null;
        showNext(failures + 1);
      } else if (!ready) {
        setNote('');
        draw(performance.now());
      }
    });
  }

  showNext(0);
  draw(performance.now());

  return function destroy() {
    destroyed = true;
    if (scrambleTimer) clearTimeout(scrambleTimer);
    if (frame) cancelAnimationFrame(frame);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('lostpointercapture', onLostCapture);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('blur', onBlur);
    canvas.removeEventListener('contextmenu', stopEvent);
    canvas.removeEventListener('dragstart', stopEvent);
  };
}

function start() {
  var canvas = document.getElementById('boot-jigsaw');
  if (!canvas || canvas.dataset.mounted) return;
  canvas.dataset.mounted = '1';
  mountBootJigsaw(canvas, { note: document.getElementById('boot-jigsaw-note') });
}

// Tests evaluate this while the document is still loading.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
