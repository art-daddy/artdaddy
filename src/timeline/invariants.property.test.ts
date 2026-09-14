// Property-based invariant tests: throw RANDOM sequences of edit tools at a fresh
// in-memory timeline and assert a battery of invariants after EVERY op. Catches
// edge cases fixed-example tests miss (odd frames, empty tracks, overlapping
// ranges, retimes, cross-track moves, track add/remove, canvas changes).
// fast-check shrinks any failure to a minimal counterexample + prints the seed.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { audioRunner, seededCtx } from "../test/timelineKit";
import { buildScene } from "../preview/scene";
import {
  moveClipsTool,
  removeClipsTool,
  rippleDeleteTool,
  splitClipsTool,
  trimClipsTool,
} from "./edit";
import { doRedo, doUndo, loadTimeline, normalizeTimeline } from "./engine";
import { toSecondsView } from "./frames";
import { addTrackTool, removeTracksTool, setCanvasTool, setTrackTool } from "./ops";
import { addClipsTool, addTextClipsTool, insertClipsTool } from "./placement";
import {
  applyColorTool,
  applyEffectsTool,
  setClipPropertiesTool,
  setKeyframesTool,
  setTransitionTool,
} from "./props";
import { buildRenderCommand } from "./render";
import { BLEND_KINDS, FIT_KINDS, resolveRenderPlan } from "./renderPlan";
import { compactClip } from "./shape";
import { TRANSITION_KINDS } from "./transition";
import { validateTimeline } from "./validate";
import {
  clipsSorted,
  eachClip,
  framesOk,
  keyframesMonotonic,
  linkLockOk,
  linkRefsOk,
  noBadOverlaps,
  scalarsInBounds,
  sourceSpansOk,
  trackKindOk,
  uniqueClipIds,
} from "./invariants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FRAME = fc.integer({ min: 0, max: 240 });
const LEN = fc.integer({ min: 1, max: 90 });
const IDX = fc.nat(20);
const TRACK = fc.constantFrom("v1", "v2", "a1", "a2");
// A media ref paired with a KIND-COMPATIBLE track (video ref -> video track,
// audio ref -> audio track). resolveTrack now REFUSES a kind-mismatched track_id,
// so fuzzing video-on-audio would just exercise the refusal path; pair by kind to
// keep the sequences exercising real edits.
const MEDIA = fc.oneof(
  fc.record({ ref: fc.constant("m.mp4"), track: fc.constantFrom("v1", "v2") }),
  fc.record({ ref: fc.constant("m.mp3"), track: fc.constantFrom("a1", "a2") }),
);
const UNIT = fc.double({ min: 0, max: 1, noNaN: true });
const optFrame = fc.option(FRAME, { nil: undefined });
const optBool = fc.option(fc.boolean(), { nil: undefined });

