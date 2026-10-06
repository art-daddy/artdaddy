// Guards the Tauri boundary from the TS side: the sidecar wiring (which binary,
// which cwd, which resource), cancellation (Stop must actually kill the child),
// the never-throw contract (a spawn failure must surface as a result, not an
// exception the tool layer never catches), live progress that can neither flood
// the page nor hang a run, and `trash_path` — the only recoverable-delete path a
// user has.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Stands in for Tauri's Channel: a test delivers messages by calling `onmessage`. */
class FakeChannel<T> {
  onmessage: (message: T) => void = () => undefined;
}

interface RunArgs {
  runId: string;
  program: string;
  args: string[];
  cwd: string | null;
  progress: boolean;
  onStdout: FakeChannel<string>;
}
interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  progress_sent: number;
}

/** Every `sidecar_run` the runner asked the app for, and the hooks to finish it. */
const runs: {
  args: RunArgs;
  resolve: (o: RunOutput) => void;
  reject: (e: unknown) => void;
}[] = [];
/** When set, a run finishes at once with this; when null, a test finishes it by hand. */
let autoFinish: RunOutput | null = null;
const done = (o: Partial<RunOutput> = {}): RunOutput => ({
  code: 0,
  stdout: "",
  stderr: "",
  progress_sent: 0,
  ...o,
});

const fs = {
  copyFile: vi.fn(async () => undefined),
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => undefined),
  readDir: vi.fn(async () => [
    { name: "a.mp4", isDirectory: false, isFile: true },
    { name: "sub", isDirectory: true, isFile: false },
  ]),
  readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  readTextFile: vi.fn(async () => "hello"),
  remove: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  writeTextFile: vi.fn(async () => undefined),
};
const invoke = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  if (cmd === "sidecar_run")
    return new Promise<RunOutput>((resolve, reject) => {
      runs.push({ args: args as RunArgs, resolve, reject });
      if (autoFinish) resolve(autoFinish);
    });
  if (cmd === "sidecar_kill") return true;
  return undefined;
});
const downloadDir = vi.fn(async () => "/Users/me/Downloads");
const resolveResource = vi.fn(async (p: string) => `/app/${p}`);
const resolveSidecar = vi.fn((program: string) => ({ path: program, sidecar: true }));

vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: () => downloadDir(),
  resolveResource: (p: string) => resolveResource(p),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (c: string, a: unknown) => invoke(c, a),
  Channel: FakeChannel,
}));
// Only `resolveSidecar` is stubbed. BROWSER_BIN keeps its REAL value, because tauri.ts
// builds the binary and resource paths from it — a stand-in here would let those drift
// from what actually ships and no test would notice.
vi.mock("./sidecar", async () => ({
  ...(await vi.importActual<typeof import("./sidecar")>("./sidecar")),
  resolveSidecar: (p: string) => resolveSidecar(p),
}));

const { TauriCommandRunner, TauriFs, makeTauriContext } = await import("./tauri");
const { BROWSER_BIN, packagedSidecarName } = await import("./sidecar");

