import { describe, expect, test } from "bun:test";
import { runHost } from "./harness.ts";

describe("game loop", () => {
  test("counts only completed ticks and stops when managed execution stops", () => {
    const { window, scheduled, events } = runHost();
    let calls = 0;
    window.startGameLoop({ invokeMethod: () => ++calls === 1 });
    expect(events).toEqual(["resize"]);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(window.__frames).toBe(1);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(window.__frames).toBe(1);
    expect(scheduled).toHaveLength(0);
  });

  test("a frame cap drops whole animation frames rather than timing out", () => {
    const { window, scheduled } = runHost();
    let now = 0;
    window.performance = { now: () => now };
    // 30 per second on a 60 Hz display: every other frame should tick.
    window.__frameCap = 30;
    window.startGameLoop({ invokeMethod: () => true });
    expect(scheduled).toHaveLength(1);

    // One display frame in is inside the budget, so nothing is ticked and
    // another animation frame is asked for instead.
    now = 16.7;
    scheduled.shift()?.();
    expect(window.__frames).toBe(0);
    expect(scheduled).toHaveLength(1);

    // Two frames in, the budget has passed.
    now = 33.4;
    scheduled.shift()?.();
    expect(window.__frames).toBe(1);

    now = 50.1;
    scheduled.shift()?.();
    expect(window.__frames).toBe(1);

    now = 66.8;
    scheduled.shift()?.();
    expect(window.__frames).toBe(2);
  });

  test("an uncapped loop ticks on every animation frame", () => {
    const { window, scheduled } = runHost();
    let now = 0;
    window.performance = { now: () => now };
    window.startGameLoop({ invokeMethod: () => true });
    now = 16.7;
    scheduled.shift()?.();
    expect(window.__frames).toBe(1);
    now = 33.4;
    scheduled.shift()?.();
    expect(window.__frames).toBe(2);
  });

  test("a hidden tab keeps ticking unless the player asked it not to", () => {
    const running = runHost();
    running.document.hidden = true;
    running.window.startGameLoop({ invokeMethod: () => true });
    running.scheduled.shift()?.();
    expect(running.window.__frames).toBe(1);

    const paused = runHost();
    paused.document.hidden = true;
    paused.window.__pauseWhenHidden = true;
    paused.window.startGameLoop({ invokeMethod: () => true });
    // What is scheduled while hidden only looks again; it does not tick.
    paused.scheduled.shift()?.();
    expect(paused.window.__frames).toBe(0);
    expect(paused.scheduled).toHaveLength(1);

    // Once the tab comes back, that same check schedules a real frame again.
    paused.document.hidden = false;
    paused.scheduled.shift()?.();
    expect(paused.window.__frames).toBe(0);
    paused.scheduled.shift()?.();
    expect(paused.window.__frames).toBe(1);
  });

  test("an interop exception stops the loop without counting a failed frame", () => {
    const { window, scheduled } = runHost();
    window.startGameLoop({
      invokeMethod() {
        throw new Error("interop failure");
      },
    });
    scheduled.shift()?.();
    expect(window.__frames).toBe(0);
    expect(scheduled).toHaveLength(0);
  });
});
