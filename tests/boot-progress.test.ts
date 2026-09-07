import { describe, expect, test } from "bun:test";
import { runHost } from "./harness.ts";

describe("boot progress", () => {
  test("a failure after startup restores a visible message and keeps logs", () => {
    const { window, elements } = runHost();
    window.reportBootError("runtime failure");
    expect(elements.get("boot")?.textContent).toBe("runtime failure");
    expect(elements.get("boot")?.role).toBe("alert");
    window.reportBootError("next failure");
    expect(elements.get("boot")?.textContent).toBe("next failure");
    expect(window.__errs).toHaveLength(2);
    expect(window.__bootFailed).toBe(true);
    expect(window.__boot.getState().failed).toBe(true);

    const errorText = elements.get("boot")?.textContent;
    window.__boot.setRuntime(4, 10);
    expect(elements.get("boot")?.textContent).toBe(errorText);
    expect(window.__boot.getState().runtimeLoaded).toBe(0);
  });

  test("runtime, stage, and asset counts drive the combined bar", () => {
    const progress = runHost();
    progress.window.__boot.setRuntime(4, 10);
    expect(progress.window.__boot.getState().percent).toBe(20);
    expect(progress.window.__boot.getState().status).toBe("loading the .NET runtime");
    expect(progress.window.__boot.getState().detail).toBe("4 / 10 files");

    progress.window.reportBootStage("running");
    expect(progress.window.__stages).toHaveLength(1);
    expect(progress.window.__stages[0]).toBe("running");
    expect(progress.window.__boot.getState().runtimeDone).toBe(true);
    expect(progress.window.__boot.getState().percent).toBe(50);
    expect(progress.window.__boot.getState().status).toBe("starting the game");

    progress.window.__boot.setAssets(631, 1262);
    expect(progress.window.__boot.getState().percent).toBe(75);
    expect(progress.window.__boot.getState().status).toBe("loading game assets");
    expect(progress.window.__boot.getState().detail).toBe("631 / 1262 files");

    const xhr = new progress.window.XMLHttpRequest();
    xhr.open("GET", "Content/Maps/Town.xnb");
    xhr.send();
    expect(progress.window.__boot.getState().assetsLoaded).toBe(632);

    const ignored = new progress.window.XMLHttpRequest();
    ignored.open("GET", "_framework/dotnet.native.wasm");
    ignored.send();
    expect(progress.window.__boot.getState().assetsLoaded).toBe(632);

    progress.elements.set("boot", {
      remove() {
        progress.elements.delete("boot");
      },
    });
    progress.window.clearBoot();
    expect(progress.window.__boot.getState().percent).toBe(100);
    expect(progress.window.__boot.getState().visible).toBe(false);
    expect(progress.elements.has("boot")).toBe(false);
  });
});
