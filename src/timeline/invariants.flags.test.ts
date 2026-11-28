// The consistency checks (invariants.ts) are how the property test and the eval oracle say "this edit
// left the timeline broken". They used to be run on GOOD timelines only, so a check that had stopped
// noticing anything still passed (mutation testing, 26 Nov: 42% of planted bugs caught). Each case below
// is a timeline a person would see as broken (two clips on top of each other, picture and sound
// drifting apart, a clip starting before the timeline does, a keyframe that plays backwards), and the
// battery must name exactly that problem. Beside it is the nearest LEGITIMATE timeline (abutting clips,
// a J/L cut, a lone link member, a value right on its limit), which must not be flagged: a check that
// cries wolf hides the real reports just as well as one that stays silent.
import { describe, expect, it } from "vitest";

import { ANIM_PROPS, writeAnim } from "./animProps";
import {
  clipsSorted,
  framesOk,
  keyframesMonotonic,
  linkLockOk,
  linkRefsOk,
  noBadOverlaps,
  scalarsInBounds,
  sourceSpansOk,
  TIMELINE_INVARIANTS,
  timelineInvariantViolations,
  trackKindOk,
  uniqueClipIds,
} from "./invariants";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const clip = (over: Any = {}): Any => ({
  id: "c1",
  kind: "video",
  media_ref: "a.mp4",
  timeline_in: 0,
  timeline_out: 60,
  source_in: 0,
  source_out: 60,
  ...over,
});
const track = (id: string, kind: string, clips: Any[], over: Any = {}): Any => ({
  id,
  kind,
  z: 0,
  clips,
  ...over,
});
const tl = (...tracks: Any[]): Timeline =>
  ({ units: "frames", canvas: { width: 1920, height: 1080, fps: 30 }, tracks }) as Timeline;
/** One clip alone on a video track: the smallest timeline that can carry a broken clip. */
const lone = (over: Any): Timeline => tl(track("v1", "video", [clip(over)]));

/** The battery's own name for a check, so a reworded label cannot strand these cases. */
const label = (fn: (t: Timeline) => boolean): string => {
  const entry = TIMELINE_INVARIANTS.find(([, f]) => f === fn);
  if (!entry) throw new Error(`${fn.name} is not in TIMELINE_INVARIANTS`);
  return entry[0];
};

/** A broken timeline, and the ONE check that must name it. */
type Broken = [what: string, timeline: Timeline, check: (t: Timeline) => boolean];

