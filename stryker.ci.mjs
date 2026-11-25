// Stryker for the weekly CI run (.github/workflows/mutation-weekly.yml). The same scope as `npm run mutation`
// (stryker.config.mjs), with these changes:
//   - the vitest config that leaves out the few tests that cannot pass in Stryker's first run (vitest.mutation.config.ts,
//     each with its reason). Stryker aborts if ANY test is red in that run, so one of them would otherwise stop the
//     whole report;
//   - a longer limit for that first run (dryRunTimeoutMinutes, below);
//   - a JSON report next to the HTML one: scripts/ci/mutationSummary.mjs reads it for the page of the run;
//   - one log line per step (progress-append-only) instead of a progress bar, and no clear-text list of every
//     mutant (the HTML report has them), so the log of a long run stays readable;
//   - a longer limit for one mutant, because a shared runner is slower than a laptop;
//   - `ignoreStatic`: a "static" mutant sits in code that runs when a file is loaded, so it can only be tested by
//     running the WHOLE suite (about five minutes here) and a few of them took 45% of a one-file run's time. Left
//     out, the run measures what the tests catch in the logic, which is what a weak test would let through;
//   - SHARDS: the scope is cut into jobs that run side by side, each planned to test its mutants in no more than
//     about four hours, so every job fits GitHub's limit of six hours per job (5 h 50 min in the workflow, with
//     the setup and the first pass). The first full run to get past the first pass, in three shards, showed why (run
//     45652956328, 25 Nov): rest finished in an hour, but in 5 h 30 min timeline had done 9% of its work and tools
//     46%. So src/timeline and src/tools are spread over several shards by scripts/ci/mutationShards.json, which
//     names the files of each shard with the hours it plans for each. A file too big for one shard is named in parts,
//     `file@anchor`, each cut where a declaration starts (fileParts, below). Every other file of the scope is the
//     `rest` shard, and a file of a split folder that the plan does not name (one added since) goes to the shard the
//     plan names for new files of that folder, so nothing is left out. Each shard is handed to Stryker as a list of
//     files and line ranges; scripts/ci/mutationShards.test.mjs fails if a line of the scope is in no shard or in
//     two, if a cut loses a mutant it should not (checked with Stryker's own instrumenter), if the plan names a file
//     that is no longer in the scope, or if a shard is planned at more than its budget.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import base from "./stryker.config.mjs";

// From the module's own path, not `new URL(...)`: the tests run in a browser-like environment whose URL Node refuses.
const ROOT = dirname(fileURLToPath(import.meta.url));
// Loaded only to cut a split file into parts, so listing the shards needs no installed packages.
const require = createRequire(import.meta.url);

/** The shard plan: for each split folder, the shards of its files and the shard that takes a file it does not name. */
export const PLAN = JSON.parse(
  readFileSync(join(ROOT, "scripts", "ci", "mutationShards.json"), "utf8").replace(/^\uFEFF/, ""),
);

/** A glob of the `mutate` list as a regular expression over a path from the repository root: `**` is any number
 *  of folders, `*` any part of one name, `?` one character. Braces and brackets are not used in the scope. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:[^/]+/)*" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The files of `files` (paths from the repository root, with "/") that a `mutate` list selects: matched by one
 *  of its globs and by none of its `!` globs. */
export function selectedBy(mutate, files) {
  const take = mutate.filter((g) => !g.startsWith("!")).map(globToRegExp);
  const drop = mutate.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
  return files.filter((f) => take.some((re) => re.test(f)) && !drop.some((re) => re.test(f)));
}

/** Every file under the folder each glob of the `mutate` list starts in (the part before its first wildcard). */
export function candidateFiles(mutate, root = ROOT) {
  const found = new Set();
  const walk = (rel) => {
    const abs = `${root}/${rel}`;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.isFile()) found.add(rel);
    else if (stat.isDirectory())
      for (const name of readdirSync(abs))
        if (name !== "node_modules" && !name.startsWith(".")) walk(`${rel}/${name}`);
  };
  for (const glob of mutate.filter((g) => !g.startsWith("!"))) {
    const parts = glob.split("/");
    const wild = parts.findIndex((p) => /[*?]/.test(p));
    walk(wild === -1 ? glob : parts.slice(0, wild).join("/"));
  }
  return [...found].sort();
}

