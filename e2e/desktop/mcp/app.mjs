// The real app for the MCP lane: built from THIS worktree under its own identity, started, driven over CDP, quit
// through its own File menu and started again.
//
// The pattern is the export lane's (e2e/desktop/export/app.mjs, which says why each part is there): its own identifier
// and sign-in link scheme through TAURI_CONFIG, so it never takes the installed app's single-instance key, its
// `artdaddy://` link or its web view storage; the web view keeps its storage in the run's folder; the page comes from
// a Vite server with hot reload off; the API is a stand-in on loopback that answers only the build check. What this
// lane adds: the window says it is a test, because while it runs it holds the MCP port that every agent on the PC
// (and the owner's own app) would otherwise use.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectPage } from "../export/cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..", "..", "..");

export const IDENTIFIER = "com.artdaddy.qa.mcp";
export const LINK_SCHEME = "artdaddy-qa-mcp";
export const WINDOW_TITLE = "ArtDaddy QA (test): MCP lane";
export const MCP_PORT = 19787;
export const PAGE_PORT = Number(process.env.ARTDADDY_QA_MCP_PAGE_PORT || 5391);
export const CDP_PORT = Number(process.env.ARTDADDY_QA_MCP_CDP_PORT || 9391);
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shippedWindow() {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  return conf.app.windows[0];
}

export function tauriConfig() {
  return {
    identifier: IDENTIFIER,
    build: { devUrl: PAGE_URL, beforeDevCommand: "", beforeBuildCommand: "" },
    // A merge patch replaces a list whole, so the shipped window is copied and only its title changes.
    app: { windows: [{ ...shippedWindow(), title: WINDOW_TITLE }] },
    plugins: { "deep-link": { desktop: { schemes: [LINK_SCHEME] } } },
  };
}

export function exePath() {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const name = conf.mainBinaryName || conf.productName;
  const target = process.env.CARGO_TARGET_DIR || path.join(root, "src-tauri", "target");
  return path.join(target, "debug", process.platform === "win32" ? `${name}.exe` : name);
}

/** No model key may reach the app or anything it starts: an AI request must fail, never bill. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/AZURE|GOOGLE|OPENAI|VERTEX|ANTHROPIC/i.test(key)) delete env[key];
  return { ...env, ...extra };
}

/** Compile the shell with this lane's identity (what `tauri dev` runs). Seconds when nothing changed. */
export function buildShell(log) {
  const t0 = performance.now();
  const r = spawnSync(
    "cargo",
    ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml")],
    {
      cwd: root,
      env: cleanEnv({ TAURI_CONFIG: JSON.stringify(tauriConfig()) }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (log) writeFileSync(log, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  if (r.status !== 0)
    throw new Error(`cargo build failed (${r.status}); see ${log ?? "its output"}`);
  return {
    ms: Math.round(performance.now() - t0),
    exe: exePath(),
    builtAt: statSync(exePath()).mtime.toISOString(),
  };
}

/** The page's server: this worktree's source, no hot reload, the API on the lane's loopback stand-in, the e2e
 *  sign-in bypass, no Sentry. */
export async function startPage(apiBase) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase ?? ""))
    throw new Error(`the page's API must be a loopback stand-in, not ${apiBase}`);
  Object.assign(process.env, {
    VITE_API_BASE_URL: apiBase,
    VITE_E2E_AUTH_BYPASS: "1",
    VITE_SENTRY_DSN: "",
  });
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    mode: "development",
    logLevel: "warn",
    server: { host: "127.0.0.1", port: PAGE_PORT, strictPort: true, hmr: false, ws: false },
  });
  await server.listen();
  return server;
}

function powershell(command) {
  return (
    spawnSync("powershell", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    }).stdout?.trim() ?? ""
  );
}

/** The process listening on a loopback port, or null. */
export function portHolder(port = MCP_PORT) {
  const pid = Number(
    powershell(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ),
  );
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function processCommandLine(pid) {
  return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
}

/** Every ArtDaddy process on this PC (an installed one, another run): `artdaddy.exe` by any path. */
export function artdaddyProcesses() {
  return powershell(
    'Get-Process artdaddy -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)" }',
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, file] = line.split("|");
      return { pid: Number(pid), path: file };
    });
}

/** The web view processes this app started (its window's page lives in them), with when each started. */
export function webviewProcesses(pid) {
  if (!pid) return [];
  return powershell(
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' AND ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToString('HH:mm:ss'))" }`,
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [child, at] = line.split("|");
      return { pid: Number(child), at };
    });
}

