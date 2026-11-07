import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  codecLabel,
  heavierSource,
  LookStats,
  reportLook,
  sourceFacts,
  type FrameMode,
  type FrameStat,
  type LookReport,
} from "./lookReport";

/** A look on a clock the test moves by hand. */
function clocked(tool: "inspect_media" | "inspect_timeline" = "inspect_media") {
  let t = 1_000;
  const stats = new LookStats(tool, () => t);
  return {
    stats,
    at: (ms: number) => {
      t = 1_000 + ms;
    },
  };
}

const MODES: FrameMode[] = ["cached", "software", "gpu", "retried", "failed"];
const frame = (mode: FrameMode, ms = 100, extra: Partial<FrameStat> = {}): FrameStat => ({
  mode,
  ms,
  ...extra,
});

describe("what a look reports", () => {
  it("says where each frame came from and how long the slowest took", () => {
    const { stats, at } = clocked();
    stats.plan(6);
    stats.framesBegin();
    for (const f of [
      frame("cached", 3),
      frame("software", 900),
      frame("gpu", 400),
      frame("gpu", 450),
      frame("retried", 7_000),
      frame("failed", 12_000),
    ])
      stats.frame(f);
    at(13_500);
    stats.framesEnd();
    at(14_000);
    expect(stats.finish()).toMatchObject({
      tool: "inspect_media",
      outcome: "partial",
      ms: 14_000,
      frames_ms: 13_500,
      slowest_ms: 12_000,
      frames: 6,
      cached: 1,
      gpu: 2,
      retried: 1,
      failed: 1,
    });
  });

  it("is done when every frame was made, partial when some were not, failed when none was", () => {
    const outcome = (modes: FrameMode[], asked = modes.length) => {
      const { stats } = clocked();
      stats.plan(asked);
      for (const m of modes) stats.frame(frame(m));
      return stats.finish().outcome;
    };
    expect(outcome(["software", "gpu", "cached"])).toBe("done");
    expect(outcome(["software", "failed"])).toBe("partial");
    expect(outcome(["failed", "failed"])).toBe("failed");
    expect(outcome([], 3)).toBe("failed"); // asked for frames, made none
    expect(outcome([])).toBe("failed"); // nothing asked, nothing made
  });

  it("counts a frame that was never reported as a frame that did not come to exist", () => {
    const { stats } = clocked();
    stats.plan(4);
    stats.frame(frame("software"));
    stats.frame(frame("gpu"));
    expect(stats.finish()).toMatchObject({ frames: 4, failed: 2, outcome: "partial" });
  });

  it("is stopped when the person pressed Stop, whatever else happened", () => {
    const { stats } = clocked();
    stats.plan(3);
    stats.frame(frame("software"));
    stats.stopped();
    expect(stats.finish().outcome).toBe("stopped");
  });

  it("does not count a reused file as slow, and a failed frame that took a minute as exactly that", () => {
    const { stats } = clocked();
    stats.plan(2);
    stats.frame(frame("cached", 90_000)); // nonsense for a cache hit; it must not set the slowest
    stats.frame(frame("failed", 60_000));
    expect(stats.finish().slowest_ms).toBe(60_000);
    const none = clocked();
    none.stats.plan(1);
    none.stats.frame(frame("cached", 50));
    expect(none.stats.finish().slowest_ms).toBe(0);
  });

  it("takes the source facts from the slowest frame that has them, else the look's own", () => {
    const hevc = { codec: "hevc", width: 3840, height: 2160, kbps: 80_000 };
    const h264 = { codec: "h264", width: 1280, height: 720 };
    const { stats } = clocked("inspect_timeline");
    stats.plan(3);
    stats.source({ codec: "own", width: 1, height: 1 });
    stats.frame(frame("software", 100, { source: h264 }));
    stats.frame(frame("gpu", 5_000, { source: hevc }));
    stats.frame(frame("software", 9_000)); // slowest, but it says nothing about its source
    expect(stats.finish().source).toEqual(hevc);
    const plain = clocked();
    plain.stats.plan(1);
    plain.stats.source({ codec: "own" });
    plain.stats.frame(frame("software", 10));
    expect(plain.stats.finish().source).toEqual({ codec: "own" });
  });

  it("says the most sources any one frame opened", () => {
    const { stats } = clocked("inspect_timeline");
    stats.plan(3);
    stats.frame(frame("software", 1, { layers: 2 }));
    stats.frame(frame("software", 1, { layers: 5 }));
    stats.frame(frame("software", 1)); // none said: one
    expect(stats.finish().layers).toBe(5);
  });

  it("measures the frame phase from the first start to the last end, not the sum of the lanes", () => {
    const { stats, at } = clocked();
    stats.plan(2);
    at(1_000);
    stats.framesBegin();
    at(1_200);
    stats.framesBegin(); // a second lane starting later changes nothing
    at(3_000);
    stats.framesEnd();
    at(3_500);
    expect(stats.finish()).toMatchObject({ ms: 3_500, frames_ms: 2_000 });
  });

  it("has no frame phase when frames never started, and ends it at the report when it never ended", () => {
    const none = clocked();
    none.at(500);
    expect(none.stats.finish().frames_ms).toBe(0);
    const open = clocked();
    open.stats.plan(1);
    open.at(100);
    open.stats.framesBegin();
    open.at(900);
    expect(open.stats.finish().frames_ms).toBe(800);
  });

  it("is said once: a later frame or call changes nothing", () => {
    const { stats } = clocked();
    stats.plan(1);
    stats.frame(frame("software", 10));
    const first = stats.finish();
    stats.frame(frame("failed", 99_999));
    stats.stopped();
    stats.plan(50);
    expect(stats.finish()).toBe(first);
    expect(first).toMatchObject({ frames: 1, failed: 0, outcome: "done" });
  });

  it("touched is false until the look asked for or made a frame", () => {
    const { stats } = clocked();
    expect(stats.touched).toBe(false);
    stats.plan(2);
    expect(stats.touched).toBe(true);
    const made = clocked();
    made.stats.frame(frame("software"));
    expect(made.stats.touched).toBe(true);
  });
});

