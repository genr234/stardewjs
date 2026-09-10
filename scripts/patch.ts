import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export type Substitution = readonly [oldText: string, replacement: string, count: number];
export type LineSubstitution = readonly [lineno: number, oldText: string, replacement: string];

function countLiteral(source: string, snippet: string): number {
  return source.split(snippet).length - 1;
}

/** Split like Python readlines(): keep the trailing newline on every line but the last. */
export function splitKeepNewlines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1) {
      if (parts[i] !== "") lines.push(parts[i]!);
    } else {
      lines.push(`${parts[i]!}\n`);
    }
  }
  return lines;
}

export function edit(srcRoot: string, rel: string, subs: readonly Substitution[]): void {
  const path = join(srcRoot, rel);
  let source = readFileSync(path, "utf8");
  for (const [oldText, replacement, count] of subs) {
    const n = countLiteral(source, oldText);
    if (n !== count) {
      throw new PatchError(`${rel}: expected ${count} occurrence(s) of pattern, found ${n}`);
    }
    source = source.replaceAll(oldText, replacement);
  }
  writeFileSync(path, source);
  console.log(`patched ${rel}`);
}

export function editLines(srcRoot: string, rel: string, lineSubs: readonly LineSubstitution[]): void {
  const path = join(srcRoot, rel);
  const lines = splitKeepNewlines(readFileSync(path, "utf8"));
  for (const [lineno, oldText, replacement] of lineSubs) {
    const i = lineno - 1;
    const line = lines[i];
    if (line === undefined || !line.includes(oldText)) {
      throw new PatchError(
        `${rel}:${lineno}: expected ${JSON.stringify(oldText)}, got ${JSON.stringify(line)}`,
      );
    }
    lines[i] = line.replaceAll(oldText, replacement);
  }
  writeFileSync(path, lines.join(""));
  console.log(`patched ${rel}`);
}

/** Replace `original` with `replacement`, asserting it appears `expected` times. Idempotent. */
export function patch(
  srcRoot: string,
  rel: string,
  original: string,
  replacement: string,
  expected = 1,
): void {
  const path = join(srcRoot, rel);
  const source = readFileSync(path, "utf8");
  if (source.includes(replacement)) {
    console.log(`already patched ${rel}`);
    return;
  }
  const n = countLiteral(source, original);
  if (n !== expected) {
    throw new PatchError(`${rel}: expected ${expected} match(es), found ${n}`);
  }
  writeFileSync(path, source.replaceAll(original, replacement));
  console.log(`patched ${rel}`);
}
