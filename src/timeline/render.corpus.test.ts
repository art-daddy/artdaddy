// Commit-1 byte-identical GATE for the renderPlan extraction (render parity).
//
// These snapshot the EXPORTER's `buildRenderCommand(...).filterComplex` for the thin, intricate
// paths the extraction is most likely to perturb: centred crossfade + tpad hold, speed + crossfade,
// Ken-Burns size animation recentre, blend modes, multi-track z-ordering, and text interleaved
// between video layers (which the CURRENT exporter composites LAST — a fact this snapshot pins so
// Commit 2's z-band fix is a visible, reviewed change, not a silent drift).
//
// DISCIPLINE (owner Q6): this file is frozen GREEN against the CURRENT code BEFORE the extraction.
// After the refactor it is re-run WITHOUT `-u`; any diff is proof the extraction changed export
// output, not a snapshot to bless. Existing render.test.ts snapshots must likewise stay untouched.
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A SECONDS-view timeline built from explicit tracks (so a single track can hold ABUTTING clips —
 *  the shape a crossfade + its outgoing hold require, which the per-clip `tl()` helper can't make). */
function timeline(tracks: Any[], canvas = { width: 1920, height: 1080, fps: 30 }): Timeline {
  return { canvas, tracks } as Timeline;
}
const vtrack = (id: string, z: number, clips: Any[]) => ({ id, kind: "video", z, clips });

const fc = (t: Timeline): string => buildRenderCommand(t, "/out.mp4").filterComplex;

describe("render corpus (Commit-1 byte-identical gate)", () => {
  it("centred crossfade + outgoing tpad hold (abutting same-track pair)", () => {
    // Clip A holds its last frame while B's incoming dissolve straddles the cut; B gets the front
    // lead-in. Exercises holdDur (derived from B's transition) + leadIn + the centred setpts offset.
    const t = timeline([
      vtrack("v", 0, [
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
        {
          media_ref: "/b.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 2,
          timeline_out: 4,
          transition_in: { kind: "crossfade", duration: 0.5 },
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });

  // Snapshot deliberately re-frozen once, and only here: a RETIMED clip now carries a one-frame
  // `stop_mode=clone` tail. Its retimed stream ended a fraction of a frame short of its slot, and
  // the black base showed through for the final frame — reproduced on real pixels in
  // speedTail.smoke.e2e.ts (last frame luma 16 against 235). The speed-1 entries above are
  // untouched, which is what confines the change to the clips that can have the gap.
  it("speed change combined with a centred crossfade", () => {
    // start_duration + stop_duration scale by speed; setpts divides by speed. The interaction of a
    // 2x clip with the lead-in pad is a classic off-by-a-factor site.
    const t = timeline([
      vtrack("v", 0, [
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
        {
          media_ref: "/b.mp4",
          source_in: 0,
          source_out: 4,
          timeline_in: 2,
          timeline_out: 4,
          speed: 2,
          transition_in: { kind: "crossfade", duration: 0.5 },
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });

  it("Ken-Burns size animation recentres the aspect-preserved clip in its box (cover)", () => {
    const t = timeline([
      vtrack("v", 0, [
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          fit: "cover",
          transform: {
            position: {
              x: [
                { t: 0, v: 0.5 },
                { t: 2, v: 0.55 },
              ],
              y: 0.5,
            },
            scale: [
              { t: 0, v: 1 },
              { t: 2, v: 1.2 },
            ],
          },
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });

  it("blend mode composites via the split/alphamerge chain", () => {
    const t = timeline([
      vtrack("bg", 0, [
        { media_ref: "/bg.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
      ]),
      vtrack("fg", 1, [
        {
          media_ref: "/fg.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          blend: "screen",
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });

  it("multi-track z-ordering stacks overlays low-z first", () => {
    const t = timeline([
      vtrack("hi", 2, [
        {
          media_ref: "/c.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transform: { position: { x: 0.7, y: 0.7 }, scale: 0.3 },
        },
      ]),
      vtrack("lo", 0, [
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
      ]),
      vtrack("mid", 1, [
        {
          media_ref: "/b.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transform: { position: { x: 0.5, y: 0.5 }, scale: 0.6 },
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });

  // z0 video, z1 caption, z2 video: the caption composites at its OWN z-band (a libass `ass` overlay),
  // so the higher-z video correctly paints OVER it — unlike the old drawtext path, which forced every
  // caption last (on top of everything, ignoring z). This is the one intended C2 exporter change.
  it("text composites at its z-band so a higher-z video overlays the caption (not drawtext-last)", () => {
    const t = timeline([
      vtrack("v0", 0, [
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
      ]),
      {
        id: "cap",
        kind: "text",
        z: 1,
        clips: [
          {
            kind: "text",
            text: "Lower third",
            timeline_in: 0,
            timeline_out: 2,
            style: { size: 64, color: "#ffffff", font: "Anton" },
            transform: { position: { x: 0.5, y: 0.85 } },
          },
        ],
      },
      vtrack("v2", 2, [
        {
          media_ref: "/b.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          transform: { position: { x: 0.5, y: 0.5 }, scale: 0.4 },
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });

  it("rotate + opacity animation + visual fade stack on one clip", () => {
    const t = timeline([
      vtrack("v", 0, [
        {
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 0,
          timeline_out: 2,
          rotate: [
            { t: 0, v: 0 },
            { t: 2, v: 90 },
          ],
          opacity: [
            { t: 0, v: 0.2 },
            { t: 2, v: 1 },
          ],
          fade: { in: 0.3, out: 0.3 },
        },
      ]),
    ]);
    expect(fc(t)).toMatchSnapshot();
  });
});

describe("render corpus (Commit-2 transition exports)", () => {
  // NEW behavior, NOT frozen-on-old: wipe/whip/dip now render as spatially-varying geq masks (and,
  // for dip, a full-canvas colour flash overlaid between the outgoing and incoming clips), all centred
  // on the cut like the crossfade. These snapshots are drift canaries for the emitted graph; the
  // distinctive per-kind mask expression is asserted directly in render.test.ts.
  const pair = (kind: string) =>
    timeline([
      vtrack("v", 0, [
        { media_ref: "/a.mp4", source_in: 0, source_out: 2, timeline_in: 0, timeline_out: 2 },
        {
          media_ref: "/b.mp4",
          source_in: 0,
          source_out: 2,
          timeline_in: 2,
          timeline_out: 4,
          transition_in: { kind, duration: 0.5 },
        },
      ]),
    ]);
  for (const kind of ["wipe-l", "wipe-r", "whip", "dip-to-black", "dip-to-white"]) {
    it(`${kind} renders a centred spatial/colour transition`, () => {
      expect(fc(pair(kind))).toMatchSnapshot();
    });
  }
});
