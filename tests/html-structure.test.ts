import { describe, expect, test } from "bun:test";
import { html, hostJs, jigsawJs, ownershipJs, runtimeJs, settingsJs, RUNTIME_SCRIPTS } from "./harness.ts";

describe("html and script structure", () => {
  test("does not inline scripts or Blazor framework URLs", () => {
    expect([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]).toHaveLength(0);
    expect(html).not.toMatch(/_content\//);
    expect(html).not.toMatch(/_framework\//);
    expect(html).not.toMatch(/blazor\.webassembly/);
  });

  test("loads the host shell and boot overlay", () => {
    expect(html).toMatch(/js\/alpine\.min\.js/);
    expect(html).toMatch(/js\/host\.js/);
    expect(html).toMatch(/js\/boot-jigsaw\.js/);
    expect(html).toMatch(/id="boot-jigsaw"/);
    expect(html).toMatch(/x-data/);
    expect(html).toMatch(/\$store\.boot\.percent/);
    expect(html).toMatch(/x-text="\$store\.boot\.status"/);
    expect(html).toMatch(/id="profiler"/);
    expect(html).toMatch(/pointer-events:\s*none/);
  });

  test("shows a title screen with a play button", () => {
    expect(html).toMatch(/id="title"/);
    expect(html).toMatch(/x-show="\$store\.title\.visible"/);
    expect(html).toMatch(/@click="\$store\.title\.play\(\)"/);
    expect(html).toMatch(/>Play</);
  });

  test("the title screen and the tab wear the logo", () => {
    expect(html).toMatch(/<link rel="icon" href="chicken-js\.png" \/>/);
    expect([...html.matchAll(/<img class="title-logo" src="chicken-js\.png" alt="Stardew Valley"/g)])
      .toHaveLength(2);
    expect(html).not.toMatch(/>Stardew Valley<\/h1>/);
  });

  test("the title screen offers a settings menu", () => {
    expect(html).toMatch(/js\/settings\.js/);
    expect(html).toMatch(/@click="\$store\.settings\.open\(\)"/);
    expect(html).toMatch(/@click="\$store\.settings\.close\(\)"/);
    expect(html).toMatch(/x-show="!\$store\.settings\.visible"/);
    expect(html).toMatch(/x-show="\$store\.settings\.visible"/);
    expect(settingsJs).toMatch(/Alpine\.store\('settings', settings\)/);
    expect(settingsJs).toMatch(/visible: false/);
  });

  test("the settings menu covers sound, performance, picture, co-op, saves and the pad", () => {
    for (const name of [
      'audio.master', 'audio.music', 'audio.effects',
      'pacing.fpsCap', 'pacing.pauseWhenHidden',
      'display.renderScale', 'display.crisp',
      'net.relay',
      'input.deadzone', 'input.pointerLock',
    ]) {
      expect(html).toContain("$store.settings.get('" + name + "')");
      expect(html).toContain("$store.settings.set('" + name + "'");
    }
    expect(html).toMatch(/js\/save-transfer\.js/);
    expect(html).toMatch(/\$store\.saves\.runExport\(\)/);
    expect(html).toMatch(/\$store\.saves\.runImport\(\$event\)/);
    expect(html).toMatch(/@click="toggleFullscreen\(\)"/);
    expect(html).toMatch(/\$store\.settings\.forget\(\)/);
    expect(html).toMatch(/\.settings-panel \{[^}]*overflow-y: auto/);
    expect(html.indexOf('js/save-storage.js')).toBeLessThan(html.indexOf('js/save-transfer.js'));
  });

  test("the settings menu offers the profiler overlay", () => {
    expect(html).toMatch(/\$store\.settings\.get\('profiler'\)/);
    expect(html).toMatch(/\$store\.settings\.set\('profiler', \$event\.target\.checked\)/);
    expect(hostJs).toMatch(/window\.profilerPreference = function/);
    expect(hostJs).toMatch(/addEventListener\('settings-change'/);
    expect(hostJs).toMatch(/setEnabled: function/);
    expect(settingsJs).toMatch(/EVENT = 'settings-change'/);
  });

  test("what the settings menu holds outlives the tab", () => {
    expect(settingsJs).toMatch(/STORAGE_KEY = 'stardew\.settings'/);
    expect(settingsJs).toMatch(/localStorage\.getItem\(STORAGE_KEY\)/);
    expect(settingsJs).toMatch(/localStorage\.setItem\(STORAGE_KEY/);
    expect(settingsJs).toMatch(/try \{[\s\S]*getItem[\s\S]*catch/);
    expect(settingsJs).toMatch(/try \{[\s\S]*setItem[\s\S]*catch/);
    expect(settingsJs).not.toMatch(/visible['"]?\s*:\s*load\(/);
  });

  test("gates the title screen behind proof of ownership", () => {
    expect(html).toMatch(/js\/ownership\.js/);
    expect(html).toMatch(/x-if="!\$store\.ownership\.ready"/);
    expect(html).toMatch(/x-if="\$store\.ownership\.ready && !\$store\.ownership\.unlocked"/);
    expect(html).toMatch(/x-if="\$store\.ownership\.ready && \$store\.ownership\.unlocked"/);
    expect(html).toMatch(/type="file"/);
    expect(html).toMatch(/@change="\$store\.ownership\.submit\(\$event\)"/);
    expect(html).toMatch(/x-text="\$store\.ownership\.error"/);
    expect(html.indexOf('js/ownership.js')).toBeLessThan(html.indexOf('js/host.js'));
  });

  test("the host will not start a boot without an unlock", () => {
    expect(hostJs).toMatch(/ownershipState/);
    expect(hostJs).toMatch(/!owner \|\| !owner\.unlocked/);
  });

  test("the page asks the host rather than deciding for itself", () => {
    expect(ownershipJs).toMatch(/ENDPOINT = 'ownership'/);
    expect(ownershipJs).toMatch(/post\('\/challenge'\)/);
    expect(ownershipJs).toMatch(/post\('\/answer'/);
    // Nothing about the unlock is kept where the page could forge it.
    expect(ownershipJs).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  test("boot jigsaw points at the puzzle image", () => {
    expect(jigsawJs).toMatch(/boot-jigsaw\/puzzle\.png/);
  });

  test("host transfers the canvas to a worker", () => {
    expect(hostJs).toMatch(/game\.worker\.js/);
    expect(hostJs).toMatch(/transferControlToOffscreen/);
  });

  test("runtime lists every Blazor/KNI script and disables autostart", () => {
    expect(runtimeJs).toMatch(/autostart/);
    expect(runtimeJs).toMatch(/blazor\.webassembly\.js/);
    for (const src of RUNTIME_SCRIPTS) {
      expect(runtimeJs).toMatch(new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
