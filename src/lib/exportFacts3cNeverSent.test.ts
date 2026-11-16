// A tripwire for a promise. The six NEW facts of an export report (exportFacts3c.ts: the speed class, the estimate and its basis, the route, the Quick offer and the help
// shown) are a LOCAL record: the client send is HELD until the owner approves the one privacy text. `SEND_3C_FACTS` gates only `factsForReport`, while `factsOf3c` hands out
// the same record unconditionally, so the promise rests on one constant and on nothing but the absence of an import. This test is that absence: nothing that talks to a
// server, runs the agent, reports on crashes, checks for updates or serves MCP may import the module or name anything it exports, and nothing outside the two parts of the
// app that learn a fact (the estimate side and the help side) may either. If it fails, do not change the test to make it pass: sending the facts needs the owner's approval
// of the privacy text first.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as facts from "../timeline/exportFacts3c";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

// The code that sends things or reports on its own: every call to the server, the agent's tools, what is reported about crashes and errors, the update check and the MCP
// server. Each is held to the same rule.
const GUARDED = ["api", "agent", "observability", "update", "mcp"] as const;

/** The module, and the only two files that may name it: the parts of the app that learn a fact and note it. Paths relative to src, with "/". */
const MODULE = "timeline/exportFacts3c.ts";
const WRITERS = ["timeline/estimateAdmission.ts", "timeline/exportHelpWatch.ts"] as const;

/** What the module is called and what it hands out. The exports are read from the module itself, so one that is added to it is guarded the day it is added. */
const EXPORTED = Object.keys(facts);
const VALUE_NAMES = ["exportFacts3c", ...EXPORTED];
/** A type leaves no trace at run time, so it is not among the exports: a request body typed with it is as much a way out as the record. */
const TYPE_NAMES = ["ReportFacts3c"];

/** The files of a source tree, so the whole scan can run on a tree made up in memory as well as on the real one. Paths are relative to src and use "/"; "" is src itself. */
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
      const prefix = dir === "" ? "" : `${dir}/`;
      const below = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split("/");
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
    const path = dir === "" ? name : `${dir}/${name}`;
    if (isDir) return sourcesUnder(tree, path);
    return /\.tsx?$/.test(name) && !/\.(test|spec|e2e)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A name of the module, however it is written: a static import (on one line or across several), a dynamic import, a require, an export-from, a mock, a call, a type, a
 *  comment. Only the whole word matters: a longer name that merely starts with one is not it. */
function offence(source: string, names: readonly string[]): string | null {
  const hit = new RegExp(`\\b(?:${names.join("|")})\\b`).exec(source);
  return hit === null ? null : `names ${hit[0]}`;
}

/** The files under `dir` that must not be there, each with the reason. */
function offencesUnder(tree: Tree, dir: string): string[] {
  return sourcesUnder(tree, dir).flatMap((file) => {
    const why = offence(tree.read(file), [...VALUE_NAMES, ...TYPE_NAMES]);
    return why === null ? [] : [`${file} ${why}`];
  });
}

/** The files of the whole of src, tests apart, that name the module's exports and are neither the module nor one of its two writers. */
function strangersIn(tree: Tree): string[] {
  const welcome = new Set<string>([MODULE, ...WRITERS]);
  return sourcesUnder(tree, "").flatMap((file) => {
    if (welcome.has(file)) return [];
    const why = offence(tree.read(file), VALUE_NAMES);
    return why === null ? [] : [`${file} ${why}`];
  });
}

const report = (found: string[]) =>
  `${found.join("; ")}. The six facts of an export report stay on this PC; sending them anywhere, or letting another part of the app learn them, needs the owner's ` +
  "approval of the privacy text first.";

describe("what is guarded", () => {
  it("is read from the module: the four names the owner's rule is about are among them, so a rename cannot leave the guard empty", () => {
    for (const name of ["SEND_3C_FACTS", "noteFact3c", "factsOf3c", "factsForReport"])
      expect(EXPORTED, name).toContain(name);
    expect(VALUE_NAMES).toContain("exportFacts3c");
    expect(EXPORTED.length).toBeGreaterThanOrEqual(5);
  });
});

describe("the detector", () => {
  const everything = [...VALUE_NAMES, ...TYPE_NAMES];

  it.each([
    ['import { factsOf3c } from "../timeline/exportFacts3c";'],
    ["import {\n  noteFact3c,\n  factsForReport,\n} from '../timeline/exportFacts3c';"],
    ['export { factsOf3c } from "./exportFacts3c";'],
    ['import * as facts from "src/timeline/exportFacts3c";'],
    ['const facts = await import("../../timeline/exportFacts3c");'],
    ["const facts = require('./exportFacts3c.ts');"],
    ["vi.mock('../timeline/exportFacts3c', () => ({}));"],
    ["body.facts = factsOf3c(jobId);"],
    ["const sent = factsForReport(job.id);"],
    ["noteFact3c(jobId, { speed_class: 'weak' });"],
    ["if (SEND_3C_FACTS) post(facts);"],
    ["forgetFacts3c(jobId);"],
    ["const wire: Partial<ReportFacts3c> = {};"],
    ["// the facts live in exportFacts3c and are never sent"],
    ...EXPORTED.map((name) => [`const x = ${name};`]),
  ])("catches %s", (source) => {
    expect(offence(source, everything)).not.toBeNull();
  });

  it.each([
    ['import { http } from "./http";'],
    ['import { x } from "../timeline/exportFacts3cOther";'],
    ["const factsOf3cs = 1;"],
    ["const myNoteFact3c = 1;"],
    ["const exportFacts = 1;"],
    ['const text = "facts of the export are kept here";'],
    ['import { ExportReport } from "../timeline/exportReport";'],
    [""],
  ])("leaves alone %j", (source) => {
    expect(offence(source, everything)).toBeNull();
  });
});

