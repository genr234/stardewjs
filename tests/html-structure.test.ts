import { describe, expect, test } from "bun:test";
import { html, hostJs, jigsawJs, runtimeJs, RUNTIME_SCRIPTS } from "./harness.ts";

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
