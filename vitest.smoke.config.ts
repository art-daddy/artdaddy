import { defineConfig } from "vitest/config";

// Standalone config for the E2E smoke (real ffmpeg/ffprobe/yt-dlp). Kept out of
// the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
// `npm run smoke` runs it in two passes: every file but src/timeline/exportFast.smoke.e2e.ts first, then that file
// alone. That file's streamed cases render three times through the native test program, and each render is waited
// for at most two minutes, the most that program accepts. The three take 72 s when the file runs alone. Beside the
// rest of the smoke files (vitest's default of one worker fewer than the threads: 15 on the 16-thread PC where this was
// measured, with ffmpeg and cargo running at once) the last encode slowed to about a quarter of real time and ran
// out of its wait in two whole runs out of two (at 90 s, then at 120 s). The CI and release workflows run it as one
// run with --maxWorkers=2 and are unchanged.
// Network tools require ARTDADDY_SMOKE_NET=1.
// The global setup compiles the native test program once before any case starts (only for a run
// that holds native render cases; ARTDADDY_SMOKE_NO_WARMUP=1 skips it): see src/test/nativeWarmup.ts.
export default defineConfig({
  define: { __ARTDADDY_RELEASE__: JSON.stringify("artdaddy@test") },
  test: {
    environment: "node",
    env: { VITE_SENTRY_DSN: "" },
    globalSetup: ["./src/test/smokeGlobalSetup.ts"],
    setupFiles: ["./src/test/smokeSetup.ts"],
    include: ["src/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
