import { describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { registerTestDocument } from "../test/timelineKit";
import { BROWSER_BIN } from "./sidecar";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import {
  getPageImageTool,
  getPageTool,
  resolveRenderProfile,
  resolveViewport,
  webSearchTool,
} from "./web";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
    if (b) return b;
    const t = this.files.get(n);
    if (t === undefined) throw new Error("ENOENT");
    return new TextEncoder().encode(t || "png-bytes");
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

interface RunnerOpts {
  fail?: boolean;
  badJson?: boolean;
  noShot?: boolean;
  search?: unknown;
}
function webRunner(fs: MockFs, opts: RunnerOpts = {}): CommandRunner {
  return {
    run: vi.fn(async (program: string, args: string[]) => {
      if (program !== BROWSER_BIN) return { code: 0, stdout: "", stderr: "" };
      if (opts.fail) return { code: 1, stdout: "", stderr: "boom" };
      if (opts.badJson) return { code: 0, stdout: "not json", stderr: "" };
      const cmd = args[0];
      if (cmd === "search") {
        return {
          code: 0,
          stdout: JSON.stringify(
            opts.search ?? {
              ok: true,
              engine: "ddg",
              results: [{ title: "T", url: "https://x", snippet: "s" }],
            },
          ),
          stderr: "",
        };
      }
      if (cmd === "page") {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            title: "Title",
            final_url: "https://x/final",
            html: "<html>hi</html>",
          }),
          stderr: "",
        };
      }
      if (cmd === "shot") {
        const out = args[args.indexOf("--out") + 1];
        if (!opts.noShot) fs.touch(out);
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, title: "Title", final_url: "https://x" }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    }),
  };
}

describe("resolveViewport", () => {
  it("maps presets, freeform, and falls back to desktop", () => {
    expect(resolveViewport("mobile")).toBe("1170x2532");
    expect(resolveViewport("desktop")).toBe("3840x2400");
    expect(resolveViewport("ULTRAWIDE")).toBe("7680x4320");
    expect(resolveViewport("1080x1920")).toBe("1080x1920");
    expect(resolveViewport("garbage")).toBe("3840x2400");
    expect(resolveViewport(undefined)).toBe("3840x2400");
  });
});

describe("resolveRenderProfile", () => {
  // The contract promises `viewport` is the SOURCE pixel size of the PNG. The
  // CSS viewport x dsf must therefore reproduce resolveViewport() EXACTLY, or a
  // documented '1080x1920' silently stops being 1080 wide.
  it("renders the same pixel size the contract promises, for every preset", () => {
    for (const name of ["mobile", "tablet", "desktop", "wide", "large_monitor", "ultrawide"]) {
      const p = resolveRenderProfile(name);
      const [cw, ch] = p.viewport.split("x").map(Number);
      expect(`${cw * p.dsf}x${ch * p.dsf}`).toBe(resolveViewport(name));
    }
  });

  it("keeps freeform sizes literal (dsf 1), so '1080x1920' is 1080 px wide", () => {
    const p = resolveRenderProfile("1080x1920");
    expect(p).toEqual({ viewport: "1080x1920", dsf: 1, mobile: false });
    expect(`${1080 * p.dsf}x${1920 * p.dsf}`).toBe(resolveViewport("1080x1920"));
  });

  it("marks only the phone/tablet breakpoints as mobile", () => {
    expect(resolveRenderProfile("mobile").mobile).toBe(true);
    expect(resolveRenderProfile("tablet").mobile).toBe(true);
    for (const n of ["desktop", "wide", "large_monitor", "ultrawide", "garbage", undefined]) {
      expect(resolveRenderProfile(n).mobile).toBe(false);
    }
  });

  it("falls back to desktop for junk, like resolveViewport", () => {
    expect(resolveRenderProfile("garbage")).toEqual(resolveRenderProfile("desktop"));
    expect(resolveRenderProfile(undefined)).toEqual(resolveRenderProfile("desktop"));
    expect(resolveRenderProfile("MOBILE")).toEqual(resolveRenderProfile("mobile"));
  });
});

