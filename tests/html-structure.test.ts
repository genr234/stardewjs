import { describe, expect, test } from "bun:test";
import { html, hostJs, jigsawJs, ownershipJs, runtimeJs, RUNTIME_SCRIPTS } from "./harness.ts";

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
