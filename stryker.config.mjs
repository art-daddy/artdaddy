// Mutation testing (Stryker). A REPORT tool, not a CI gate: our 95% line coverage
// says lines RUN, not that tests CATCH bugs. Stryker deliberately breaks the code
// and checks whether a test fails — surviving mutants = weak assertions.
//
//   npm run mutation                               full scope (timeline + tools)
//   npx stryker run --mutate "src/timeline/clamp.ts"   one file (fast, for a baseline)
//
// Note: src/tools/** is heavy on ffmpeg/network IO that is E2E-covered (not in the
// unit runner), so those mutants SURVIVE by design — read the timeline/** score as
// the signal for the core algebra. src/preview/scene.ts (the compositor draw-list —
// sampling offset, transition/hold, karaoke boundary, emphasis box, colour grade) is
// PURE and unit-tested (scene.test + parity + parity.property), so it is mutated too;
// the other preview files (renderer.ts WebGL, text.ts Canvas2D rasterizers) are
// browser IO covered only by pixel-smoke, so they stay OUT (their mutants would
// survive like tools/**).
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  mutate: [
    "src/timeline/**/*.ts",
    "src/tools/**/*.ts",
    "src/preview/scene.ts",
    // Newly unit-covered and worth mutating: the retry ceiling, the editor's edit
    // surface, the desktop fs fast-path and the playback clock all now have tests
    // that should KILL a mutant, so a survivor here is a real gap, not IO noise.
    "src/api/http.ts",
    "src/store/editorCommands.ts",
    "src/lib/desktop.ts",
    // The import boundary every picker/paste/drop goes through, and the rule deciding who owns
    // an OS file drop. Both are pure and unit-covered, so a survivor here is a real gap.
    "src/lib/upload.ts",
    "src/lib/osDrop.ts",
    "src/preview/transport.ts",
    "src/contract/clamp.ts",
    // NOT src/eval/studio.ts: the stub surface is exercised by the LIVE eval lane,
    // not by vitest, so its mutants are ~all "no coverage" and only dilute the score.
    "!src/**/*.test.ts",
    "!src/**/*.e2e.ts",
    "!src/tools/__e2e.ts",
  ],
  coverageAnalysis: "perTest",
  concurrency: 4,
  timeoutMS: 20000,
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // Report only — never fail the run on a low score.
  thresholds: { high: 80, low: 60, break: null },
};