/** A key of the plan: a whole file (`src/timeline/clamp.ts`), or one part of a file that is too big for one
 *  shard (`src/timeline/render.ts@validateRendered`: from that anchor to the next part of the same file). */
export function parsePlanKey(key) {
  const at = key.indexOf("@");
  return at === -1
    ? { file: key, anchor: null }
    : { file: key.slice(0, at), anchor: key.slice(at + 1) };
}

/** The names a top-level or body statement declares (`const a = 1, b = 2` declares a and b). */
function declaredNames(ts, statement) {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
}

/**
 * The lines (from 1, both included) of each part of a split file, from its anchors:
 *   `^`            the part from line 1;
 *   `name`         the part from the first top-level statement that declares `name`;
 *   `outer/inner`  the part from the statement of the body of the function `outer` that declares `inner`.
 * Each part runs to the line before the next one; the last to the end of the file. Stryker only mutates code that lies
 * WHOLLY inside one range, so a cut between top-level statements loses nothing, and a cut inside the function `outer`
 * loses exactly one mutant: the one that empties `outer`'s body (an empty body breaks every caller, so its tests
 * would kill it anyway). A cut must start a statement that shares no line with the one before it. Anything else
 * (a renamed or deleted anchor, two parts on one line, a part before `^`) throws: a run that stops is better than
 * code that silently goes untested or is tested twice.
 */
export function fileParts(file, anchors, text = readFileSync(`${ROOT}/${file}`, "utf8")) {
  const ts = require("typescript");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineAt = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const startOf = (anchor, statements, name, where) => {
    const i = statements.findIndex((s) => declaredNames(ts, s).includes(name));
    if (i === -1) {
      throw new Error(
        `${file}@${anchor}: ${where} declares no "${name}". The shard plan (scripts/ci/mutationShards.json) cuts the ` +
          `file there: rename its anchor to the new name, or to another declaration nearby`,
      );
    }
    const start = lineAt(statements[i].getStart(source));
    if (i > 0 && lineAt(statements[i - 1].getEnd()) >= start) {
      throw new Error(
        `${file}@${anchor}: the statement there shares line ${start} with the one before it`,
      );
    }
    return start;
  };
  const starts = anchors.map((anchor) => {
    if (anchor === "^") return 1;
    const [outer, inner, more] = anchor.split("/");
    if (!outer || inner === "" || more !== undefined)
      throw new Error(`${file}@${anchor}: not an anchor`);
    if (inner === undefined)
      return startOf(anchor, source.statements, outer, "the top level of the file");
    const fn = source.statements.find(
      (s) => ts.isFunctionDeclaration(s) && s.body && s.name?.text === outer,
    );
    if (!fn)
      throw new Error(`${file}@${anchor}: there is no top-level function "${outer}" with a body`);
    return startOf(anchor, fn.body.statements, inner, `the body of ${outer}`);
  });
  if (anchors.filter((a) => a === "^").length !== 1) {
    throw new Error(`${file}: a split file has exactly one part from line 1, ${file}@^`);
  }
  const order = anchors
    .map((anchor, i) => ({ anchor, start: starts[i] }))
    .sort((a, b) => a.start - b.start);
  const last = text.split("\n").length;
  return new Map(
    order.map(({ anchor, start }, i) => {
      if (i > 0 && start === order[i - 1].start) {
        throw new Error(
          `${file}@${anchor} starts on line ${start}, as ${file}@${order[i - 1].anchor} does`,
        );
      }
      return [anchor, { start, end: i + 1 < order.length ? order[i + 1].start - 1 : last }];
    }),
  );
}

/** The shard of every file of `scope`, or of every part of a split file (key `file@anchor`): the one the plan names
 *  it in; for a file of a split folder that the plan does not name, the folder's shard for new files; for any other
 *  file, `rest`. Throws if the plan names a key in two shards, or a file both whole and in parts. */
