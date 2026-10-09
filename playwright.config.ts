import { defineConfig, devices } from "@playwright/test";

// Real-browser lane. happy-dom has no WebGL, no layout and no real pointer input,
// so three whole classes of bug are invisible to the unit suite:
//   * the app white-screens on boot (a bad import / CSP / bundle split),
//   * the WebGL2 compositor fails to build its shaders on a real GPU stack,
//   * the composite is structurally wrong (letterbox, z-order, alpha) even though
//     buildScene's draw-list is numerically correct.
// This lane runs the REAL vite bundle in REAL Chromium and asserts pixels.
//
//   npm run e2e:ui
//
// PREREQUISITES (not in package.json — this lane installs its own runner so the
// app's committed lockfile stays about the app):
//   npm i --no-save @playwright/test@1.61.1
//   npx playwright install chromium
//
// To reuse the browser `npm run bundle:browser` already staged instead of downloading a
// second one, install the runner matching THAT playwright-core version and point at it:
//   PLAYWRIGHT_BROWSERS_PATH=src-tauri/resources/ms-playwright
// A mismatched pair fails with "Executable doesn't exist at .../chromium_headless_shell-<rev>".
//
// No backend is required: the specs target the app shell and the compositor probe
// page, neither of which needs /inference or a project on the server.
export default defineConfig({
  testDir: "./e2e/ui",
  globalSetup: "./e2e/ui/warmup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // GPU-less runners (macOS CI) get WebGL2 only from SwiftShader, which Chrome no longer picks unasked.
        launchOptions: {
          channel: process.env.CI ? "chrome" : undefined,
          args: ["--enable-unsafe-swiftshader"],
        },
      },
    },
    // The closest thing to macOS without a Mac: WKWebView is WebKit, and this build runs on
    // Windows. It does NOT cover Metal-backed WebGL or the Tauri shell, but it does cover the
    // engine-level differences (CSS, layout, JS APIs) that a Chromium-only lane cannot see.
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      // Playwright's Windows WebKit build exposes no WebGL2 context, so the GPU probe pages
      // cannot initialize there. Keep WebKit on boot/layout/input/OS-drop; Chromium covers the
      // real WebGL2 pixel suite, and macOS CI/runtime covers the actual WKWebView + Metal path.
      // That Windows build's DataTransfer also has no `items.add`, so the OS-drop spec cannot even
      // build its input there; it runs on macOS WebKit, the engine those drops come from.
      // Nor does it have WebCodecs (no VideoDecoder, checked 2026-10-08), which the playback
      // spec decodes with; macOS WebKit has it.
      // On macOS the GPU specs DO run here: until 2026-10-04 they were ignored on every OS.
      testIgnore:
        process.platform === "win32"
          ? [
              "preview.spec.ts",
              "chromaKey.spec.ts",
              "rotation.spec.ts",
              "stream.spec.ts",
              "osdrop.spec.ts",
            ]
          : [],
    },
  ],
  webServer: {
    // A dedicated port so the lane never collides with a dev server the user has open.
    // --host 127.0.0.1: vite otherwise binds "localhost", which on Windows resolves to ::1
    // first, so the IPv4 `url` below never answers and the lane dies on a webServer timeout.
    command: "npx vite --port 5199 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // "No backend", as the specs assume (boot.spec's BENIGN names this address). Since the API
    // default became the deployed server, the lane booted against PRODUCTION: CORS refused the
    // 127.0.0.1:5199 origin, the app locked itself, and every boot and menu spec failed. Set here,
    // it also overrides a VITE_API_BASE_URL a workflow exports for its build steps.
    //
    // The e2e auth bypass, because with no server the app is "offline" with no stored session, and
    // the sign-in gate then replaces the WHOLE app — menu bar included. The menu specs passed on
    // every developer machine only because a gitignored .env.development sets this; CI never had
    // it, so all eight failed there (2026-10-04). Set here, a local run is the run CI does.
    // vite.config.ts refuses a production build with it set, so it cannot reach a release.
    // And no Sentry: a local run would otherwise report the lane's deliberate failures upstream.
    env: {
      VITE_API_BASE_URL: "http://127.0.0.1:8000",
      VITE_E2E_AUTH_BYPASS: "1",
      VITE_SENTRY_DSN: "",
    },
  },
});
