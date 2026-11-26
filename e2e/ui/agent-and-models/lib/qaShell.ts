// The QA shell: a stand-in for the desktop app's native side, so the browser lane can open a
// project. In the real app the page talks to Rust through `window.__TAURI_INTERNALS__.invoke`;
// in a plain browser that bridge is missing, projects resolve through Tauri's `dataDir()`, and no
// project can ever be created (e2e/ui/menus.spec.ts proves the failure). This installs a bridge
// before the app's first script runs, and answers its commands from the test process:
//
//   * files (the fs plugin, `commit_file`, `remove_file`, `trash_path`, `read_file_head`,
//     `probe_media_file`) live in a REAL folder under the test's output folder, so what the app
//     saved is read back from disk the way the desktop app would have written it;
//   * the app sees that folder as `/qa-home/...` (POSIX on every OS), never a host path;
//   * `sidecar_run` runs the shipped ffprobe/ffmpeg (src-tauri/binaries) on those real files;
//   * the OS file dialog answers what the test queued (`pickFiles`), as if the person chose it;
//   * everything else the app asks at start (MCP, crash watch, the keychain, the updater) gets
//     the answer of a desktop with nothing running; an unknown command is refused and recorded.
//
// What it does NOT cover: the real Rust commands, the WebView2/WKWebView engines and the real
// OS dialogs. Those are the desktop lane's (e2e/desktop). The page side runs in the page; the
// Node side is `QaShell.handle`, reached through one exposed function.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Page } from "@playwright/test";

/** Where the app's own folders appear, from the page's side. */
export const VIRTUAL_ROOT = "/qa-home";

type Args = Record<string, unknown>;

export interface ShellCall {
  cmd: string;
  at: number;
  error?: string;
}

/** The host the shell reports (host_platform), mirroring the machine the test runs on. */
function hostPlatform(): [string, string] {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return ["windows", arch];
  if (process.platform === "darwin") return ["macos", arch];
  return ["linux", arch];
}

function hostTriple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

export class QaShell {
  /** Every command the app sent, in order. */
  readonly calls: ShellCall[] = [];
  /** Commands the shell does not know: each is refused, as a command the app lacks would be. */
  readonly unknown = new Set<string>();
  /** Internet origins the page tried to reach (all refused: the shell's desktop is offline). */
  readonly blocked = new Set<string>();
  /** The OS keychain's saved session. A person who signed in once has one; null = signed out. */
  refreshToken: string | null = "qa-refresh-0";
  private appVersion = "0.0.0";
  private readonly picks: Array<string[] | null> = [];
  private readonly answers: boolean[] = [];
  private readonly runs = new Map<string, ChildProcess>();

  private constructor(readonly root: string) {}

  /** A shell whose disk is `root`: empty apart from the folders an installed app has made. */
  static async create(root: string): Promise<QaShell> {
    await fsp.rm(root, { recursive: true, force: true });
    for (const d of [
      "data/ArtDaddy/projects",
      "cache",
      "appcache",
      "downloads",
      "home",
      "tmp",
      "resources",
      "media",
    ])
      await fsp.mkdir(path.join(root, d), { recursive: true });
    return new QaShell(root);
  }

