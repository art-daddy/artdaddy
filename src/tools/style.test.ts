import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { shortHash } from "./media";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { registerStyleTools } from "./style";

// extract_style leans on exactly ONE hosted call — the whole-video style pass via
// the /ai/style_analyze proxy — plus local ffprobe/ffmpeg/yt-dlp driven through the
// injected CommandRunner. Mock the proxy + toB64 so no network runs and the encoded
// bytes never have to be real. Everything else (store, media hashing, styleSchema
// parsing, versioning) runs for real against a MockFs.
vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  toB64: () => "b64data",
}));

import { callAiProxy } from "../api/ai";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  set(p: string, c: string): void {
    this.files.set(joinPath(p), c);
  }
  putBytes(p: string, b: Uint8Array): void {
    this.bytes.set(joinPath(p), b);
  }
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const n = joinPath(p);
    const b = this.bytes.get(n);
    if (b !== undefined) return b;
    const t = this.files.get(n);
    if (t !== undefined) return new TextEncoder().encode(t);
    throw new Error("ENOENT");
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
const STYLES = joinPath(DIR, "internals/styles");
// The absolute path `media_a` resolves to (project-relative library/a.mp4).
const LOCAL = joinPath(DIR, "library/a.mp4");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A minimal ffprobe payload reporting the given duration (seconds).
const probeJson = (duration: number): string =>
  JSON.stringify({
    format: { format_name: "mov,mp4", duration: String(duration), size: "1000" },
    streams: [
      {
        codec_type: "video",
        width: 640,
        height: 360,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
      },
    ],
  });

interface RunnerOpts {
  duration?: number;
  ffprobeThrows?: boolean;
  ffprobeNoDuration?: boolean;
  ffmpegCode?: number;
  ffmpegBytes?: Uint8Array;
  ytdlpCode?: number;
  ytdlpWrites?: boolean;
}

function mockRunner(impl: (program: string, args: string[]) => CommandResult): CommandRunner {
  return { run: vi.fn(async (program: string, args: string[]) => impl(program, args)) };
}

