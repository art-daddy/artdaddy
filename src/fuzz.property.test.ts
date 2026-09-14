// The validator-input fuzzer — hurls structured garbage + blind random JSON at
// every guard that faces untrusted input (a corrupted timeline.json, a model's
// hallucinated tool args, or raw ffprobe output) and asserts the STRICT contract:
//   - pure validators/normalizers NEVER throw (they are total functions), and
//   - tool dispatch ALWAYS resolves to { ok: boolean }, never throws/rejects.
// A crash here is a real bug: fix the guard, do not weaken the test. Runs on the
// unit lane, bounded + seeded so it is deterministic in CI.
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { clampArgs } from "./contract/clamp";
import { snapshotToolNames, toolParams } from "./contract/params";
import { clampTimelineValues } from "./timeline/clamp";
import { applyOp, normalizeTimeline } from "./timeline/engine";
import { validateTimeline } from "./timeline/validate";
import { parseProbe } from "./tools/media";
import { ProjectStoreAccess, joinPath } from "./tools/store";
import { createToolRegistry } from "./tools";
import { MemFs, registerTestDocument, resetTestDocuments } from "./test/timelineKit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Reset the injected open-document resolver after each test (the applyOp fuzz below registers a
// fresh document per run so it reads THAT run's corrupt timeline through the real edit path).
afterEach(resetTestDocuments);

const RUNS = { numRuns: 150, seed: 0x5eed } as const;

/** Fresh copy per run so an in-place normalizer can't corrupt fast-check shrinking. */
const clone = <T>(x: T): T => {
  try {
    return structuredClone(x);
  } catch {
    return JSON.parse(JSON.stringify(x ?? null)) as T;
  }
};

// ── garbage vocabulary ──────────────────────────────────────────────────────
const EDGE_NUMS = fc.constantFrom(
  0,
  -0,
  1,
  -1,
  NaN,
  Infinity,
  -Infinity,
  1e308,
  -1e308,
  1e-9,
  2 ** 53,
);
const EDGE_STRS = fc.constantFrom(
  "",
  " ",
  "abc",
  "0",
  "-3",
  "12.5",
  "00:05",
  "1:2:3",
  "1:2:3:4",
  "NaN",
  "1e9",
  "true",
);
const gLeaf = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  EDGE_NUMS,
  fc.string(),
  EDGE_STRS,
);
const gAny = fc.anything({ maxDepth: 3 }); // blind random JSON
const gField = fc.oneof(gLeaf, gAny);

// ── structured garbage: a timeline-shaped object with corrupted fields ───────
const CLIP_KEYS = [
  "kind",
  "media_ref",
  "timeline_in",
  "timeline_out",
  "source_in",
  "source_out",
  "speed",
  "opacity",
  "volume",
  "glow",
  "crop",
  "duck",
  "fade",
  "loop",
  "stretch",
  "transition_in",
  "link",
  "id",
  "z",
] as const;
const gClip = fc.oneof(fc.dictionary(fc.constantFrom(...CLIP_KEYS), gField), gLeaf, gAny);
const gClipArray = fc.array(gClip, { maxLength: 5 });
const gTrack = fc.oneof(
  fc.record(
    {
      id: fc.oneof(fc.string(), gLeaf),
      kind: fc.oneof(fc.constantFrom("video", "audio", "text", "bogus"), gLeaf),
      z: fc.oneof(fc.integer(), gLeaf),
      clips: fc.oneof(gClipArray, gField),
    },
    { requiredKeys: [] },
  ),
  gLeaf,
  gAny,
);
const gCanvas = fc.oneof(
  fc.record(
    {
      width: fc.oneof(fc.integer(), gLeaf),
      height: fc.oneof(fc.integer(), gLeaf),
      fps: fc.oneof(fc.integer({ min: -5, max: 240 }), fc.constantFrom(0, -1, 24, 30, NaN), gLeaf),
    },
    { requiredKeys: [] },
  ),
  gLeaf,
  gAny,
);
const gTimeline = fc.record(
  {
    units: fc.oneof(fc.constantFrom("frames", "seconds", "FRAMES", ""), gLeaf),
    canvas: gCanvas,
    tracks: fc.oneof(fc.array(gTrack, { maxLength: 4 }), gField),
  },
  { requiredKeys: [] },
);
// structured (weighted heavier — it reaches deeper code) + blind
const gTimelineInput = fc.oneof(gTimeline, gTimeline, gTimeline, gAny);

