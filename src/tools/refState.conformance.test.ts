// A `media_ref` that is still being GENERATED must never be reported as unknown.
//
// Generation returns a ref immediately; the file appears tens of seconds later. In that window the
// ref is correct AND resolves to nothing. Every tool worded its own null branch, and only add_clips
// had been taught the difference, so one real session told the model "media not found: media_gen_…"
// 21 times. It believed the message, decided its ref was wrong, and started guessing filesystem
// paths — 28 of that session's 51 tool errors came from this one sentence.
//
// The list of tools is DERIVED from the served contract rather than hand-written, so a new tool
// that takes a `media_ref` fails here until it is either wired up or explicitly exempted. That is
// the whole point: the previous shape of this rule was "each caller remembers", which is how the
// gap existed in the first place.
import { describe, expect, it, vi } from "vitest";

import { paramsByTool } from "../contract/views";
import { clipVideoTool, cropImageTool, probeMediaTool } from "./media";
import { inspectColorTool, inspectMediaTool } from "./inspect";
import { registerVisionTools } from "./vision";
import { registerVideoTools } from "./video";
import { ClientToolRegistry } from "./registry";
import type { ClientToolContext } from "./context";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Surface = NonNullable<ClientToolContext["surface"]>;

vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(async () => ({ result: {}, media: [] })),
  toB64: () => "",
  fromB64: () => new Uint8Array(),
  RateLimitError: class extends Error {},
}));

const DIR = "C:/proj";
const PENDING = "media_gen_pending01";
const FAILED = "media_gen_failed01";
const OFFLINE = "media_offline01";
/** What the in-app agent was told before MCP had its own wording. Frozen: that agent IS told when
 *  the media lands, so this is true for it, and changing it changes what the model does. */
const APP_PENDING = `'${PENDING}' is still being generated, so there is nothing to read yet. The ref is correct; you will be told when it lands. Don't re-generate it and don't guess a file path.`;

class Fs implements FsLike {
  files = new Map<string, string>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p));
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(): Promise<Uint8Array> {
    throw new Error("ENOENT");
  }
  async writeBytes(): Promise<void> {}
  async readDir(): Promise<DirEntry[]> {
    return [];
  }
  async mkdir(): Promise<void> {}
}

/** A catalog holding one generating row and one failed row, and NO files on disk — exactly the
 *  state a generation tool leaves behind between submit and settle. `surface` is who is calling:
 *  left out it is the in-app agent, which is what every context was before MCP had its own wording. */
function ctx(surface?: Surface): ClientToolContext {
  const fs = new Fs();
  fs.files.set(
    joinPath(DIR, "internals/library.json"),
    JSON.stringify({
      clips: [
        {
          id: PENDING,
          path: `library/${PENDING}.mp4`,
          kind: "video",
          status: "generating",
          added_at: Date.now() / 1000 - 30,
        },
        {
          id: FAILED,
          path: `library/${FAILED}.mp4`,
          kind: "video",
          status: "failed",
          error: "content filter",
        },
        // UJ-014: linked from the user's disk, and no longer there.
        {
          id: OFFLINE,
          path: "D:/Downloads/iCloud Fotos/New Jeans.mp4",
          filename: "New Jeans.mp4",
          kind: "video",
          external: true,
        },
      ],
    }),
  );
  return {
    store: new ProjectStoreAccess(DIR, fs),
    runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    ...(surface ? { surface } : {}),
  };
}

/** Every contract tool that accepts a `media_ref`, and how to call it with one. */
const CALLS: Record<string, (ref: string, surface?: Surface) => Promise<unknown>> = {
  probe_media: (ref, s) => probeMediaTool({ media_ref: ref }, ctx(s)),
  inspect_media: (ref, s) => inspectMediaTool({ media_ref: ref }, ctx(s)),
  inspect_color: (ref, s) => inspectColorTool({ media_ref: ref }, ctx(s)),
  crop_image: (ref, s) =>
    cropImageTool({ media_ref: ref, bbox: { x: 0, y: 0, w: 10, h: 10 } }, ctx(s)),
  clip_video: (ref, s) =>
    clipVideoTool({ media_ref: ref, start_s: 0, end_s: 1, output_name: "out.mp4" }, ctx(s)),
  vision_describe: (ref, s) =>
    viaRegistry(registerVisionTools, "vision_describe", { media_ref: ref }, s),
  find_content: (ref, s) =>
    viaRegistry(registerVisionTools, "find_content", { media_ref: ref, prompt: "x" }, s),
  video_ask: (ref, s) =>
    viaRegistry(registerVideoTools, "video_ask", { media_ref: ref, prompt: "x" }, s),
  video_find_moment: (ref, s) =>
    viaRegistry(registerVideoTools, "video_find_moment", { media_ref: ref, query: "x" }, s),
};

type Register = (r: ClientToolRegistry, getCtx: () => ClientToolContext | null) => void;

async function viaRegistry(
  register: Register,
  name: string,
  args: Record<string, unknown>,
  surface?: Surface,
): Promise<unknown> {
  const reg = new ClientToolRegistry();
  register(reg, () => ctx(surface));
  return reg.run(name, args);
}