// Fakes ffprobe (duration), ffmpeg (writes the encoded output so the encode
// "succeeds") and yt-dlp (writes the download) unless the opts say otherwise.
function makeRunner(fs: MockFs, opts: RunnerOpts = {}): CommandRunner {
  return mockRunner((program, args) => {
    if (program === "ffprobe") {
      if (opts.ffprobeThrows) throw new Error("ffprobe crashed");
      if (opts.ffprobeNoDuration) {
        return {
          code: 0,
          stdout: JSON.stringify({ format: { format_name: "mp4" }, streams: [] }),
          stderr: "",
        };
      }
      return { code: 0, stdout: probeJson(opts.duration ?? 10), stderr: "" };
    }
    if (program === "ffmpeg") {
      const code = opts.ffmpegCode ?? 0;
      if (code === 0)
        fs.putBytes(args[args.length - 1], opts.ffmpegBytes ?? new Uint8Array([1, 2, 3]));
      return { code, stdout: "", stderr: code === 0 ? "" : "ffmpeg boom" };
    }
    if (program === "yt-dlp") {
      const code = opts.ytdlpCode ?? 0;
      if (code === 0 && (opts.ytdlpWrites ?? true))
        fs.putBytes(args[args.length - 2], new Uint8Array([9, 9]));
      return { code, stdout: "", stderr: code === 0 ? "" : "yt-dlp boom" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

// A project that already holds a resolvable library clip (`media_a`).
function resolvableFs(): MockFs {
  const fs = new MockFs();
  fs.set(
    joinPath(DIR, "internals/library.json"),
    JSON.stringify({ clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }] }),
  );
  fs.touch(LOCAL);
  return fs;
}

async function runTool(args: Record<string, unknown>, ctx: ClientToolContext | null): Promise<Any> {
  const reg = new ClientToolRegistry();
  registerStyleTools(reg, () => ctx);
  return (await reg.run("extract_style", args)) as Any;
}

const proxy = vi.mocked(callAiProxy);
// Resolve the proxy with a raw result payload (the `{result}` envelope wrapper).
function proxyResult(result: Record<string, unknown>): void {
  proxy.mockResolvedValue({ result } as Any);
}
// The (name, body) of the most recent proxy call.
function lastProxyCall(): { name: string; body: Any } {
  const c = proxy.mock.calls[proxy.mock.calls.length - 1];
  return { name: c[0] as string, body: c[1] as Any };
}
// Did the injected runner ever shell out to `program`?
function ran(runner: CommandRunner, program: string): boolean {
  return (runner.run as Any).mock.calls.some((c: Any[]) => c[0] === program);
}

// A generated style doc with every REQUIRED dimension (+ one optional) present.
const FULL_MD = [
  "# Kinetic Clean",
  "",
  "## Identity",
  "Fast, clean, energetic.",
  "",
  "## Pacing",
  "Cut on the beat.",
  "",
  "## Density",
  "One idea per shot.",
  "",
  "## Composition",
  "Centered framing.",
  "",
  "## Captions",
  "Bold sans, bottom third.",
  "",
  "## Sourcing",
  "Stock b-roll.",
  "",
  "## Color Grade",
  "Cool, high contrast.",
].join("\n");

// A doc missing four required dimensions (only identity + pacing).
const PARTIAL_MD = ["# X", "", "## Identity", "id", "", "## Pacing", "pace"].join("\n");

beforeEach(() => {
  proxy.mockReset();
  proxyResult({ ok: true, body: FULL_MD, input_tokens: 10, output_tokens: 20 });
});

describe("registerStyleTools", () => {
  it("registers exactly the extract_style tool", () => {
    const reg = new ClientToolRegistry();
    registerStyleTools(reg, () => null);
    expect(reg.names()).toEqual(["extract_style"]);
  });
});

describe("extract_style · validation", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool({ references: ["media_a"], style_name: "kinetic" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects an empty or non-array reference list", async () => {
    const ctx = ctxWith(makeRunner(new MockFs()));
    expect(String((await runTool({ references: [], style_name: "kinetic" }, ctx)).error)).toContain(
      "no references provided",
    );
    // A non-array `references` is coerced to an empty list.
    expect(
      String((await runTool({ references: "media_a", style_name: "kinetic" }, ctx)).error),
    ).toContain("no references provided");
  });

  it("rejects more than five references", async () => {
    const r = await runTool(
      { references: ["a", "b", "c", "d", "e", "f"], style_name: "kinetic" },
      ctxWith(makeRunner(new MockFs())),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("too many references (6); max 5");
  });

  it("rejects a style_name that is empty or not slug-safe", async () => {
    const ctx = ctxWith(makeRunner(new MockFs()));
    expect(
      String((await runTool({ references: ["media_a"], style_name: "" }, ctx)).error),
    ).toContain("style_name must be");
    expect(
      String((await runTool({ references: ["media_a"], style_name: "Bad Name" }, ctx)).error),
    ).toContain("style_name must be");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing style directory", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(STYLES, "kinetic")); // the style dir already exists
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("already exists");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing single-file style", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(STYLES, "kinetic.md")); // legacy <name>.md form
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("already exists");
  });
});

describe("extract_style · happy path", () => {
  it("acquires a resolvable ref, encodes, analyzes, then versions + writes the style", async () => {
    const fs = resolvableFs();
    const runner = makeRunner(fs);
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(runner, fs),
    );

    expect(r.ok).toBe(true);
    expect(r.style_name).toBe("kinetic");
    expect(r.version).toBe(1);
    expect(r.style_path).toBe(joinPath(STYLES, "kinetic", "style.md"));
    expect(r.references).toEqual(["media_a"]);
    expect(r.warnings).toEqual([]);
    expect(r.metrics_summary.fps).toBe(16);
    expect(r.metrics_summary.total_seconds).toBe(10);
    expect(r.metrics_summary.dimensions_present).toContain("identity");
    expect(r.metrics_summary.dimensions_present).toContain("color");
    expect(r.cost).toEqual({ analyze_input_tokens: 10, analyze_output_tokens: 20 });
    expect(r.draft_preview).toContain("Kinetic Clean");

    // The proxy body carries fps, ordered video keys + durations, and the encoded media.
    const { name, body } = lastProxyCall();
    expect(name).toBe("style_analyze");
    expect(body.args).toMatchObject({ fps: 16, n: 1, videos: ["v0"], durations: [10] });
    expect(body.media.v0).toEqual({ b64: "b64data", ext: ".mp4" });

    // style.md + the versioned copy + meta.json + analyze.json all landed on disk.
    expect(fs.files.get(joinPath(STYLES, "kinetic", "style.md"))).toBe(FULL_MD);
    expect(fs.files.get(joinPath(STYLES, "kinetic", "versions", "v1.md"))).toBe(FULL_MD);
    const meta = JSON.parse(fs.files.get(joinPath(STYLES, "kinetic", "meta.json")) as string);
    expect(meta.current_version).toBe(1);
    expect(meta.versions).toHaveLength(1);
    expect(meta.versions[0]).toMatchObject({
      version: 1,
      origin: "extraction",
      references: ["media_a"],
    });
    const analyze = JSON.parse(
      fs.files.get(joinPath(STYLES, "kinetic", "extraction", "analyze.json")) as string,
    );
    expect(analyze).toMatchObject({
      fps: 16,
      n_references: 1,
      input_tokens: 10,
      output_tokens: 20,
      references: ["media_a"],
    });
  });
});

describe("extract_style · acquisition + encoding", () => {
  it("downloads an unresolved reference with yt-dlp", async () => {
    const fs = new MockFs();
    const runner = makeRunner(fs);
    const r = await runTool(
      { references: ["https://host/clip"], style_name: "kinetic" },
      ctxWith(runner, fs),
    );
    expect(r.ok).toBe(true);
    expect(ran(runner, "yt-dlp")).toBe(true);
  });

  it("surfaces a yt-dlp download failure against the offending reference", async () => {
    const fs = new MockFs();
    const runner = makeRunner(fs, { ytdlpCode: 1 });
    const r = await runTool(
      { references: ["https://host/clip"], style_name: "kinetic" },
      ctxWith(runner, fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("reference 1:");
    expect(String(r.error)).toContain("could not download");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("reuses a previously downloaded reference without re-invoking yt-dlp", async () => {
    const fs = new MockFs();
    const ref = "https://host/clip";
    fs.putBytes(
      joinPath(DIR, "internals/cache", `style_dl/ref_${shortHash(ref)}.mp4`),
      new Uint8Array([7]),
    );
    const runner = makeRunner(fs);
    const r = await runTool({ references: [ref], style_name: "kinetic" }, ctxWith(runner, fs));
    expect(r.ok).toBe(true);
    expect(ran(runner, "yt-dlp")).toBe(false);
  });

  it("reuses a cached encode without re-invoking ffmpeg for it", async () => {
    const fs = resolvableFs();
    fs.putBytes(
      joinPath(DIR, "internals/cache", `style_enc/${shortHash(LOCAL)}.style.mp4`),
      new Uint8Array([5, 5]),
    );
    const runner = makeRunner(fs);
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(runner, fs),
    );
    expect(r.ok).toBe(true);
    expect(ran(runner, "ffmpeg")).toBe(false);
  });

  it("falls back to the source bytes when the ffmpeg encode fails", async () => {
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs, { ffmpegCode: 1 }), fs),
    );
    expect(r.ok).toBe(true); // encode fell back to the original file bytes
  });

  it("treats an unprobeable reference as zero duration", async () => {
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs, { ffprobeThrows: true }), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.metrics_summary.total_seconds).toBe(0);
    expect(r.metrics_summary.fps).toBe(16);
  });

  it("treats a probe without a numeric duration as zero duration", async () => {
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs, { ffprobeNoDuration: true }), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.metrics_summary.total_seconds).toBe(0);
  });

  it("normalizes falsy/whitespace-only entries out of the reference list", async () => {
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a", "   ", ""], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.references).toEqual(["media_a"]);
  });
});