const BROKEN: Broken[] = [
  // ── clips on top of each other / without length ────────────────────────────────────────────
  [
    "two clips on one track overlap",
    tl(
      track("v1", "video", [
        clip({ id: "a" }),
        clip({ id: "b", timeline_in: 30, timeline_out: 90 }),
      ]),
    ),
    noBadOverlaps,
  ],
  ["a clip with no length", lone({ timeline_in: 30, timeline_out: 30 }), noBadOverlaps],
  ["a clip that ends before it starts", lone({ timeline_in: 60, timeline_out: 30 }), noBadOverlaps],
  // ── picture and sound of one source drifting apart (t008) ──────────────────────────────────
  [
    "a video and its own audio, linked, of different lengths",
    tl(
      track("v1", "video", [clip({ id: "v", media_ref: "m.mp4", link_group: "g" })]),
      track("a1", "audio", [
        clip({ id: "a", kind: "audio", media_ref: "m.mp4", link_group: "g", timeline_out: 30 }),
      ]),
    ),
    linkLockOk,
  ],
  [
    "a video and its own audio, linked, playing at different speeds",
    tl(
      track("v1", "video", [clip({ id: "v", media_ref: "m.mp4", link_group: "g", speed: 1 })]),
      track("a1", "audio", [
        clip({
          id: "a",
          kind: "audio",
          media_ref: "m.mp4",
          link_group: "g",
          speed: 2,
          source_out: 120,
        }),
      ]),
    ),
    linkLockOk,
  ],
  // ── a link that points at nothing a person could find again ────────────────────────────────
  ["a link group that is an empty name", lone({ link_group: "" }), linkRefsOk],
  ["a link group that is a number, not a name", lone({ link_group: 42 }), linkRefsOk],
  // ── positions a frame-based timeline cannot hold ───────────────────────────────────────────
  [
    "a clip that starts before the timeline",
    lone({ timeline_in: -30, timeline_out: 30 }),
    framesOk,
  ],
  ["a start between two frames", lone({ timeline_in: 10.5 }), framesOk],
  ["an end between two frames", lone({ timeline_out: 59.5 }), framesOk],
  ["a source in-point between two frames", lone({ source_in: 0.5 }), framesOk],
  ["a source out-point between two frames", lone({ source_out: 59.5 }), framesOk],
  // ── a window that shows no footage ─────────────────────────────────────────────────────────
  ["a source window with no frames in it", lone({ source_in: 40, source_out: 40 }), sourceSpansOk],
  ["a source window that runs backwards", lone({ source_in: 40, source_out: 10 }), sourceSpansOk],
  // ── two clips the agent cannot tell apart ──────────────────────────────────────────────────
  [
    "two clips on different tracks with the same id",
    tl(track("v1", "video", [clip({ id: "same" })]), track("v2", "video", [clip({ id: "same" })])),
    uniqueClipIds,
  ],
  // ── a clip on a track that cannot play it ──────────────────────────────────────────────────
  [
    "an audio clip on a video track",
    tl(track("v1", "video", [clip({ kind: "audio", media_ref: "m.mp3" })])),
    trackKindOk,
  ],
  [
    "a video clip on an audio track",
    tl(track("a1", "audio", [clip({ kind: "video" })])),
    trackKindOk,
  ],
  // ── stored out of order (the pipeline sorts; a writer that skipped it is caught here) ──────
  [
    "clips stored in reverse order (none of them overlapping)",
    tl(
      track("v1", "video", [
        clip({ id: "c", timeline_in: 120, timeline_out: 180 }),
        clip({ id: "b", timeline_in: 60, timeline_out: 120 }),
        clip({ id: "a", timeline_in: 0, timeline_out: 60 }),
      ]),
    ),
    clipsSorted,
  ],
  // ── keyframes that play backwards or between frames ────────────────────────────────────────
  [
    "two keyframes at the same frame",
    lone({
      opacity: [
        { t: 5, v: 0 },
        { t: 5, v: 1 },
      ],
    }),
    keyframesMonotonic,
  ],
  [
    "a keyframe between two frames",
    lone({
      opacity: [
        { t: 0, v: 0 },
        { t: 2.5, v: 1 },
      ],
    }),
    keyframesMonotonic,
  ],
  ["a keyframe before the clip starts", lone({ opacity: [{ t: -1, v: 0 }] }), keyframesMonotonic],
  ["a keyframe that is not a keyframe", lone({ opacity: [null] }), keyframesMonotonic],
  // ── settings past what the renderer can do ─────────────────────────────────────────────────
  ["opacity above 100%", lone({ opacity: 1.5 }), scalarsInBounds],
  ["opacity below 0%", lone({ opacity: -0.1 }), scalarsInBounds],
  ["a negative volume", lone({ volume: -1 }), scalarsInBounds],
  ["glow above 100", lone({ glow: 150 }), scalarsInBounds],
  ["a glow amount above 100", lone({ glow: { amount: 150, opacity: 0.5 } }), scalarsInBounds],
  ["a glow opacity above 100%", lone({ glow: { amount: 50, opacity: 2 } }), scalarsInBounds],
  ["a crop that leaves no width", lone({ crop: { left: 0.5, right: 0.5 } }), scalarsInBounds],
  ["a crop that leaves no height", lone({ crop: { top: 0.6, bottom: 0.5 } }), scalarsInBounds],
  ["a ducking ratio below 1", lone({ duck: { ratio: 0.5, threshold: 0.1 } }), scalarsInBounds],
  [
    "a ducking threshold of nothing",
    lone({ duck: { ratio: 4, threshold: 0.0001 } }),
    scalarsInBounds,
  ],
  [
    "a ducking threshold above full scale",
    lone({ duck: { ratio: 4, threshold: 1.5 } }),
    scalarsInBounds,
  ],
  [
    "a fade-in longer than the clip",
    lone({ timeline_in: 30, timeline_out: 90, fade: { in: 61, out: 0 } }),
    scalarsInBounds,
  ],
  [
    "a fade-out longer than the clip",
    lone({ timeline_in: 30, timeline_out: 90, fade: { in: 0, out: 61 } }),
    scalarsInBounds,
  ],
  ["a negative fade", lone({ fade: { in: -1, out: 0 } }), scalarsInBounds],
];