describe("the report is always a well-formed one, whatever it is fed", () => {
  const stat = fc.record({
    mode: fc.constantFrom<FrameMode>(...MODES),
    ms: fc.oneof(
      fc.integer({ min: -1e6, max: 1e9 }),
      fc.double({ noNaN: false }),
      fc.constant(NaN),
    ),
    layers: fc.option(fc.oneof(fc.integer({ min: -3, max: 12 }), fc.constant(NaN)), {
      nil: undefined,
    }),
  });

  it("partitions the frames, keeps every number a non-negative whole number and agrees with its outcome", () => {
    fc.assert(
      fc.property(
        fc.array(stat, { maxLength: 60 }),
        fc.integer({ min: 0, max: 80 }),
        fc.boolean(),
        (stats, asked, halted) => {
          const { stats: look } = clocked();
          look.plan(asked);
          for (const s of stats) look.frame(s as FrameStat);
          if (halted) look.stopped();
          const r = look.finish();
          const numbers = [
            r.ms,
            r.frames_ms,
            r.slowest_ms,
            r.frames,
            r.cached,
            r.gpu,
            r.retried,
            r.failed,
            r.layers,
          ];
          expect(numbers.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
          expect(r.frames).toBe(Math.max(asked, stats.length));
          // every frame is exactly one of: reused, GPU, retried, failed, or made in software
          const software = stats.filter((s) => s.mode === "software").length;
          expect(r.cached + r.gpu + r.retried + r.failed + software).toBe(r.frames);
          const made = r.frames - r.failed;
          if (halted) expect(r.outcome).toBe("stopped");
          else if (made === 0) expect(r.outcome).toBe("failed");
          else expect(r.outcome).toBe(r.failed === 0 ? "done" : "partial");
          const fresh = stats
            .filter((s) => s.mode !== "cached")
            .map((s) => (Number.isFinite(s.ms) ? Math.max(0, Math.round(s.ms)) : 0));
          expect(r.slowest_ms).toBe(fresh.length ? Math.max(...fresh) : 0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never shows a negative time when the clock jumps back", () => {
    let t = 10_000;
    const look = new LookStats("inspect_media", () => t);
    look.plan(1);
    look.framesBegin();
    t = 4_000; // the system clock stepped back an hour mid-look
    look.framesEnd();
    const r = look.finish();
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.frames_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("the facts of a source", () => {
  const probe = {
    ok: true,
    duration_s: 600.4,
    size_bytes: 750_000_000,
    video: { codec: "hevc", width: 1080, height: 1920 },
  };

  it("are rounded from the probe the look already ran", () => {
    // 750 MB over 600.4 s is about 9,993 kilobits a second
    expect(sourceFacts(probe)).toEqual({
      codec: "hevc",
      width: 1080,
      height: 1920,
      dur_s: 600,
      kbps: 9993,
    });
  });

  it("say nothing they do not know: no data rate without both size and length, nothing at all from an empty probe", () => {
    expect(sourceFacts({ video: { codec: "h264", width: 640, height: 360 } })).toEqual({
      codec: "h264",
      width: 640,
      height: 360,
    });
    expect(sourceFacts({ ok: false, error: "ffprobe produced no output" })).toBeUndefined();
    for (const junk of [null, undefined, 5, "x", [], {}]) expect(sourceFacts(junk)).toBeUndefined();
  });

  it("never carry a path or a sentence as a codec", () => {
    for (const bad of [
      "C:\\Users\\me\\holiday.mp4",
      "/home/me/holiday.mp4",
      "my holiday video",
      "x".repeat(21),
      "",
      "../x",
      "h264; rm -rf",
    ])
      expect(codecLabel(bad)).toBeUndefined();
    for (const good of ["hevc", "h264", "av1", "prores", "pcm_s16le", "mpeg4", "vp9", "H264"])
      expect(codecLabel(good)).toBe(good.toLowerCase());
  });

  it("fuzz: no text makes a codec that is anything but a short name, and no legitimate name is dropped", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (text) => {
        const label = codecLabel(text);
        if (label !== undefined) expect(label).toMatch(/^[a-z0-9][a-z0-9_.-]{0,19}$/);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,19}$/), (name) => {
        expect(codecLabel(name)).toBe(name);
      }),
      { numRuns: 200 },
    );
  });

  it("prefer the source with more pixels, and keep the first on a tie or when sizes are unknown", () => {
    const small = { codec: "h264", width: 640, height: 360 };
    const big = { codec: "hevc", width: 3840, height: 2160 };
    expect(heavierSource(small, big)).toBe(big);
    expect(heavierSource(big, small)).toBe(big);
    expect(heavierSource(small, { ...small, codec: "other" })).toBe(small);
    expect(heavierSource(undefined, big)).toBe(big);
    expect(heavierSource(big, undefined)).toBe(big);
    expect(heavierSource(undefined, undefined)).toBeUndefined();
    const unknown = { codec: "x" };
    expect(heavierSource(unknown, { codec: "y" })).toBe(unknown);
  });
});

describe("reporting a look", () => {
  it("hands the sink the report once, when the look did something", () => {
    const seen: LookReport[] = [];
    const { stats } = clocked();
    stats.plan(1);
    stats.frame(frame("software"));
    reportLook({ look: (r) => seen.push(r) }, stats);
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe("done");
  });

  it("says nothing for a look that never asked for or made a frame (an error before it began, an audio file)", () => {
    const seen: LookReport[] = [];
    reportLook({ look: (r) => seen.push(r) }, clocked().stats);
    expect(seen).toEqual([]);
  });

  it("says stopped when the turn's signal is aborted by the time the look ends", () => {
    const seen: LookReport[] = [];
    const { stats } = clocked();
    stats.plan(2);
    stats.frame(frame("software"));
    const stop = new AbortController();
    stop.abort();
    reportLook({ look: (r) => seen.push(r) }, stats, stop.signal);
    expect(seen[0].outcome).toBe("stopped");
  });

  it("never lets a sink that throws, or no sink at all, cost the look anything", () => {
    const { stats } = clocked();
    stats.plan(1);
    stats.frame(frame("software"));
    expect(() =>
      reportLook(
        {
          look: () => {
            throw new Error("sink exploded");
          },
        },
        stats,
      ),
    ).not.toThrow();
    expect(() => reportLook({}, clocked().stats)).not.toThrow();
  });
});
