// Guards the Tauri boundary from the TS side: the sidecar wiring (which binary,
// which cwd, which resource), cancellation (Stop must actually kill the child),
// the never-throw contract (a spawn failure must surface as a result, not an
// exception the tool layer never catches), and `trash_path` — the one custom IPC
// command, and the only recoverable-delete path a user has.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (data: unknown) => void;

class FakeCommand {
  static made: { kind: "sidecar" | "create"; program: string; args: string[]; opts: unknown }[] =
    [];
  static nextExecute: { code: number | null; stdout: number[]; stderr: number[] } | null = null;
  static spawnRejects = false;
  static lastInstance: FakeCommand | null = null;

  handlers = new Map<string, Handler[]>();
  stdout = { on: (e: string, h: Handler) => this.bind(`stdout:${e}`, h) };
  stderr = { on: (e: string, h: Handler) => this.bind(`stderr:${e}`, h) };
  killed = false;

  private bind(key: string, h: Handler) {
    const list = this.handlers.get(key) ?? [];
    list.push(h);
    this.handlers.set(key, list);
  }
  on(event: string, h: Handler) {
    this.bind(event, h);
  }
  emit(key: string, data: unknown) {
    for (const h of this.handlers.get(key) ?? []) h(data);
  }
  execute() {
    const r = FakeCommand.nextExecute ?? { code: 0, stdout: [], stderr: [] };
    return Promise.resolve({
      code: r.code,
      stdout: new Uint8Array(r.stdout),
      stderr: new Uint8Array(r.stderr),
    });
  }
  spawn() {
    FakeCommand.lastInstance = this;
    if (FakeCommand.spawnRejects) return Promise.reject(new Error("no such binary"));
    return Promise.resolve({
      kill: () => {
        this.killed = true;
        return Promise.resolve();
      },
    });
  }
  static sidecar(program: string, args: string[], opts: unknown) {
    const c = new FakeCommand();
    FakeCommand.made.push({ kind: "sidecar", program, args, opts });
    FakeCommand.lastInstance = c;
    return c;
  }
  static create(program: string, args: string[], opts: unknown) {
    const c = new FakeCommand();
    FakeCommand.made.push({ kind: "create", program, args, opts });
    FakeCommand.lastInstance = c;
    return c;
  }
}

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
const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined);
const downloadDir = vi.fn(async () => "/Users/me/Downloads");
const resolveResource = vi.fn(async (p: string) => `/app/${p}`);
const resolveSidecar = vi.fn((program: string) => ({ path: `binaries/${program}`, sidecar: true }));

vi.mock("@tauri-apps/plugin-shell", () => ({ Command: FakeCommand }));
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: () => downloadDir(),
  resolveResource: (p: string) => resolveResource(p),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invoke(c, a) }));
// Only `resolveSidecar` is stubbed. BROWSER_BIN keeps its REAL value, because tauri.ts
// builds the binary and resource paths from it — a stand-in here would let those drift
// from what actually ships and no test would notice.
vi.mock("./sidecar", async () => ({
  ...(await vi.importActual<typeof import("./sidecar")>("./sidecar")),
  resolveSidecar: (p: string) => resolveSidecar(p),
}));

const { TauriCommandRunner, TauriFs, makeTauriContext } = await import("./tauri");
const { BROWSER_BIN } = await import("./sidecar");

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

beforeEach(() => {
  FakeCommand.made = [];
  FakeCommand.nextExecute = null;
  FakeCommand.spawnRejects = false;
  FakeCommand.lastInstance = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resolveResource.mockImplementation(async (p: string) => `/app/${p}`);
  resolveSidecar.mockImplementation((program: string) => ({
    path: `binaries/${program}`,
    sidecar: true,
  }));
});

// The whisper cwd is Windows-ONLY, so every case below must say which platform it runs on
// rather than inheriting whatever the DOM shim reports.
const asWindows = () =>
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
const asMac = () =>
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });

