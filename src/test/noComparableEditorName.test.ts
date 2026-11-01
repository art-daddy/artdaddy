// The comparable editor is never named: not in code, comments, tests, file names or documents of
// this repository (owner rule, 2026-11-01). Describe what the code does, not who else does it.
//
// The name is built from parts, so this file is not itself a match. Every file git knows (tracked,
// or new and not ignored) is searched, and file names are checked too. Where there is no git
// checkout (a copied sandbox), the tree is walked and read instead; an empty tree can never pass.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const NAME = ["pal", "mier"].join("");
const NAMED = new RegExp(NAME, "i");
const ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "reports",
  "test-results",
  ".stryker-tmp",
  "binaries",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
}

/** Every file git knows about, or every file under the root when there is no git checkout. */
function repoFiles(): string[] {
  try {
    const listed = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: ROOT,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const files = listed.toString("utf8").split("\0").filter(Boolean);
    if (files.length) return files;
  } catch {
    /* no git here: walk the tree below */
  }
  return walk(ROOT);
}

/** A text file's contents, or null for a binary one (a NUL byte in its first 8 KB). */
function textOf(file: string): string | null {
  const full = path.join(ROOT, file);
  try {
    if (!statSync(full).isFile()) return null;
    const bytes = readFileSync(full);
    return bytes.subarray(0, 8192).includes(0) ? null : bytes.toString("utf8");
  } catch {
    return null; // listed by git but deleted in the working tree
  }
}

/** Lines of text files (tracked, or new and not ignored) that match, as "file:line"; null when git
 *  cannot search here. One git process, so it stays fast when the test runners are all busy. */
function gitGrep(pattern: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-I", "-i", "-n", "-E", "--untracked", "-e", pattern, "--", "."],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(":").slice(0, 2).join(":"));
  } catch (e) {
    return (e as { status?: number }).status === 1 ? [] : null; // status 1 is "no match"
  }
}

const files = repoFiles();

describe("the comparable editor is never named", () => {
  it("looks at the whole repository, so an empty list cannot pass", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("package.json");
    expect(files.some((f) => f.startsWith("src/tools/"))).toBe(true);
  });

  it("notices the name in every form it is written (the matcher itself)", () => {
    const title = NAME[0].toUpperCase() + NAME.slice(1);
    for (const sample of [
      NAME,
      title,
      NAME.toUpperCase(),
      `${title} Pro's rule`,
      `see ${title}'s grid`,
    ])
      expect(NAMED.test(sample), sample).toBe(true);
    for (const clean of ["a palette of colours", "the editor", "pal mier"])
      expect(NAMED.test(clean), clean).toBe(false);
  });

  it("is in no file name", () => {
    expect(files.filter((f) => NAMED.test(f))).toEqual([]);
  });

  it("searches what it claims to: git finds this very file by a phrase it contains", () => {
    const found = gitGrep("comparable editor is never named");
    if (found === null) return; // no git here: the next test reads the files itself
    expect(found.map((hit) => hit.split(":")[0])).toContain(
      "src/test/noComparableEditorName.test.ts",
    );
  });

  it("is in no file's text", { timeout: 60_000 }, () => {
    const viaGit = gitGrep(NAME);
    if (viaGit !== null) {
      expect(viaGit).toEqual([]);
      return;
    }
    const hits: string[] = [];
    for (const file of files) {
      const text = textOf(file);
      if (text === null || !NAMED.test(text)) continue;
      const line = text.split(/\r?\n/).findIndex((l) => NAMED.test(l)) + 1;
      hits.push(`${file}:${line}`);
    }
    expect(hits).toEqual([]);
  });
});