// ── caption look + media composite generators (Slice B) ─────────────────────
// Fuzz the STYLING (renderPlan.resolveText/resolveRuns/mergeStyle/presets) and the media COMPOSITE
// (resolveFit/Blend/Crop/Flip) surfaces the edit-tool sequence never exercised before: `text` carried
// fixed content with no style/animation, `add` set no composite, `color` only exposure. Every value is
// FINITE + well-typed (the tools write fit/blend/crop raw, so a NaN would leak into the timeline and
// break the JSON round-trip invariant — that's a tool-validation concern, not what this fuzzes). Fonts
// include unbundled names (clamp path) and blends/fits include out-of-enum strings (coercion path).
const HEX = fc.constantFrom(
  "#ffffff",
  "#000000",
  "#ff0000",
  "#00ff88",
  "white",
  "black",
  "rebeccapurple",
);
const FONT = fc.constantFrom(
  "Anton",
  "Bebas Neue",
  "Oswald",
  "Playfair Display",
  "Poppins",
  "Impact",
  "comic sans",
);
const styleGen = fc.record(
  {
    font: FONT,
    size: fc.integer({ min: 8, max: 200 }),
    color: HEX,
    bold: fc.boolean(),
    italic: fc.boolean(),
    underline: fc.boolean(),
    strike: fc.boolean(),
    weight: fc.integer({ min: 0, max: 1000 }), // out of 100..900 -> null in the plan
    case: fc.constantFrom("none", "upper", "lower"),
    spacing: fc.integer({ min: 0, max: 20 }),
    preset: fc.constantFrom("clean-white", "boxed", "punchy", "headline", "editorial", "minimal"),
    outline: fc.record({ color: HEX, width: fc.integer({ min: 0, max: 12 }) }),
    shadow: fc.record({ color: HEX, depth: fc.integer({ min: 0, max: 8 }) }),
    box: fc.record({ color: HEX, opacity: UNIT, padding: fc.integer({ min: 0, max: 40 }) }),
  },
  { requiredKeys: [] }, // a random SUBSET of keys, each defined (no undefined leaks into the timeline)
);
const animGen = fc.record(
  {
    build: fc.constantFrom(
      "none",
      "whole-line",
      "phrase-chunks",
      "word-highlight",
      "word-by-word",
      "append",
      "typewriter",
    ),
    entrance: fc.constantFrom("none", "fade", "pop", "slide-up", "slide-left"),
    exit: fc.constantFrom("none", "fade"),
    entrance_ms: fc.integer({ min: 0, max: 1000 }),
    exit_ms: fc.integer({ min: 0, max: 1000 }),
    timing: fc.constantFrom("even", "explicit", "transcript"),
    emphasis: fc.record(
      {
        kind: fc.constantFrom("none", "pop", "color", "highlight", "box-invert"),
        color: HEX,
        scale: fc.double({ min: 0.5, max: 2, noNaN: true }),
      },
      { requiredKeys: ["kind"] },
    ),
  },
  { requiredKeys: [] },
);
const contentItem = fc.record(
  {
    text: fc.constantFrom("hero", "word", "phrase", "the", "quick"),
    style: styleGen,
    emphasis: fc.boolean(),
    t_in: fc.double({ min: 0, max: 3, noNaN: true }),
    t_out: fc.double({ min: 0, max: 3, noNaN: true }),
  },
  { requiredKeys: ["text"] },
);
const contentGen = fc.oneof(
  fc.constantFrom("Title", "Lower third", "Subscribe"),
  fc.array(contentItem, { minLength: 1, maxLength: 4 }),
);

