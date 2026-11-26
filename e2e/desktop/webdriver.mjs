// Minimal W3C WebDriver client for the Tauri desktop lane.
//
// WebdriverIO cannot be installed on this machine (registry.npmjs.org fails the TLS handshake
// and its tree is not in the npm cache), but nothing here needs it: `tauri-driver` is a plain
// W3C WebDriver server, and `fetch` is enough to speak it. The Actions API below is REAL pointer
// input delivered to the app window only — unlike synthetic OS-level mouse events, it cannot
// land in another application if the app loses focus.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..", "..");
const BASE = "http://127.0.0.1:4444";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app's MCP port (src-tauri/src/mcp.rs DEFAULT_PORT). */
export const MCP_PORT = 19787;

function portTaken(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Whether something already listens on the MCP port. Only one app can hold it, so a lane that talks MCP checks this
 *  BEFORE it launches its app: if another ArtDaddy (an installed one) holds the port, every call would reach that
 *  app and its projects, never the one under test. */
export function mcpPortTaken(port = MCP_PORT) {
  return portTaken(port);
}

export function appBinary() {
  const explicit = process.env.ARTDADDY_APP_BINARY;
  if (explicit) return explicit;
  // Take the name from the config that produced the binary. Hardcoding it meant the product
  // rename left `app.exe` behind in target/debug, and every desktop lane went on driving that
  // stale build -- passing, against code that was days old.
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const name = conf.mainBinaryName || conf.productName;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const profile of ["debug", "release"]) {
    const p = path.join(root, "src-tauri", "target", profile, exe);
    if (existsSync(p)) return p;
  }
  throw new Error(`no built ${exe} — run \`npx tauri dev\` once, or set ARTDADDY_APP_BINARY`);
}

/** The app's OS process name (no extension) — what Get-Process answers to. The helper scripts
 *  defaulted to "app", so every OS-level lane silently found no window after the rename. */
export function appProcessName() {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  return conf.mainBinaryName || conf.productName;
}

/** Where the app keeps projects. Read from brand.json for the same reason as the binary name:
 *  every desktop lane had `APPDATA/Akaru/projects` frozen in, which is the LEGACY folder. The
 *  reads got ENOENT and the cleanups deleted nothing, quietly littering the real root. */
export function projectsRoot() {
  const brand = JSON.parse(readFileSync(path.join(root, "src", "brand.json"), "utf8"));
  const folder = brand.identity.dataFolder;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA
      : process.platform === "darwin"
        ? path.join(process.env.HOME, "Library", "Application Support")
        : process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local", "share");
  return path.join(base, folder, "projects");
}

async function call(method, url, body, timeoutMs) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${url} -> non-JSON ${res.status}: ${text.slice(0, 300)}`);
  }
  if (json.value?.error) {
    throw new Error(`${method} ${url} -> ${json.value.error}: ${json.value.message?.slice(0, 300)}`);
  }
  return json.value;
}

/** Stops a process and everything it started (Windows does not stop a killed process's children). */
function stopTree(proc) {
  if (proc.exitCode !== null || !proc.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc.kill("SIGKILL");
}

/** Starts tauri-driver (4444), which runs the Edge WebDriver (4445) as its child, and waits until it answers.
 *
 *  Lanes run back to back (the nightly timing run) met two failures here: killing tauri-driver alone left that child
 *  running and holding 4445, and a pair started while the previous one was still letting go of its ports found the
 *  new Edge WebDriver unable to bind ("Only one usage of each socket address") and tauri-driver never answering. So
 *  `driver.kill()` stops the whole tree on Windows, a start waits for both ports, and a pair that does not answer
 *  within 30 s is stopped and started again (three tries). */
export async function startDriver() {
  const native = process.env.MSEDGEDRIVER || "msedgedriver";
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (let i = 0; i < 80 && ((await portTaken(4444)) || (await portTaken(4445))); i++) await sleep(250);
    const proc = spawn("tauri-driver", ["--native-driver", native], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (d) => process.stderr.write(`[tauri-driver] ${d}`));
    if (process.platform === "win32") {
      const killOne = proc.kill.bind(proc);
      proc.kill = (signal) => {
        stopTree(proc);
        return killOne(signal);
      };
    }
    // Poll the status endpoint rather than sleeping a fixed time.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await call("GET", "/status", undefined, 3_000);
        return proc;
      } catch {
        await sleep(250);
      }
    }
    proc.kill();
    process.stderr.write(`[tauri-driver] did not answer on 4444 (try ${attempt} of 3)\n`);
    await sleep(1_000);
  }
  throw new Error("tauri-driver did not come up on 4444");
}

/** The WebView2 debugging port to ATTACH through instead of letting the Edge WebDriver start the app (see
 *  launchForAttach); 0 when unset, the usual way. */
export const ATTACH_PORT = Number(process.env.ARTDADDY_WEBVIEW2_DEBUG_PORT || 0);

/** Starts the app with its WebView2 debugging port open, for the Edge WebDriver to attach to (`debuggerAddress`).
 *
 *  The Edge WebDriver opens that port with WEBVIEW2_* variables when it starts the app, and an ELEVATED WebView2
 *  ignores those ("session not created: DevToolsActivePort file doesn't exist"). GitHub's Windows runners are
 *  elevated, so there the port comes from HKLM policy instead (the desktop-e2e job in .github/workflows/ci.yml sets
 *  it, as scripts/qa/windowsUpdateCanary.mjs does) and the variable below serves a normal machine. Whatever opens the
 *  port replaces the app's own WebView2 arguments (tauri.conf.json), so they are repeated. Returns the app's process
 *  once the port answers. */
export async function launchForAttach(application, port = ATTACH_PORT) {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const own = (conf.app?.windows ?? []).map((w) => w.additionalBrowserArgs).find(Boolean) ?? "";
  const app = spawn(application, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `${own} --remote-debugging-port=${port} --remote-allow-origins=*`.trim(),
    },
    stdio: "ignore",
  });
  try {
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) })).ok,
      { label: `the app's WebView2 debugging port ${port}`, timeout: 120_000, interval: 250 },
    );
  } catch (error) {
    stopTree(app);
    throw error;
  }
  return { app, stop: () => stopTree(app) };
}