/** Tools whose `media_ref` cannot name generated media. An entry here is a decision.
 *
 *  `set_clip_properties` takes a `media_ref` to SWAP a clip's source, and a still-generating ref is
 *  a legitimate target: the clip already has its slot, so the swap needs no length from the file and
 *  the picture fills in when the media lands — the same promise add_clips makes. Reporting it as
 *  "pending" would refuse an edit that works. */
const EXEMPT: string[] = ["set_clip_properties"];

const contractTools = paramsByTool();
const takesMediaRef = Object.entries(contractTools)
  .filter(([, v]) => v.params.includes("media_ref"))
  .map(([name]) => name)
  .sort();

describe("every tool that takes a media_ref knows 'pending' from 'unknown'", () => {
  it("covers the whole contract surface (a new media_ref tool lands here first)", () => {
    const missing = takesMediaRef.filter((t) => !CALLS[t] && !EXEMPT.includes(t));
    expect(missing).toEqual([]);
  });

  for (const name of takesMediaRef) {
    if (EXEMPT.includes(name)) continue;

    it(`${name}: a generating ref is reported as pending, not as a wrong ref`, async () => {
      const r = (await CALLS[name](PENDING)) as Any;
      const msg = String(r?.error ?? "");
      expect(msg).toMatch(/still being generated/i);
      // The failure this replaces: the model reads "not found", concludes its ref is wrong, and
      // invents a path. So the old wording must be GONE, not merely accompanied.
      expect(msg).not.toMatch(/not found/i);
      expect(msg).toMatch(/don't guess a file path|will be told when it lands/i);
    });

    it(`${name}: a FAILED generation says so instead of inviting a retry of the same ref`, async () => {
      const r = (await CALLS[name](FAILED)) as Any;
      const msg = String(r?.error ?? "");
      expect(msg).toMatch(/failed to generate/i);
      expect(msg).toContain("content filter"); // the provider's reason survives to the model
    });

    // UJ-014: "media not found" told the model its ref was wrong. The ref is right; the user's file
    // moved, and only the user can point the library at it again.
    it(`${name}: an OFFLINE linked file is offline, not unknown`, async () => {
      const r = (await CALLS[name](OFFLINE)) as Any;
      const msg = String(r?.error ?? "");
      expect(msg).toMatch(/offline/i);
      expect(msg).toContain("New Jeans.mp4");
      expect(msg).toMatch(/relink/i);
      expect(msg).not.toMatch(/not found|could not sample/i);
      // Never the user's folder layout: the model gets the library's name for it.
      expect(msg).not.toContain("iCloud Fotos");
    });

    // The direction that keeps the rule honest: a genuine typo must still read as a typo, or the
    // fix would just have swapped one misleading message for another.
    it(`${name}: an unknown ref still says it is unknown`, async () => {
      const r = (await CALLS[name]("media_typo")) as Any;
      const msg = String(r?.error ?? "");
      expect(msg).not.toMatch(/still being generated/i);
      expect(msg).toMatch(/not found|could not sample/i);
    });

    // The in-app agent is told when background media lands, and what it reads here must not change:
    // this is the sentence as it was before MCP had its own wording.
    it(`${name}: for the in-app agent the pending answer is the frozen sentence, with no structured status`, async () => {
      const r = (await CALLS[name](PENDING, "app")) as Any;
      expect(r.error).toBe(APP_PENDING);
      expect(r).not.toHaveProperty("pending");
      expect(r).not.toHaveProperty("retry_after_s");
    });

    // An MCP agent is never told. "You will be told when it lands" there is the sentence that made
    // one session poll 243 times, so it must be GONE and replaced by what a caller can act on.
    it(`${name}: over MCP a generating ref is a typed pending status, and says nothing will tell the caller`, async () => {
      const r = (await CALLS[name](PENDING, "mcp")) as Any;
      expect(r).toMatchObject({ pending: true, status: "generating" });
      expect(Number.isInteger(r.eta_s)).toBe(true);
      expect(r.eta_s).toBeGreaterThanOrEqual(10);
      expect(r.retry_after_s).toBeGreaterThanOrEqual(10);
      expect(r.retry_after_s).toBeLessThanOrEqual(60);
      const msg = String(r.error);
      expect(msg).toMatch(/still being generated/i);
      expect(msg).toMatch(/nothing will tell you/i);
      expect(msg).toContain(`${r.retry_after_s} s`);
      expect(msg).not.toMatch(/you will be told/i);
      expect(msg).not.toMatch(/not found/i);
      expect(msg).toMatch(/don't guess a file path/i);
    });

    // Only the wording of "still generating" differs by surface: a failed generation, an offline
    // file and a typo read the same to both, and carry no pending status.
    it(`${name}: over MCP a failed, offline or unknown ref is reported exactly as in the app`, async () => {
      for (const ref of [FAILED, OFFLINE, "media_typo"]) {
        const app = (await CALLS[name](ref, "app")) as Any;
        const mcp = (await CALLS[name](ref, "mcp")) as Any;
        expect(mcp.error, ref).toBe(app.error);
        expect(mcp, ref).not.toHaveProperty("pending");
      }
    });
  }
});