  /** The page's path for a file under the shell's disk (`media/still.png` -> `/qa-home/media/still.png`). */
  virtual(rel: string): string {
    return `${VIRTUAL_ROOT}/${rel.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  }

  /** The real file behind a page path. Refuses anything outside the shell's disk. */
  real(vpath: string): string {
    const p = String(vpath).replace(/\\/g, "/");
    if (p !== VIRTUAL_ROOT && !p.startsWith(`${VIRTUAL_ROOT}/`))
      throw new Error(`forbidden path: ${vpath}`);
    const rel = p.slice(VIRTUAL_ROOT.length).replace(/^\/+/, "");
    const out = path.resolve(this.root, rel);
    if (out !== this.root && !out.startsWith(this.root + path.sep))
      throw new Error(`forbidden path: ${vpath}`);
    return out;
  }

  /** The real folder of project `id`. */
  projectDir(id: string): string {
    return path.join(this.root, "data", "ArtDaddy", "projects", id);
  }

  /** A saved project file, parsed (`internals/timeline.json`...), or null when it is not there. */
  async readProjectJson<T = Record<string, unknown>>(id: string, rel: string): Promise<T | null> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.projectDir(id), rel), "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** Put a copy of `source` on the shell's disk under media/, and return its page path. */
  async addMedia(source: string, name = path.basename(source)): Promise<string> {
    await fsp.copyFile(source, path.join(this.root, "media", name));
    return this.virtual(`media/${name}`);
  }

  /** The next OS file dialog the app opens answers these paths (page paths); null = cancelled. */
  pickFiles(paths: string[] | null): void {
    this.picks.push(paths);
  }

  /** The next yes/no dialog (`ask`/`confirm`) answers this. Unqueued ones answer no. */
  answerDialog(yes: boolean): void {
    this.answers.push(yes);
  }

  /** Wire the bridge into `page`: before navigation, so it exists before the app's first line. */
  async install(page: Page, apiBase: string, appVersion: string): Promise<void> {
    this.appVersion = appVersion;
    await page.exposeFunction("__qaShellCall", (cmd: string, json: string) =>
      this.handle(cmd, json),
    );
    const [os, arch] = hostPlatform();
    await page.addInitScript(pageShell, { root: VIRTUAL_ROOT, apiBase, os, arch, appVersion });
    // A desktop with no internet: the only server is the fake one. Nothing a test does can reach a
    // real service (the production API, a model vendor, the speech model's 465 MB download).
    await page.route("https://**", async (route) => {
      this.blocked.add(new URL(route.request().url()).origin);
      await route.abort("internetdisconnected");
    });
    // The asset protocol (convertFileSrc) is served from the shell's disk, so <img>/<video> work.
    await page.route("http://asset.localhost/**", async (route) => {
      try {
        const vpath = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
        await route.fulfill({ body: await fsp.readFile(this.real(vpath)) });
      } catch {
        await route.fulfill({ status: 404, body: "" });
      }
    });
  }

  /** Stop every process a sidecar run started that is still running. */
  dispose(): void {
    for (const child of this.runs.values()) child.kill();
    this.runs.clear();
  }

  /** One command from the page. Answers a JSON envelope: {ok, value} | {ok, bytes} | {ok:false, error}. */
  async handle(cmd: string, json: string): Promise<string> {
    const call: ShellCall = { cmd, at: performance.now() };
    this.calls.push(call);
    try {
      const out = await this.dispatch(cmd, (JSON.parse(json) ?? {}) as Args);
      if (out instanceof Uint8Array)
        return JSON.stringify({ ok: true, bytes: Buffer.from(out).toString("base64") });
      return JSON.stringify({ ok: true, value: out === undefined ? null : out });
    } catch (e) {
      // A host path never reaches the page: the app only ever knows the shell's own paths.
      const message = e instanceof Error ? e.message : String(e);
      call.error = message
        .split(this.root)
        .join(VIRTUAL_ROOT)
        .split(this.root.replace(/\\/g, "/"))
        .join(VIRTUAL_ROOT)
        .replace(/\\/g, "/");
      return JSON.stringify({ ok: false, error: call.error });
    }
  }

  private async dispatch(cmd: string, a: Args): Promise<unknown> {
    const p = (k = "path"): string => this.real(String(a[k]));
    switch (cmd) {
      // ── the fs plugin ──────────────────────────────────────────────────────
      case "plugin:fs|exists":
        return existsSync(p());
      case "plugin:fs|read_text_file":
      case "plugin:fs|read_file":
        return new Uint8Array(await readOrExplain(p(), String(a.path)));
      case "plugin:fs|write_text_file":
      case "plugin:fs|write_file": {
        const headers = (a.__headers ?? {}) as Record<string, string>;
        const shown = decodeURIComponent(headers.path ?? "");
        const target = this.real(shown);
        const options = headers.options
          ? (JSON.parse(headers.options) as { append?: boolean } | null)
          : null;
        const bytes = Buffer.from(String(a.__raw ?? ""), "base64");
        try {
          if (options?.append) await fsp.appendFile(target, bytes);
          else await fsp.writeFile(target, bytes);
        } catch {
          throw new Error(
            `failed to open file at path: ${shown} with error: The system cannot find the path specified. (os error 3)`,
          );
        }
        return null;
      }
      case "plugin:fs|stat":
      case "plugin:fs|lstat": {
        const s = await fsp.stat(p()).catch(() => {
          throw new Error(`failed to get metadata of path: ${String(a.path)} (os error 2)`);
        });
        return {
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          isSymlink: false,
          size: s.size,
          mtime: s.mtimeMs,
          atime: s.atimeMs,
          birthtime: s.birthtimeMs,
          readonly: false,
          fileAttributes: null,
          dev: null,
          ino: null,
          mode: null,
          nlink: null,
          uid: null,
          gid: null,
          rdev: null,
          blksize: null,
          blocks: null,
        };
      }
      case "plugin:fs|read_dir": {
        const entries = await fsp.readdir(p(), { withFileTypes: true }).catch(() => {
          throw new Error(`failed to read directory at path: ${String(a.path)} (os error 2)`);
        });
        return entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        }));
      }
      case "plugin:fs|mkdir":
        await fsp.mkdir(p(), { recursive: true });
        return null;
      case "plugin:fs|copy_file":
        await fsp.copyFile(this.real(String(a.fromPath)), this.real(String(a.toPath)));
        return null;
      case "plugin:fs|remove":
        await fsp.rm(p(), {
          recursive: Boolean((a.options as Args | null)?.recursive),
          force: false,
        });
        return null;
      case "plugin:fs|rename":
        await fsp.rename(this.real(String(a.oldPath)), this.real(String(a.newPath)));
        return null;
      // ── the app's own file commands (src-tauri/src/lib.rs) ─────────────────
      case "commit_file":
        await fsp.rename(this.real(String(a.from)), this.real(String(a.to)));
        return null;
      case "remove_file":
        await fsp.rm(p(), { force: true });
        return null;
      case "trash_path": {
        const from = p();
        const bin = path.join(this.root, "trash");
        await fsp.mkdir(bin, { recursive: true });
        await fsp.rename(from, path.join(bin, `${Date.now()}-${path.basename(from)}`));
        return null;
      }
      case "read_file_head":
        return new Uint8Array(await readRange(p(), String(a.path), 0, Number(a.maxBytes) || 0));
      case "read_file_range":
        return new Uint8Array(
          await readRange(p(), String(a.path), Number(a.offset) || 0, Number(a.maxBytes) || 0),
        );
      case "probe_media_file": {
        const bytes = await readOrExplain(p(), String(a.path));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const head = Array.from(bytes.subarray(0, Math.max(0, Number(a.headBytes) || 0)));
        return { id12: sha256.slice(0, 12), sha256, size: bytes.length, head };
      }
      case "allow_preview_path":
        return null;
      // ── the shipped sidecars, on the shell's real files ────────────────────
      case "sidecar_run":
        return this.runSidecar(a);
      case "sidecar_kill":
        this.runs.get(String(a.runId))?.kill();
        return null;
      // ── the OS dialogs: what the test queued ───────────────────────────────
      case "plugin:dialog|open": {
        const pick = this.picks.length ? this.picks.shift()! : null;
        if (!pick) return null;
        return (a.options as Args | null)?.multiple ? pick : pick[0];
      }
      case "plugin:dialog|save":
        return null;
      case "plugin:dialog|ask":
      case "plugin:dialog|confirm":
        return this.answers.length ? this.answers.shift()! : false;
      case "plugin:dialog|message":
        return null;
      // ── a desktop with nothing else running ────────────────────────────────
      case "get_env":
        return null;
      case "host_platform":
        return hostPlatform();
      case "processor_name":
        return "QA shell CPU";
      case "process_age_ms":
        return 1500;
      case "jobs_export_resources":
        return null;
      case "runtime_health_begin":
      case "runtime_health_status":
        return { launch_id: "qa-shell", renderer_epoch: 1, failures: [], storage_ok: true };
      case "runtime_health_ack":
        return true;
      case "runtime_health_update":
      case "runtime_health_cause":
        return null;
      case "mcp_status":
      case "mcp_stop":
        return { running: false, port: 19787 };
      case "mcp_start":
        // The QA shell never opens the MCP port: a second listener on this PC would answer the
        // owner's tools.
        throw new Error("the QA shell does not start the MCP server");
      case "mcp_port_holder":
        return { holder: "none" };
      case "mcp_set_instructions":
      case "mcp_reply":
        return null;
      case "load_refresh_token":
        return this.refreshToken;
      case "store_refresh_token":
        this.refreshToken = typeof a.token === "string" ? a.token : null;
        return null;
      case "clear_refresh_token":
        this.refreshToken = null;
        return null;
      case "check_for_update":
        return null;
      case "jobs_list":
      case "jobs_export_intents":
        return [];
      case "jobs_launch_id":
        return "qa-shell-launch";
      case "jobs_export_protocol":
        return 1;
      case "open_community_link":
      case "open_install_link":
      case "open_desktop_auth":
      case "reveal_mcp_bundle":
        return null;
      case "plugin:app|version":
        return this.appVersion;
      case "plugin:app|name":
        return "artdaddy";
      case "plugin:app|tauri_version":
        return "2.0.0";
    }
    if (/^plugin:(window|webview|deep-link|shell|opener|notification)\|/.test(cmd)) return null;
    this.unknown.add(cmd);
    throw new Error(`QA shell: "${cmd}" is not available`);
  }

  /** Run a shipped sidecar on the shell's files: page paths in its arguments become real ones,
   *  and real paths in what it prints become page paths again. */
  private async runSidecar(a: Args): Promise<unknown> {
    const program = String(a.program ?? "");
    const ext = process.platform === "win32" ? ".exe" : "";
    const bin = path.resolve("src-tauri/binaries", `${program}-${hostTriple()}${ext}`);
    if (!existsSync(bin))
      return {
        code: -1,
        stdout: "",
        stderr: `${program} is not staged in this checkout`,
        progress_sent: 0,
      };
    const realRoot = this.root.replace(/\\/g, "/");
    const toReal = (s: string): string => s.split(VIRTUAL_ROOT).join(realRoot);
    const toPage = (s: string): string => s.replace(/\\/g, "/").split(realRoot).join(VIRTUAL_ROOT);
    const args = (Array.isArray(a.args) ? a.args : []).map((x) => toReal(String(x)));
    const cwd = typeof a.cwd === "string" && a.cwd ? this.real(a.cwd) : undefined;
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, windowsHide: true });
      const runId = String(a.runId ?? "");
      this.runs.set(runId, child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (e) => {
        this.runs.delete(runId);
        resolve({ code: -1, stdout: "", stderr: `spawn failed: ${e.message}`, progress_sent: 0 });
      });
      child.on("close", (code) => {
        this.runs.delete(runId);
        resolve({ code, stdout: toPage(stdout), stderr: toPage(stderr), progress_sent: 0 });
      });
    });
  }
}

/** Errors name the page's path, never the host folder behind it, as the real app would. */
async function readOrExplain(file: string, shown: string): Promise<Buffer> {
  try {
    return await fsp.readFile(file);
  } catch {
    throw new Error(
      `failed to open file at path: ${shown} with error: No such file or directory (os error 2)`,
    );
  }
}

async function readRange(
  file: string,
  shown: string,
  offset: number,
  max: number,
): Promise<Buffer> {
  const handle = await fsp.open(file, "r").catch(() => {
    throw new Error(`${shown}: No such file or directory (os error 2)`);
  });
  try {
    const buf = Buffer.alloc(Math.max(0, max));
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface ShellConfig {
  root: string;
  apiBase: string;
  os: string;
  arch: string;
  appVersion: string;
}

/** The page side. Runs in the page before any of the app's scripts, so it must not use anything
 *  from this module's scope: Playwright sends it as source text. */
function pageShell(cfg: ShellConfig): void {
  const w = window as unknown as Record<string, unknown>;
  try {
    // The app's own runtime server setting (src/api/config.ts): the fake server.
    localStorage.setItem("artdaddy.api_base", cfg.apiBase);
    // A person who once said no to the speech model's download (src/tools/modelDecline.ts): the
    // app does not start fetching 465 MB at launch, which no agent scenario needs.
    localStorage.setItem(
      "artdaddy.speech_model_declined.v1",
      JSON.stringify({ at: Date.now(), version: `artdaddy@${cfg.appVersion}` }),
    );
  } catch {
    /* storage off: the build default stays */
  }
  const callbacks = new Map<number, (data: unknown) => unknown>();
  let nextId = 1;
  const transformCallback = (cb?: (data: unknown) => unknown, once = false): number => {
    const id = nextId++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return cb ? cb(data) : undefined;
    });
    return id;
  };
  const unregisterCallback = (id: number): void => {
    callbacks.delete(id);
  };
  const runCallback = (id: number, data: unknown): void => {
    callbacks.get(id)?.(data);
  };
  const listeners = new Map<string, Set<number>>();
  const emit = (event: string, payload: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])])
      runCallback(handler, { event, id: handler, payload });
  };

  const toB64 = (u8: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64: string): ArrayBuffer => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.buffer;
  };

  const DIRS: Record<number, string> = {
    1: "home/Music",
    2: "cache",
    3: "config",
    4: "data",
    5: "localdata",
    6: "home/Documents",
    7: "downloads",
    8: "home/Pictures",
    9: "home/Public",
    10: "home/Videos",
    11: "resources",
    12: "tmp",
    13: "config/com.artdaddy.app",
    14: "data/com.artdaddy.app",
    15: "localdata/com.artdaddy.app",
    16: "appcache",
    17: "logs",
    18: "home/Desktop",
    19: "bin",
    20: "fonts",
    21: "home",
    22: "runtime",
    23: "templates",
  };
  const normalize = (p: string): string => {
    const abs = p.startsWith("/");
    const out: string[] = [];
    for (const seg of p.replace(/\\/g, "/").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return (abs ? "/" : "") + out.join("/");
  };
  const pathPlugin = (cmd: string, a: Record<string, unknown>): unknown => {
    switch (cmd) {
      case "plugin:path|resolve_directory": {
        const base = `${cfg.root}/${DIRS[Number(a.directory)] ?? "data"}`;
        return a.path ? normalize(`${base}/${String(a.path)}`) : base;
      }
      case "plugin:path|join":
        return normalize((a.paths as string[]).join("/"));
      case "plugin:path|resolve":
        return normalize((a.paths as string[]).join("/"));
      case "plugin:path|normalize":
        return normalize(String(a.path));
      case "plugin:path|dirname":
        return normalize(String(a.path)).replace(/\/[^/]*$/, "") || "/";
      case "plugin:path|basename": {
        const base = normalize(String(a.path)).split("/").pop() ?? "";
        const ext = typeof a.ext === "string" ? a.ext : "";
        return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
      }
      case "plugin:path|extname": {
        const m = /\.([^./]+)$/.exec(String(a.path));
        if (!m) throw new Error("no extension");
        return m[1];
      }
      case "plugin:path|is_absolute":
        return String(a.path).startsWith("/");
    }
    throw new Error(`QA shell: "${cmd}" is not available`);
  };
  const eventPlugin = (cmd: string, a: Record<string, unknown>): unknown => {
    const event = String(a.event);
    if (cmd === "plugin:event|listen") {
      const set = listeners.get(event) ?? new Set<number>();
      set.add(Number(a.handler));
      listeners.set(event, set);
      return Number(a.handler);
    }
    if (cmd === "plugin:event|unlisten") {
      listeners.get(event)?.delete(Number(a.eventId));
      return null;
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      emit(event, a.payload);
      return null;
    }
    return null;
  };

  const call = w.__qaShellCall as (cmd: string, json: string) => Promise<string>;
  const invoke = async (cmd: string, args: unknown = {}, options?: { headers?: unknown }) => {
    if (cmd.startsWith("plugin:event|"))
      return eventPlugin(cmd, (args ?? {}) as Record<string, unknown>);
    if (cmd.startsWith("plugin:path|"))
      return pathPlugin(cmd, (args ?? {}) as Record<string, unknown>);
    let payload: unknown = args;
    if (args instanceof Uint8Array || args instanceof ArrayBuffer || Array.isArray(args)) {
      const u8 =
        args instanceof Uint8Array
          ? args
          : Array.isArray(args)
            ? Uint8Array.from(args as number[])
            : new Uint8Array(args);
      const h = options?.headers;
      const headers =
        h instanceof Headers
          ? Object.fromEntries(h.entries())
          : ((h ?? {}) as Record<string, string>);
      payload = { __raw: toB64(u8), __headers: headers };
    }
    const fn = (w.__qaShellCall as typeof call | undefined) ?? call;
    const out = JSON.parse(await fn(cmd, JSON.stringify(payload ?? null))) as {
      ok: boolean;
      value?: unknown;
      bytes?: string;
      error?: string;
    };
    // A Rust command rejects with its error string, so this does too.
    if (!out.ok) throw out.error;
    return out.bytes !== undefined ? fromB64(out.bytes) : out.value;
  };

  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback,
    runCallback,
    callbacks,
    convertFileSrc: (p: string, protocol = "asset") =>
      `http://${protocol}.localhost/${encodeURIComponent(p)}`,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, id: number) => {
      listeners.get(event)?.delete(id);
      callbacks.delete(id);
    },
  };
  // For a test to raise a native event (a window close, a file drop) the way Rust would.
  w.__qaShell = { emit, os: cfg.os, arch: cfg.arch, appVersion: cfg.appVersion };
}
