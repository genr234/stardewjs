import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { edit, editLines, patch, PatchError, splitKeepNewlines } from "../scripts/patch.ts";

function tempSrc(): string {
  const dir = mkdtempSync(join(tmpdir(), "stardew-patch-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("splitKeepNewlines", () => {
  test("keeps trailing newlines like Python readlines", () => {
    expect(splitKeepNewlines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitKeepNewlines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitKeepNewlines("")).toEqual([]);
  });
});

describe("edit", () => {
  test("replaces the expected number of occurrences", () => {
    const src = tempSrc();
    writeFileSync(join(src, "Game.cs"), "foo bar foo\n");
    edit(src, "Game.cs", [["foo", "baz", 2]]);
    expect(readFileSync(join(src, "Game.cs"), "utf8")).toBe("baz bar baz\n");
  });

  test("throws when the count does not match", () => {
    const src = tempSrc();
    writeFileSync(join(src, "Game.cs"), "foo bar foo\n");
    expect(() => edit(src, "Game.cs", [["foo", "baz", 1]])).toThrow(PatchError);
    expect(() => edit(src, "Game.cs", [["foo", "baz", 1]])).toThrow(
      "Game.cs: expected 1 occurrence(s) of pattern, found 2",
    );
    expect(readFileSync(join(src, "Game.cs"), "utf8")).toBe("foo bar foo\n");
  });
});

describe("editLines", () => {
  test("replaces inside a specific 1-based line", () => {
    const src = tempSrc();
    writeFileSync(join(src, "Net.cs"), "_dict.FieldDict\nkeep\n_dict.FieldDict\n");
    editLines(src, "Net.cs", [[1, "_dict.FieldDict", "dict.FieldDict"]]);
    expect(readFileSync(join(src, "Net.cs"), "utf8")).toBe("dict.FieldDict\nkeep\n_dict.FieldDict\n");
  });

  test("throws when the line does not contain the pattern", () => {
    const src = tempSrc();
    writeFileSync(join(src, "Net.cs"), "alpha\nbeta\n");
    expect(() => editLines(src, "Net.cs", [[2, "_dict", "dict"]])).toThrow(PatchError);
    expect(readFileSync(join(src, "Net.cs"), "utf8")).toBe("alpha\nbeta\n");
  });
});

describe("patch", () => {
  test("replaces once and is a no-op when the replacement is already present", () => {
    const src = tempSrc();
    writeFileSync(join(src, "Runner.cs"), "original line\n");
    patch(src, "Runner.cs", "original line", "patched line");
    expect(readFileSync(join(src, "Runner.cs"), "utf8")).toBe("patched line\n");
    patch(src, "Runner.cs", "original line", "patched line");
    expect(readFileSync(join(src, "Runner.cs"), "utf8")).toBe("patched line\n");
  });

  test("throws when the original is missing", () => {
    const src = tempSrc();
    writeFileSync(join(src, "Runner.cs"), "something else\n");
    expect(() => patch(src, "Runner.cs", "original line", "patched line")).toThrow(
      "Runner.cs: expected 1 match(es), found 0",
    );
  });
});
