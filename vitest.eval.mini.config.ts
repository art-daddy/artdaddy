import { defineConfig } from "vitest/config";

// The small variant of the MODEL EVAL lane: the same live-server + real-client + real-model round
// trip on the model and effort a person gets in the app (the picker's defaults, as `npm run eval`),
// with a $1 cap so a smoke run stays small. Every round is a paid model call too: run it only when
// that spend has been approved. Same prereqs as `npm run eval` (server running, metering OFF — see
// src/eval/eval.e2e.ts). Run: `npm run eval:mini`.
//   Override the cap / effort / scenario via ARTDADDY_EVAL_CAP_USD / ARTDADDY_EVAL_EFFORT /
//   ARTDADDY_EVAL_ONLY (a csv of scenario ids — use one id for the cheapest smoke).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/eval/**/*.e2e.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    env: {
      ARTDADDY_EVAL: "1",
      ARTDADDY_EVAL_CAP_USD: "1",
    },
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
