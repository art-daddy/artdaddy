// Adds the scratch cases of the memory-bounds batch to a checkout's promise library before a run. The code under test is a PINNED, older commit,
// so the cases cannot live in it; they live here, next to the instrument, and are merged into the checkout's own library:
//   node linuxBoundsCases.mjs <the checkout's scripts/qa/exporterPromiseCases.json> [<cases json, default: linuxBoundsCases.json beside this file>]
// With CASES set (space separated) it also refuses, after the merge, a name the library does not have.
// A case that is already there must be identical (a different definition under the same name would make two results mean different things), and
// every added case must have exactly the fields the library's own generated cases have, so a change to the library's schema stops the run
// here instead of being read wrongly by the harness.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fields = (entry) => Object.keys(entry).sort().join(",");

export function mergeCases(library, added) {
  assert.ok(Array.isArray(library?.cases), "The library has no list of cases");
  const reference = library.cases.find((entry) => entry.kind === "promise" && entry.source === "generated");
  assert.ok(reference, "The library has no generated promise case to take the field list from");
  const cases = [...library.cases];
  const addedIds = [];
  for (const entry of added) {
    assert.equal(fields(entry), fields(reference), `${entry.id}: its fields differ from the library's generated cases`);
    assert.equal(entry.source, "generated", `${entry.id}: a scratch case must generate its own source`);
    const existing = cases.find((candidate) => candidate.id === entry.id);
    if (existing) {
      assert.ok(isDeepStrictEqual(existing, entry), `${entry.id} is already defined in the library, differently`);
      continue;
    }
    cases.push(entry);
    addedIds.push(entry.id);
  }
  return { library: { ...library, cases }, added: addedIds };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [libraryPath, casesPath = fileURLToPath(new URL("./linuxBoundsCases.json", import.meta.url))] = process.argv.slice(2);
  if (!libraryPath) {
    console.error("usage: [CASES='a b c'] node linuxBoundsCases.mjs <exporterPromiseCases.json> [cases.json]");
    process.exit(2);
  }
  const { library, added } = mergeCases(JSON.parse(await readFile(libraryPath, "utf8")), JSON.parse(await readFile(casesPath, "utf8")));
  if (added.length) await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
  console.log(added.length ? `Added ${added.length} cases: ${added.join(", ")}` : "All the scratch cases are already in the library");
  // The batch's own list (CASES, space separated): a name that is in neither place would otherwise be run as nothing, and look like a pass.
  const unknown = (process.env.CASES ?? "").split(/\s+/).filter((id) => id && !library.cases.some((entry) => entry.id === id));
  if (unknown.length) {
    console.error(`Unknown cases: ${unknown.join(", ")}`);
    process.exit(1);
  }
}
