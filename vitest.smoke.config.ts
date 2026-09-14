import { defineConfig } from "vitest/config";

// Standalone config for the E2E smoke (real ffmpeg/ffprobe/yt-dlp). Kept out of
// the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
// Network tools require ARTDADDY_SMOKE_NET=1.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
