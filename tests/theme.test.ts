import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as vm from "node:vm";
import { bundle, html } from "./harness.ts";

const themeBundle = await bundle("js/theme.js");

type ThemeRun = {
  window: vm.Context & Record<string, any>;
  /** Custom properties written onto the root element, by name. */
  properties: Map<string, string>;
  root: Record<string, any>;
  windowListeners: Record<string, Array<(event: any) => void>>;
};

/** Runs js/theme.js against a stand-in root element to capture its properties. */
function runTheme(options: { settings?: Record<string, unknown>; roll?: number } = {}): ThemeRun {
  const properties = new Map<string, string>();
  const windowListeners: Record<string, Array<(event: any) => void>> = {};
  const stored = new Map<string, string>();
  if (options.settings) stored.set("stardew.settings", JSON.stringify(options.settings));
  const root: Record<string, any> = {
    attributes: {} as Record<string, string>,
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
  };
  const document: Record<string, any> = {
    documentElement: root,
    addEventListener() {},
  };
  const window: Record<string, any> = {
    addEventListener(type: string, fn: (event: any) => void) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    dispatchEvent(event: { type: string }) {
      for (const fn of windowListeners[event.type] || []) fn(event);
      return true;
    },
  };
  const context = vm.createContext(
    Object.assign(window, {
      window,
      document,
      Object,
      Map,
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, String(value)),
        removeItem: (key: string) => void stored.delete(key),
      },
      CustomEvent: class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    }),
  );
  if (options.roll !== undefined) {
    vm.runInContext(`Math.random = () => ${options.roll};`, context);
  }
  vm.runInContext(themeBundle, context);
  return { window: window as ThemeRun["window"], properties, root, windowListeners };
}

describe("the theme", () => {
  test("paints the stored palette onto the root element", () => {
    const { properties, root } = runTheme({ settings: { "ui.theme": "coop" } });
    expect(root.attributes["data-theme"]).toBe("coop");
    expect(properties.get("--ui-bg")).toBe("#f8c81a");
    expect(properties.get("--ui-on-accent")).toBe("#ffe9b0");
    expect(properties.get("--ui-accent-light")).toBe("#cc5f22");
  });

  test("every theme fills in every colour the stylesheet asks for", () => {
    // A theme missing a property would leave a rule painting nothing.
    const names = [...html.matchAll(/var\(--ui-([a-z-]+)\)/g)].map((match) => match[1]!);
    const wanted = [...new Set(names)].filter((name) => !name.startsWith("pattern"));
    expect(wanted.length).toBeGreaterThan(5);
    for (const id of ["stardew", "blueberry", "pepper", "blossom", "coop"]) {
      const { properties } = runTheme({ settings: { "ui.theme": id } });
      for (const name of wanted) {
        expect(properties.get("--ui-" + name)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("lays a repeating wallpaper down at half its own width", () => {
    const { properties } = runTheme({ settings: { "ui.theme": "blueberry" } });
    expect(properties.get("--ui-pattern")).toBe('url("themes/blueberry.png")');
    // Half of 3156, so each source pixel lands on exactly two.
    expect(properties.get("--ui-pattern-size")).toBe("1578px auto");
    expect(properties.get("--ui-pattern-repeat")).toBe("repeat");
    expect(properties.get("--ui-pattern-rendering")).toBe("pixelated");
  });

  test("a wallpaper that is a picture rather than a pattern covers instead", () => {
    const { properties } = runTheme({ settings: { "ui.theme": "stardew" } });
    expect(properties.get("--ui-pattern")).toBe('url("themes/stardew.jpg")');
    expect(properties.get("--ui-pattern-size")).toBe("cover");
    expect(properties.get("--ui-pattern-repeat")).toBe("no-repeat");
    expect(properties.get("--ui-pattern-rendering")).toBe("auto");
  });

  test("every theme ships the wallpaper it names", async () => {
    const { window } = runTheme({ settings: { "ui.theme": "stardew" } });
    for (const entry of window.themeState().list) {
      const file = Bun.file(join(import.meta.dir, "../src/web/wwwroot", entry.wallpaper.src));
      expect(await file.exists()).toBe(true);
    }
  });

  test("follows the menu without a reload", () => {
    const { window, properties, root } = runTheme({ settings: { "ui.theme": "stardew" } });
    expect(root.attributes["data-theme"]).toBe("stardew");
    window.settingsState().set("ui.theme", "blossom");
    expect(root.attributes["data-theme"]).toBe("blossom");
    expect(properties.get("--ui-bg")).toBe("#f7ced9");
    // A reset un-chooses the theme, so the page goes back to rolling one.
    window.settingsState().forget();
    expect(window.themeState().list.map((entry: any) => entry.id))
      .toContain(root.attributes["data-theme"]);
  });

  test("a name no longer on the list falls back rather than blanking the page", () => {
    const { properties, root } = runTheme({ settings: { "ui.theme": "no-such-theme" } });
    expect(root.attributes["data-theme"]).toBe("stardew");
    expect(properties.get("--ui-fg")).toBe("#cfc6a8");
  });

  test("a player who has never picked one gets a different theme each visit", () => {
    const ids = ["stardew", "blueberry", "pepper", "blossom", "coop"];
    for (let index = 0; index < ids.length; index += 1) {
      const roll = (index + 0.5) / ids.length;
      const { root, window } = runTheme({ roll });
      expect(root.attributes["data-theme"]).toBe(ids[index]);
      expect(window.settingsState().values["ui.theme"]).toBeUndefined();
      expect(window.themeState().chosen).toBe(ids[index]);
    }
  });

  test("picking one in the menu stops the rolling", () => {
    const { window, root } = runTheme({ roll: 0.9 });
    expect(root.attributes["data-theme"]).toBe("coop");
    window.settingsState().set("ui.theme", "pepper");
    expect(root.attributes["data-theme"]).toBe("pepper");
    expect(window.settingsState().values["ui.theme"]).toBe("pepper");
    const next = runTheme({ settings: { "ui.theme": "pepper" }, roll: 0.9 });
    expect(next.root.attributes["data-theme"]).toBe("pepper");
  });

  test("the menu leads with the picker, one swatch per theme", () => {
    expect(html).toMatch(/js\/theme\.js/);
    expect(html).toMatch(/x-for="theme in \$store\.themes\.list"/);
    expect(html).toContain("$store.settings.set('ui.theme', theme.id)");
    expect(html).toContain("$store.themes.preview(theme.id)");
    expect(html).toContain("$store.themes.chosen === theme.id");
    expect(html).not.toContain("$store.settings.get('ui.theme') === theme.id");
    expect(html.indexOf('class="settings-heading">Theme<'))
      .toBeLessThan(html.indexOf('class="settings-heading">Sound<'));
    expect(html).toMatch(/background-repeat: var\(--ui-pattern-repeat\)/);
    expect(html).toMatch(/background-size: var\(--ui-pattern-size\)/);
  });
});
