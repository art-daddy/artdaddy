// Tauri-only bindings: run binaries through the app's sidecar runner, touch files via the fs
// plugin. Imported only from the tool host's default context factory (which runs
// solely inside the Tauri webview), so the browser bundle/tests never load the
// Tauri plugins.
import {
  copyFile,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat as fsStat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { downloadDir, resolveResource } from "@tauri-apps/api/path";
import { Channel, invoke } from "@tauri-apps/api/core";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { ffmpegPolicy } from "./ffmpegPolicy";
import { BROWSER_BIN, packagedSidecarName, resolveSidecar } from "./sidecar";
import { type DirEntry, type FsLike, ProjectStoreAccess } from "./store";

/** A run as the app's runner (`sidecar_run`, src-tauri/src/sidecar_run.rs) takes it. */
interface SidecarSpec {
  /** The packaged sidecar name, e.g. "artdaddy-ffmpeg". */
  program: string;
  args: string[];
  cwd: string | null;
}

/** What `sidecar_run` hands back when the process ends. */
interface SidecarOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Progress messages it sent; the run resolves once all of them have been handed on. */
  progress_sent: number;
}

/** After a run's result arrives, how long to wait for progress messages still on their way.
 *  They normally land within milliseconds; this only bounds a message that was lost. */
const PROGRESS_GRACE_MS = 1000;

let runSeq = 0;
const runPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** Unique per app process: ids from a page that reloaded must not collide with the old page's. */
function newRunId(): string {
  runSeq += 1;
  return `${runPrefix}-${runSeq}`;
}

export class TauriCommandRunner implements CommandRunner {
  async run(
    program: string,
    args: string[],
    signal?: AbortSignal,
    cwd?: string,
    onStdout?: (chunk: string) => void,
  ): Promise<CommandResult> {
    if (signal?.aborted) return { code: -1, stdout: "", stderr: "cancelled" };
    try {
      // Every production ffmpeg passes here, so the app's ffmpeg rules are applied here and
      // nowhere else (ffmpegPolicy.ts: AAC is always encoded at 48 kHz).
      const spec = await this.build(program, ffmpegPolicy(program, args), cwd);
      return await runInApp(spec, program, signal, onStdout);
    } catch (e) {
      // Never throw: surface a spawn failure as a structured result so the tool
      // returns a readable error instead of rejecting with a raw exception.
      return { code: -1, stdout: "", stderr: `command failed to run (${program}): ${String(e)}` };
    }
  }

  // The browser sidecar is a Node-sidecar: the bundled Node runtime runs the bundled
  // Playwright script (shipped as a resource). The others are direct sidecars.
  private async build(program: string, args: string[], cwd?: string): Promise<SidecarSpec> {
    if (program === BROWSER_BIN) {
      const script = await resolveResource(`resources/${BROWSER_BIN}.mjs`);
      return { program: BROWSER_BIN, args: [script, ...args], cwd: null };
    }
    if (!resolveSidecar(program).sidecar) throw new Error(`'${program}' is not a bundled program`);
    const name = packagedSidecarName(program);
    if (program === "whisper-cli") {
      // The Windows whisper.cpp sidecar is a DYNAMIC build: it needs its runtime
      // DLLs (ggml*.dll, whisper.dll) at load time. They ship as a bundled
      // resource (resources/whisper); run whisper-cli WITH THAT DIR AS ITS cwd so
      // Windows' DLL search resolves them. The model / wav / -of args are all
      // absolute, so the cwd doesn't affect whisper's file I/O.
      //
      // Getting this wrong does not surface as a tool error: the process never
      // starts (STATUS_DLL_NOT_FOUND, 0xC0000135) and Windows shows a modal
      // "ggml.dll was not found" dialog instead.
      const dllDir = isWindows()
        ? stripVerbatim(await resolveResource("resources/whisper").catch(() => ""))
        : "";
      return { program: name, args, cwd: dllDir && (await dllDirUsable(dllDir)) ? dllDir : null };
    }
    return { program: name, args, cwd: cwd ?? null };
  }
}

/** Windows verbatim paths (`\\?\C:\…`) are rejected as a working directory, and the fs
 *  plugin's scope globs never match them either. */
function stripVerbatim(p: string): string {
  return p.startsWith("\\\\?\\") ? p.slice(4) : p;
}

/** Did the fs plugin refuse this path for being outside its scope, rather than fail on the
 *  file itself? Only that case may fall back to a native command — a real ENOENT or a
 *  permission error must still surface. */
function isForbiddenPath(e: unknown): boolean {
  return /forbidden path/i.test(e instanceof Error ? e.message : String(e));
}

/** Only the Windows build ships (and needs) the whisper DLL resource dir. `dllDirUsable` cannot
 *  tell mac's MISSING dir apart from Windows' out-of-scope refusal — `exists` throws for both — so
 *  the platform, not the probe, decides whether a cwd is wanted at all. Without this gate mac got
 *  a cwd that does not exist and whisper-cli never spawned (ENOENT), killing all transcription. */
function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/** Can we hand this to whisper-cli as its cwd?
 *
 *  Spawning with a cwd that does not exist fails outright — so a definite "no" must still mean
 *  no cwd. But `exists` THROWING is not a "no": the fs plugin refuses paths outside its scope,
 *  and the install directory is not in it. Treating that refusal as absence is what dropped the
 *  cwd and left whisper-cli unable to load ggml.dll, with no error the app could report. */
async function dllDirUsable(dir: string): Promise<boolean> {
  try {
    return await exists(dir);
  } catch {
    return true;
  }
}

