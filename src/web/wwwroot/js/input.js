// KNI derives the cursor from 'mousemove', so a synthetic one is how the game
// moves it (see src/web/BrowserMouse.cs). Coordinates are client pixels.
(function (root) {
  root.browserInput = {
    setMousePosition: function (x, y) {
      if (typeof importScripts === 'function') {
        // The worker's window shim takes plain objects.
        root.dispatchEvent({ type: 'mousemove', clientX: x, clientY: y, buttons: 0 });
        return;
      }
      var event;
      try {
        event = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true });
      } catch (err) {
        event = new Event('mousemove');
        event.clientX = x;
        event.clientY = y;
      }
      event.__syntheticCursor = true;
      root.dispatchEvent(event);
    },
  };
})(typeof self !== 'undefined' ? self : window);