export function assignShards(scope, plan = PLAN) {
  const named = new Map();
  for (const folder of Object.values(plan.folders))
    for (const [shard, keys] of Object.entries(folder.shards))
      for (const key of Object.keys(keys)) {
        if (named.has(key))
          throw new Error(`${key} is planned in two shards: ${named.get(key)} and ${shard}`);
        named.set(key, shard);
      }
  const parts = new Map();
  for (const key of named.keys()) {
    const { file, anchor } = parsePlanKey(key);
    if (anchor !== null) parts.set(file, [...(parts.get(file) ?? []), key]);
  }
  const folderOf = (file) => Object.keys(plan.folders).find((f) => file.startsWith(f));
  const shardOf = new Map();
  for (const file of scope) {
    if (parts.has(file)) {
      if (named.has(file)) throw new Error(`${file} is planned both whole and in parts`);
      for (const key of parts.get(file)) shardOf.set(key, named.get(key));
    } else {
      const folder = folderOf(file);
      shardOf.set(file, named.get(file) ?? (folder ? plan.folders[folder].newFilesGoTo : "rest"));
    }
  }
  return shardOf;
}

/** Every shard of the plan, the most hours first, then `rest`: the order the workflow starts them in. */
export const SHARD_NAMES = [
  ...Object.values(PLAN.folders)
    .flatMap((folder) => Object.entries(folder.shards))
    .map(([name, files]) => ({ name, hours: Object.values(files).reduce((a, h) => a + h, 0) }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
    .map(({ name }) => name),
  "rest",
];

/** What one shard mutates, as the `mutate` list Stryker is given: whole files by name, a part of a split file as
 *  `file:first-last` (Stryker's syntax for a range of lines). */
export function shardMutate(shard, mutate = base.mutate, root = ROOT) {
  if (!SHARD_NAMES.includes(shard)) {
    throw new Error(`MUTATION_SHARD="${shard}" is not one of ${SHARD_NAMES.join(", ")}`);
  }
  const shardOf = assignShards(selectedBy(mutate, candidateFiles(mutate, root)));
  const partsOf = new Map();
  const list = [];
  for (const [key, s] of shardOf) {
    if (s !== shard) continue;
    const { file, anchor } = parsePlanKey(key);
    if (anchor === null) {
      list.push(file);
      continue;
    }
    if (!partsOf.has(file)) {
      const anchors = [...shardOf.keys()].map(parsePlanKey).filter((k) => k.file === file);
      partsOf.set(
        file,
        fileParts(
          file,
          anchors.map((k) => k.anchor),
          readFileSync(`${root}/${file}`, "utf8"),
        ),
      );
    }
    const { start, end } = partsOf.get(file).get(anchor);
    list.push(`${file}:${start}-${end}`);
  }
  return list;
}

/** The shards a run starts: all of them, or the one asked for (the workflow's `shard` input). */
export function shardsToRun(wanted) {
  if (!wanted || wanted === "all") return SHARD_NAMES;
  if (!SHARD_NAMES.includes(wanted)) {
    throw new Error(`shard "${wanted}" is not "all" or one of ${SHARD_NAMES.join(", ")}`);
  }
  return [wanted];
}

const shard = process.env.MUTATION_SHARD;

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: shard ? shardMutate(shard) : base.mutate,
  ignoreStatic: true,
  vitest: { configFile: "vitest.mutation.config.ts" },
  reporters: ["progress-append-only", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // The Linux runners of a public repository have four cores.
  concurrency: 4,
  timeoutMS: 30000,
  // Stryker's first run executes every test that imports the shard's files once, in ONE thread (its vitest runner
  // allows one worker) and with the shard's files instrumented. Its default limit of 5 minutes stopped all three shards
  // of the first full run. On a laptop the timeline shard, the slowest, took 43 minutes (tools 25, rest 19); on GitHub
  // the same three passes took 17, 13 and 9 minutes (run 45652956328), and a smaller shard runs fewer tests. 90 minutes
  // is twice the laptop's slowest and still ends a run that hangs long before the job's own limit.
  dryRunTimeoutMinutes: 90,
};
