import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import {
  clearMetadataCache,
  curateInfoJson,
  downloadVideoTool,
  slimMetadata,
  videoGetMetadataTool,
  youtubeSearchTool,
} from "./net";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
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
const PROBE_JSON = JSON.stringify({
  format: { format_name: "mp4", duration: "12.5", size: "1048576" },
  streams: [
    { codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1", codec_name: "h264" },
    { codec_type: "audio", codec_name: "aac" },
  ],
});
const INFO_JSON = JSON.stringify({
  extractor_key: "Youtube",
  title: "Test Video",
  duration: 212,
  channel: "Chan",
  uploader: "Chan",
  upload_date: "20240101",
  view_count: 1000,
  like_count: 50,
  description: "hello world",
  thumbnail: "http://t/best.jpg",
  chapters: [{ start_time: 0, end_time: 10, title: "Intro" }],
  heatmap: [{ start_time: 0, end_time: 5, value: 0.9 }],
  formats: [{ protocol: "mhtml", format_id: "sb0" }],
  subtitles: { en: [] },
  is_live: false,
  was_live: false,
});

function runnerOf(impl: (program: string, args: string[]) => CommandResult): CommandRunner {
  return { run: vi.fn(async (program: string, args: string[]) => impl(program, args)) };
}
function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

beforeEach(() => clearMetadataCache());

describe("curateInfoJson", () => {
  it("maps the yt-dlp info shape", () => {
    const c = curateInfoJson(JSON.parse(INFO_JSON), "u") as Any;
    expect(c.extractor).toBe("Youtube");
    expect(c.title).toBe("Test Video");
    expect(c.duration_s).toBe(212);
    expect(c.channel).toBe("Chan");
    expect(c.chapters).toHaveLength(1);
    expect(c.heatmap_total_buckets).toBe(1);
    expect(c.has_storyboards).toBe(true);
    expect(c.captions_available).toBe(true);
    expect(c.thumbnail_url).toBe("http://t/best.jpg");
  });
  it("truncates a long description", () => {
    const c = curateInfoJson({ description: "x".repeat(2500) }, "u") as Any;
    expect(c.description_truncated).toBe(true);
    expect((c.description as string).length).toBe(2000);
  });
  it("keeps the 10 hottest heatmap buckets in chronological order", () => {
    const heatmap = Array.from({ length: 12 }, (_, i) => ({
      start_time: i,
      end_time: i + 1,
      value: i, // hottest = latest
    }));
    const c = curateInfoJson({ heatmap }, "u") as Any;
    expect(c.heatmap_total_buckets).toBe(12);
    expect(c.heatmap).toHaveLength(10);
    // top-10 by value are start_time 2..11, re-sorted chronologically
    expect(c.heatmap[0].start_s).toBe(2);
    expect(c.heatmap[9].start_s).toBe(11);
  });
  it("falls back to the largest thumbnail when no primary is set", () => {
    const c = curateInfoJson(
      {
        thumbnails: [
          { url: "small", width: 10, height: 10 },
          { url: "big", width: 100, height: 100 },
        ],
      },
      "u",
    ) as Any;
    expect(c.thumbnail_url).toBe("big");
  });
  it("degrades gracefully on a sparse info-json", () => {
    const c = curateInfoJson({}, "u") as Any;
    expect(c.title).toBeNull();
    expect(c.extractor).toBeNull();
    expect(c.channel).toBeNull();
    expect(c.chapters).toEqual([]);
    expect(c.heatmap).toEqual([]);
    expect(c.heatmap_total_buckets).toBe(0);
    expect(c.has_storyboards).toBe(false);
    expect(c.captions_available).toBe(false);
    expect(c.thumbnail_url).toBeNull();
    expect(c.description_truncated).toBe(false);
  });
  it("uses fallbacks and drops partial chapter/heatmap entries", () => {
    const c = curateInfoJson(
      {
        extractor: "Generic",
        uploader: "U",
        chapters: [{ title: "no-start" }, { start_time: 5, title: "ok" }],
        heatmap: [{ start_time: 1 }, { start_time: 2, value: 0.5 }],
        formats: [{ format_id: "web", protocol: "https" }],
      },
      "u",
    ) as Any;
    expect(c.extractor).toBe("Generic");
    expect(c.channel).toBe("U");
    expect(c.chapters).toHaveLength(1);
    expect(c.heatmap_total_buckets).toBe(1);
    expect(c.has_storyboards).toBe(false);
  });
});

describe("slimMetadata", () => {
  it("projects onto the ranking shape", () => {
    const s = slimMetadata(curateInfoJson(JSON.parse(INFO_JSON), "u")) as Any;
    expect(s.duration_s).toBe(212);
    expect(s.n_chapters).toBe(1);
    expect(s.n_heatmap_buckets).toBe(1);
    expect(s.description_first_300).toBe("hello world");
  });
});

describe("downloadVideoTool", () => {
  it("errors without a context and on bad args", async () => {
    expect(((await downloadVideoTool({}, null)) as Any).ok).toBe(false);
    const ctx = ctxWith(runnerOf(() => ({ code: 0, stdout: "", stderr: "" })));
    expect(((await downloadVideoTool({ output_name: "o.mp4" }, ctx)) as Any).ok).toBe(false);
    expect(((await downloadVideoTool({ url: "u" }, ctx)) as Any).ok).toBe(false);
    expect(((await downloadVideoTool({ url: "u", output_name: "../e" }, ctx)) as Any).ok).toBe(
      false,
    );
  });
  it("downloads a full video and probes it", async () => {
    const fs = new MockFs();
    const out = joinPath(DIR, "internals/cache/downloads/o.mp4");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "yt-dlp") {
          fs.touch(out);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const r = (await downloadVideoTool(
      { url: "u", output_name: "o.mp4" },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(String(r.media_ref)).toMatch(/^media_[0-9a-f]{12}$/); // registered as a library asset
    expect(r.path).toBeUndefined(); // the model gets a ref, never a path
    expect(r.duration_s).toBe(12.5);
    expect(r.width).toBe(1080);
    expect(r.has_audio).toBe(true);
    // full download: no --download-sections
    const dl = calls.find((c) => c[0] === "yt-dlp") as string[];
    expect(dl.some((a) => a === "--download-sections")).toBe(false);
  });
  it("passes a --download-sections window", async () => {
    const fs = new MockFs();
    const out = joinPath(DIR, "internals/cache/downloads/o.mp4");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "yt-dlp") {
          fs.touch(out);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const r = (await downloadVideoTool(
      { url: "u", output_name: "o.mp4", start_s: 5, end_s: 10 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    const dl = calls.find((c) => c[0] === "yt-dlp") as string[];
    expect(dl).toContain("*5.00-10.00");
  });
  it("promotes a degenerate window to a full download with a note", async () => {
    const fs = new MockFs();
    const out = joinPath(DIR, "internals/cache/downloads/o.mp4");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "yt-dlp") {
          fs.touch(out);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const r = (await downloadVideoTool(
      { url: "u", output_name: "o.mp4", start_s: 5 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(String(r.note)).toContain("FULL video");
    const dl = calls.find((c) => c[0] === "yt-dlp") as string[];
    expect(dl.some((a) => a === "--download-sections")).toBe(false);
  });
  it("rejects a near-empty windowed clip", async () => {
    const fs = new MockFs();
    const out = joinPath(DIR, "internals/cache/downloads/o.mp4");
    const shortProbe = JSON.stringify({ format: { duration: "0.1", size: "10" }, streams: [] });
    const runner: CommandRunner = {
      run: vi.fn(async (program: string) => {
        if (program === "yt-dlp") {
          fs.touch(out);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: shortProbe, stderr: "" };
      }),
    };
    const r = (await downloadVideoTool(
      { url: "u", output_name: "o.mp4", start_s: 5, end_s: 10 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("near-empty");
  });
  it("surfaces a yt-dlp failure", async () => {
    const r = (await downloadVideoTool(
      { url: "u", output_name: "o.mp4" },
      ctxWith(runnerOf(() => ({ code: 1, stdout: "", stderr: "gone" }))),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("gone");
  });
  it("caps resolution by the SHORT edge, so 9:16 is not downgraded", async () => {
    const fs = new MockFs();
    const out = joinPath(DIR, "internals/cache/downloads/o.mp4");
    let fmtArg = "";
    let sortArg = "";
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "yt-dlp") {
          fmtArg = args[args.indexOf("-f") + 1];
          sortArg = args.includes("-S") ? args[args.indexOf("-S") + 1] : "";
          fs.touch(out);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const r = (await downloadVideoTool(
      { url: "u", output_name: "o.mp4", with_audio: true },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(fmtArg).toContain("ba"); // with_audio still asks for an audio stream
    // A width/height filter is orientation-DEPENDENT: `height` is the long edge on a
    // vertical source, so `height<=720` selected 360x640. `res` is the lower of the two.
    expect(fmtArg).not.toMatch(/\b(height|width)\s*<=/);
    expect(sortArg).toMatch(/\bres:720\b/);
  });
});

describe("videoGetMetadataTool", () => {
  it("errors without a context or url", async () => {
    expect(((await videoGetMetadataTool({ url: "u" }, null)) as Any).ok).toBe(false);
    expect(
      (
        (await videoGetMetadataTool(
          {},
          ctxWith(runnerOf(() => ({ code: 0, stdout: "", stderr: "" }))),
        )) as Any
      ).ok,
    ).toBe(false);
  });
  it("fetches, curates, then serves from cache", async () => {
    const runner = runnerOf(() => ({ code: 0, stdout: INFO_JSON, stderr: "" }));
    const ctx = ctxWith(runner);
    const a = (await videoGetMetadataTool({ url: "u1" }, ctx)) as Any;
    expect(a.ok).toBe(true);
    expect(a.cached).toBe(false);
    expect(a.metadata.title).toBe("Test Video");
    const b = (await videoGetMetadataTool({ url: "u1" }, ctx)) as Any;
    expect(b.cached).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
  it("surfaces failures and bad json", async () => {
    const fail = (await videoGetMetadataTool(
      { url: "u2" },
      ctxWith(runnerOf(() => ({ code: 1, stdout: "", stderr: "private" }))),
    )) as Any;
    expect(fail.ok).toBe(false);
    const bad = (await videoGetMetadataTool(
      { url: "u3" },
      ctxWith(runnerOf(() => ({ code: 0, stdout: "{not json", stderr: "" }))),
    )) as Any;
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("parse");
  });
});

describe("youtubeSearchTool", () => {
  const SEARCH_JSON = JSON.stringify({
    entries: [
      { id: "aaaaaaaaaaa", title: "One", channel: "C1", duration: 100 },
      { url: "https://www.youtube.com/watch?v=b", title: "Two", uploader: "C2", duration: 200 },
    ],
  });
  it("errors without a context or query", async () => {
    expect(((await youtubeSearchTool({ query: "q" }, null)) as Any).ok).toBe(false);
    expect(
      (
        (await youtubeSearchTool(
          {},
          ctxWith(runnerOf(() => ({ code: 0, stdout: "", stderr: "" }))),
        )) as Any
      ).ok,
    ).toBe(false);
  });
  it("returns empty results gracefully", async () => {
    const r = (await youtubeSearchTool(
      { query: "q" },
      ctxWith(runnerOf(() => ({ code: 0, stdout: JSON.stringify({ entries: [] }), stderr: "" }))),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.result_count).toBe(0);
  });
  it("returns shallow rows when enrich is false", async () => {
    const r = (await youtubeSearchTool(
      { query: "q", enrich: false },
      ctxWith(
        runnerOf((_p, args) => ({
          code: 0,
          stdout: args.some((a) => a.startsWith("ytsearch")) ? SEARCH_JSON : INFO_JSON,
          stderr: "",
        })),
      ),
    )) as Any;
    expect(r.enriched).toBe(false);
    expect(r.result_count).toBe(2);
    expect(r.results[0].url).toContain("watch?v=aaaaaaaaaaa");
    expect(r.results[0].metadata).toBeNull();
  });
  it("enriches each hit with slim metadata", async () => {
    const runner = runnerOf((_p, args) => ({
      code: 0,
      stdout: args.some((a) => a.startsWith("ytsearch")) ? SEARCH_JSON : INFO_JSON,
      stderr: "",
    }));
    const r = (await youtubeSearchTool({ query: "q" }, ctxWith(runner))) as Any;
    expect(r.enriched).toBe(true);
    expect(r.result_count).toBe(2);
    expect(r.results[0].metadata.duration_s).toBe(212);
    expect(r.results[0].metadata_error).toBeNull();
  });
  it("reports metadata_error when enrichment fails", async () => {
    const runner = runnerOf((_p, args) => ({
      code: args.some((a) => a.startsWith("ytsearch")) ? 0 : 1,
      stdout: args.some((a) => a.startsWith("ytsearch")) ? SEARCH_JSON : "",
      stderr: args.some((a) => a.startsWith("ytsearch")) ? "" : "private",
    }));
    const r = (await youtubeSearchTool({ query: "q" }, ctxWith(runner))) as Any;
    expect(r.enriched).toBe(true);
    expect(r.results[0].metadata).toBeNull();
    expect(String(r.results[0].metadata_error)).toContain("private");
  });
});
