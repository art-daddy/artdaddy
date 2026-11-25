// Stryker for the weekly CI run (.github/workflows/mutation-weekly.yml). The same scope as `npm run mutation`
// (stryker.config.mjs), with these changes:
//   - the vitest config that leaves out the one known-red test (vitest.mutation.config.ts). Stryker aborts if ANY
//     test is red in its first run, so one unrelated red test would otherwise stop the whole report;
//   - a JSON report next to the HTML one: scripts/ci/mutationSummary.mjs reads it for the page of the run;
//   - one log line per step (progress-append-only) instead of a progress bar, and no clear-text list of every
//     mutant (the HTML report has them), so the log of a long run stays readable;
//   - a longer limit for one mutant, because a shared runner is slower than a laptop;
//   - `ignoreStatic`: a "static" mutant sits in code that runs when a file is loaded, so it can only be tested by
//     running the WHOLE suite (about five minutes here) and a few of them took 45% of a one-file run's time. Left
//     out, the run measures what the tests catch in the logic, which is what a weak test would let through;
//   - SHARDS: one job runs a third of the scope (MUTATION_SHARD=timeline|tools|rest), so the three fit GitHub's
//     six-hour limit per job and run side by side. The shards are cut from the same `mutate` list as
//     stryker.config.mjs, so a glob added there lands in a shard without anyone editing this file;
//     scripts/ci/mutationShards.test.mjs fails if one lands in no shard or in two.
import base from "./stryker.config.mjs";

/** Which part of the scope each named shard takes; `rest` is everything the others do not take. */
export const SHARDS = {
  timeline: (glob) => glob.startsWith("src/timeline/"),
  tools: (glob) => glob.startsWith("src/tools/"),
};
export const SHARD_NAMES = [...Object.keys(SHARDS), "rest"];

/** The `mutate` list of one shard: its own globs, plus every exclusion (the `!` globs), which apply to all. */
export function shardMutate(mutate, shard) {
  if (!SHARD_NAMES.includes(shard)) {
    throw new Error(`MUTATION_SHARD="${shard}" is not one of ${SHARD_NAMES.join(", ")}`);
  }
  const takenByAShard = (glob) => Object.values(SHARDS).some((takes) => takes(glob));
  const inShard = (glob) => (shard === "rest" ? !takenByAShard(glob) : SHARDS[shard](glob));
  return [
    ...mutate.filter((g) => !g.startsWith("!") && inShard(g)),
    ...mutate.filter((g) => g.startsWith("!")),
  ];
}

const shard = process.env.MUTATION_SHARD;

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: shard ? shardMutate(base.mutate, shard) : base.mutate,
  ignoreStatic: true,
  vitest: { configFile: "vitest.mutation.config.ts" },
  reporters: ["progress-append-only", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // The Linux runners of a public repository have four cores.
  concurrency: 4,
  timeoutMS: 30000,
};