/** Is a page reachable on this debugging port? */
export async function pageAlive(port = CDP_PORT) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(3000),
    }).then((r) => r.json());
    return targets.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

/** The registry entry Windows opens `artdaddy://` links with. A run must leave the installed app's link alone. */
export function signInLinkTarget() {
  const r = spawnSync(
    "reg",
    ["query", "HKCU\\Software\\Classes\\artdaddy\\shell\\open\\command", "/ve"],
    {
      encoding: "utf8",
    },
  );
  return r.status === 0 ? (r.stdout.match(/REG_SZ\s+(.*)/)?.[1] ?? "").trim() : null;
}

export function linkKeyExists() {
  return (
    spawnSync("reg", ["query", `HKCU\\Software\\Classes\\${LINK_SCHEME}`], { encoding: "utf8" })
      .status === 0
  );
}

export function removeLinkKey() {
  spawnSync("reg", ["delete", `HKCU\\Software\\Classes\\${LINK_SCHEME}`, "/f"], {
    encoding: "utf8",
  });
}

export class App {
  constructor(runDir) {
    this.runDir = runDir;
    this.webviewDir = path.join(runDir, "webview");
    this.child = null;
    this.d = null;
    this.startedAt = 0;
    this.cdpPort = CDP_PORT;
    this.lastPid = null;
    this.launches = [];
    mkdirSync(this.webviewDir, { recursive: true });
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Start the app and wait for its menu bar. `startedAt` is the performance clock at the spawn, for the waits a
   *  scenario times from the launch. The first start waits longest: the page server compiles the app's modules then.
   *
   *  Two things keep a restart from being judged on the copy that just quit. Each start gets its own debugging port,
   *  so the page this lane drives is never the old copy's page still being torn down. And the new copy starts only
   *  once the old copy's web view processes are gone (they share the web view's data folder, and a new copy can attach
   *  to a browser process that is about to exit): how long they lingered is kept with the launch. */
  async launch(label = "launch", { menuMs = this.launches.length ? 120_000 : 300_000 } = {}) {
    if (this.running()) throw new Error("the app is already running");
    let lingeredMs = 0;
    if (this.lastPid) {
      const since = performance.now();
      while (webviewProcesses(this.lastPid).length && performance.now() - since < 30_000)
        await sleep(250);
      lingeredMs = Math.round(performance.now() - since);
    }
    this.cdpPort = CDP_PORT + this.launches.length;
    const t0 = performance.now();
    this.startedAt = t0;
    const log = path.join(this.runDir, `app-${this.launches.length + 1}.log`);
    const child = spawn(exePath(), [], {
      cwd: root,
      env: cleanEnv({
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.cdpPort}`,
        WEBVIEW2_USER_DATA_FOLDER: this.webviewDir,
        RUST_LOG: process.env.RUST_LOG || "info",
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("exit", () => writeFileSync(log, Buffer.concat(chunks)));
    this.child = child;
    this.lastPid = child.pid;
    this.d = await connectPage(this.cdpPort, 90_000, () => !this.running());
    await this.d.waitFor(
      `[...document.querySelectorAll('button')].some(b => (b.innerText ?? '').trim() === 'File')`,
      menuMs,
    );
    const ms = Math.round(performance.now() - t0);
    this.launches.push({
      label,
      pid: child.pid,
      cdpPort: this.cdpPort,
      ms,
      lingeredMs,
      at: new Date().toISOString(),
    });
    return { ms, lingeredMs };
  }

  /** Is this copy's page reachable (its debugging port answers with a page)? */
  pageAlive() {
    return pageAlive(this.cdpPort);
  }

  /** Quit the way a person does: File > Exit. Resolves with whether the process ended. */
  async quit(ms = 30_000) {
    if (!this.running()) return true;
    await this.d.key("Escape");
    await this.d.clickText("File", { sel: "button" });
    await this.d.clickText("Exit", { sel: "button,[role=menuitem]" });
    const end = Date.now() + ms;
    while (this.running() && Date.now() < end) await sleep(100);
    try {
      this.d.close();
    } catch {
      /* gone with the app */
    }
    return !this.running();
  }

  /** End the process tree, as Task Manager's "End process tree" does. Only this run's own process. */
  kill() {
    if (!this.child?.pid) return;
    try {
      this.d?.close();
    } catch {
      /* gone */
    }
    spawnSync("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { encoding: "utf8" });
  }

  async stop() {
    if (!this.running()) return;
    if (!(await this.quit().catch(() => false))) this.kill();
    const end = Date.now() + 15_000;
    while (this.running() && Date.now() < end) await sleep(100);
  }
}
