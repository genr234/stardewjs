// A jigsaw to play with while the game downloads. Mounts itself on the boot
// overlay's canvas.
var DEFAULTS = {
  src: 'boot-jigsaw/puzzle.png',
  cols: 0,
  rows: 0,
  snap: 0.38,
};

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

function chooseGrid(image, cols, rows) {
  if (cols > 0 && rows > 0) return { cols: cols, rows: rows };
  if (image.width / Math.max(image.height, 1) >= 1.4) return { cols: 4, rows: 3 };
  return { cols: 3, rows: 3 };
}

function pieceSize(canvas, cols, rows) {
  return {
    w: canvas.width / cols,
    h: canvas.height / rows,
  };
}

export function mountBootJigsaw(canvas, options) {
  options = options || {};
  var src = options.src || DEFAULTS.src;
  var snapRatio = options.snap || DEFAULTS.snap;
  var ctx = canvas.getContext('2d');
  if (!ctx) return function () {};

  var image = new Image();
  var pieces = [];
  var cols = 0;
  var rows = 0;
  var cellW = 0;
  var cellH = 0;
  var drag = null;
  var completeUntil = 0;
  var scrambleTimer = 0;
  var destroyed = false;

  ctx.imageSmoothingEnabled = false;

  function stopEvent(event) {
    if (!event) return;
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (event.preventDefault) event.preventDefault();
  }

  function localPoint(event) {
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / Math.max(rect.width, 1);
    var scaleY = canvas.height / Math.max(rect.height, 1);
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  function hitPiece(x, y) {
    for (var i = pieces.length - 1; i >= 0; i--) {
      var piece = pieces[i];
      if (x >= piece.x && x < piece.x + cellW && y >= piece.y && y < piece.y + cellH) {
        return piece;
      }
    }
    return null;
  }

  function isSolved() {
    var limit = snapRatio * Math.min(cellW, cellH) * 0.35;
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      if (Math.abs(piece.x - piece.homeX) > limit || Math.abs(piece.y - piece.homeY) > limit) {
        return false;
      }
    }
    return pieces.length > 0;
  }

  function scramble() {
    var homes = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        homes.push({ x: c * cellW, y: r * cellH });
      }
    }
    var order = shuffleInPlace(homes.slice());
    var same = order.every(function (home, i) {
      return home.x === homes[i].x && home.y === homes[i].y;
    });
    if (same && order.length > 1) {
      var swap = order[0];
      order[0] = order[1];
      order[1] = swap;
    }
    for (var i = 0; i < pieces.length; i++) {
      pieces[i].x = order[i].x;
      pieces[i].y = order[i].y;
    }
    completeUntil = 0;
  }

  function buildPieces() {
    var grid = chooseGrid(image, options.cols || DEFAULTS.cols, options.rows || DEFAULTS.rows);
    cols = grid.cols;
    rows = grid.rows;
    var size = pieceSize(canvas, cols, rows);
    cellW = size.w;
    cellH = size.h;
    var srcW = image.width / cols;
    var srcH = image.height / rows;
    pieces = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        pieces.push({
          sx: c * srcW,
          sy: r * srcH,
          sw: srcW,
          sh: srcH,
          homeX: c * cellW,
          homeY: r * cellH,
          x: c * cellW,
          y: r * cellH,
        });
      }
    }
    scramble();
  }

  function snapPiece(piece) {
    var threshold = snapRatio * Math.min(cellW, cellH);
    if (Math.abs(piece.x - piece.homeX) <= threshold && Math.abs(piece.y - piece.homeY) <= threshold) {
      piece.x = piece.homeX;
      piece.y = piece.homeY;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0e0d0b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(207, 198, 168, 0.28)';
    ctx.lineWidth = 1;
    for (var c = 0; c <= cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cellW + 0.5, 0);
      ctx.lineTo(c * cellW + 0.5, canvas.height);
      ctx.stroke();
    }
    for (var r = 0; r <= rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellH + 0.5);
      ctx.lineTo(canvas.width, r * cellH + 0.5);
      ctx.stroke();
    }
    var glow = completeUntil && performance.now() < completeUntil;
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      if (drag && piece === drag.piece) continue;
      ctx.drawImage(image, piece.sx, piece.sy, piece.sw, piece.sh, piece.x, piece.y, cellW, cellH);
    }
    if (drag) {
      ctx.drawImage(image, drag.piece.sx, drag.piece.sy, drag.piece.sw, drag.piece.sh, drag.piece.x, drag.piece.y, cellW, cellH);
    }
    if (glow) {
      ctx.fillStyle = 'rgba(244, 225, 154, 0.18)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function onSolved() {
    var hold = prefersReducedMotion() ? 120 : 520;
    completeUntil = performance.now() + hold;
    if (scrambleTimer) clearTimeout(scrambleTimer);
    scrambleTimer = setTimeout(function () {
      if (destroyed) return;
      scramble();
      draw();
    }, hold);
    draw();
  }

  function onPointerDown(event) {
    stopEvent(event);
    if (completeUntil && performance.now() < completeUntil) return;
    var point = localPoint(event);
    var piece = hitPiece(point.x, point.y);
    if (!piece) return;
    var idx = pieces.indexOf(piece);
    if (idx >= 0) {
      pieces.splice(idx, 1);
      pieces.push(piece);
    }
    drag = { piece: piece, dx: point.x - piece.x, dy: point.y - piece.y };
    if (canvas.setPointerCapture && event.pointerId != null) {
      try { canvas.setPointerCapture(event.pointerId); } catch (err) {}
    }
    draw();
  }

  function onPointerMove(event) {
    if (!drag) return;
    stopEvent(event);
    var point = localPoint(event);
    drag.piece.x = point.x - drag.dx;
    drag.piece.y = point.y - drag.dy;
    draw();
  }

  function onPointerUp(event) {
    if (!drag) return;
    stopEvent(event);
    snapPiece(drag.piece);
    drag = null;
    draw();
    if (isSolved()) onSolved();
  }

  function onLostCapture() {
    if (!drag) return;
    snapPiece(drag.piece);
    drag = null;
    draw();
    if (isSolved()) onSolved();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('contextmenu', stopEvent);
  canvas.addEventListener('dragstart', stopEvent);

  image.onload = function () {
    if (destroyed) return;
    buildPieces();
    draw();
  };
  image.onerror = function () {
    if (destroyed) return;
    ctx.fillStyle = '#0e0d0b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  image.src = src;

  return function destroy() {
    destroyed = true;
    if (scrambleTimer) clearTimeout(scrambleTimer);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('lostpointercapture', onLostCapture);
    canvas.removeEventListener('contextmenu', stopEvent);
    canvas.removeEventListener('dragstart', stopEvent);
  };
}

function start() {
  var canvas = document.getElementById('boot-jigsaw');
  if (!canvas || canvas.dataset.mounted) return;
  canvas.dataset.mounted = '1';
  mountBootJigsaw(canvas);
}

// Tests evaluate this while the document is still loading.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