/** Timelines a person could really have made; none of them is broken. */
const FINE: Array<[what: string, timeline: Timeline]> = [
  [
    "clips that touch end to start",
    tl(
      track("v1", "video", [
        clip({ id: "a" }),
        clip({ id: "b", timeline_in: 60, timeline_out: 120 }),
      ]),
    ),
  ],
  [
    "a J/L cut: picture and its own sound of one length, the sound starting later",
    tl(
      track("v1", "video", [clip({ id: "v", media_ref: "m.mp4", link_group: "g" })]),
      track("a1", "audio", [
        clip({
          id: "a",
          kind: "audio",
          media_ref: "m.mp4",
          link_group: "g",
          timeline_in: 10,
          timeline_out: 70,
        }),
      ]),
    ),
  ],
  [
    "a video linked to a longer music bed from another file",
    tl(
      track("v1", "video", [clip({ id: "v", media_ref: "m.mp4", link_group: "g" })]),
      track("a1", "audio", [
        clip({
          id: "a",
          kind: "audio",
          media_ref: "song.mp3",
          link_group: "g",
          timeline_out: 200,
          source_out: 200,
        }),
      ]),
    ),
  ],
  ["a clip whose link partner was deleted", lone({ link_group: "g" })],
  ["a clip with no link (null)", lone({ link_group: null })],
  ["a still with no source window", lone({ kind: "image", source_in: null, source_out: null })],
  ["a clip with only a source in-point", lone({ source_out: undefined })],
  ["a clip with only a source out-point", lone({ source_in: undefined, source_out: 0 })],
  [
    "two clips without ids",
    tl(
      track("v1", "video", [
        clip({ id: undefined }),
        clip({ id: undefined, timeline_in: 60, timeline_out: 120 }),
      ]),
    ),
  ],
  [
    "each kind on a track that plays it",
    tl(
      track("v1", "video", [
        clip({ id: "v" }),
        clip({
          id: "i",
          kind: "image",
          timeline_in: 60,
          timeline_out: 90,
          source_in: undefined,
          source_out: undefined,
        }),
      ]),
      track("a1", "audio", [clip({ id: "a", kind: "audio", media_ref: "m.mp3" })]),
      track("t1", "text", [
        clip({
          id: "t",
          kind: "text",
          media_ref: undefined,
          source_in: undefined,
          source_out: undefined,
        }),
      ]),
    ),
  ],
  [
    "keyframes from the first frame on, in order",
    lone({
      opacity: [
        { t: 0, v: 0 },
        { t: 30, v: 1 },
      ],
    }),
  ],
  ["opacity at exactly 0% and a volume above 100%", lone({ opacity: 0, volume: 2 })],
  ["opacity at exactly 100%", lone({ opacity: 1 })],
  ["glow at exactly 100", lone({ glow: 100 })],
  ["a glow at its limits", lone({ glow: { amount: 100, opacity: 1 } })],
  ["a crop right at its limits", lone({ crop: { left: 0.49, right: 0.5, top: 0.98, bottom: 0 } })],
  ["a ducking threshold right at its floor", lone({ duck: { ratio: 1, threshold: 0.001 } })],
  [
    "fades as long as the clip itself",
    lone({ timeline_in: 30, timeline_out: 90, fade: { in: 60, out: 60 } }),
  ],
];