// The whole scan, on a tree made up here: a file that reaches for the facts must be found, wherever it sits, and named in what the failure says. This is what shows the
// real scan below can fail.
describe("the scan", () => {
  const tree = treeOf({
    "api/http.ts": 'import { x } from "./y";',
    "api/deep/er/report.ts":
      'import {\n  factsForReport,\n} from "../../../timeline/exportFacts3c";',
    "api/panel.tsx": "const body = factsOf3c(id);",
    "api/wire.ts": "export type Wire = Partial<ReportFacts3c>;",
    "api/send.test.ts": 'import "../timeline/exportFacts3c";',
    "api/send.e2e.ts": 'import "../timeline/exportFacts3c";',
    "api/data.json": '{"exportFacts3c": 1}',
    "mcp/server.ts": 'const facts = await import("../timeline/exportFacts3c");',
    "mcp/ok.ts": "export const ok = 1;",
    "timeline/exportFacts3c.ts": "export function factsOf3c() {}",
    "timeline/estimateAdmission.ts": 'import { noteFact3c } from "./exportFacts3c";',
    "timeline/exportHelpWatch.ts": 'import { noteFact3c } from "./exportFacts3c";',
    "timeline/exportTypes3c.ts": "export interface ReportFacts3c {}",
    "timeline/routeEstimates.ts": 'import { factsOf3c } from "./exportFacts3c";',
    "lib/telemetry.ts": "post(factsForReport(id));",
    "lib/ok.ts": "export const fine = 1;",
  });

  it("finds a file that imports the module, names what it exports or names the type, wherever it sits under a guarded directory", () => {
    expect(offencesUnder(tree, "api")).toEqual([
      "api/deep/er/report.ts names factsForReport",
      "api/panel.tsx names factsOf3c",
      "api/wire.ts names ReportFacts3c",
    ]);
    expect(offencesUnder(tree, "mcp")).toEqual(["mcp/server.ts names exportFacts3c"]);
  });

  it("finds a stranger anywhere in src: a file that is neither the module nor one of its two writers", () => {
    expect(strangersIn(tree).sort()).toEqual(
      [
        "api/deep/er/report.ts names factsForReport",
        "api/panel.tsx names factsOf3c",
        "lib/telemetry.ts names factsForReport",
        "mcp/server.ts names exportFacts3c",
        "timeline/routeEstimates.ts names factsOf3c",
      ].sort(),
    );
    // the two writers and the module are welcome, the type's own file is not about the record, and a test says what it likes
    expect(strangersIn(treeOf({ "timeline/estimateAdmission.ts": "noteFact3c(id, {});" }))).toEqual(
      [],
    );
    expect(strangersIn(treeOf({ "timeline/x.test.ts": "factsOf3c(id);" }))).toEqual([]);
    expect(
      strangersIn(treeOf({ "timeline/exportTypes3c.ts": "interface ReportFacts3c {}" })),
    ).toEqual([]);
  });

  it("leaves tests and other kinds of file alone, and everything outside the guarded directories", () => {
    expect(sourcesUnder(tree, "api")).not.toContain("api/send.test.ts");
    expect(sourcesUnder(tree, "api")).not.toContain("api/send.e2e.ts");
    expect(sourcesUnder(tree, "api")).not.toContain("api/data.json");
    expect(sourcesUnder(tree, "mcp")).toEqual(["mcp/server.ts", "mcp/ok.ts"]);
    expect(offencesUnder(tree, "lib")).toEqual(["lib/telemetry.ts names factsForReport"]);
  });

  it("says which file it is, and that sending the facts needs the owner's approval of the privacy text", () => {
    const message = report(offencesUnder(tree, "api"));
    expect(message).toContain("api/deep/er/report.ts");
    expect(message).toContain("api/panel.tsx");
    expect(message).toMatch(/owner's\s+approval of the privacy text/);
  });

  it("finds nothing in a tree that keeps to the rule", () => {
    const clean = treeOf({
      "api/a.ts": "export {};",
      "api/b/c.ts": "export {};",
      "timeline/exportFacts3c.ts": "export function factsOf3c() {}",
      "timeline/estimateAdmission.ts": 'import { noteFact3c } from "./exportFacts3c";',
    });
    expect(offencesUnder(clean, "api")).toEqual([]);
    expect(strangersIn(clean)).toEqual([]);
  });
});

describe.each(GUARDED)("src/%s never reaches for the six held report facts", (name) => {
  it("holds .ts source files to look at, or this test would pass for nothing", () => {
    const files = sourcesUnder(disk, name);
    expect(files.some((file) => file.endsWith(".ts"))).toBe(true);
    // and what it reads is code, so an empty read cannot make the next test pass
    expect(files.some((file) => /\bfrom\s+["']/.test(disk.read(file)))).toBe(true);
  });

  it("imports nothing from exportFacts3c and names none of what it exports", () => {
    const found = offencesUnder(disk, name);
    expect(found, report(found)).toEqual([]);
  });
});

describe("outside the two parts of the app that learn a fact", () => {
  it("looks at real code: the module and both writers are in the scan and do name the facts", () => {
    const all = sourcesUnder(disk, "");
    for (const file of [MODULE, ...WRITERS]) {
      expect(all, file).toContain(file);
      expect(offence(disk.read(file), VALUE_NAMES), file).not.toBeNull();
    }
    expect(all.length).toBeGreaterThan(200);
  });

  it("nothing else in src imports the module or names what it exports", () => {
    const found = strangersIn(disk);
    expect(found, report(found)).toEqual([]);
  });
});