// ── structured garbage: an ffprobe JSON payload ──────────────────────────────
const gStream = fc.oneof(
  fc.record(
    {
      codec_type: fc.oneof(fc.constantFrom("video", "audio", "subtitle", "data"), gLeaf),
      codec_name: gField,
      width: gField,
      height: gField,
      r_frame_rate: fc.oneof(fc.constantFrom("30/1", "0/0", "abc", "", "30"), gLeaf),
      avg_frame_rate: fc.oneof(fc.constantFrom("30/1", "0/0", ""), gLeaf),
      pix_fmt: gField,
      sample_rate: gField,
      channels: gField,
      channel_layout: gField,
      side_data_list: fc.oneof(fc.array(gField, { maxLength: 3 }), gField),
      tags: fc.oneof(fc.dictionary(fc.string(), gField), gField),
      nb_frames: gField,
    },
    { requiredKeys: [] },
  ),
  gLeaf,
  gAny,
);
const gProbe = fc.oneof(
  fc.record(
    {
      format: fc.oneof(
        fc.record({ duration: gField, size: gField, format_name: gField }, { requiredKeys: [] }),
        gField,
      ),
      streams: fc.oneof(fc.array(gStream, { maxLength: 4 }), gField), // gField => a non-array `streams`
    },
    { requiredKeys: [] },
  ),
  gLeaf,
  gAny,
);
const safeStringify = (o: unknown): string => {
  const s = JSON.stringify(o);
  return s === undefined ? "null" : s;
};
const gProbeRaw = fc.oneof(
  gProbe.map(safeStringify),
  fc.string(),
  fc.constantFrom("", "null", "42", '"x"', "[]", "{}", "{bad json", "true", "[1,2,3]"),
);

// ── pure guards: must be total (never throw) ─────────────────────────────────
describe("fuzz: pure timeline guards never crash", () => {
  it("validateTimeline always returns string[]", () => {
    fc.assert(
      fc.property(gTimelineInput, (raw) => {
        const out = validateTimeline(clone(raw) as Any);
        expect(Array.isArray(out)).toBe(true);
        for (const e of out) expect(typeof e).toBe("string");
      }),
      RUNS,
    );
  });

  it("normalizeTimeline never throws and returns clamp notes", () => {
    fc.assert(
      fc.property(gTimelineInput, (raw) => {
        let out: unknown;
        expect(() => {
          out = normalizeTimeline(clone(raw) as Any);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
      }),
      RUNS,
    );
  });

  it("clampTimelineValues never throws", () => {
    fc.assert(
      fc.property(gTimelineInput, (raw) => {
        expect(() => clampTimelineValues(clone(raw) as Any)).not.toThrow();
      }),
      RUNS,
    );
  });

  it("clampArgs never throws for any tool name and args", () => {
    const names = snapshotToolNames();
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...(names.length ? names : ["x"]))),
        gField,
        (name, args) => {
          expect(() => clampArgs(name, clone(args) as Any)).not.toThrow();
        },
      ),
      RUNS,
    );
  });
});

// ── media-metadata parser: must be total ─────────────────────────────────────
describe("fuzz: media-metadata parser never crashes", () => {
  it("parseProbe returns a Result for any raw ffprobe output", () => {
    fc.assert(
      fc.property(gProbeRaw, (raw) => {
        let r: Any;
        expect(() => {
          r = parseProbe("src.mp4", raw);
        }).not.toThrow();
        expect(typeof r.ok).toBe("boolean");
      }),
      RUNS,
    );
  });
});

// ── the edit pipeline: a corrupted timeline.json must not crash a tool call ──
describe("fuzz: applyOp survives a corrupted timeline.json", () => {
  it("returns { ok: boolean }, never rejects, for any stored value", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Bias to VALID JSON (parseable) so we exercise the post-load guard +
        // normalize + validate path, not loadTimeline's retry backoff on junk.
        fc.oneof(
          gTimeline.map(safeStringify),
          gAny.map(safeStringify),
          fc.constantFrom("42", '"x"', "null", "[]", "true", "{}", "not json", ""),
        ),
        async (raw) => {
          const store = new ProjectStoreAccess("C:/fuzz", new MemFs());
          await store.writeTextAtomic(joinPath("C:/fuzz", "internals", "timeline.json"), raw);
          registerTestDocument("C:/fuzz"); // a FRESH document per run so applyOp reads THIS corrupt disk (crash-safe -> {ok:false})
          const r = (await applyOp(store, "fuzz_noop", () => {})) as Any;
          expect(r).toBeDefined();
          expect(typeof r.ok).toBe("boolean");
        },
      ),
      { numRuns: 60, seed: 0x5eed },
    );
  }, 20000);
});

// ── tool dispatch: crash-proof, always { ok: boolean } ───────────────────────
describe("fuzz: every tool dispatch is crash-proof", () => {
  let names: string[];
  let registry: ReturnType<typeof createToolRegistry>;

  beforeAll(() => {
    // ctx=null keeps this hermetic: tools bail before any disk/network IO, so we
    // exercise the dispatch boundary (+ any handler that reads args before its ctx
    // guard) with zero side effects. fetch is stubbed too, belt-and-suspenders.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in fuzz");
      }),
    );
    registry = createToolRegistry(() => null);
    names = registry.names();
  });
  afterAll(() => vi.unstubAllGlobals());

  it("covers a non-trivial set of tools", () => {
    expect(names.length).toBeGreaterThan(20);
  });

  it("resolves to { ok: boolean } for garbage args on every tool", async () => {
    for (const name of names) {
      const params = toolParams(name); // [] for tools with no snapshot entry
      const argGen = params.length
        ? fc.dictionary(fc.constantFrom(...params), gField)
        : fc.constant({});
      await fc.assert(
        fc.asyncProperty(argGen, async (args) => {
          const r = (await registry.run(name, clone(args) as Any)) as Any;
          expect(r).toBeDefined();
          expect(typeof r.ok).toBe("boolean");
        }),
        { numRuns: 25, seed: 0x5eed },
      );
    }
  });
});
