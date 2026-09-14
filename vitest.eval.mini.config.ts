import { defineConfig } from "vitest/config";

// gpt-5.4-mini-only variant of the MODEL EVAL lane (cheaper) — the live-server +
// real-client + real-model round-trip, pinned to gpt-5.4-mini with a low cap/effort
// to keep spend small. Same prereqs as `npm run eval` (server running, metering
// OFF — see src/eval/eval.e2e.ts). Run: `npm run eval:mini`.
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
      ARTDADDY_EVAL_MODELS: "gpt-5.4-mini",
      ARTDADDY_EVAL_CAP_USD: "2",
      ARTDADDY_EVAL_EFFORT: "medium",
    },
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
