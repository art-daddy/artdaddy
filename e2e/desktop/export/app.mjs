// The real app for the export lane: built from THIS worktree under its own identity, started, driven over
// CDP, closed, killed and started again.
//
// Its own identity, not the installed app's. A debug build with the shipped config shares everything with an
// installed ArtDaddy on the same PC: the single-instance key (launching the installed app would only focus this
// window), the `artdaddy://` sign-in link (a debug build on Windows registers it for itself), the web
// view's storage and the native export journal under %LOCALAPPDATA%\com.artdaddy.app. So the shell is
// built with TAURI_CONFIG naming its own identifier and link scheme (the pattern of
// scripts/qa/exporterNative.mjs), and the web view keeps its storage in the run's folder. The projects folder
// cannot be moved (the app takes it from the OS's data folder: the ARTDADDY_DATA_DIR override in
// src/tools/dataRoot.ts asks the shell for a `get_env` command it no longer has), so the lane names its projects
// `sweep_qa-export …` and removes them through the app. The page is served by a
// Vite server with hot reload off (scripts/qa/exporterVite.mjs says why: a dropped socket reloads the page
// under a running export).
//
// `cargo build` with TAURI_CONFIG is what `tauri dev` runs; running the exe ourselves is what lets a
// scenario quit it, kill it and start it again by process id.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..", "..", "..");

export const IDENTIFIER = "com.artdaddy.qa.export";
export const LINK_SCHEME = "artdaddy-qa-export";
export const PAGE_PORT = Number(process.env.ARTDADDY_QA_EXPORT_PAGE_PORT || 5287);
export const CDP_PORT = Number(process.env.CDP_PORT || 9287);
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tauriConfig() {
  return {
    identifier: IDENTIFIER,
    build: { devUrl: PAGE_URL, beforeDevCommand: "", beforeBuildCommand: "" },
    plugins: { "deep-link": { desktop: { schemes: [LINK_SCHEME] } } },
  };
}

export function targetDir() {
  return process.env.CARGO_TARGET_DIR || path.join(root, "src-tauri", "target");
}

export function exePath() {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const name = conf.mainBinaryName || conf.productName;
  return path.join(targetDir(), "debug", process.platform === "win32" ? `${name}.exe` : name);
}

/** No model key may reach the app or anything it starts: an AI request must fail, never bill. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/AZURE|GOOGLE|OPENAI|VERTEX|ANTHROPIC/i.test(key)) delete env[key];
  return { ...env, ...extra };
}

/** Compile the shell with this lane's identity. A no-op in seconds when nothing changed; a rebuild when
 *  anything else (another worktree, the shipped config) built the shared target last. */
export function buildShell(log) {
  const t0 = performance.now();
  const r = spawnSync("cargo", ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml")], {
    cwd: root,
    env: cleanEnv({ TAURI_CONFIG: JSON.stringify(tauriConfig()) }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (log) writeFileSync(log, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  if (r.status !== 0) throw new Error(`cargo build failed (${r.status}); see ${log ?? "its output"}`);
  return { ms: Math.round(performance.now() - t0), exe: exePath(), builtAt: statSync(exePath()).mtime.toISOString() };
}

/** The page's server: this worktree's source, no hot reload, the API pointed at the lane's stand-in server
 *  (backend.mjs: no request can reach a real one), the e2e sign-in bypass, no Sentry. */
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

/** The registry entry Windows opens `artdaddy://` links with. A run must leave the installed app's link alone. */
export function signInLinkTarget() {
  const r = spawnSync("reg", ["query", "HKCU\\Software\\Classes\\artdaddy\\shell\\open\\command", "/ve"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout.match(/REG_SZ\s+(.*)/)?.[1] ?? "").trim() : null;
}

/** Is another ArtDaddy (an installed one, another run) on this PC? */
export function otherAppsRunning() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "Get-Process artdaddy -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)|$($_.Path)\" }"], { encoding: "utf8" });
  return (r.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, file] = line.split("|");
    return { pid: Number(pid), path: file };
  });
}

export class App {
  constructor(runDir) {
    this.runDir = runDir;
    this.webviewDir = path.join(runDir, "webview");
    this.child = null;
    this.launches = [];
    mkdirSync(this.webviewDir, { recursive: true });
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Start the app and wait until its menu bar is on screen. Resolves with how long that took. The first start of a
   *  run waits longer: the page server compiles the app's modules on first request, which takes minutes on a busy PC. */
  async launch(label = "launch", { menuMs = this.launches.length ? 120_000 : 300_000 } = {}) {
    if (this.running()) throw new Error("the app is already running");
    const t0 = performance.now();
    const log = path.join(this.runDir, `app-${this.launches.length + 1}.log`);
    const child = spawn(exePath(), [], {
      cwd: root,
      env: cleanEnv({
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
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
    this.exitedAt = null;
    child.on("exit", () => (this.exitedAt = performance.now()));
    const { connectPage } = await import("./cdp.mjs");
    const d = await connectPage(CDP_PORT, 90_000, () => !this.running());
    // Kept before the menu shows, so a clean-up after a start that never finished can still reach the page.
    this.d = d;
    await d.waitFor(
      `[...document.querySelectorAll('button')].some(b => (b.innerText ?? '').trim() === 'File')`,
      menuMs,
    );
    const ms = Math.round(performance.now() - t0);
    this.launches.push({ label, pid: child.pid, ms, at: new Date().toISOString() });
    return { d, ms };
  }

  /** Wait for the process to end on its own (after a quit). */
  async waitExit(ms = 30_000) {
    const end = Date.now() + ms;
    while (this.running() && Date.now() < end) await sleep(100);
    return !this.running();
  }

  /** End the process tree the way Task Manager's "End process tree" does: no close request, no clean-up. */
  kill() {
    if (!this.child?.pid) return;
    try {
      this.d?.close();
    } catch {
      /* gone */
    }
    spawnSync("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { encoding: "utf8" });
  }

  /** End the app's own process only, as a crash does: whatever it started is left to whatever the OS does with
   *  it, which is the point (a sidecar that outlives the app keeps writing). */
  crash() {
    if (!this.child?.pid) return;
    try {
      this.d?.close();
    } catch {
      /* gone */
    }
    spawnSync("taskkill.exe", ["/PID", String(this.child.pid), "/F"], { encoding: "utf8" });
  }

  async stop() {
    if (!this.running()) return;
    this.kill();
    await this.waitExit(15_000);
  }
}

export function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/** This identity's native export journal (the app keeps one intent per export there, and takes an unfinished one
 *  over at its next start). Only this lane's own identity: never the installed app's. */
export const journalDir = () => path.join(process.env.LOCALAPPDATA ?? "", IDENTIFIER, "exports", "intents-v1");

/** Move what earlier runs left in this identity's journal into `into` (kept as evidence), so a run starts with
 *  nothing for the app to take over: an export an earlier run left unfinished would otherwise come back in this
 *  run's queue. Returns what was moved. */
export function clearJournal(into) {
  const dir = journalDir();
  if (!process.env.LOCALAPPDATA || !existsSync(dir)) return [];
  const moved = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    ensureDir(into);
    renameSync(path.join(dir, name), path.join(into, name));
    moved.push(name);
  }
  return moved;
}
