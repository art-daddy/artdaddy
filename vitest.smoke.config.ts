import { defineConfig } from "vitest/config";

// Standalone config for the E2E smoke (real ffmpeg/ffprobe/yt-dlp). Kept out of
// the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
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
