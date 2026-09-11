import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { html, runHost } from "./harness.ts";

const exitSource = await Bun.file(new URL("../src/web/wwwroot/js/exit.js", import.meta.url)).text();

/** The runtime half, as it runs in the game worker: no page, so it posts. */
function runInWorker() {
  const posted: any[] = [];
  const context: Record<string, any> = {
    postMessage: (message: unknown) => posted.push(message),
    importScripts() {},
  };
  context.self = context;
  runInNewContext(exitSource, context);
  return { context, posted };
}

describe("exit", () => {
  test("the runtime half posts the shutdown to the page", () => {
    const { context, posted } = runInWorker();
    context.browserExit.report("exiting", "");
    context.browserExit.report("exited", "");
    expect(posted).toEqual([
      { type: "exit", phase: "exiting", error: "" },
      { type: "exit", phase: "exited", error: "" },
    ]);
  });

  test("the main-thread fallback calls the page half directly", () => {
    const applied: any[] = [];
    const context: Record<string, any> = {
      browserExitPage: { apply: (message: unknown) => applied.push(message) },
      postMessage() {
        throw new Error("the fallback has no page to post to");
      },
    };
    context.self = context;
    runInNewContext(exitSource, context);
    context.browserExit.report("exited", "");
    expect(applied).toEqual([{ type: "exit", phase: "exited", error: "" }]);
  });

  test("the page shows the shutdown, then offers a way back", () => {
    const runtime = runHost();
    runtime.readyListeners[0]?.();
    expect(runtime.window.exitState().visible).toBe(false);

    runtime.workers[0].onmessage({ data: { type: "exit", phase: "exiting", error: "" } });
    let state = runtime.window.exitState();
    expect(state.visible).toBe(true);
    expect(state.done).toBe(false);
    expect(state.status).toBe("closing the game");

    runtime.workers[0].onmessage({ data: { type: "exit", phase: "exited", error: "" } });
    state = runtime.window.exitState();
    expect(state.done).toBe(true);
    expect(state.status).toBe("the game has closed");
    expect(state.detail).toBe("your farm is saved in this browser");
  });

  test("a save that could not be committed is said so, not swallowed", () => {
    const runtime = runHost();
    runtime.readyListeners[0]?.();
    runtime.workers[0].onmessage({
      data: { type: "exit", phase: "exited", error: "Could not persist browser saves." },
    });
    const state = runtime.window.exitState();
    expect(state.done).toBe(true);
    expect(state.status).toMatch(/could not be written/);
    expect(state.detail).toBe("Could not persist browser saves.");
  });

  test("the overlay starts hidden so it cannot flash before Alpine loads", () => {
    expect(html).toMatch(/<div id="exit"[^>]*\shidden/);
    expect(html).toMatch(/#exit\[hidden\]\s*\{\s*display:\s*none;/);
    // Alpine owns it from then on, and the attribute is what it toggles.
    expect(html).toMatch(/x-effect="\$el\.hidden = !\$store\.exit\.visible"/);
  });
});
