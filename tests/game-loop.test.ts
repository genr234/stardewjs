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