/** The capabilities that attach the Edge WebDriver to a WebView2 whose debugging port is `port`. tauri-driver passes a
 *  request with no `tauri:options` through as it is. */
export function attachCapabilities(port = ATTACH_PORT) {
  return { browserName: "webview2", "ms:edgeOptions": { debuggerAddress: `127.0.0.1:${port}` } };
}

/** A session on the app: started by the Edge WebDriver, or, with ARTDADDY_WEBVIEW2_DEBUG_PORT set, started here and
 *  attached to (launchForAttach). Either way `quit()` closes the app. */
export async function newSession(application) {
  if (ATTACH_PORT) {
    const launched = await launchForAttach(application);
    let v;
    try {
      v = await call("POST", "/session", { capabilities: { alwaysMatch: attachCapabilities() } });
    } catch (error) {
      launched.stop();
      throw error;
    }
    const id = v.sessionId ?? v.capabilities?.sessionId;
    if (!id) {
      launched.stop();
      throw new Error(`no sessionId in ${JSON.stringify(v).slice(0, 200)}`);
    }
    const attached = session(id);
    const detach = attached.quit;
    attached.quit = async () => {
      await detach();
      launched.stop();
      for (let i = 0; i < 40 && launched.app.exitCode === null; i++) await sleep(250);
    };
    return attached;
  }
  const v = await call("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application } } },
  });
  const id = v.sessionId ?? v.capabilities?.sessionId;
  if (!id) throw new Error(`no sessionId in ${JSON.stringify(v).slice(0, 200)}`);
  return session(id);
}

function session(id) {
  const s = (p) => `/session/${id}${p}`;
  const self = {
    id,
    quit: () => call("DELETE", s("")).catch(() => {}),
    /** Run JS in the webview. `body` is a function source string; args are JSON. */
    exec: (script, args = []) => call("POST", s("/execute/sync"), { script, args }),
    findAll: (css) => call("POST", s("/elements"), { using: "css selector", value: css }),
    async find(css) {
      const els = await self.findAll(css);
      if (!els.length) throw new Error(`no element matches ${css}`);
      return Object.values(els[0])[0];
    },
    click: (elementId) => call("POST", s(`/element/${elementId}/click`), {}),
    type: (elementId, text) => call("POST", s(`/element/${elementId}/value`), { text }),
    /** A REAL pointer drag through the app's own input pipeline. */
    async drag(from, to, steps = 12) {
      const actions = [{ type: "pointerMove", duration: 0, x: Math.round(from.x), y: Math.round(from.y) }, { type: "pointerDown", button: 0 }, { type: "pause", duration: 120 }];
      for (let i = 1; i <= steps; i++) {
        actions.push({
          type: "pointerMove",
          duration: 40,
          x: Math.round(from.x + ((to.x - from.x) * i) / steps),
          y: Math.round(from.y + ((to.y - from.y) * i) / steps),
        });
      }
      actions.push({ type: "pause", duration: 200 }, { type: "pointerUp", button: 0 });
      await call("POST", s("/actions"), {
        actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
      });
      await call("DELETE", s("/actions")).catch(() => {});
    },
    /** Centre of the first element matching `css`, in viewport coords. */
    box: (css) =>
      self.exec(
        "const el = document.querySelector(arguments[0]); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };",
        [css],
      ),
  };
  return self;
}

export { sleep };

/** Poll until `fn` returns something truthy. A fixed sleep is a coin toss here: the app boots in
 *  anything from 2s to 10s depending on how warm vite is, and the failure ("no button: File")
 *  looks like a broken selector rather than a race. A COLD dev build (vite transforming the whole
 *  tree on first request) takes far longer than that — measured at ~50s — so the ceiling is
 *  raisable rather than a constant that turns a slow boot into a fake failure. */
const DEFAULT_TIMEOUT = Number(process.env.ARTDADDY_E2E_TIMEOUT_MS || 40_000);
export async function waitFor(fn, { timeout = DEFAULT_TIMEOUT, interval = 300, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
    await sleep(interval);
  }
}
