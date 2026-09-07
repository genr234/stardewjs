import { describe, expect, test } from "bun:test";
import { runHost, runInHost, runtimeJs, RUNTIME_SCRIPTS, waitUntil } from "./harness.ts";

describe("main-thread fallback", () => {
  test("without OffscreenCanvas the host injects runtime scripts on this thread", async () => {
    const fallback = runHost({ fallback: true });
    fallback.readyListeners[0]?.();
    expect(fallback.workers).toHaveLength(0);
    let started = false;
    const fallbackScripts = ["js/runtime.js", ...RUNTIME_SCRIPTS];
    for (let i = 0; i < fallbackScripts.length; i++) {
      const src = fallbackScripts[i]!;
      await waitUntil(() => fallback.appended.length === i + 1);
      const script = fallback.appended[i];
      expect(script.src).toBe(src);
      if (src.includes("runtime.js")) {
        runInHost(runtimeJs, fallback.window);
      }
      if (src.includes("blazor.webassembly.js")) {
        expect(script.attributes.autostart).toBe("false");
        fallback.window.Blazor = {
          start() {
            started = true;
            return Promise.resolve();
          },
        };
      }
      script.onload();
    }
    await waitUntil(() => started && fallback.fetches[0] === "_framework/blazor.boot.json");
    expect(fallback.appended).toHaveLength(fallbackScripts.length);
  });
});
