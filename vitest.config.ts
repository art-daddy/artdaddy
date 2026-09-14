import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Test runner config. Kept separate from vite.config.ts (and out of tsconfig)
// so the app typecheck doesn't hit the vite/vitest duplicate-types clash.
export default defineConfig({
  plugins: [react()],
  // Mirrors vite.config.ts: the app reads this global, so it must exist under the runner too.
  define: { __ARTDADDY_RELEASE__: JSON.stringify("artdaddy@test") },
  test: {
    environment: "happy-dom",
    globals: false,
    // Keep the Stryker mutation sandbox out of normal discovery: an outer `vitest run`
    // would otherwise re-run every suite from .stryker-tmp/sandbox-*/ (the duplicate runs).
    // Stryker's own inner runs execute INSIDE the sandbox, where this pattern doesn't match.
    // `e2e/**` holds the Playwright + WebdriverIO lanes; vitest's default include covers
    // `*.spec.*` too, so without this it tries to run them and fails on their globals.
    exclude: [...configDefaults.exclude, ".stryker-tmp/**", "e2e/**"],
    // Vite loads .env for tests too, so a REAL VITE_SENTRY_DSN would make initSentry()
    // arm the live project from the suite. Blank it at the baseline (not via stubEnv —
    // vi.unstubAllEnvs() would restore the real value).
    env: { VITE_SENTRY_DSN: "" },
    setupFiles: ["./src/test/setup.ts"],
    unstubGlobals: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/api/schema.d.ts",
        "src/**/*.d.ts",
        // Type-only modules (interfaces/types only — no runtime code to test).
        "src/agent/types.ts",
        "src/api/types.ts",
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.e2e.ts",
        // The opt-in e2e lane's shared harness (real child-process ffmpeg). Imported by *.e2e.ts,
        // never run in the unit lane — measured by the smoke lane, not unit coverage. Mirrors the
        // stryker config's `!src/tools/__e2e.ts` exclusion.
        "src/tools/__e2e.ts",
        "src/eval/**",
        "src/tools/command.ts",
        "src/tools/context.ts",
        "src/tools/dataRoot.ts",
        "src/tools/host.ts",
        "src/preview/renderer.ts",
        "src/preview/loader.ts",
        "src/preview/videoSource.ts",
        "src/preview/audioEngine.ts",
        "src/preview/text.ts",
        "src/preview/previewWorker.ts",
        "src/preview/mediaProxy.ts",
        "src/preview/__probe.ts",
        "src/preview/__probe_video.ts",
        "src/preview/__parity.ts",
        "src/preview/__probe_parity.ts",
        "src/components/PreviewCanvas.tsx",
        "src/components/SourceMonitor.tsx",
        "src/components/ClipWaveform.tsx",
        "src/components/ClipThumbnail.tsx",
        "src/components/LeftColumn.tsx",
      ],
      reporter: ["text", "text-summary"],
      thresholds: { statements: 95, lines: 95, functions: 90, branches: 82 },
    },
  },
});
