import baseConfig from "./vitest.config";
import { defineConfig, mergeConfig } from "vitest/config";

// The vitest config of the weekly mutation run (stryker.ci.mjs). Stryker stops before the first mutant if ANY test
// fails in its first pass, and that pass runs every test that imports the shard's files, in one thread, against source
// files it has rewritten to hold every mutant. So a test that cannot pass there would stop the whole report: it is left
// out here, with its reason, once it has been seen failing in that pass. The normal `vitest run` lane and the pre-push
// hook do not use this file; they still run every test.
//
// What may be left out:
//   - a test whose verdict is the TEXT of a source file the run rewrites (a guard that scans the code): there it reads
//     Stryker's rewrite, not our code. Every mutant sits in that text at once and is switched on while the tests run,
//     so the text is the same whichever mutant is on: a test that judges only the text cannot kill a mutant;
//   - a test that only times the code: instrumented, the code is several times slower whichever mutant is on, so the
//     time says nothing about the mutant;
//   - a test that keeps its worker busy for over a minute without a pause: a vitest worker must answer its runner
//     within 60 s (a fixed limit), or the run reports an error outside any test, which also stops the first pass;
//   - a qualification run at full scale, which takes minutes once the code is instrumented.
// A whole file goes in EXCLUDED_FILES. One test of a file whose other tests the run needs goes in SKIPPED_TESTS, by its
// describe names and its own name as Stryker prints them, joined by " > "; scripts/ci/mutationSkipSetup.mjs reports it
// skipped before its body runs. scripts/ci/mutationExclusions.test.mjs fails if an entry stops naming a file or a test,
// or if anything else is left out.

declare module "vitest" {
  export interface ProvidedContext {
    mutationSkips: Record<string, Record<string, string>>;
  }
}

/** Test files the mutation run leaves out: the path from the repository root, and why. */
export const EXCLUDED_FILES: Record<string, string> = {
  "src/agent/loop.integration.test.ts":
    "expects add_track to hit the approval gate, but needsApproval() gates only paid, external and destructive tools: a red test outside the mutation scope; delete this entry once that is resolved",
};

/** Single tests the mutation run skips: file, then "describe > ... > test", then why. */
export const SKIPPED_TESTS: Record<string, Record<string, string>> = {
  "src/timeline/chipTest.test.ts": {
    "the words a chip test can say are words a report may carry, and words the memory can keep > reads the type it guards (a parse that found nothing would pass everything below)":
      "parses the ChipTestResult type out of the text of src/timeline/chipTest.ts, which the timeline shard rewrites, and finds nothing there",
  },
  "src/timeline/exportChoiceWords.guard.test.ts": {
    "T16 (1) every D2 text is written once, in the words file > leaves no text in the words file that this guard has not been told about":
      "lists the string literals in the text of src/timeline/exportChoiceWords.ts, where the timeline shard's rewrite adds strings of its own",
  },
  "src/timeline/leanWindows.test.ts": {
    "opacityWindow > gives null rather than a window of 400 characters or more":
      "two timelines of 50,000 frames in one go keep the worker busy for a minute once instrumented (57 s on a laptop), at the worker's fixed 60 s limit",
  },
  "src/timeline/render.test.ts": {
    "combined-workload preparation > prepares two hours of 4K60 with5000clips and16simultaneous sources inside native receipt bounds":
      "a qualification run at full scale (5,000 clips, two hours of 4K60): instrumented, it ran past its own 120 s limit, and it would cost minutes for every mutant it covers",
  },
  "src/tools/speechModelRun.test.ts": {
    "where the engine is started > is one place, and that place checks the model file's path before it spawns anything":
      "matches the text of the files under src/tools, which the tools shard rewrites, so it finds no engine start there",
  },
  "src/tools/speechLeadingQuiet.test.ts": {
    "what the detector must always do, for any seed and any length > answers for the first 30 seconds only: nothing appended after them can change it":
      "its 30 runs over 30 s of audio keep the worker busy for over a minute once instrumented, past the worker's fixed 60 s limit",
  },
  "src/tools/whisperFacts.test.ts": {
    "the maker of the graphics chip a run used > megabytes of log > is read in a fraction of a second: one line of spaces":
      "times the reader (under 2 s for 5 MB) and checks nothing it reads: instrumented, it took 4.8 s on a laptop",
    "the maker of the graphics chip a run used > megabytes of log > is read in a fraction of a second: blank lines":
      "times the reader (under 2 s for 5 MB) and checks nothing it reads: instrumented, it took 14.8 s on a laptop",
    "the maker of the graphics chip a run used > megabytes of log > is read in a fraction of a second: spaces and tabs, then a device line":
      "times the reader (under 2 s for 5 MB) and checks nothing it reads: instrumented, it took 5.4 s on a laptop",
  },
};

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: Object.keys(EXCLUDED_FILES),
      setupFiles: ["./scripts/ci/mutationSkipSetup.mjs"],
      provide: { mutationSkips: SKIPPED_TESTS },
      // The code runs instrumented and the first pass runs the tests in one thread, so a test that takes seconds in
      // the unit lane can take a minute here, and more on a slower runner. A test that hangs still fails, only later;
      // a mutant that hangs is stopped by Stryker's own limit for it.
      testTimeout: 300_000,
      hookTimeout: 300_000,
    },
  }),
);
