import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import base from "../../vitest.config";

// The unit lane's coverage leaves out what its `coverage.exclude` lists. An entry that names nothing is a reader's trap: a
// file named there looks deliberately left out, and one that comes back under that name is left out without anyone
// deciding it. src/components/LeftColumn.tsx stayed listed long after the file was deleted (the coverage measurement of
// 26 Nov), and src/api/schema.d.ts, a file of the history before this repository's first commit. So every entry must
// still name something that is there: a path, the file; a pattern, at least one file.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every file under `dir`, as a path from the repository root with forward slashes. */
function filesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const entry of readdirSync(path.join(ROOT, at), { withFileTypes: true })) {
      const rel = `${at}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** A coverage pattern as a regular expression: `**` any folders, `*` within one name, `{a,b}` either. */
function patternToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      const choices = pattern.slice(i + 1, end).split(",");
      out += `(?:${choices.map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const isPattern = (entry) => /[*?{}]/.test(entry);

/** The entries of `exclude` that name nothing among `files`. */
function stale(exclude, files) {
  return exclude.filter((entry) => {
    if (!isPattern(entry)) return !files.includes(entry);
    const re = patternToRegExp(entry);
    return !files.some((file) => re.test(file));
  });
}

describe("the unit lane's coverage leaves out only what is there (vitest.config.ts coverage.exclude)", () => {
  const files = filesUnder("src");

  it("names a file that exists, or a pattern that matches one, in every entry", () => {
    const exclude = base.test.coverage.exclude;
    expect(exclude.length).toBeGreaterThan(10);
    expect(stale(exclude, files)).toEqual([]);
  });

  it("finds an entry that names a deleted file, and a pattern that matches nothing", () => {
    expect(stale(["src/main.tsx", "src/components/Gone.tsx"], files)).toEqual([
      "src/components/Gone.tsx",
    ]);
    expect(stale(["src/**/*.test.{ts,tsx}", "src/**/*.nothing-here"], files)).toEqual([
      "src/**/*.nothing-here",
    ]);
  });

  it("reads the patterns the way the coverage settings use them", () => {
    expect(patternToRegExp("src/**/*.d.ts").test("src/vite-env.d.ts")).toBe(true);
    expect(patternToRegExp("src/**/*.d.ts").test("src/api/schema.d.ts")).toBe(true);
    expect(patternToRegExp("src/test/**").test("src/test/setup.ts")).toBe(true);
    expect(patternToRegExp("src/test/**").test("src/tests.ts")).toBe(false);
    expect(patternToRegExp("src/**/*.test.{ts,tsx}").test("src/a/b.test.tsx")).toBe(true);
    expect(patternToRegExp("src/**/*.test.{ts,tsx}").test("src/a/b.test.mjs")).toBe(false);
    expect(patternToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(existsSync(path.join(ROOT, "vitest.config.ts"))).toBe(true);
  });
});
