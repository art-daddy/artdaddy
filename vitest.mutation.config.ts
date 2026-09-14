import baseConfig from "./vitest.config";
import { defineConfig, mergeConfig } from "vitest/config";

// Mutation-run config. Stryker aborts if ANY test is red in its initial run, so a
// single unrelated pre-existing failure blocks mutation testing for the whole repo.
// This excludes exactly that file so the mutation REPORT stays available; it changes
// nothing about the normal `vitest run` lane, which still runs (and still fails) it.
//
// Excluded: src/agent/loop.integration.test.ts — expects add_track to hit the approval
// gate, but needsApproval() gates only paid/external/destructive tools. Pre-existing
// and unrelated to mutation scope; delete this entry once that is resolved.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: ["**/node_modules/**", ".stryker-tmp/**", "src/agent/loop.integration.test.ts"],
    },
  }),
);
