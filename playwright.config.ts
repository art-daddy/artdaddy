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
//   npm i --no-save @playwright/test@1.49.1
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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The closest thing to macOS without a Mac: WKWebView is WebKit, and this build runs on
    // Windows. It does NOT cover Metal-backed WebGL or the Tauri shell, but it does cover the
    // engine-level differences (CSS, layout, JS APIs) that a Chromium-only lane cannot see.
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
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
  },
});
