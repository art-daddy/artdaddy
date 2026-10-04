// UJ-026: the export draws each clip on exactly the frames the preview draws it on.
//
// The export gates every clip with an ffmpeg `between(t,lo,hi)`. A bound printed to six places
// sat a hair off its own frame time, so a gate AT a frame was decided by rounding: about 2 cuts in
// 3 at 24/30/60 fps showed a black frame or skipped the incoming clip's first frame. The pixel
// proof is exportFrames.smoke.e2e.ts; these are the same rules, fast, over many more timelines.
// Gates are evaluated the way ffmpeg evaluates them: t = pts * (1/fps), both ends inclusive.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand, frameGate } from "./render";
import { framesOf, resolveRenderPlan } from "./renderPlan";
import { toSecondsView } from "./frames";
import { buildScene } from "../preview/scene";
import { visibleClips } from "../tools/inspect";

/** Whether ffmpeg opens a `between(t,lo,hi)` gate on frame k. */
function opensAt(gate: string, k: number, fps: number): boolean {
  const m = /^between\(t,(-?[\d.]+),(-?[\d.]+)\)$/.exec(gate);
  if (!m) throw new Error(`not a gate: ${gate}`);
  const t = k * (1 / fps);
  return t >= Number(m[1]) && t <= Number(m[2]);
}

describe("frameGate", () => {
  it("opens on exactly frames first..end-1, at any fps and frame number", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 240 }),
        fc.integer({ min: -100_000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (fps, first, len) => {
          const end = first + len;
          const gate = frameGate(first, end, fps);
          for (const k of [first - 2, first - 1, first, first + 1, end - 2, end - 1, end, end + 1])
            expect(opensAt(gate, k, fps), `${gate} at frame ${k}`).toBe(k >= first && k < end);
        },
      ),
    );
  });
});

describe("framesOf", () => {
  it("counts the frames with from <= k/fps < to, on spans built the way the plan builds them", () => {
    // The plan works in seconds: a clip starts at tin/fps less half its transition, and ends at
    // tout/fps plus half of the next clip's. Either half can be a half frame.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 240 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 600 }),
        (fps, tin, len, lead, hold) => {
          const tout = tin + len;
          const span = { from: tin / fps - lead / fps / 2, to: tout / fps + hold / fps / 2 };
          expect(framesOf(span, fps)).toEqual({
            first: tin - Math.floor(lead / 2),
            end: tout + Math.ceil(hold / 2),
          });
        },
      ),
    );
  });
});

type Spec = { len: number; kind: string; dur: number };

/** Abutting clips on one track from frame `start`, each but the first optionally transitioning
 *  in. Frames view, the shape the editor stores. */
function timelineOf(fps: number, start: number, specs: Spec[]): Timeline {
  let t = start;
  const clips = specs.map((s, i) => {
    const c = {
      id: `c${i}`,
      kind: "video",
      media_ref: `/c${i}.mp4`,
      timeline_in: t,
      timeline_out: t + s.len,
      source_in: 0,
      source_out: s.len,
      ...(i > 0 && s.kind !== "none" ? { transition_in: { kind: s.kind, duration: s.dur } } : {}),
    };
    t += s.len;
    return c;
  });
  return {
    units: "frames",
    canvas: { width: 64, height: 64, fps },
    tracks: [{ id: "v0", kind: "video", z: 0, clips }],
  } as unknown as Timeline;
}

/** For each frame: the clips the export's overlays are open on, and how many dip colours. */
function exportGates(timeline: Timeline) {
  const plan = buildRenderCommand(timeline, "/o.mp4");
  const chains = plan.filterComplex.split(";");
  const inputOf = new Map<number, number>();
  for (const c of chains) {
    const m = /^\[(\d+):v\].*\[v(\d+)\]$/.exec(c);
    if (m) inputOf.set(Number(m[2]), Number(m[1]));
  }
  const clipGates: { clipId: string; gate: string }[] = [];
  const dipGates: string[] = [];
  for (const c of chains) {
    const v = /\[v(\d+)\]overlay=.*enable='(between\(t,[^']+\))'/.exec(c);
    if (v) {
      const idx = inputOf.get(Number(v[1]));
      expect(idx, `no input for v${v[1]}`).toBeDefined();
      clipGates.push({ clipId: plan.sources[idx!].clipId, gate: v[2] });
    }
    const d = /\[dip\d+\]overlay=.*enable='(between\(t,[^']+\))'/.exec(c);
    if (d) dipGates.push(d[1]);
  }
  return { clipGates, dipGates };
}

describe("the export draws each clip on the frames the preview and inspect_timeline do", () => {
  it("cuts at every residue, odd and even transitions of every kind, at 24/25/30/60 fps", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(24, 25, 30, 60),
        fc.integer({ min: 0, max: 9 }),
        fc.array(
          fc.record({
            len: fc.integer({ min: 2, max: 24 }),
            kind: fc.constantFrom("none", "crossfade", "dip-to-black", "dip-to-white", "wipe-l"),
            dur: fc.integer({ min: 1, max: 12 }),
          }),
          { minLength: 2, maxLength: 5 },
        ),
        (fps, start, specs) => {
          const timeline = timelineOf(fps, start, specs);
          const { clipGates, dipGates } = exportGates(timeline);
          const look = resolveRenderPlan(toSecondsView(timeline));
          const total = start + specs.reduce((n, s) => n + s.len, 0);
          // Only the timeline's own frames: the export has none after its end.
          for (let k = 0; k < total; k++) {
            const exported = clipGates
              .filter((g) => opensAt(g.gate, k, fps))
              .map((g) => `/${g.clipId}.mp4`)
              .sort();
            const layers = buildScene(timeline, k / fps, new Map()).layers;
            const previewed = layers
              .filter((l) => l.source !== "")
              .map((l) => l.source)
              .sort();
            expect(exported, `frame ${k}: export vs preview`).toEqual(previewed);
            const inspected = visibleClips(look, k, fps)
              .map((id) => `/${id}.mp4`)
              .sort();
            expect(inspected, `frame ${k}: inspect_timeline vs export`).toEqual(exported);
            const dips = dipGates.filter((g) => opensAt(g, k, fps)).length;
            const solids = layers.filter((l) => l.source === "").length;
            expect(dips, `frame ${k}: dip colour`).toBe(solids);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