/** Run `spec` in the app and resolve with what it wrote, KILLING it if `signal` aborts (Stop).
 *
 *  The process's output stays in the app until it ends and comes back as this run's one
 *  result. With `onStdout`, stdout also arrives as it is written, coalesced by the app to a few
 *  messages a second however fast the process writes: the plugin's per-chunk events overflowed
 *  the page thread's queue, which lost runs' exits and froze the app's IPC (2026-10-07). */
function runInApp(
  spec: SidecarSpec,
  program: string,
  signal: AbortSignal | undefined,
  onStdout?: (chunk: string) => void,
): Promise<CommandResult> {
  const runId = newRunId();
  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let received = 0;
    let arrived: { sent: number; result: CommandResult } | null = null;
    const finish = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = (): void => {
      // The app kills the whole TREE, not just the direct child: yt-dlp re-execs itself and
      // that worker spawns ffmpeg, so signalling the child alone would leave the job running.
      // A run that has not started yet is marked so it never does.
      invoke("sidecar_kill", { runId }).catch((e: unknown) => {
        console.error(`[shell] could not kill ${program} on Stop — it keeps running:`, e);
      });
      finish({ code: -1, stdout: "", stderr: "cancelled" });
    };
    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      received += 1;
      if (onStdout && !settled) {
        try {
          onStdout(chunk);
        } catch {
          /* a progress consumer must never be able to fail the run */
        }
      }
      if (arrived && received >= arrived.sent) finish(arrived.result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    invoke<SidecarOutput>("sidecar_run", {
      runId,
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      progress: onStdout !== undefined,
      onStdout: channel,
    })
      .then((o) => {
        // The process has ended: from here a Stop has nothing left to stop.
        signal?.removeEventListener("abort", onAbort);
        const result = { code: o.code ?? -1, stdout: o.stdout, stderr: o.stderr };
        if (received >= o.progress_sent) return finish(result);
        // Progress travels apart from the result; hand on the rest before resolving, so a
        // late message cannot move a finished job's bar. A lost one must not hang the run.
        arrived = { sent: o.progress_sent, result };
        setTimeout(() => finish(result), PROGRESS_GRACE_MS);
      })
      .catch((e: unknown) =>
        finish({ code: -1, stdout: "", stderr: `spawn failed: ${String(e)}` }),
      );
  });
}

export class TauriFs implements FsLike {
  exists(path: string): Promise<boolean> {
    return exists(path);
  }
  readTextFile(path: string): Promise<string> {
    return readTextFile(path);
  }
  writeTextFile(path: string, contents: string): Promise<void> {
    return writeTextFile(path, contents);
  }
  readBytes(path: string): Promise<Uint8Array> {
    return readFile(path);
  }
  async stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const s = await fsStat(path);
    const written = s.mtime ? new Date(s.mtime).getTime() : NaN;
    return {
      isDirectory: !!s.isDirectory,
      size: Number(s.size) || 0,
      ...(Number.isFinite(written) ? { mtimeMs: written } : {}),
    };
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }
  async appendBytes(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data, { append: true });
  }
  async probeMedia(path: string, headBytes: number) {
    // Byte progress goes straight to the import-jobs store, keyed by the path the caller
    // already registered. A Channel (not a global event) so concurrent probes can't be
    // confused for one another, and the store ignores paths nobody is watching.
    const { Channel } = await import("@tauri-apps/api/core");
    const { useImportJobs } = await import("../store/importJobs");
    const onProgress = new Channel<{ read: number; total: number }>();
    onProgress.onmessage = (m) => useImportJobs.getState().progress(path, m.read, m.total);
    const p = await invoke<{ id12: string; sha256: string; size: number; head: number[] }>(
      "probe_media_file",
      {
        path,
        headBytes,
        onProgress,
      },
    );
    return { id12: p.id12, sha256: p.sha256, size: p.size, head: new Uint8Array(p.head) };
  }
  async readHead(path: string, maxBytes: number): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>("read_file_head", { path, maxBytes }));
  }
  async readRange(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>("read_file_range", { path, offset, maxBytes }));
  }
  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await readDir(path);
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
  }
  async remove(path: string): Promise<void> {
    try {
      await remove(path, { recursive: true });
    } catch (e) {
      // Outside the plugin's scope (an export destination on another drive) it refuses rather
      // than failing to find the file. Falling back keeps a failed export from leaving its
      // staging file in the user's folder.
      if (!isForbiddenPath(e)) throw e;
      await invoke("remove_file", { path });
    }
  }
  async trash(path: string): Promise<void> {
    // Native command (lib.rs) -> the cross-platform `trash` crate -> OS Recycle Bin / Trash.
    await invoke("trash_path", { path });
  }
  async copyFile(src: string, dst: string): Promise<void> {
    await copyFile(src, dst);
  }
  async rename(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (e) {
      // Same scope wall, and this is the one that matters: it is the COMMIT of an export.
      if (!isForbiddenPath(e)) throw e;
      await invoke("commit_file", { from, to });
    }
  }
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  downloadDir(): Promise<string> {
    return downloadDir();
  }
  async cacheDir(): Promise<string> {
    const { appCacheRoot } = await import("./dataRoot");
    return appCacheRoot();
  }
  async workDir(): Promise<string> {
    const { appWorkRoot } = await import("./dataRoot");
    return appWorkRoot();
  }
}

export function makeTauriContext(projectDir: string): ClientToolContext {
  return {
    store: new ProjectStoreAccess(projectDir, new TauriFs()),
    runner: new TauriCommandRunner(),
  };
}
