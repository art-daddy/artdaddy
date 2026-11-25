// The mutation run's way to leave out ONE test of a file whose other tests it needs. Only vitest.mutation.config.ts
// loads this file, as a setup file after the unit suite's own: it reads the list there (SKIPPED_TESTS, handed over by
// `provide`) and reports each listed test skipped before its body runs. Stryker counts a skipped test as neither passed
// nor failed, so it cannot stop the run's first pass and cannot kill a mutant. The normal unit run never loads this file.
import { beforeEach, inject } from "vitest";

/** A test as the skip list names it: its describe names, outermost first, then its own name, joined by " > ". */
export function listedName(task) {
  const names = [];
  for (let at = task; at && at !== at.file; at = at.suite) if (at.name) names.unshift(at.name);
  return names.join(" > ");
}

/** Why the mutation run skips this test, or undefined when it runs: an entry names the file and the whole name exactly. */
export function skipReason(skips, file, task) {
  const inFile = skips && Object.hasOwn(skips, file) ? skips[file] : undefined;
  const name = listedName(task);
  return inFile && Object.hasOwn(inFile, name) ? inFile[name] : undefined;
}

const skips = inject("mutationSkips");
if (skips) {
  beforeEach((context) => {
    const reason = skipReason(skips, context.task.file.name, context.task);
    if (reason !== undefined) context.skip(reason);
  });
}
