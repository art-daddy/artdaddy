import { defineConfig } from "vitest/config";

// Standalone config for the MODEL EVAL lane (manual/nightly). Drives the live model
// via /inference — needs the server running with metering OFF (see the eval.e2e.ts
// header). Kept out of the unit + smoke suites. Run: `npm run eval`.
//   ARTDADDY_EVAL_MODELS  (default gpt-5.4,gpt-5.4-mini)
//   ARTDADDY_EVAL_CAP_USD (default 10)  ·  ARTDADDY_EVAL_EFFORT (default high)
//   ARTDADDY_SERVER       (default http://127.0.0.1:8000)  ·  ARTDADDY_EVAL_ONLY (csv of ids)
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/eval/**/*.e2e.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    env: { ARTDADDY_EVAL: "1" },
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