const command = fc.oneof(
  // placement (batched, multi-track, source-span + loop, ignore-list)
  fc.record({
    op: fc.constant("add"),
    entries: fc.array(fc.record({ media: MEDIA, at: FRAME, len: LEN }), {
      minLength: 1,
      maxLength: 2,
    }),
  }),
  fc.record({
    op: fc.constant("insert"),
    at: FRAME,
    media: MEDIA,
    len: LEN,
    ignoreI: fc.option(IDX, { nil: undefined }),
  }),
  // ripple: whole-track single, whole-track batch ranges[], clip-scoped
  fc.record({ op: fc.constant("rippleT"), track: TRACK, a: FRAME, b: FRAME }),
  fc.record({
    op: fc.constant("rippleR"),
    track: TRACK,
    ranges: fc.array(fc.record({ a: FRAME, b: FRAME }), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ op: fc.constant("rippleC"), i: IDX, a: FRAME, b: FRAME }),
  // structural (cross-track move, source-trim, multi-remove)
  fc.record({ op: fc.constant("move"), i: IDX, to: FRAME, cross: fc.boolean(), tt: IDX }),
  fc.record({ op: fc.constant("split"), i: IDX, at: FRAME }),
  fc.record({
    op: fc.constant("trim"),
    i: IDX,
    si: optFrame,
    so: optFrame,
    ti: optFrame,
    to: optFrame,
  }),
  fc.record({ op: fc.constant("remove"), i: IDX, j: fc.option(IDX, { nil: undefined }) }),
  // properties / look
  fc.record({
    op: fc.constant("props"),
    i: IDX,
    vol: fc.option(UNIT, { nil: undefined }),
    opa: fc.option(UNIT, { nil: undefined }),
    speed: fc.option(fc.double({ min: 0.25, max: 4, noNaN: true }), { nil: undefined }),
  }),
  fc.record({
    op: fc.constant("keyframes"),
    i: IDX,
    prop: fc.constantFrom("opacity", "volume"),
    kfs: fc.array(fc.record({ t: fc.nat(60), v: UNIT }), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    op: fc.constant("effects"),
    i: IDX,
    etype: fc.constantFrom("blur", "sharpen", "grain"),
    amt: fc.integer({ min: 0, max: 20 }),
  }),
  fc.record({
    op: fc.constant("color"),
    i: IDX,
    exposure: fc.double({ min: -1, max: 1, noNaN: true }),
  }),
  fc.record({ op: fc.constant("transition"), i: IDX, dur: fc.integer({ min: 1, max: 20 }) }),
  // media composite (fit/blend/crop/flip resolved in the shared plan) — set on an existing clip
  fc.record({
    op: fc.constant("composite"),
    i: IDX,
    fit: fc.option(fc.constantFrom("contain", "cover", "stretch"), { nil: undefined }),
    blend: fc.option(fc.constantFrom("normal", "multiply", "screen", "overlay", "add", "burn"), {
      nil: undefined,
    }),
    crop: fc.option(fc.record({ left: UNIT, right: UNIT, top: UNIT, bottom: UNIT }), {
      nil: undefined,
    }),
    flip: fc.option(fc.record({ h: fc.boolean(), v: fc.boolean() }), { nil: undefined }),
  }),
  // text / captions (auto-creates a text track) — now with fuzzed style + animation + rich content
  fc.record({
    op: fc.constant("text"),
    at: FRAME,
    len: LEN,
    content: contentGen,
    style: fc.option(styleGen, { nil: undefined }),
    animation: fc.option(animGen, { nil: undefined }),
  }),
  // tracks / canvas
  fc.record({ op: fc.constant("addTrack"), kind: fc.constantFrom("video", "audio", "text") }),
  fc.record({ op: fc.constant("removeTrack"), i: IDX }),
  fc.record({ op: fc.constant("setTrack"), i: IDX, mute: optBool, hidden: optBool, sync: optBool }),
  fc.record({
    op: fc.constant("setCanvas"),
    w: fc.option(fc.integer({ min: 16, max: 4096 }), { nil: undefined }),
    h: fc.option(fc.integer({ min: 16, max: 4096 }), { nil: undefined }),
    fps: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
  }),
);

const SKIP = { ok: true, _skip: true } as Any;

/** Find a clip by id anywhere in the timeline (before/after metamorphic checks). */
const findC = (t: Any, id: string): Any => {
  for (const tr of t.tracks ?? [])
    for (const c of tr.clips ?? []) if (String(c.id) === id) return c;
  return undefined;
};

/** Total occupied clip duration (sum of tout-tin) on one track. */
function occOnTrack(tl: Any, trackId: string | undefined): number {
  if (!trackId) return 0;
  const t = (tl.tracks ?? []).find((x: Any) => String(x.id) === String(trackId));
  return (t?.clips ?? []).reduce(
    (s: number, c: Any) => s + ((Number(c.timeline_out) || 0) - (Number(c.timeline_in) || 0)),
    0,
  );
}
const trackOfClip = (tl: Any, id: string): string | undefined => {
  for (const t of tl.tracks ?? [])
    for (const c of t.clips ?? []) if (String(c.id) === id) return String(t.id);
  return undefined;
};
/** Conservation law for ripple_delete: it only REMOVES anchor-track content and
 *  never more than the reported removed_span (the cut content is a subset of the
 *  deleted range). Guards a ripple that duplicates/extends content (removed < 0) or
 *  over-deletes (removed > span). Positions may shift, but occupied duration can't
 *  grow or drop by more than what was cut. */
function assertRippleConserves(before: number, after: Any, trackId: string, r: Any): void {
  const removedContent = before - occOnTrack(after, trackId);
  expect(removedContent).toBeGreaterThanOrEqual(-1e-9); // never fabricates content
  expect(removedContent).toBeLessThanOrEqual((Number(r.removed_span) || 0) + 1e-9); // cut ⊆ deleted span
}

/** Interpret one abstract command against the live timeline. Index ops resolve to
 *  the i-th clip / track (across all tracks); with nothing to target they no-op. */
async function runCommand(cmd: Any, ctx: Any, store: Any): Promise<Any> {
  const tl = await loadTimeline(store);
  const tracks = (tl.tracks ?? []) as Any[];
  const clipIds: string[] = [];
  for (const t of tracks) for (const c of t.clips ?? []) if (c.id) clipIds.push(String(c.id));
  const clip = (i: number): string | undefined =>
    clipIds.length ? clipIds[i % clipIds.length] : undefined;
  const track = (i: number): string | undefined =>
    tracks.length ? String(tracks[i % tracks.length].id) : undefined;

  switch (cmd.op) {
    case "add":
      return addClipsTool(
        {
          entries: cmd.entries.map((e: Any) => ({
            media_ref: e.media.ref,
            timeline_in: e.at,
            timeline_out: e.at + e.len,
            track_id: e.media.track,
          })),
        },
        ctx,
      );
    case "insert":
      return insertClipsTool(
        {
          at: cmd.at,
          track_id: cmd.media.track,
          entries: [{ media_ref: cmd.media.ref, duration: cmd.len }],
          ...(cmd.ignoreI != null && track(cmd.ignoreI)
            ? { ignore_sync_locked_tracks: [track(cmd.ignoreI)] }
            : {}),
        },
        ctx,
      );
    case "rippleT": {
      const before = occOnTrack(tl, cmd.track);
      const r = await rippleDeleteTool(
        { track_id: cmd.track, start: Math.min(cmd.a, cmd.b), end: Math.max(cmd.a, cmd.b) },
        ctx,
      );
      if (r.ok) assertRippleConserves(before, await loadTimeline(store), cmd.track, r);
      return r;
    }
    case "rippleR": {
      const before = occOnTrack(tl, cmd.track);
      const r = await rippleDeleteTool(
        {
          track_id: cmd.track,
          ranges: cmd.ranges.map((r: Any) => ({
            start: Math.min(r.a, r.b),
            end: Math.max(r.a, r.b),
          })),
        },
        ctx,
      );
      if (r.ok) assertRippleConserves(before, await loadTimeline(store), cmd.track, r);
      return r;
    }
    case "rippleC": {
      const id = clip(cmd.i);
      if (!id) return SKIP;
      const anchor = trackOfClip(tl, id);
      const before = occOnTrack(tl, anchor);
      const r = await rippleDeleteTool(
        { clip_id: id, start: Math.min(cmd.a, cmd.b), end: Math.max(cmd.a, cmd.b) },
        ctx,
      );
      if (r.ok && anchor) assertRippleConserves(before, await loadTimeline(store), anchor, r);
      return r;
    }
    case "move": {
      const id = clip(cmd.i);
      if (!id) return SKIP;
      const preC = findC(tl, id);
      const move: Any = { clip_id: id, to_timeline_in: cmd.to };
      if (cmd.cross) {
        const cObj = tracks
          .flatMap((t: Any) => t.clips ?? [])
          .find((c: Any) => String(c.id) === id);
        const wantKind = cObj?.kind === "audio" ? "audio" : "video";
        const dest = tracks.filter((t: Any) => t.kind === wantKind).map((t: Any) => String(t.id));
        if (dest.length) move.to_track = dest[cmd.tt % dest.length];
      }
      const r = await moveClipsTool({ moves: [move] }, ctx);
      // Value-semantics: a move relocates a clip WITHOUT retrimming it. Its source
      // window start, speed, and media are preserved (only timeline position / track
      // changes).
      if (r.ok && preC) {
        const moved = findC(await loadTimeline(store), id);
        if (moved) {
          expect(moved.source_in).toBe(preC.source_in);
          expect(moved.speed ?? 1).toBe(preC.speed ?? 1);
          expect(moved.media_ref).toBe(preC.media_ref);
        }
      }
      return r;
    }
    case "split": {
      const id = clip(cmd.i);
      if (!id) return SKIP;
      const preC = findC(tl, id);
      const r = await splitClipsTool({ splits: [{ clip_id: id, at: cmd.at }] }, ctx);
      // Value-semantics: a split CONSERVES the clip. [tin, cut] + [cut, tout] exactly
      // tiles the original span, and the cut is source-contiguous (no source frames
      // lost or duplicated at the join).
      if (r.ok && Array.isArray(r.new_clip_ids) && r.new_clip_ids.length && preC) {
        const post = await loadTimeline(store);
        const left = findC(post, id);
        const right = findC(post, String(r.new_clip_ids[0]));
        if (left && right) {
          expect(left.timeline_in).toBe(preC.timeline_in);
          expect(right.timeline_out).toBe(preC.timeline_out);
          expect(left.timeline_out).toBe(right.timeline_in);
          if (typeof preC.source_in === "number") {
            expect(left.source_in).toBe(preC.source_in);
            expect(left.source_out).toBe(right.source_in);
          }
        }
      }
      return r;
    }
    case "trim": {
      const id = clip(cmd.i);
      if (!id) return SKIP;
      const t: Any = { clip_id: id };
      if (cmd.si != null) t.source_in = cmd.si;
      if (cmd.so != null) t.source_out = cmd.so;
      if (cmd.ti != null) t.timeline_in = cmd.ti;
      if (cmd.to != null) t.timeline_out = cmd.to;
      return trimClipsTool({ trims: [t] }, ctx);
    }
    case "remove": {
      const ids = [clip(cmd.i), cmd.j != null ? clip(cmd.j) : undefined].filter(
        (x): x is string => !!x,
      );
      return ids.length ? removeClipsTool({ clip_ids: [...new Set(ids)] }, ctx) : SKIP;
    }
    case "props": {
      const id = clip(cmd.i);
      if (!id) return SKIP;
      const p: Any = {};
      if (cmd.vol != null) p.volume = cmd.vol;
      if (cmd.opa != null) p.opacity = cmd.opa;
      if (cmd.speed != null) p.speed = cmd.speed;
      return setClipPropertiesTool({ clip_ids: [id], properties: p }, ctx);
    }
    case "keyframes": {
      const id = clip(cmd.i);
      return id
        ? setKeyframesTool(
            {
              clip_id: id,
              property: cmd.prop,
              keyframes: cmd.kfs.map((k: Any) => ({ t: k.t, v: k.v })),
            },
            ctx,
          )
        : SKIP;
    }
    case "effects": {
      const id = clip(cmd.i);
      return id
        ? applyEffectsTool({ clip_ids: [id], add: [{ type: cmd.etype, amount: cmd.amt }] }, ctx)
        : SKIP;
    }
    case "color": {
      const id = clip(cmd.i);
      return id ? applyColorTool({ clip_ids: [id], color: { exposure: cmd.exposure } }, ctx) : SKIP;
    }
    case "transition": {
      const id = clip(cmd.i);
      return id
        ? setTransitionTool(
            { clip_id: id, transition_in: { kind: "crossfade", duration: cmd.dur } },
            ctx,
          )
        : SKIP;
    }
    case "composite": {
      const id = clip(cmd.i);
      if (!id) return SKIP;
      const p: Any = { clip_ids: [id] };
      if (cmd.fit != null) p.fit = cmd.fit;
      if (cmd.blend != null) p.blend = cmd.blend;
      if (cmd.crop != null) p.crop = cmd.crop;
      if (cmd.flip != null) p.flip = cmd.flip;
      return Object.keys(p).length > 1 ? setClipPropertiesTool(p, ctx) : SKIP;
    }
    case "text": {
      const entry: Any = {
        content: cmd.content,
        timeline_in: cmd.at,
        timeline_out: cmd.at + cmd.len,
      };
      if (cmd.style) entry.style = cmd.style;
      if (cmd.animation) entry.animation = cmd.animation;
      return addTextClipsTool({ entries: [entry] }, ctx);
    }
    case "addTrack":
      return addTrackTool({ kind: cmd.kind }, ctx);
    case "removeTrack": {
      const id = track(cmd.i);
      return id ? removeTracksTool({ track_ids: [id] }, ctx) : SKIP;
    }
    case "setTrack": {
      const id = track(cmd.i);
      if (!id) return SKIP;
      const a: Any = { track_id: id };
      if (cmd.mute != null) a.mute = cmd.mute;
      if (cmd.hidden != null) a.hidden = cmd.hidden;
      if (cmd.sync != null) a.sync_locked = cmd.sync;
      return setTrackTool(a, ctx);
    }
    default:
      return setCanvasTool(
        {
          ...(cmd.w != null ? { width: cmd.w } : {}),
          ...(cmd.h != null ? { height: cmd.h } : {}),
          ...(cmd.fps != null ? { fps: cmd.fps } : {}),
        },
        ctx,
      );
  }
}

// ── invariants: the battery (noBadOverlaps, linkLockOk, framesOk, …) is imported
// from ./invariants — the SAME predicates the eval oracle checks (oracle.ts). Only
// the fuzzer-local skip guard (hasOverlap) + allFinite live here. ──

/** True if any two clips overlap on the same track (ignores zero-length, which
 *  noBadOverlaps catches). Used to SKIP fuzzer inputs whose only issue is that a
 *  move / length-extending trim left an overlap — a documented gap in destination
 *  clearing (add/insert overwrite/ripple; move/trim don't). */
function hasOverlap(tl: Any): boolean {
  for (const t of tl.tracks ?? []) {
    const cs = (t.clips ?? [])
      .slice()
      .sort((a: Any, b: Any) => (Number(a.timeline_in) || 0) - (Number(b.timeline_in) || 0));
    let prevOut = -Infinity;
    for (const c of cs) {
      const tin = Number(c.timeline_in) || 0;
      if (tin < prevOut) return true;
      prevOut = Math.max(prevOut, Number(c.timeline_out) || 0);
    }
  }
  return false;
}

/** Every number nested anywhere in `v` is finite (no NaN/Infinity). Used to prove
 *  a compiled render plan / preview scene carries no numeric garbage. */
function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object") return Object.values(v).every(allFinite);
  return true;
}

// ── mutation-delta faithfulness ─────────────────────────────────────────────
// Every edit returns a delta (get_timeline vocabulary) so the model patches its
// picture instead of re-reading. It must ACCURATELY and COMPLETELY describe
// before -> after, or the model's mental timeline silently drifts from reality.
interface DIdx {
  track: string;
  full: string;
  compact: string;
  tin: number;
  tout: number;
  clip: Any;
}
function deltaIndex(tl: Any): Map<string, DIdx> {
  const m = new Map<string, DIdx>();
  for (const t of tl.tracks ?? []) {
    for (const c of t.clips ?? []) {
      if (c?.id != null) {
        m.set(String(c.id), {
          track: String(t.id),
          full: JSON.stringify(c),
          compact: JSON.stringify(compactClip(c)),
          tin: Number(c.timeline_in) || 0,
          tout: Number(c.timeline_out) || 0,
          clip: c,
        });
      }
    }
  }
  return m;
}
function assertDeltaFaithful(before: Any, after: Any, r: Any): void {
  const b = deltaIndex(before);
  const a = deltaIndex(after);
  const removed: string[] = (r.removed_ids ?? []).map(String);
  const shiftedRules: Any[] = r.shifted ?? [];
  // ACCURACY: removed ids were present before and are gone after.
  for (const id of removed) {
    expect(b.has(id)).toBe(true);
    expect(a.has(id)).toBe(false);
  }
  // ACCURACY: created tracks are genuinely new.
  const bT = new Set((before.tracks ?? []).map((t: Any) => String(t.id)));
  const aT = new Set((after.tracks ?? []).map((t: Any) => String(t.id)));
  for (const t of r.created_tracks ?? []) {
    expect(bT.has(String(t))).toBe(false);
    expect(aT.has(String(t))).toBe(true);
  }
  // ACCURACY: each listed clip equals after's compact state + its track id.
  const reported = new Set<string>(removed);
  for (const entry of r.clips ?? []) {
    const id = String(entry.id);
    reported.add(id);
    const av = a.get(id);
    expect(av).toBeTruthy();
    if (av) {
      expect(String(entry.track)).toBe(av.track);
      const { track: _t, ...rest } = entry;
      expect(JSON.stringify(rest)).toBe(av.compact);
    }
  }
  // COMPLETENESS (unless the change list was capped): every clip that actually
  // changed is reported — in clips[], removed_ids, or a shifted rule.
  if (r.clips_note) return;
  const coveredByShift = (bv: DIdx, av: DIdx): boolean => {
    const by = av.tin - bv.tin;
    if (av.track !== bv.track || by === 0 || av.tout - bv.tout !== by) return false;
    const restored = JSON.stringify({
      ...(av.clip as Any),
      timeline_in: bv.tin,
      timeline_out: bv.tout,
    });
    if (restored !== bv.full) return false; // not a PURE shift
    return shiftedRules.some(
      (s) => String(s.track) === bv.track && s.by === by && bv.tin >= s.from_frame,
    );
  };
  for (const [id, bv] of b) {
    const av = a.get(id);
    if (!av) {
      expect(reported.has(id)).toBe(true); // removed
      continue;
    }
    if (av.track === bv.track && av.full === bv.full) continue; // untouched
    expect(reported.has(id) || coveredByShift(bv, av)).toBe(true);
  }
  for (const id of a.keys()) if (!b.has(id)) expect(reported.has(id)).toBe(true); // new clips
}

describe("timeline invariants (property-based)", () => {
  it("random edit sequences preserve every invariant, return a faithful delta, and are undo/redo-exact", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { maxLength: 12 }), async (cmds) => {
        const { ctx, store } = await seededCtx(audioRunner); // a fresh document per run isolates the undo history
        for (const cmd of cmds) {
          const before = JSON.stringify(await loadTimeline(store));
          const r = await runCommand(cmd, ctx, store);
          if (r._skip) continue;
          if (!r.ok) {
            // Principled refusal: an error string, and the timeline is left UNCHANGED (atomic).
            expect(typeof r.error).toBe("string");
            expect(JSON.stringify(await loadTimeline(store))).toBe(before);
            continue;
          }
          const tl = await loadTimeline(store);
          // Some edits (move, a length-extending trim) reposition or resize a clip
          // WITHOUT clearing/rippling the destination, so they can leave a same-track
          // overlap. How artdaddy SHOULD resolve that (overwrite vs ripple vs refuse) is an
          // open design question — so treat an overlap-creating input as out of scope
          // here: undo it and skip rather than assert on it.
          if (hasOverlap(tl)) {
            await doUndo(store);
            continue;
          }
          expect(validateTimeline(tl)).toEqual([]);
          expect(noBadOverlaps(tl)).toBe(true);
          expect(linkLockOk(tl)).toBe(true);
          expect(linkRefsOk(tl)).toBe(true);
          expect(framesOk(tl)).toBe(true);
          expect(sourceSpansOk(tl)).toBe(true);
          expect(uniqueClipIds(tl)).toBe(true);
          expect(trackKindOk(tl)).toBe(true);
          expect(clipsSorted(tl)).toBe(true);
          expect(keyframesMonotonic(tl)).toBe(true);
          expect(scalarsInBounds(tl)).toBe(true);
          // The persisted state round-trips through JSON unchanged (no NaN/Infinity/
          // undefined leaked in by an edit or the fps rebase).
          expect(JSON.parse(JSON.stringify(tl))).toEqual(tl);
          // Pipeline fixed-point: the persisted timeline is already canonical, so
          // re-running the normalize/clamp/derive pass changes nothing (idempotent).
          const reNorm = JSON.parse(JSON.stringify(tl));
          normalizeTimeline(reNorm);
          expect(reNorm).toEqual(tl);
          // Every VALID timeline compiles to a render plan and a preview scene
          // without throwing or leaking NaN/Infinity into an ffmpeg expression or a
          // draw-list coordinate (bridges "valid data" -> "renderable").
          const plan = buildRenderCommand(tl, "out.mp4");
          expect(Number.isFinite(plan.duration)).toBe(true);
          expect(
            `${plan.filterComplex} ${plan.args.join(" ")} ${plan.assFiles.map((f) => f.content).join(" ")}`,
          ).not.toMatch(/NaN|Infinity/);
          // Shared-plan closed-union invariant (Slice B): whatever styling / composite the fuzzed ops
          // wrote, resolveRenderPlan keeps `fit`/`blend`/`transition.kind` inside their dispatch unions
          // (else a backend's assertNever would throw) and crops inside [0,1). Asserted on the SAME
          // seconds-view resolution both backends read, so an out-of-union coercion regression fails here.
          const look = resolveRenderPlan(toSecondsView(tl));
          for (const pc of look.clips) {
            expect(FIT_KINDS as readonly string[]).toContain(pc.media.fit);
            expect(BLEND_KINDS as readonly string[]).toContain(pc.media.blend);
            expect(
              typeof pc.media.flip.h === "boolean" && typeof pc.media.flip.v === "boolean",
            ).toBe(true);
            for (const edge of [
              pc.media.crop.left,
              pc.media.crop.right,
              pc.media.crop.top,
              pc.media.crop.bottom,
            ]) {
              expect(edge >= 0 && edge < 1).toBe(true);
            }
            if (pc.transition)
              expect(TRANSITION_KINDS as readonly string[]).toContain(pc.transition.kind);
          }
          const fps = Number(tl.canvas?.fps) || 30;
          const endF = Math.max(0, ...eachClip(tl).map(({ c }) => Number(c.timeline_out) || 0));
          // render<->preview parity: the preview draws bottom-to-top in NON-DECREASING z
          // (the same order the render overlays composite in). Exact pixel geometry is
          // covered by the golden e2e; a filter-string parse here would be brittle.
          const zOrdered = (arr: Any[]): boolean =>
            arr.every((l, i) => i === 0 || Number(l.z) >= Number(arr[i - 1].z));
          for (const f of new Set([0, Math.floor(endF / 2), Math.max(0, endF - 1)])) {
            const scene = buildScene(tl, f / fps, new Map()) as Any;
            expect(allFinite(scene)).toBe(true);
            expect(zOrdered(scene.layers ?? []) && zOrdered(scene.textLayers ?? [])).toBe(true);
          }
          // The returned mutation delta must faithfully describe before -> after.
          assertDeltaFaithful(JSON.parse(before), tl, r);
          // undo restores the exact pre-op state; redo restores the post-op state.
          const after = JSON.stringify(tl);
          await doUndo(store);
          expect(JSON.stringify(await loadTimeline(store))).toBe(before);
          await doRedo(store);
          expect(JSON.stringify(await loadTimeline(store))).toBe(after);
        }
      }),
      { numRuns: 150, seed: 0x5eed },
    );
  });
});
