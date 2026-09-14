// Tauri-only bindings: run binaries via the shell plugin, touch files via the fs
// plugin. Imported only from the tool host's default context factory (which runs
// solely inside the Tauri webview), so the browser bundle/tests never load the
// Tauri plugins.
import { Command, type Child } from "@tauri-apps/plugin-shell";
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
import { invoke } from "@tauri-apps/api/core";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { decodeCommandOutput as decode } from "./decode";
import { BROWSER_BIN, resolveSidecar } from "./sidecar";
import { type DirEntry, type FsLike, ProjectStoreAccess } from "./store";

export class TauriCommandRunner implements CommandRunner {
  async run(
    program: string,
    args: string[],
    signal?: AbortSignal,
    cwd?: string,
    onStdout?: (chunk: string) => void,
  ): Promise<CommandResult> {
    // Capture stdout/stderr as RAW BYTES and decode leniently (see decode.ts).
    // The default string encoding does a STRICT utf-8 decode that THROWS on the
    // first non-utf-8 byte — which yt-dlp/ffprobe/ffmpeg readily emit on Windows
    // (e.g. a cp1252 smart-quote in a "Sign in to confirm you're not a bot"
    // error). That masked real errors as an opaque "invalid utf-8 sequence".
    if (signal?.aborted) return { code: -1, stdout: "", stderr: "cancelled" };
    try {
      const cmd = await this.build(program, args, cwd);
      // execute() buffers, so it can never report progress — spawn whenever the caller wants
      // either cancellation or live output.
      if (!signal && !onStdout) {
        const out = await cmd.execute();
        return { code: out.code ?? -1, stdout: decode(out.stdout), stderr: decode(out.stderr) };
      }
      return await runCancellable(cmd, signal, program, onStdout);
    } catch (e) {
      // Never throw: surface a spawn failure as a structured result so the tool
      // returns a readable error instead of rejecting with a raw exception.
      return { code: -1, stdout: "", stderr: `command failed to run (${program}): ${String(e)}` };
    }
  }

  // The browser sidecar is a Node-sidecar: the bundled Node runtime runs the bundled
  // Playwright script (shipped as a resource). The others are direct sidecars.
  private async build(program: string, args: string[], cwd?: string): Promise<Command<Uint8Array>> {
    if (program === BROWSER_BIN) {
      const script = await resolveResource(`resources/${BROWSER_BIN}.mjs`);
      return Command.sidecar(`binaries/${BROWSER_BIN}`, [script, ...args], { encoding: "raw" });
    }
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
      const opts =
        dllDir && (await dllDirUsable(dllDir))
          ? { encoding: "raw" as const, cwd: dllDir }
          : { encoding: "raw" as const };
      return Command.sidecar("binaries/whisper-cli", args, opts);
    }
    const r = resolveSidecar(program);
    const opts = cwd ? { encoding: "raw" as const, cwd } : { encoding: "raw" as const };
    return r.sidecar ? Command.sidecar(r.path, args, opts) : Command.create(r.path, args, opts);
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

/** Terminate a sidecar and everything it spawned. A failure here is NEVER silent:
 *  it means the process keeps running (burning CPU, still writing its output)
 *  while the UI reports the turn cancelled. */
async function killTree(pid: number | undefined, program: string): Promise<void> {
  if (pid === undefined) return;
  try {
    await invoke("kill_process_tree", { pid });
  } catch (e) {
    console.error(`[shell] could not kill ${program} (pid ${pid}) on Stop — it keeps running:`, e);
  }
}

/** Spawn a command and resolve on close, KILLING the child if `signal` aborts
 *  (Stop). Accumulates raw stdout/stderr bytes and decodes them like execute(), and hands each
 *  stdout chunk to `onStdout` as it lands so a long job can report progress. */
async function runCancellable(
  cmd: Command<Uint8Array>,
  signal: AbortSignal | undefined,
  program: string,
  onStdout?: (chunk: string) => void,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const out: number[] = [];
    const err: number[] = [];
    let child: Child | null = null;
    let settled = false;
    const push = (buf: number[], chunk: unknown): void => {
      if (chunk instanceof Uint8Array) for (let i = 0; i < chunk.length; i += 1) buf.push(chunk[i]);
      else if (Array.isArray(chunk)) for (const b of chunk) buf.push(Number(b));
      else if (typeof chunk === "string") {
        const e = new TextEncoder().encode(chunk);
        for (let i = 0; i < e.length; i += 1) buf.push(e[i]);
      }
    };
    const finish = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = (): void => {
      // Kill the whole TREE, not just the direct child: yt-dlp re-execs itself and
      // that worker spawns ffmpeg, so signalling the child alone leaves the job
      // running and it finishes the download the user just cancelled. Tree first,
      // while the parent still exists to enumerate descendants from.
      void killTree(child?.pid, program);
      // Plugin-side bookkeeping; the tree kill above is the authoritative one and
      // reports its own failure, so a "process already gone" here is expected.
      void child?.kill().catch(() => undefined);
      finish({ code: -1, stdout: decode(out), stderr: "cancelled" });
    };
    cmd.stdout.on("data", (c) => {
      push(out, c);
      if (!onStdout) return;
      // Decode only the new bytes: re-decoding the whole buffer every chunk is quadratic over a
      // render that emits thousands of progress blocks.
      try {
        onStdout(decode(c as Uint8Array));
      } catch {
        /* a progress consumer must never be able to fail the render */
      }
    });
    cmd.stderr.on("data", (c) => push(err, c));
    cmd.on("close", (d: { code: number | null }) =>
      finish({ code: d?.code ?? -1, stdout: decode(out), stderr: decode(err) }),
    );
    cmd.on("error", (e) =>
      finish({ code: -1, stdout: decode(out), stderr: `command error: ${String(e)}` }),
    );
    cmd
      .spawn()
      .then((c) => {
        child = c;
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      })
      .catch((e) => finish({ code: -1, stdout: "", stderr: `spawn failed: ${String(e)}` }));
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
  async stat(path: string): Promise<{ isDirectory: boolean; size: number }> {
    const s = await fsStat(path);
    return { isDirectory: !!s.isDirectory, size: Number(s.size) || 0 };
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
    const p = await invoke<{ id12: string; size: number; head: number[] }>("probe_media_file", {
      path,
      headBytes,
      onProgress,
    });
    return { id12: p.id12, size: p.size, head: new Uint8Array(p.head) };
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
}

export function makeTauriContext(projectDir: string): ClientToolContext {
  return {
    store: new ProjectStoreAccess(projectDir, new TauriFs()),
    runner: new TauriCommandRunner(),
  };
}