/** Let the runner's awaits (resource lookups, the invoke) run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const calls = (cmd: string): unknown[] =>
  invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  runs.length = 0;
  autoFinish = done();
  vi.clearAllMocks();
  resolveSidecar.mockImplementation((program: string) => ({
    path: `binaries/${packagedSidecarName(program)}`,
    sidecar: true,
  }));
  vi.unstubAllGlobals();
  resolveResource.mockImplementation(async (p: string) => `/app/${p}`);
});
afterEach(() => {
  vi.useRealTimers();
});

// The whisper cwd is Windows-ONLY, so every case below must say which platform it runs on
// rather than inheriting whatever the DOM shim reports.
const asWindows = () =>
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
const asMac = () =>
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });

describe("TauriCommandRunner — sidecar wiring", () => {
  // The app's own runner (sidecar_run) starts it: the page holds no shell grant, so nothing a
  // process writes reaches the page except through the run's one result and its coalesced
  // progress (2026-10-07: per-chunk events overflowed the page's queue and froze the app).
  it("runs a bundled sidecar by its packaged name, with no live output unless asked", async () => {
    const r = await new TauriCommandRunner().run("ffmpeg", ["-version"]);
    expect(r.code).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toMatchObject({
      program: "artdaddy-ffmpeg",
      args: ["-version"],
      cwd: null,
      progress: false,
    });
    expect(typeof runs[0].args.runId).toBe("string");
  });

  it("refuses a program that is not bundled, without asking the app to start anything", async () => {
    resolveSidecar.mockReturnValueOnce({ path: "/usr/bin/ffmpeg", sidecar: false });
    const r = await new TauriCommandRunner().run("ffmpeg", []);
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(/not a bundled program/);
    expect(runs).toHaveLength(0);
  });

  it("gives every run its own id", async () => {
    const runner = new TauriCommandRunner();
    await Promise.all([runner.run("ffmpeg", []), runner.run("ffprobe", [])]);
    expect(new Set(runs.map((r) => r.args.runId)).size).toBe(2);
  });

  it("runs the browser sidecar through the Node runtime with the bundled script first", async () => {
    await new TauriCommandRunner().run(BROWSER_BIN, ["search", "cats"]);
    expect(resolveResource).toHaveBeenCalledWith(`resources/${BROWSER_BIN}.mjs`);
    expect(runs[0].args).toMatchObject({
      program: BROWSER_BIN,
      args: [`/app/resources/${BROWSER_BIN}.mjs`, "search", "cats"],
    });
  });

  it("runs whisper-cli with the DLL resource dir as cwd (Windows load path)", async () => {
    asWindows();
    await new TauriCommandRunner().run("whisper-cli", ["-m", "model.bin"]);
    expect(resolveResource).toHaveBeenCalledWith("resources/whisper");
    expect(runs[0].args.cwd).toBe("/app/resources/whisper");
    // The args are absolute, so the cwd must NOT be prepended to them.
    expect(runs[0].args.args).toEqual(["-m", "model.bin"]);
  });

  // The mac build is static and ships no resources/whisper. Spawning with a cwd that
  // isn't there fails outright, so transcription would be dead for every mac user
  // while every Windows assertion above still passed.
  it("omits the cwd when the DLL resource dir is absent (static mac build)", async () => {
    asMac();
    fs.exists.mockResolvedValueOnce(false);
    await new TauriCommandRunner().run("whisper-cli", ["-m", "model.bin"]);
    expect(runs[0].args.cwd).toBeNull();
    expect(runs[0].args.program).toBe("artdaddy-whisper-cli");
    expect(runs[0].args.args).toEqual(["-m", "model.bin"]);
  });

  // The shipped mac failure, which every mock above missed: the fs plugin REFUSES the install
  // path (it is outside the scope) exactly as it does on Windows, but here the directory is
  // genuinely not there. Reading that refusal as "keep the cwd" spawned whisper-cli into a
  // non-existent directory, so it died ENOENT and every transcript came back a tool failure.
  it("omits the cwd on mac even when the existence check is REFUSED", async () => {
    asMac();
    fs.exists.mockRejectedValue(new Error("forbidden path: not allowed on the scope"));
    const r = await new TauriCommandRunner().run("whisper-cli", ["-m", "model.bin"]);
    expect(r.code).toBe(0);
    expect(runs[0].args.cwd).toBeNull();
  });

  // A REFUSAL is not an absence. The fs plugin's scope does not cover the install
  // directory, so `exists` throws there — and dropping the cwd on that basis meant
  // whisper-cli started with no way to find ggml.dll. That is not a tool error: the
  // process never starts (0xC0000135) and Windows shows a modal system dialog.
  it("keeps the cwd when the existence check is REFUSED rather than answered", async () => {
    asWindows();
    fs.exists.mockRejectedValueOnce(new Error("forbidden path: not allowed on the scope"));
    const r = await new TauriCommandRunner().run("whisper-cli", []);
    expect(r.code).toBe(0);
    expect(runs[0].args.cwd).toBe("/app/resources/whisper");
  });

  // Windows verbatim paths are rejected as a working directory and match no scope glob.
  it("strips a \\\\?\\ prefix from the resolved DLL dir", async () => {
    asWindows();
    resolveResource.mockResolvedValueOnce("\\\\?\\C:\\Program Files\\ArtDaddy\\resources\\whisper");
    await new TauriCommandRunner().run("whisper-cli", []);
    expect(runs[0].args.cwd).toBe("C:\\Program Files\\ArtDaddy\\resources\\whisper");
  });

  it("passes an explicit cwd through for an ordinary sidecar", async () => {
    await new TauriCommandRunner().run("ffmpeg", [], undefined, "/work");
    expect(runs[0].args.cwd).toBe("/work");
  });

  // The one door every production ffmpeg passes, so the AAC rule lives here and nowhere else.
  // Checked on what reaches the spawn, for a producer that never asked for it.
  it("spawns an AAC encode at 48 kHz, and leaves other commands and programs exactly as given", async () => {
    const aac = ["-i", "/in/talk16k.wav", "-af", "adelay=5000|5000", "-c:a", "aac", "/out/a.m4a"];
    await new TauriCommandRunner().run("ffmpeg", aac);
    const spawned = runs[0].args.args;
    expect(spawned.slice(spawned.indexOf("-ar"), spawned.indexOf("-ar") + 2)).toEqual([
      "-ar",
      "48000",
    ]);
    expect(spawned[spawned.length - 1]).toBe("/out/a.m4a");

    const wav = ["-i", "/in/a.mp4", "-ar", "16000", "-c:a", "pcm_s16le", "/out/a.wav"];
    await new TauriCommandRunner().run("ffmpeg", wav);
    expect(runs[1].args.args).toEqual(wav);

    await new TauriCommandRunner().run("ffprobe", aac);
    expect(runs[2].args.args).toEqual(aac);
  });

  it("hands back exactly what the app collected: the exit code and both streams", async () => {
    autoFinish = done({ code: 3, stdout: "out", stderr: "No such filter" });
    const r = await new TauriCommandRunner().run("ffprobe", []);
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "No such filter" });
  });

  it("treats a null exit code as a failure, not a success", async () => {
    autoFinish = done({ code: null, stderr: "killed" });
    const r = await new TauriCommandRunner().run("ffmpeg", []);
    expect(r.code).toBe(-1);
  });

  it("NEVER throws — a build failure comes back as a structured result", async () => {
    resolveResource.mockRejectedValueOnce(new Error("resource missing"));
    const r = await new TauriCommandRunner().run(BROWSER_BIN, []);
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(new RegExp(`command failed to run \\(${BROWSER_BIN}\\)`));
  });

  it("surfaces the app refusing or failing to start it as a result, not a rejection", async () => {
    autoFinish = null;
    const p = new TauriCommandRunner().run("ffmpeg", []);
    await settle();
    runs[0].reject("'artdaddy-ffmpeg' is not a bundled program");
    const r = await p;
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(/spawn failed: 'artdaddy-ffmpeg' is not a bundled program/);
  });
});

describe("TauriCommandRunner — cancellation", () => {
  it("returns immediately for an ALREADY aborted signal and never starts anything", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    expect(r).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("KILLS that run's process when the signal aborts mid-run (Stop must stop the process)", async () => {
    autoFinish = null;
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await settle();
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(calls("sidecar_kill")).toEqual([{ runId: runs[0].args.runId }]);
  });

  it("settles only once — the run ending after the Stop cannot overwrite the result", async () => {
    autoFinish = null;
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await settle();
    ac.abort();
    runs[0].resolve(done({ code: 0, stdout: "late" }));
    await expect(p).resolves.toMatchObject({ code: -1, stderr: "cancelled" });
  });

  it("does not throw when the kill itself fails; it says so", async () => {
    autoFinish = null;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    invoke.mockImplementationOnce(async () => new Promise(() => undefined)); // the run
    invoke.mockImplementationOnce(async () => {
      throw new Error("taskkill exited with 1");
    });
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await settle();
    ac.abort();
    await expect(p).resolves.toMatchObject({ code: -1, stderr: "cancelled" });
    await settle();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/could not kill ffmpeg/);
    err.mockRestore();
  });

  it("a result that has arrived stands: a Stop while its last progress is on the way is ignored", async () => {
    vi.useFakeTimers();
    autoFinish = null;
    const ac = new AbortController();
    const seen: string[] = [];
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal, undefined, (c) =>
      seen.push(c),
    );
    await settle();
    runs[0].resolve(done({ code: 0, stdout: "a", progress_sent: 1 }));
    await settle();
    ac.abort();
    runs[0].args.onStdout.onmessage("a");
    await expect(p).resolves.toMatchObject({ code: 0, stdout: "a" });
    expect(calls("sidecar_kill")).toEqual([]);
  });
});

describe("TauriCommandRunner — live output", () => {
  it("asks for progress only when someone listens, and hands each message on", async () => {
    autoFinish = null;
    const seen: string[] = [];
    const p = new TauriCommandRunner().run("ffmpeg", [], undefined, undefined, (c) =>
      seen.push(c),
    );
    await settle();
    expect(runs[0].args.progress).toBe(true);
    runs[0].args.onStdout.onmessage("frame=1\n");
    runs[0].args.onStdout.onmessage("frame=2\nprogress=end\n");
    runs[0].resolve(done({ stdout: "frame=1\nframe=2\nprogress=end\n", progress_sent: 2 }));
    await p;
    expect(seen).toEqual(["frame=1\n", "frame=2\nprogress=end\n"]);
  });

  // The result and the progress travel by different routes. A render that resolved before its
  // last progress message landed would let that message move a finished export's bar.
  it("does not resolve until every progress message the run sent has been handed on", async () => {
    autoFinish = null;
    const seen: string[] = [];
    let resolved = false;
    const p = new TauriCommandRunner()
      .run("ffmpeg", [], undefined, undefined, (c) => seen.push(c))
      .then((r) => ((resolved = true), r));
    await settle();
    runs[0].args.onStdout.onmessage("one\n");
    runs[0].resolve(done({ stdout: "one\ntwo\n", progress_sent: 2 }));
    await settle();
    expect(resolved).toBe(false);
    runs[0].args.onStdout.onmessage("two\n");
    await p;
    expect(seen).toEqual(["one\n", "two\n"]);
  });

  // The failure direction: a progress message that never arrives must not hang the tool — the
  // exact symptom this runner replaced.
  it("resolves anyway when a progress message never arrives", async () => {
    vi.useFakeTimers();
    autoFinish = null;
    const p = new TauriCommandRunner().run("ffmpeg", [], undefined, undefined, () => undefined);
    await settle();
    runs[0].resolve(done({ code: 0, stdout: "all of it", progress_sent: 3 }));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ code: 0, stdout: "all of it", stderr: "" });
  });

  it("a progress consumer that throws cannot fail the run", async () => {
    autoFinish = null;
    const p = new TauriCommandRunner().run("ffmpeg", [], undefined, undefined, () => {
      throw new Error("bad consumer");
    });
    await settle();
    runs[0].args.onStdout.onmessage("x");
    runs[0].resolve(done({ code: 0, stdout: "x", progress_sent: 1 }));
    await expect(p).resolves.toMatchObject({ code: 0 });
  });
});

describe("TauriFs", () => {
  it("trash goes through the trash_path IPC command (recoverable delete)", async () => {
    await new TauriFs().trash("C:/projects/p1");
    expect(invoke).toHaveBeenCalledWith("trash_path", { path: "C:/projects/p1" });
  });

  it("trash is NOT a permanent remove — the fs plugin is never called", async () => {
    await new TauriFs().trash("C:/projects/p1");
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it("remove is recursive (a project dir is never empty)", async () => {
    await new TauriFs().remove("/p");
    expect(fs.remove).toHaveBeenCalledWith("/p", { recursive: true });
  });

  it("mkdir is recursive", async () => {
    await new TauriFs().mkdir("/a/b/c");
    expect(fs.mkdir).toHaveBeenCalledWith("/a/b/c", { recursive: true });
  });

  describe("a destination the fs plugin's scope will not reach", () => {
    // Its scope is $DATA/$DOWNLOAD/$HOME. Sidecars ignore it, so ffmpeg renders onto a second
    // drive and the plugin then refuses to rename the result into place: every export off the
    // home volume failed and left its .part file in the user's folder.
    const forbidden = () => {
      throw new Error(
        "forbidden path: D:/out/x.mp4, maybe it is not allowed on the scope for `allow-rename` permission in your capability file",
      );
    };

    it("commits the export through the native command instead of failing", async () => {
      fs.rename.mockImplementationOnce(forbidden);
      await new TauriFs().rename("D:/out/x.part.mp4", "D:/out/x.mp4");
      expect(invoke).toHaveBeenCalledWith("commit_file", {
        from: "D:/out/x.part.mp4",
        to: "D:/out/x.mp4",
      });
    });

    it("cleans up a staging file there too, so a failed export leaves nothing", async () => {
      fs.remove.mockImplementationOnce(forbidden);
      await new TauriFs().remove("D:/out/x.part.mp4");
      expect(invoke).toHaveBeenCalledWith("remove_file", { path: "D:/out/x.part.mp4" });
    });

    it("does NOT reach for the native command on an ordinary failure", async () => {
      // The failure direction: a real ENOENT / permission error must still surface. Falling
      // back on ANY error would turn a genuine problem into a second, more confusing one.
      fs.rename.mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      await expect(new TauriFs().rename("/a", "/b")).rejects.toThrow(/ENOENT/);
      expect(invoke).not.toHaveBeenCalledWith("commit_file", expect.anything());
    });

    it("uses the plugin, not the native command, when the path IS in scope", async () => {
      await new TauriFs().rename("/home/me/a.part.mp4", "/home/me/a.mp4");
      expect(fs.rename).toHaveBeenCalledWith("/home/me/a.part.mp4", "/home/me/a.mp4");
      expect(invoke).not.toHaveBeenCalledWith("commit_file", expect.anything());
    });
  });

  it("readDir narrows plugin entries to the FsLike shape", async () => {
    await expect(new TauriFs().readDir("/p")).resolves.toEqual([
      { name: "a.mp4", isDirectory: false },
      { name: "sub", isDirectory: true },
    ]);
  });

  it("delegates the remaining fs verbs to the plugin", async () => {
    const t = new TauriFs();
    await expect(t.exists("/p")).resolves.toBe(true);
    await expect(t.readTextFile("/p")).resolves.toBe("hello");
    await expect(t.readBytes("/p")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await t.writeTextFile("/p", "x");
    await t.writeBytes("/p", new Uint8Array([9]));
    await t.copyFile("/a", "/b");
    await t.rename("/a", "/b");
    await expect(t.downloadDir()).resolves.toBe("/Users/me/Downloads");
    expect(fs.writeTextFile).toHaveBeenCalledWith("/p", "x");
    expect(fs.copyFile).toHaveBeenCalledWith("/a", "/b");
    expect(fs.rename).toHaveBeenCalledWith("/a", "/b");
  });
});

describe("makeTauriContext", () => {
  it("binds a store rooted at the project dir and a real command runner", async () => {
    const ctx = makeTauriContext("C:/projects/p1");
    expect(ctx.runner).toBeInstanceOf(TauriCommandRunner);
    // The store must be backed by the Tauri fs plugin, not a memory shim.
    await ctx.store.readText("C:/projects/p1/internals/timeline.json");
    expect(fs.readTextFile).toHaveBeenCalledWith("C:/projects/p1/internals/timeline.json");
  });

  it("roots artifacts inside the project dir it was given", () => {
    const ctx = makeTauriContext("C:/projects/p1");
    expect(ctx.store.artifactPath("gemini/x.jpg")).toContain("C:/projects/p1");
  });
});
