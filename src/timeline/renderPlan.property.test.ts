// Property tests for resolveRenderPlan — the shared IR both backends derive from. The direct unit tests
// (renderPlan.resolve.test.ts) pin resolved VALUES on fixed examples; these pin the structural INVARIANTS
// that examples can't cover, over random input: canonical clip order (both backends iterate it, so it
// must never diverge), the caption title-safe band, phrase-chunk window integrity, karaoke duration
// conservation, and the holdSec neighbour law. resolveRenderPlan takes a SECONDS-view timeline, so every
// time field here is SECONDS.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { resolveRenderPlan } from "./renderPlan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const secTL = (tracks: Any[], canvas: Any = {}): Timeline =>
  ({ canvas: { width: 1920, height: 1080, fps: 30, ...canvas }, tracks }) as Timeline;
const dbl = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

describe("resolveRenderPlan — canonical clip order (property)", () => {
  it("emits tracks in (z, then id) order, clips in input order, each track contiguous", () => {
    // Both the exporter and the preview iterate plan.clips WITHOUT re-sorting, so the plan's order is the
    // single authority. It must be: tracks by z then id.localeCompare (render.ts's sort), clips in their
    // track array order, and each track's clips contiguous (never interleaved with another track's).
    const trackGen = fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      z: fc.integer({ min: -3, max: 3 }),
      n: fc.integer({ min: 1, max: 4 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(trackGen, { minLength: 1, maxLength: 6, selector: (t) => t.id }),
        (specs) => {
          const tracks = specs.map((s) => ({
            id: s.id,
            kind: "video",
            z: s.z,
            clips: Array.from({ length: s.n }, (_, i) => ({
              kind: "video",
              media_ref: `${s.id}#${i}`,
              timeline_in: i,
              timeline_out: i + 1,
            })),
          }));
          const plan = resolveRenderPlan(secTL(tracks));
          const expectedOrder = [...specs]
            .sort((a, b) => a.z - b.z || String(a.id).localeCompare(String(b.id)))
            .map((s) => s.id);
          // Distinct track blocks, in first-appearance order: dupes here would mean a track was interleaved.
          const blocks: string[] = [];
          for (const c of plan.clips)
            if (blocks[blocks.length - 1] !== c.srcTrackId) blocks.push(c.srcTrackId);
          expect(blocks).toEqual(expectedOrder);
          for (const id of expectedOrder) {
            const idxs = plan.clips
              .filter((c: Any) => c.srcTrackId === id)
              .map((c: Any) => Number(String(c.clipRef.media_ref).split("#")[1]));
            expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("resolveRenderPlan — caption title-safe band (property)", () => {
  it("clamps the vertical centre into [safeY, ch-safeY] and insets the wrap box by the safe margin", () => {
    // A positioned caption can request any y (incl. out of [0,1]); the plan must clamp its vertical centre
    // into the 5%-per-edge safe band so it can never sit in the outer margin, and the wrap box is the
    // canvas inset by the horizontal safe margin on both sides (so it always fits).
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: 4000 }),
        fc.integer({ min: 16, max: 4000 }),
        dbl(-5, 5),
        dbl(-5, 5),
        (w, h, py, px) => {
          const clip = {
            kind: "text",
            content: "Caption",
            timeline_in: 0,
            timeline_out: 2,
            transform: { position: { x: px, y: py } },
          };
          const t = resolveRenderPlan(
            secTL([{ id: "t", kind: "text", z: 0, clips: [clip] }], { width: w, height: h }),
          ).clips[0].text as Any;
          const cw = Math.trunc(w);
          const ch = Math.trunc(h);
          const safeY = Math.round(ch * 0.05);
          const safeX = Math.round(cw * 0.05);
          expect(t.cyPx).toBeGreaterThanOrEqual(safeY);
          expect(t.cyPx).toBeLessThanOrEqual(ch - safeY);
          expect(t.wPx).toBe(Math.max(1, cw - 2 * safeX));
          expect(t.wPx).toBeLessThanOrEqual(cw);
          expect(Number.isFinite(t.sizePx)).toBe(true);
          expect(t.sizePx).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("resolveRenderPlan — phrase-chunk windows (property)", () => {
  it("even-split chunks are ordered, contiguous, and exactly span [0, durSec]", () => {
    // A kinetic phrase-chunk caption shows one sub-phrase at a time; the windows must tile the clip with
    // no gap and no overlap, in order, covering exactly [0, durSec] — a drift here shows a chunk twice or
    // leaves the caption blank mid-clip.
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), dbl(0.1, 60), (n, durSec) => {
        const content = Array.from({ length: n }, (_, i) => ({ text: `p${i}` }));
        const clip = {
          kind: "text",
          content,
          animation: { build: "phrase-chunks" },
          timeline_in: 0,
          timeline_out: durSec,
        };
        const chunks = (
          resolveRenderPlan(secTL([{ id: "t", kind: "text", z: 0, clips: [clip] }])).clips[0]
            .text as Any
        ).chunks as Any[];
        expect(chunks).toHaveLength(n);
        expect(chunks[0].relInSec).toBeCloseTo(0, 6);
        expect(chunks[n - 1].relOutSec).toBeCloseTo(durSec, 6);
        for (let i = 0; i < n; i++) {
          expect(chunks[i].relOutSec).toBeGreaterThan(chunks[i].relInSec);
          expect(chunks[i].relInSec).toBeGreaterThanOrEqual(-1e-9);
          expect(chunks[i].relOutSec).toBeLessThanOrEqual(durSec + 1e-9);
          if (i > 0) expect(chunks[i].relInSec).toBeCloseTo(chunks[i - 1].relOutSec, 6);
        }
      }),
      { numRuns: 250 },
    );
  });
});

describe("resolveRenderPlan — karaoke durations (property)", () => {
  it("even-split word durations are >=1cs and sum to ~durSec within rounding slack", () => {
    // A word-highlight \k line's syllable durations must cover the clip: each >= 1cs, and the sum equals
    // durSec (in centiseconds) up to the per-word rounding slack (<= n/2 cs). durSec >= 1 keeps every
    // word's share >= 5cs, so the max(1,...) floor never distorts the sum.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), dbl(1, 60), (n, durSec) => {
        const content = Array.from({ length: n }, (_, i) => ({ text: `w${i}` }));
        const clip = {
          kind: "text",
          content,
          animation: { build: "word-highlight" },
          timeline_in: 0,
          timeline_out: durSec,
        };
        const k = (
          resolveRenderPlan(secTL([{ id: "t", kind: "text", z: 0, clips: [clip] }])).clips[0]
            .text as Any
        ).karaoke as Any[];
        expect(k).toHaveLength(n);
        for (const s of k) expect(s.durCs).toBeGreaterThanOrEqual(1);
        const sum = k.reduce((a, s) => a + s.durCs, 0);
        expect(Math.abs(sum - durSec * 100)).toBeLessThanOrEqual(n / 2 + 1e-9);
      }),
      { numRuns: 250 },
    );
  });
});

describe("resolveRenderPlan — holdSec neighbour law (property)", () => {
  it("hold is 0 across a gap or a transition-less neighbour, non-negative otherwise, and 0 for the last clip", () => {
    // holdSec keeps a clip on-canvas under the NEXT same-track clip's centred incoming transition. It is
    // the straddle only when the neighbour actually transitions AND abuts/overlaps; a gap or a plain cut
    // means no hold. The last clip (no follower) never holds. Both backends read this one number.
    fc.assert(
      fc.property(
        dbl(1, 20),
        fc.boolean(),
        dbl(0.2, 4),
        fc.boolean(),
        dbl(0, 4),
        (a, hasTr, dur, gap, amt) => {
          const bIn = gap ? a + (amt + 0.01) : Math.max(0, a - amt);
          const c2: Any = {
            kind: "video",
            media_ref: "b.mp4",
            timeline_in: bIn,
            timeline_out: bIn + 5,
          };
          if (hasTr) c2.transition_in = { kind: "crossfade", duration: dur };
          const c1 = { kind: "video", media_ref: "a.mp4", timeline_in: 0, timeline_out: a };
          const [h1, h2] = resolveRenderPlan(
            secTL([{ id: "v", kind: "video", z: 0, clips: [c1, c2] }]),
          ).clips.map((c: Any) => c.visibility.holdSec);
          expect(h1).toBeGreaterThanOrEqual(0);
          expect(h2).toBe(0); // last clip has no follower
          if (!hasTr) expect(h1).toBe(0);
          else if (bIn - a > 1e-4)
            expect(h1).toBe(0); // gap beyond EPS
          else expect(h1).toBeCloseTo(Math.max(0, bIn + dur / 2 - a), 6);
        },
      ),
      { numRuns: 300 },
    );
  });
});