describe("extract_style · limits", () => {
  it("rejects a payload that exceeds the inline transport limit", async () => {
    const fs = resolvableFs();
    const big = new Uint8Array(18 * 1024 * 1024 + 1);
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs, { ffmpegBytes: big }), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("exceeds the inline transport limit");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects total reference length beyond the one-hour cap", async () => {
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs, { duration: 4000 }), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("exceeds the 1-hour cap");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("scales fps down for longer references", async () => {
    const mid = resolvableFs();
    const rMid = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(mid, { duration: 400 }), mid),
    );
    expect(rMid.metrics_summary.fps).toBe(8);

    const long = resolvableFs();
    const rLong = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(long, { duration: 700 }), long),
    );
    expect(rLong.metrics_summary.fps).toBe(4);
  });
});

describe("extract_style · analyze result handling", () => {
  it("surfaces a thrown proxy error message", async () => {
    proxy.mockRejectedValue(new Error("style proxy exploded"));
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("style proxy exploded");
  });

  it("stringifies a non-Error proxy rejection", async () => {
    proxy.mockRejectedValue("rate limited");
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate limited");
  });

  it("surfaces a model-side analyze failure", async () => {
    proxyResult({ ok: false, error: "analyze exploded" });
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("analyze exploded");
  });

  it("uses a default message for a bare analyze failure", async () => {
    proxyResult({ ok: false });
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("analyze stage failed");
  });

  it("errors when the analyze body is empty", async () => {
    proxyResult({ ok: true, body: "   " });
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("produced empty output");
  });

  it("treats a missing result envelope as an empty body", async () => {
    proxy.mockResolvedValue({} as Any);
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("produced empty output");
  });

  it("defaults the token cost to zero when the analyze omits token counts", async () => {
    proxyResult({ ok: true, body: FULL_MD }); // no input_tokens / output_tokens
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.cost).toEqual({ analyze_input_tokens: 0, analyze_output_tokens: 0 });
  });
});

