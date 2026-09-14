// Minimal W3C WebDriver client for the Tauri desktop lane.
//
// WebdriverIO cannot be installed on this machine (registry.npmjs.org fails the TLS handshake
// and its tree is not in the npm cache), but nothing here needs it: `tauri-driver` is a plain
// W3C WebDriver server, and `fetch` is enough to speak it. The Actions API below is REAL pointer
// input delivered to the app window only — unlike synthetic OS-level mouse events, it cannot
// land in another application if the app loses focus.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..", "..");
const BASE = "http://127.0.0.1:4444";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

export async function startDriver() {
  const native = process.env.MSEDGEDRIVER || "msedgedriver";
  const proc = spawn("tauri-driver", ["--native-driver", native], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => process.stderr.write(`[tauri-driver] ${d}`));
  // Poll the status endpoint rather than sleeping a fixed time.
  for (let i = 0; i < 60; i++) {
    try {
      await call("GET", "/status");
      return proc;
    } catch {
      await sleep(250);
    }
  }
  proc.kill();
  throw new Error("tauri-driver did not come up on 4444");
}

export async function newSession(application) {
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
