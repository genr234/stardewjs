// Game.Exit() throws in KNI's browser backend and a page can't close itself,
// so quitting stops the loop and shows an overlay. See src/web/BrowserExit.cs.
(function (root) {
  root.browserExit = {
    // phase: 'exiting' | 'exited'. error: a save that could not be committed.
    report(phase, error) {
      const message = { type: 'exit', phase: phase, error: error || '' };
      if (root.browserExitPage) root.browserExitPage.apply(message);
      else root.postMessage(message);
    },
  };
})(typeof self !== 'undefined' ? self : window);