describe("extract_style · parsing + versioning", () => {
  it("warns (but still succeeds) when required dimensions are missing", async () => {
    proxyResult({ ok: true, body: PARTIAL_MD, input_tokens: 1, output_tokens: 2 });
    const fs = resolvableFs();
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(String(r.warnings[0])).toContain("missing required dimension");
    expect(String(r.warnings[0])).toContain("Density");
    expect(String(r.warnings[0])).toContain("Sourcing");
  });

  it("increments the version off an existing meta.json", async () => {
    const fs = resolvableFs();
    fs.set(
      joinPath(STYLES, "kinetic", "meta.json"),
      JSON.stringify({
        name: "kinetic",
        current_version: 2,
        versions: [{ version: 1 }, { version: 2 }],
      }),
    );
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.version).toBe(3);
    const meta = JSON.parse(fs.files.get(joinPath(STYLES, "kinetic", "meta.json")) as string);
    expect(meta.current_version).toBe(3);
    expect(meta.versions).toHaveLength(3);
    expect(fs.files.get(joinPath(STYLES, "kinetic", "versions", "v3.md"))).toBe(FULL_MD);
  });

  it("falls back to a fresh version when meta.json is corrupt", async () => {
    const fs = resolvableFs();
    fs.set(joinPath(STYLES, "kinetic", "meta.json"), "{ not valid json");
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.version).toBe(1);
  });

  it("tolerates an existing meta.json whose versions field is not an array", async () => {
    const fs = resolvableFs();
    fs.set(
      joinPath(STYLES, "kinetic", "meta.json"),
      JSON.stringify({ current_version: 5, versions: "oops" }),
    );
    const r = await runTool(
      { references: ["media_a"], style_name: "kinetic" },
      ctxWith(makeRunner(fs), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.version).toBe(6);
    const meta = JSON.parse(fs.files.get(joinPath(STYLES, "kinetic", "meta.json")) as string);
    expect(meta.versions).toHaveLength(1);
  });
});
