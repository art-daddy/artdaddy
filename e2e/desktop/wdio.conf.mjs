// WebdriverIO config for the DESKTOP lane — drives the packaged Tauri app itself.
//
// This is the only lane that exercises the real Tauri runtime: the Rust shell, the
// capabilities allowlist, the custom `trash_path` IPC command, and the webview
// actually loading the production bundle. Everything else in the repo tests the
// TypeScript side with the boundary mocked.
//
//   npm run e2e:desktop
//
// If WebdriverIO cannot be installed (this machine's npm registry fails the TLS handshake and its
// tree is not cached), `webdriver.mjs` speaks the same W3C protocol to the same tauri-driver with
// no dependencies: `npm run e2e:drag` and `npm run e2e:osdrop` need only steps 1-3 below.
//
// PREREQUISITES (this lane FAILS LOUDLY rather than skipping — a silently skipped
// desktop test is indistinguishable from a passing one):
//   1. cargo install tauri-driver --locked
//   2. Windows: Microsoft Edge WebDriver matching the installed Edge, on PATH or at
//      $env:MSEDGEDRIVER. Linux: WebKitWebDriver.
//   3. A built app:  npx tauri build --debug
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const isWin = process.platform === "win32";

/** The packaged binary the driver should launch. */
function appBinary() {
  const explicit = process.env.ARTDADDY_APP_BINARY;
  if (explicit) return explicit;
  // Name comes from the config that produced it — see webdriver.mjs.
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const name = conf.mainBinaryName || conf.productName;
  const exe = isWin ? `${name}.exe` : name;
  for (const profile of ["debug", "release"]) {
    const p = path.join(root, "src-tauri", "target", profile, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

function nativeDriver() {
  const explicit = process.env.MSEDGEDRIVER || process.env.NATIVE_DRIVER;
  if (explicit) return explicit;
  return isWin ? "msedgedriver.exe" : "WebKitWebDriver";
}

const binary = appBinary();
if (!binary) {
  throw new Error(
    "e2e:desktop — no built app found.\n" +
      "  Build one first:  npx tauri build --debug\n" +
      "  Or point at it:   $env:ARTDADDY_APP_BINARY = 'C:\\path\\to\\artdaddy.exe'",
  );
}

let driver;

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: [path.join(here, "*.spec.mjs")],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "wry",
      "tauri:options": { application: binary },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  logLevel: "warn",
  waitforTimeout: 20_000,
  connectionRetryCount: 3,

  onPrepare: () => {
    driver = spawn("tauri-driver", ["--native-driver", nativeDriver()], {
      stdio: [null, process.stdout, process.stderr],
    });
    driver.on("error", (e) => {
      throw new Error(
        `e2e:desktop — could not start tauri-driver (${e.message}).\n` +
          "  Install it with:  cargo install tauri-driver --locked",
      );
    });
  },
  onComplete: () => {
    driver?.kill();
  },
};
