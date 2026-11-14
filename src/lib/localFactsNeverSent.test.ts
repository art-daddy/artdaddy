// A tripwire for a promise. The local record of facts (localFacts.ts) lives on this PC and is NEVER
// SENT. Nothing that talks to a server may reach for it, and nothing may name the key it is stored
// under, or the record could ride out inside a request or a crash report without anyone deciding
// that it should. Sending it needs the owner's approval of a privacy text first. This test is what
// makes whoever tries ask: if it fails, do not change the test to make it pass.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FACTS_KEY } from "./localFacts";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

// The code that sends things: every call to the server, and what is reported about crashes and
// errors. Each is held to the same rule.
const GUARDED = ["api", "observability", "agent", "update"] as const;

/** The files of a source tree, so the whole scan can run on a tree made up in memory as well as on
 *  the real one. Paths are relative to src and use "/". */
interface Tree {
  list(dir: string): Array<{ name: string; isDir: boolean }>;
  read(file: string): string;
}

const disk: Tree = {
  list: (dir) =>
    readdirSync(join(SRC, dir), { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDir: entry.isDirectory(),
    })),
  read: (file) => readFileSync(join(SRC, file), "utf8"),
};

/** A tree made of the given files: path (relative to src, with "/") to content. */
function treeOf(files: Record<string, string>): Tree {
  return {
    list(dir) {
      const below = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(`${dir}/`)) continue;
        const [first, ...rest] = path.slice(dir.length + 1).split("/");
        below.set(first, below.get(first) === true || rest.length > 0);
      }
      return [...below].map(([name, isDir]) => ({ name, isDir }));
    },
    read: (file) => files[file],
  };
}

/** Every non-test .ts/.tsx file under `dir`, recursively. */
function sourcesUnder(tree: Tree, dir: string): string[] {
  return tree.list(dir).flatMap(({ name, isDir }) => {
    const path = `${dir}/${name}`;
    if (isDir) return sourcesUnder(tree, path);
    return /\.tsx?$/.test(name) && !/\.(test|spec|e2e)\.tsx?$/.test(name) ? [path] : [];
  });
}

// A quoted module whose last path segment is localFacts, however it is written: a static import
// (on one line or across several), a dynamic import, a require, an export-from, a mock. Only the
// quoted name matters, which is what a line-by-line import matcher gets wrong for a long import.
const QUOTED_MODULE = /["'`](?:[^"'`\r\n]*\/)?localFacts(?:\.[cm]?[jt]sx?)?["'`]/;
// The stem of the storage key, so a version bump or a key split in two still trips it.
const KEY_STEM = "local_facts";

/** Why `source` must not be there, or null when it is fine. */
function offence(source: string): string | null {
  if (QUOTED_MODULE.test(source)) return "names the localFacts module";
  if (source.includes(KEY_STEM) || source.includes(FACTS_KEY))
    return "names the facts' storage key";
  return null;
}

/** The files under `dir` that must not be there, each with the reason. */
function offencesUnder(tree: Tree, dir: string): string[] {
  return sourcesUnder(tree, dir).flatMap((file) => {
    const why = offence(tree.read(file));
    return why === null ? [] : [`${file} ${why}`];
  });
}

const report = (found: string[]) =>
  `${found.join("; ")}. The local facts stay on this PC; sending them anywhere needs the owner's ` +
  "approval of the privacy text first.";

describe("the detector", () => {
  it.each([
    ['import { recordFact } from "../lib/localFacts";'],
    ["import {\n  readFacts,\n  recordFact,\n} from '../lib/localFacts';"],
    ['export { readFacts } from "./localFacts";'],
    ['import * as facts from "src/lib/localFacts";'],
    ['const facts = await import("../../lib/localFacts");'],
    ['import("./localFacts.js")'],
    ["const facts = require('./localFacts.ts');"],
    ["vi.mock('../lib/localFacts', () => ({}));"],
    ["localStorage.getItem('artdaddy.local_facts.v1');"],
    ["localStorage.getItem('artdaddy.local_facts.v2');"],
    ['const key = "artdaddy." + "local_facts" + ".v1";'],
    ["// the record under artdaddy.local_facts.v1 is never sent"],
    [`localStorage.getItem("${FACTS_KEY}")`],
  ])("catches %s", (source) => {
    expect(offence(source)).not.toBeNull();
  });

  it.each([
    ['import { http } from "./http";'],
    ['import { recordFact } from "../lib/factsLocal";'],
    ['import { x } from "../lib/localFactsOther";'],
    ['const text = "local facts are kept here";'],
    ['import { MODEL_FAILURE_KINDS } from "../tools/modelFailure";'],
    [""],
  ])("leaves alone %j", (source) => {
    expect(offence(source)).toBeNull();
  });
});

// The whole scan, on a tree made up here: a file that reaches for the facts must be found, wherever
// it sits, and named in what the failure says. This is what shows the real scan below can fail.
describe("the scan", () => {
  const tree = treeOf({
    "api/http.ts": 'import { x } from "./y";',
    "api/deep/er/send.ts": 'import {\n  recordFact,\n} from "../../../lib/localFacts";',
    "api/panel.tsx": 'const key = "artdaddy.local_facts.v1";',
    "api/send.test.ts": 'import "../lib/localFacts";',
    "api/send.e2e.ts": 'import "../lib/localFacts";',
    "api/data.json": '{"local_facts": 1}',
    "observability/crash.ts": 'const facts = await import("../lib/localFacts");',
    "observability/ok.ts": "export const ok = 1;",
    "tools/transcribe.ts": 'import { recordFact } from "../lib/localFacts";',
  });

  it("finds a file that imports the facts or names their key, wherever it sits under a guarded directory", () => {
    expect(offencesUnder(tree, "api")).toEqual([
      "api/deep/er/send.ts names the localFacts module",
      "api/panel.tsx names the facts' storage key",
    ]);
    expect(offencesUnder(tree, "observability")).toEqual([
      "observability/crash.ts names the localFacts module",
    ]);
  });

  it("leaves tests and other kinds of file alone, and everything outside the guarded directories", () => {
    expect(sourcesUnder(tree, "api")).not.toContain("api/send.test.ts");
    expect(sourcesUnder(tree, "api")).not.toContain("api/send.e2e.ts");
    expect(sourcesUnder(tree, "api")).not.toContain("api/data.json");
    expect(sourcesUnder(tree, "observability")).toEqual([
      "observability/crash.ts",
      "observability/ok.ts",
    ]);
  });

  it("says which file it is, and that sending the facts needs the owner's approval of the privacy text", () => {
    const message = report(offencesUnder(tree, "api"));
    expect(message).toContain("api/deep/er/send.ts");
    expect(message).toContain("api/panel.tsx");
    expect(message).toMatch(/owner's approval of the privacy text/);
  });

  it("finds nothing in a tree that keeps to the rule", () => {
    const clean = treeOf({ "api/a.ts": "export {};", "api/b/c.ts": "export {};" });
    expect(offencesUnder(clean, "api")).toEqual([]);
  });
});

describe.each(GUARDED)("src/%s never reaches for the local facts", (name) => {
  it("holds .ts source files to look at, or this test would pass for nothing", () => {
    const files = sourcesUnder(disk, name);
    expect(files.some((file) => file.endsWith(".ts"))).toBe(true);
    // and what it reads is code, so an empty read cannot make the next test pass
    expect(files.some((file) => /\bfrom\s+["']/.test(disk.read(file)))).toBe(true);
  });

  it("imports nothing from localFacts and names no key of it", () => {
    const found = offencesUnder(disk, name);
    expect(found, report(found)).toEqual([]);
  });
});