describe("webSearchTool", () => {
  it("errors without a context", async () => {
    expect(((await webSearchTool({}, null)) as Any).ok).toBe(false);
  });

  it("requires a query", async () => {
    const fs = new MockFs();
    const r = (await webSearchTool({}, ctxWith(webRunner(fs), fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("query is required");
  });

  it("returns deduped results from the helper", async () => {
    const fs = new MockFs();
    const r = (await webSearchTool({ query: "saturn v", n: 3 }, ctxWith(webRunner(fs), fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("ddg");
    expect(r.result_count).toBe(1);
    expect(r.results[0]).toMatchObject({ title: "T", url: "https://x" });
  });

  // `site` is a first-class param: the model must NOT hand-write a `site:` prefix,
  // so the tool is what composes it. Assert on the args the HELPER actually got.
  it.each([
    ["x.com", "site:x.com saturn v"],
    ["https://www.reddit.com/r/space", "site:www.reddit.com saturn v"],
    ["site:x.com", "site:x.com saturn v"],
    ["not a domain", "saturn v"],
    ["", "saturn v"],
  ])("site=%j composes the query as %j", async (site, expected) => {
    const fs = new MockFs();
    const runner = webRunner(fs);
    const r = (await webSearchTool({ query: "saturn v", site }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    const args = (runner.run as unknown as { mock: { calls: [string, string[]][] } }).mock
      .calls[0][1];
    expect(args[args.indexOf("--query") + 1]).toBe(expected);
    expect(r.query).toBe(expected);
  });

  it("does not double-prefix when the query already carries a site: filter", async () => {
    const fs = new MockFs();
    const runner = webRunner(fs);
    const r = (await webSearchTool(
      { query: "site:nasa.gov artemis", site: "x.com" },
      ctxWith(runner, fs),
    )) as Any;
    const args = (runner.run as unknown as { mock: { calls: [string, string[]][] } }).mock
      .calls[0][1];
    expect(args[args.indexOf("--query") + 1]).toBe("site:nasa.gov artemis");
    expect(r.ok).toBe(true);
  });

  it("errors when the helper returns no results", async () => {
    const fs = new MockFs();
    const r = (await webSearchTool(
      { query: "x" },
      ctxWith(webRunner(fs, { search: { ok: true, results: [] } }), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no results");
  });

  // A CAPTCHA page and a genuinely empty SERP both arrive as zero rows. Conflating
  // them is what let the model retry four queries into the same wall and then
  // answer from memory without reporting that search was broken.
  it("reports an anti-bot block as a TOOL failure, distinct from 'no matches'", async () => {
    const fs = new MockFs();
    const blocked = {
      ok: false,
      engine: "ddg",
      blocked: true,
      error: "the search engine served an anti-bot challenge instead of results",
    };
    const r = (await webSearchTool(
      { query: "x" },
      ctxWith(webRunner(fs, { search: blocked }), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(String(r.error)).toMatch(/challenge|blocked/i);
    expect(String(r.error)).not.toMatch(/no results/i);
  });

  it("surfaces a helper failure", async () => {
    const fs = new MockFs();
    const r = (await webSearchTool(
      { query: "x" },
      ctxWith(webRunner(fs, { fail: true }), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("web_search failed");
  });

  it("surfaces invalid JSON from the helper", async () => {
    const fs = new MockFs();
    const r = (await webSearchTool(
      { query: "x" },
      ctxWith(webRunner(fs, { badJson: true }), fs),
    )) as Any;
    expect(r.ok).toBe(false);
  });
});

describe("getPageTool", () => {
  it("errors without a context or url", async () => {
    expect(((await getPageTool({}, null)) as Any).ok).toBe(false);
    const fs = new MockFs();
    expect(((await getPageTool({}, ctxWith(webRunner(fs), fs))) as Any).ok).toBe(false);
  });

  it("captures + saves the html snapshot", async () => {
    const fs = new MockFs();
    const r = (await getPageTool({ url: "https://x" }, ctxWith(webRunner(fs), fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Title");
    expect(r.final_url).toBe("https://x/final");
    expect(r.html_chars).toBe("<html>hi</html>".length);
    expect(r.cached).toBe(false);
    expect(await fs.exists(r.html_artifact_id)).toBe(true);
  });

  it("returns the cached snapshot on a second call, and force_refresh bypasses it", async () => {
    const fs = new MockFs();
    const runner = webRunner(fs);
    const ctx = ctxWith(runner, fs);
    await getPageTool({ url: "https://x" }, ctx);
    const cached = (await getPageTool({ url: "https://x" }, ctx)) as Any;
    expect(cached.cached).toBe(true);
    const forced = (await getPageTool({ url: "https://x", force_refresh: true }, ctx)) as Any;
    expect(forced.cached).toBe(false);
    const pageCalls = (runner.run as Any).mock.calls.filter((c: Any[]) => c[1][0] === "page");
    expect(pageCalls).toHaveLength(2); // first + forced (cache hit skipped the helper)
  });

  it("surfaces a helper failure", async () => {
    const fs = new MockFs();
    const r = (await getPageTool(
      { url: "https://x" },
      ctxWith(webRunner(fs, { fail: true }), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("get_page failed");
  });
});

describe("getPageImageTool", () => {
  it("errors without a context or url", async () => {
    expect(((await getPageImageTool({}, null)) as Any).ok).toBe(false);
    const fs = new MockFs();
    expect(((await getPageImageTool({}, ctxWith(webRunner(fs), fs))) as Any).ok).toBe(false);
  });

  it("screenshots the page and attaches it", async () => {
    const fs = new MockFs();
    const r = (await getPageImageTool(
      { url: "https://x", viewport: "mobile" },
      ctxWith(webRunner(fs), fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.viewport).toBe("1170x2532");
    expect(r.cached).toBe(false);
    expect(r._attachments).toHaveLength(1);
    expect(r._attachments[0].kind).toBe("image");
  });

  // The screenshot must come back as a LIBRARY REF that RESOLVES. It used to return the
  // project-relative cache path, which import_media rejects (it resolves only absolute
  // paths) — so the model could see the shot but never place it on the timeline.
  it("returns a media_ref that resolves to real bytes, and no path", async () => {
    const fs = new MockFs();
    registerTestDocument(DIR);
    const ctx = ctxWith(webRunner(fs), fs);
    const r = (await getPageImageTool({ url: "https://x" }, ctx)) as Any;

    expect(r.media_ref_error).toBeUndefined();
    expect(r.image_path).toBeUndefined(); // no filesystem path reaches the model
    expect(String(r.media_ref)).toMatch(/^media_/);
    const abs = await ctx.store.resolveRef(r.media_ref);
    expect(abs).toBeTruthy();
    expect(await fs.exists(abs!)).toBe(true);
  });

  it("re-shooting the same page reuses one library entry (content-addressed)", async () => {
    const fs = new MockFs();
    registerTestDocument(DIR);
    const ctx = ctxWith(webRunner(fs), fs);
    const a = (await getPageImageTool({ url: "https://x" }, ctx)) as Any;
    const b = (await getPageImageTool({ url: "https://x", force_refresh: true }, ctx)) as Any;
    expect(b.media_ref).toBe(a.media_ref); // identical bytes -> same id, no library clutter
  });

  it("serves a cached screenshot on the second call", async () => {
    const fs = new MockFs();
    const runner = webRunner(fs);
    const ctx = ctxWith(runner, fs);
    await getPageImageTool({ url: "https://x" }, ctx);
    const cached = (await getPageImageTool({ url: "https://x" }, ctx)) as Any;
    expect(cached.cached).toBe(true);
    expect((runner.run as Any).mock.calls.filter((c: Any[]) => c[1][0] === "shot")).toHaveLength(1);
  });

  it("errors when the screenshot is not produced", async () => {
    const fs = new MockFs();
    const r = (await getPageImageTool(
      { url: "https://x" },
      ctxWith(webRunner(fs, { noShot: true }), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not produced");
  });
});