describe("the consistency checks name each kind of broken timeline", () => {
  it.each(BROKEN)("%s", (_what, timeline, check) => {
    expect(timelineInvariantViolations(timeline)).toEqual([label(check)]);
  });

  it("every check in the battery has a broken timeline above that it must name (a new check needs one)", () => {
    const witnessed = new Set(BROKEN.map(([, , check]) => check));
    const unwitnessed = TIMELINE_INVARIANTS.filter(([, fn]) => !witnessed.has(fn)).map(([l]) => l);
    expect(unwitnessed).toEqual([]);
  });

  it("a crop past the limit on ANY side is caught, not just the first one looked at", () => {
    for (const side of ["left", "top", "right", "bottom"]) {
      expect(timelineInvariantViolations(lone({ crop: { [side]: 0.99 } })), side).toEqual([
        label(scalarsInBounds),
      ]);
    }
  });

  it("an overlap is caught on every track, not only the first", () => {
    const t = tl(
      track("v1", "video", [clip({ id: "ok" })]),
      track("v2", "video", [
        clip({ id: "a" }),
        clip({ id: "b", timeline_in: 59, timeline_out: 120 }),
      ]),
    );
    expect(timelineInvariantViolations(t)).toEqual([label(noBadOverlaps)]);
  });

  it("an overlap between clips stored out of order is still caught, and both problems are named", () => {
    const t = tl(
      track("v1", "video", [
        clip({ id: "b", timeline_in: 30, timeline_out: 90 }),
        clip({ id: "a" }),
      ]),
    );
    expect(timelineInvariantViolations(t)).toEqual([label(noBadOverlaps), label(clipsSorted)]);
  });

  it("two clips starting on the same frame overlap but are not out of order", () => {
    const t = tl(
      track("v1", "video", [
        clip({ id: "a" }),
        clip({ id: "b", timeline_out: 30, source_out: 30 }),
      ]),
    );
    expect(timelineInvariantViolations(t)).toEqual([label(noBadOverlaps)]);
  });

  it("looking for overlaps leaves the track's clips in the order they were stored", () => {
    const stored = [
      clip({ id: "b", timeline_in: 60, timeline_out: 120 }),
      clip({ id: "a", timeline_in: 0, timeline_out: 60 }),
    ];
    const t = tl(track("v1", "video", stored));
    noBadOverlaps(t);
    expect(stored.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("the consistency checks do not flag a legitimate timeline", () => {
  it.each(FINE)("%s", (_what, timeline) => {
    expect(timelineInvariantViolations(timeline)).toEqual([]);
  });
});

describe("keyframes are checked on EVERY animatable property, wherever it lives on the clip", () => {
  // Five of the eight animatable properties live under clip.transform; a check that looked only at the
  // flat ones would pass every opacity test and never see a broken scale curve. Walked from the real
  // registry, so a property added there is checked here without anyone remembering to.
  const backwards = [
    { t: 10, v: 0.5 },
    { t: 5, v: 0.5 },
  ];
  const forwards = [
    { t: 0, v: 0.5 },
    { t: 30, v: 0.5 },
  ];
  const at = (path: string, curve: Any): Timeline => {
    const base = clip();
    return lone(writeAnim(base, path, curve));
  };

  it.each(ANIM_PROPS.map((p) => [p.path]))("a curve on %s that runs backwards is named", (path) => {
    expect(timelineInvariantViolations(at(path, backwards))).toEqual([label(keyframesMonotonic)]);
  });

  it.each(ANIM_PROPS.map((p) => [p.path]))("a curve on %s that runs forwards is fine", (path) => {
    expect(timelineInvariantViolations(at(path, forwards))).toEqual([]);
  });
});

describe("a malformed timeline is reported, never taken for a consistent one", () => {
  it("a track with no clip list, or a timeline with no tracks, holds nothing broken", () => {
    expect(timelineInvariantViolations(tl({ id: "v1", kind: "video" }))).toEqual([]);
    expect(timelineInvariantViolations({ canvas: { fps: 30 } } as unknown as Timeline)).toEqual([]);
  });

  it("a check that crashes on the document is reported as broken instead of crashing the oracle", () => {
    const known = new Set(TIMELINE_INVARIANTS.map(([l]) => l));
    const violations = timelineInvariantViolations(tl(null));
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) expect(known.has(v.replace(/ \(threw\)$/, "")), v).toBe(true);
    expect(violations).toContain(`${label(noBadOverlaps)} (threw)`);
  });
});
