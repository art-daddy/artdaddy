// Preview-side per-frame transition GATE (Commit-1). The exporter has a byte-identical filterComplex
// gate; the preview does not. When scene.ts routes through the plan, it converts the plan's SECONDS
// transition duration back to frames AT ITS OWN EDGE (there is deliberately no FramesRenderPlan twin) —
// and that rounding lands exactly on transition-window boundaries (tin-leadF .. tout+holdF) and on the
// progress value. A one-frame shift there would sail past "scene.test passes". So this freezes
// buildScene's per-frame transition output on the CURRENT (unwired) code; after wiring it re-runs
// WITHOUT -u and must be identical. Same corpus-first discipline as render.corpus.test.ts.
import { describe, expect, it } from "vitest";

import type { Timeline } from "../timeline/model";
import { buildScene } from "./scene";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FPS = 30;
const NO_DIMS = new Map<string, { w: number; h: number }>();

/** Two ABUTTING video clips on one track (A [0,30], B [30,60]); B carries the incoming transition of
 *  `kind` over `dur` FRAMES. This is the shape a centred transition + its outgoing hold require. */
function pair(kind: string, dur: number): Timeline {
  return {
    // units:"frames" is what a real timeline carries; the preview resolves the plan via toSecondsView,
    // which only converts when this is set. Without it the durations would be read as seconds.
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: FPS },
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            media_ref: "/a.mp4",
            kind: "video",
            source_in: 0,
            source_out: 30,
            timeline_in: 0,
            timeline_out: 30,
          },
          {
            id: "b",
            media_ref: "/b.mp4",
            kind: "video",
            source_in: 0,
            source_out: 30,
            timeline_in: 30,
            timeline_out: 60,
            transition_in: { kind, duration: dur },
          },
        ],
      },
    ],
  } as Timeline;
}

/** buildScene's transition-relevant projection at frame `f`: which layers are on-canvas (window
 *  membership) + each one's transition progress, dip solid-colour quad, and opacity. Rounded to 1e-6
 *  so genuine one-frame shifts show while IEEE noise does not. */
function projectAt(t: Timeline, f: number): Any {
  const scene = buildScene(t, f / FPS, NO_DIMS);
  return {
    f,
    layers: (scene.layers ?? []).map((l) => ({
      src: l.source,
      z: l.z,
      op: Math.round((l.opacity ?? 1) * 1e6) / 1e6,
      tr: l.transition
        ? { kind: l.transition.kind, p: Math.round(l.transition.p * 1e6) / 1e6 }
        : undefined,
      solid: l.solid ?? undefined,
    })),
  };
}

/** Sample every integer frame across (and just past) the centred transition window at the cut (f=30). */
function windowScan(t: Timeline, dur: number): Any[] {
  const out: Any[] = [];
  for (let f = 30 - dur - 1; f <= 30 + dur + 1; f++) out.push(projectAt(t, f));
  return out;
}

describe("preview transition per-frame gate (Commit-1)", () => {
  const cases: Array<[string, number]> = [
    ["crossfade", 10],
    ["crossfade", 7], // ODD dur -> leadF = 3.5: the exact fractional boundary seconds->frames rounding perturbs
    ["wipe-l", 10],
    ["wipe-r", 10],
    ["whip", 10],
    ["whip", 7],
    ["dip-to-black", 12],
    ["dip-to-white", 12],
  ];
  for (const [kind, dur] of cases) {
    it(`${kind} dur=${dur}: per-frame progress + window membership`, () => {
      expect(windowScan(pair(kind, dur), dur)).toMatchSnapshot();
    });
  }
});