describe("TauriCommandRunner — sidecar wiring", () => {
  it("runs a plain sidecar with raw encoding", async () => {
    const r = await new TauriCommandRunner().run("ffmpeg", ["-version"]);
    expect(r.code).toBe(0);
    expect(FakeCommand.made[0]).toMatchObject({ kind: "sidecar", program: "binaries/ffmpeg" });
    // Raw bytes, not strings: a strict utf-8 decode THROWS on cp1252 output.
    expect(FakeCommand.made[0].opts).toMatchObject({ encoding: "raw" });
  });

  it("uses Command.create (not sidecar) when the binary is not bundled", async () => {
    resolveSidecar.mockReturnValueOnce({ path: "/usr/bin/ffmpeg", sidecar: false });
    await new TauriCommandRunner().run("ffmpeg", []);
    expect(FakeCommand.made[0]).toMatchObject({ kind: "create", program: "/usr/bin/ffmpeg" });
  });

  it("runs the browser sidecar through the Node runtime with the bundled script first", async () => {
    await new TauriCommandRunner().run(BROWSER_BIN, ["search", "cats"]);
    expect(resolveResource).toHaveBeenCalledWith(`resources/${BROWSER_BIN}.mjs`);
    expect(FakeCommand.made[0]).toMatchObject({
      program: `binaries/${BROWSER_BIN}`,
      args: [`/app/resources/${BROWSER_BIN}.mjs`, "search", "cats"],
    });
  });

  it("runs whisper-cli with the DLL resource dir as cwd (Windows load path)", async () => {
    asWindows();
    await new TauriCommandRunner().run("whisper-cli", ["-m", "model.bin"]);
    expect(resolveResource).toHaveBeenCalledWith("resources/whisper");
    expect(FakeCommand.made[0].opts).toMatchObject({ cwd: "/app/resources/whisper" });
    // The args are absolute, so the cwd must NOT be prepended to them.
    expect(FakeCommand.made[0].args).toEqual(["-m", "model.bin"]);
  });

  // The mac build is static and ships no resources/whisper. Spawning with a cwd that
  // isn't there fails outright, so transcription would be dead for every mac user
  // while every Windows assertion above still passed.
  it("omits the cwd when the DLL resource dir is absent (static mac build)", async () => {
    asMac();
    fs.exists.mockResolvedValueOnce(false);
    await new TauriCommandRunner().run("whisper-cli", ["-m", "model.bin"]);
    expect(FakeCommand.made[0].opts).not.toHaveProperty("cwd");
    expect(FakeCommand.made[0]).toMatchObject({ program: "binaries/whisper-cli" });
    expect(FakeCommand.made[0].args).toEqual(["-m", "model.bin"]);
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
    expect(FakeCommand.made[0].opts).not.toHaveProperty("cwd");
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
    expect(FakeCommand.made[0].opts).toMatchObject({ cwd: "/app/resources/whisper" });
  });

  // Windows verbatim paths are rejected as a working directory and match no scope glob.
  it("strips a \\\\?\\ prefix from the resolved DLL dir", async () => {
    asWindows();
    resolveResource.mockResolvedValueOnce("\\\\?\\C:\\Program Files\\ArtDaddy\\resources\\whisper");
    await new TauriCommandRunner().run("whisper-cli", []);
    expect(FakeCommand.made[0].opts).toMatchObject({
      cwd: "C:\\Program Files\\ArtDaddy\\resources\\whisper",
    });
  });

  it("passes an explicit cwd through for an ordinary sidecar", async () => {
    await new TauriCommandRunner().run("ffmpeg", [], undefined, "/work");
    expect(FakeCommand.made[0].opts).toMatchObject({ cwd: "/work" });
  });

  it("decodes non-utf8 output leniently instead of throwing", async () => {
    FakeCommand.nextExecute = { code: 0, stdout: [0xff, 0xfe, ...utf8("ok")], stderr: [] };
    const r = await new TauriCommandRunner().run("ffprobe", []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it("NEVER throws — a build failure comes back as a structured result", async () => {
    resolveResource.mockRejectedValueOnce(new Error("resource missing"));
    const r = await new TauriCommandRunner().run(BROWSER_BIN, []);
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(new RegExp(`command failed to run \\(${BROWSER_BIN}\\)`));
  });
});

describe("TauriCommandRunner — cancellation", () => {
  it("returns immediately for an ALREADY aborted signal and never spawns", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    expect(r).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(FakeCommand.made).toHaveLength(0);
  });

  it("resolves with the child's exit code and decoded streams on a normal close", async () => {
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    const c = FakeCommand.lastInstance!;
    c.emit("stdout:data", new Uint8Array(utf8("out")));
    c.emit("stderr:data", new Uint8Array(utf8("err")));
    c.emit("close", { code: 3 });
    await expect(p).resolves.toMatchObject({ code: 3, stdout: "out", stderr: "err" });
  });

  it("KILLS the child when the signal aborts mid-run (Stop must stop the process)", async () => {
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    const c = FakeCommand.lastInstance!;
    ac.abort();
    const r = await p;
    expect(c.killed).toBe(true);
    expect(r).toMatchObject({ code: -1, stderr: "cancelled" });
  });

  it("settles only once — a close after an abort cannot overwrite the result", async () => {
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    const c = FakeCommand.lastInstance!;
    ac.abort();
    c.emit("close", { code: 0 });
    await expect(p).resolves.toMatchObject({ code: -1, stderr: "cancelled" });
  });

  it("surfaces a spawn rejection as a result rather than an unhandled rejection", async () => {
    FakeCommand.spawnRejects = true;
    const ac = new AbortController();
    const r = await new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    expect(r).toMatchObject({ code: -1 });
    expect(r.stderr).toMatch(/spawn failed/);
  });

  it("reports a stream error as a result", async () => {
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    FakeCommand.lastInstance!.emit("error", new Error("pipe broke"));
    await expect(p).resolves.toMatchObject({ code: -1 });
  });

  it("treats a null exit code as a failure, not a success", async () => {
    const ac = new AbortController();
    const p = new TauriCommandRunner().run("ffmpeg", [], ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    FakeCommand.lastInstance!.emit("close", { code: null });
    await expect(p).resolves.toMatchObject({ code: -1 });
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
