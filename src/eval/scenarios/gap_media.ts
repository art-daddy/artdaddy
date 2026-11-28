// Two of the biggest gaps in the eval set (the coverage report of 27 Nov, art-daddy/backlog#42):
//   gap 5, highlights from long footage: recordings of 28 minutes to two hours whose content is known
//          to the stand-ins (what each shot shows, what is said, in source seconds), cut down to the
//          moments a request names;
//   gap 6, bringing media in and laying it out: files and folders imported from disk, the library
//          placed in an asked order, photos with a length each, picture-in-picture, cutaways, gaps.
//
// GRADING. Every check reads the final timeline (and, where the request is a question or a claim,
// what the agent said): which stretches of a source are kept, in what order, how long, on which
// track. Taste is never graded: which goal looks best, how long a moment runs where the request
// left it open. The footage and its facts are in gap_media_footage.ts.
import { STARTER_PROMPTS } from "../../components/starterPrompts";
import { composeModelText } from "../../agent/compose";
import { importNote } from "../../agent/importNote";
import type { ToolResultItem } from "../../agent/types";
import { clipKind, clipSourceSpanSeconds } from "../../timeline/helpers";
import type { Clip, Timeline, Track } from "../../timeline/model";
import type { InferenceRequest } from "../harness";
import type { ReferenceCalls, ReferenceStep } from "../reference";
import type { Scenario, Trace } from "../types";
import {
  ANGLES,
  ANGLES_CLIPS,
  AUDIO_CLIPS,
  BIG_LIBRARY,
  BROLL,
  CEREMONY,
  CEREMONY_CLIP,
  DAY2,
  DAY2_IN_SHOOTING_ORDER,
  DRONE,
  DRONE_CLIP,
  GARDEN,
  GARDEN_CLIPS,
  GIG,
  GIG_CLIP,
  HARBOUR,
  harbourClips,
  INTERVIEW,
  INTERVIEW_CLIPS,
  LECTURE,
  LECTURE_CLIP,
  LIGHTHOUSE,
  LIGHTHOUSE_CLIPS,
  LISBON,
  LISBON_CLIPS,
  MARKET_CLIPS,
  MATCH,
  MATCH_CLIP,
  PANEL,
  PANEL_CLIP,
  PIANO,
  PODCAST,
  PODCAST_CLIP,
  QUAY,
  QUAY_CLIPS,
  SCENES,
  SCENES_CLIPS,
  SHOOT,
  SHOOT_CLIPS,
  SKATE,
  SKATE_CLIP,
  SMALL_LIBRARY,
  SMALL_LIBRARY_CLIPS,
  STREAM,
  STREAM_CLIP,
  TAKES,
  TAKES_CLIPS,
  TRIP,
  TRIP_CLIPS,
  TUTORIAL,
  TUTORIAL_CLIPS,
  VOICE,
  type Span,
} from "./gap_media_footage";
import { aclip, atrack, timeline, vclip, vtrack } from "./helpers";

const FPS = 30;
const fr = (seconds: number): number => Math.round(seconds * FPS);
const HD = { width: 1920, height: 1080, fps: FPS };

// â”€â”€ reading the final timeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const VISUAL = ["video", "image"];

/** One clip of a source as the timeline plays it: its source span in seconds and its place in frames. */
export interface Piece {
  id: string;
  ref: string;
  track: string;
  kind: string;
  s: number;
  e: number;
  tin: number;
  tout: number;
}

function audible(t: Track, c: Clip): boolean {
  if (t.mute || c.disabled) return false;
  return !(typeof c.volume === "number" && c.volume <= 0);
}
function visible(t: Track, c: Clip): boolean {
  return !t.hidden && !c.disabled && !(typeof c.opacity === "number" && c.opacity <= 0);
}

/** The clips of `refs` the final timeline shows (or, for kinds ["audio"], plays aloud). */
export function pieces(final: Timeline, refs: readonly string[], kinds = VISUAL): Piece[] {
  const fps = Number(final.canvas?.fps) || FPS;
  const out: Piece[] = [];
  for (const t of final.tracks ?? [])
    for (const c of t.clips ?? []) {
      const ref = String(c.media_ref ?? "");
      const kind = clipKind(c);
      if (!refs.includes(ref) || !kinds.includes(kind)) continue;
      if (kind === "audio" ? !audible(t, c) : !visible(t, c)) continue;
      const [s, e] = clipSourceSpanSeconds(c, fps);
      out.push({
        id: String(c.id ?? ""),
        ref,
        track: String(t.id),
        kind,
        s,
        e,
        tin: Number(c.timeline_in) || 0,
        tout: Number(c.timeline_out) || 0,
      });
    }
  return out.sort((a, b) => a.tin - b.tin || a.track.localeCompare(b.track));
}

const sec = (frames: number): string => `${(frames / FPS).toFixed(1)} s`;

/** Seconds of [a, b] that no span in `spans` covers. */
function uncovered([a, b]: Span, spans: readonly Span[]): number {
  let left: [number, number][] = [[a, b]];
  for (const [s, e] of spans)
    left = left.flatMap(
      ([x, y]): [number, number][] =>
        [
          [x, Math.min(y, s)],
          [Math.max(x, e), y],
        ].filter(([p, q]) => q > p) as [number, number][],
    );
  return left.reduce((n, [x, y]) => n + (y - x), 0);
}
/** Seconds of [s, e] inside `window`. */
const inside = ([s, e]: Span, [a, b]: Span): number => Math.max(0, Math.min(e, b) - Math.max(s, a));

// â”€â”€ a reel cut from one or more sources â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A stretch of a source the request names. `at` must be kept whole; a `window` needs at least
 *  `minKeep` seconds of it kept. `pieceLen` bounds the piece that holds it, in seconds on screen. */
export interface Moment {
  name: string;
  ref?: string;
  at?: Span;
  window?: Span;
  minKeep?: number;
  pieceLen?: Span;
}
export interface ReelSpec {
  refs: readonly string[];
  moments: readonly Moment[];
  /** Where kept material may come from (widened by `slack` seconds each side), per source. */
  allowed: readonly { ref?: string; span: Span }[];
  slack?: number;
  /** Seconds of picture or sound allowed outside `allowed` in all (cuts a frame or two wide). */
  maxOutside?: number;
  /** The moments appear on the timeline in the order they are listed. */
  order?: boolean;
  minPieces?: number;
  /** Seconds the reel runs on screen. */
  total?: Span;
}

const spanOf = (m: Moment): Span => (m.at ?? m.window)!;
const midOf = (m: Moment): number => (spanOf(m)[0] + spanOf(m)[1]) / 2;

/** The frame where a moment first plays: the first piece that shows any of it (a window moment may
 *  be kept only in part, so its middle need not be on screen). NaN when none does. */
function playsAt(pics: readonly Piece[], ref: string, m: Moment): number {
  const [a, b] = spanOf(m);
  const p = pics.find((q) => q.ref === ref && q.e > a && q.s < b);
  return p ? p.tin + (Math.max(p.s, a) - p.s) * FPS : NaN;
}

/** Stretches that play straight on from one another (a cut piece split in two) count as one. */
function segments(ps: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of ps) {
    const last = out[out.length - 1];
    if (
      last &&
      last.ref === p.ref &&
      Math.abs(p.tin - last.tout) <= 1 &&
      Math.abs(p.s - last.e) < 0.1
    )
      out[out.length - 1] = { ...last, e: p.e, tout: p.tout };
    else out.push(p);
  }
  return out;
}

/** The pieces play one after another from frame 0, with no black between them and none on top of
 *  another: what "put them together" means for a reel. */
function oneAfterAnother(pics: readonly Piece[]): void {
  if (pics[0].tin > 2)
    throw new Error(`the reel starts at frame ${pics[0].tin}, after ${sec(pics[0].tin)} of black`);
  for (let i = 1; i < pics.length; i += 1) {
    const gap = pics[i].tin - pics[i - 1].tout;
    if (gap > 2)
      throw new Error(`${sec(gap)} of black between two pieces, at frame ${pics[i - 1].tout}`);
    if (gap < -2)
      throw new Error(
        `two pieces play on top of each other at frame ${pics[i].tin} (on ${pics[i - 1].track} and ${pics[i].track})`,
      );
  }
}

export function checkReel(final: Timeline, spec: ReelSpec): void {
  const pics = pieces(final, spec.refs);
  if (!pics.length) throw new Error("nothing from the source is on the timeline");
  oneAfterAnother(pics);
  const own = (ref: string) => pics.filter((p) => p.ref === ref).map((p): Span => [p.s, p.e]);
  for (const m of spec.moments) {
    const ref = m.ref ?? spec.refs[0];
    if (m.at) {
      const missing = uncovered(m.at, own(ref));
      if (missing > 0.3)
        throw new Error(
          `${m.name} (${m.at[0]}-${m.at[1]} s of the source) is not all kept: ${missing.toFixed(1)} s of it is missing`,
        );
    }
    if (m.window && m.minKeep !== undefined) {
      const kept = own(ref).reduce((n, s) => n + inside(s, m.window!), 0);
      if (kept + 0.05 < m.minKeep)
        throw new Error(
          `${m.name}: only ${kept.toFixed(1)} s of it (${m.window[0]}-${m.window[1]} s) is kept`,
        );
    }
    if (m.pieceLen) {
      const mid = midOf(m);
      const holder = segments(pics).find((p) => p.ref === ref && p.s <= mid && mid < p.e);
      const len = holder ? (holder.tout - holder.tin) / FPS : NaN;
      if (!(len >= m.pieceLen[0] && len <= m.pieceLen[1]))
        throw new Error(
          `${m.name} runs ${len.toFixed(1)} s on screen; the request asks for ${m.pieceLen[0]}-${m.pieceLen[1]} s`,
        );
    }
  }
  const slack = spec.slack ?? 3;
  const windows = (ref: string): Span[] =>
    spec.allowed
      .filter((a) => (a.ref ?? spec.refs[0]) === ref)
      .map((a): Span => [a.span[0] - slack, a.span[1] + slack]);
  const outside = (ps: readonly Piece[]) =>
    ps.reduce((n, p) => n + uncovered([p.s, p.e], windows(p.ref)), 0);
  const limit = spec.maxOutside ?? 5;
  const extraPicture = outside(pics);
  if (extraPicture > limit)
    throw new Error(
      `${extraPicture.toFixed(1)} s of the picture is from outside what was asked for (at most ${limit} s allowed)`,
    );
  const extraSound = outside(pieces(final, spec.refs, ["audio"]));
  if (extraSound > limit)
    throw new Error(
      `${extraSound.toFixed(1)} s of the source's sound plays from outside what was asked for (at most ${limit} s allowed)`,
    );
  if (spec.order) {
    const at = spec.moments.map((m) => playsAt(pics, m.ref ?? spec.refs[0], m));
    for (let i = 1; i < at.length; i += 1)
      if (!(at[i] > at[i - 1]))
        throw new Error(
          `${spec.moments[i].name} plays before ${spec.moments[i - 1].name}; the request gives the order ${spec.moments.map((m) => m.name).join(", ")}`,
        );
  }
  if (spec.minPieces && segments(pics).length < spec.minPieces)
    throw new Error(
      `only ${segments(pics).length} moment(s) kept; the request asks for at least ${spec.minPieces}`,
    );
  if (spec.total) {
    const total = pics.reduce((n, p) => n + (p.tout - p.tin), 0) / FPS;
    if (total < spec.total[0] - 0.05 || total > spec.total[1] + 0.05)
      throw new Error(
        `the result runs ${total.toFixed(1)} s; the request asks for ${spec.total[0]}-${spec.total[1]} s`,
      );
  }
}

// â”€â”€ a sequence of placed media â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A clip the request places: its ref and its length on the timeline in frames. */
export interface Placed {
  ref: string;
  frames: number;
}

/** The visual clips of the final timeline, by start. */
function visualClips(final: Timeline): { clip: Clip; track: Track }[] {
  return (final.tracks ?? [])
    .flatMap((track) => (track.clips ?? []).map((clip) => ({ clip, track })))
    .filter(({ clip }) => VISUAL.includes(clipKind(clip)))
    .sort((a, b) => Number(a.clip.timeline_in) - Number(b.clip.timeline_in));
}

/** Every one of `want` is placed once, whole (its length), in `want`'s order when `ordered`, the
 *  first at `from` and each `gap` frames after the one before. `only`: no other picture is placed. */
export function checkSequence(
  final: Timeline,
  want: readonly Placed[],
  opts: { ordered?: boolean; gap?: number; from?: number; only?: boolean; tol?: number } = {},
): void {
  const tol = opts.tol ?? 1;
  const vis = visualClips(final);
  const mine = vis.filter(({ clip }) => want.some((w) => w.ref === clip.media_ref));
  for (const w of want) {
    const n = mine.filter(({ clip }) => clip.media_ref === w.ref).length;
    if (n !== 1) throw new Error(`${w.ref} is on the timeline ${n} times, not once`);
  }
  if (opts.only && vis.length !== mine.length)
    throw new Error(
      `other pictures are on the timeline too: ${vis
        .filter((v) => !mine.includes(v))
        .map((v) => v.clip.media_ref)
        .join(", ")}`,
    );
  const order = mine.map(({ clip }) => String(clip.media_ref));
  if (opts.ordered !== false && order.join() !== want.map((w) => w.ref).join())
    throw new Error(
      `the order on the timeline is ${order.join(", ")}; asked for ${want.map((w) => w.ref).join(", ")}`,
    );
  let cursor = opts.from ?? 0;
  for (const { clip } of mine) {
    const w = want.find((x) => x.ref === clip.media_ref)!;
    const tin = Number(clip.timeline_in);
    const len = Number(clip.timeline_out) - tin;
    if (Math.abs(tin - cursor) > tol)
      throw new Error(
        `${w.ref} starts at frame ${tin}; it should start at ${cursor} (${opts.gap ? `${opts.gap} frames after the clip before` : "right after the clip before"})`,
      );
    if (Math.abs(len - w.frames) > tol)
      throw new Error(`${w.ref} runs ${len} frames; it should run ${w.frames}`);
    if (Number(clip.speed ?? 1) !== 1)
      throw new Error(`${w.ref} plays at speed ${String(clip.speed)}`);
    cursor = tin + len + (opts.gap ?? 0);
  }
}

// â”€â”€ reading the trace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const callsOf = (t: Trace, name: string) => t.toolCalls.filter((c) => c.name === name);
const said = (t: Trace): string => t.finalText ?? "";
/** A path in an import call names `file` (either slash, any case). */
const names = (args: Record<string, unknown>, file: string): boolean =>
  JSON.stringify(args ?? {})
    .replace(/\\\\/g, "/")
    .toLowerCase()
    .includes(file.toLowerCase());

/** A value that may be keyframed, at its lowest (absent: `d`). */
function lowest(v: unknown, d: number): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length)
    return Math.min(...v.map((k) => Number((k as { v?: unknown }).v)).filter(Number.isFinite));
  return d;
}
/** A value that may be keyframed, at its highest (absent: `d`). */
function highest(v: unknown, d: number): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length)
    return Math.max(...v.map((k) => Number((k as { v?: unknown }).v)).filter(Number.isFinite));
  return d;
}

/** The seed is exactly what the final timeline holds. */
function untouched(seed: () => Timeline) {
  return (final: Timeline) => {
    if (JSON.stringify(seed().tracks) !== JSON.stringify(final.tracks))
      throw new Error("the timeline was changed; the request asked for no change to it");
  };
}

// â”€â”€ seeds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A source placed whole at frame 0, with its sound split off and linked, as the app places it. */
function onTimeline(ref: string, seconds: number, sound = true, canvas = HD): () => Timeline {
  const n = fr(seconds);
  return () =>
    timeline(
      [
        vtrack("v1", 1, [vclip("full", ref, 0, n, sound ? { link_group: "lg_full" } : {})]),
        ...(sound
          ? [atrack("a1", 0, [aclip("full_audio", ref, 0, n, { link_group: "lg_full" })])]
          : []),
      ],
      canvas,
    );
}
const emptyHD = (): Timeline => timeline([], HD);

const CUT_SCOPE = {
  change: ["full", "full_audio"],
  remove: ["full", "full_audio"],
  add: ["video", "audio"],
  addTracks: true,
} as const;
const CUT_SCOPE_SILENT = {
  change: ["full"],
  remove: ["full"],
  add: ["video"],
  addTracks: true,
} as const;
const PLACE_SCOPE = { add: ["video", "audio"], addTracks: true } as const;
const PLACE_ALL_SCOPE = { add: ["video", "image", "audio"], addTracks: true } as const;

// â”€â”€ correct runs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const step = (...calls: ReferenceCalls): ReferenceStep => ({ calls });
const say = (text: string): ReferenceStep => ({ text });
const results = (req: InferenceRequest, name: string): Record<string, unknown>[] =>
  (req.round_input.tool_results ?? [])
    .filter((r: ToolResultItem) => r.name === name)
    .map((r: ToolResultItem) => r.result);

/** The refs the previous round's imports returned, by filename (a file, or each file of a folder). */
export function importedRefs(req: InferenceRequest): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of results(req, "import_media")) {
    if (typeof r.media_ref === "string") out.set(String(r.filename), r.media_ref);
    for (const e of (r.imported as Record<string, unknown>[] | undefined) ?? [])
      out.set(String(e.filename), String(e.media_ref));
  }
  return out;
}
/** The clip ids the previous round's add_clips minted, pictures only. */
const createdPictures = (req: InferenceRequest): string[] =>
  results(req, "add_clips")
    .flatMap((r) => (r.created as { clip_id: string; kind?: string }[] | undefined) ?? [])
    .filter((c) => c.kind !== "audio")
    .map((c) => c.clip_id);

/** Ripple out everything but `keep` (source seconds) from a source that plays whole from frame 0. */
export function keepOnly(keep: readonly Span[], total: number): ReferenceStep {
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const [a, b] of [...keep].sort((x, y) => x[0] - y[0])) {
    if (fr(a) > cursor) ranges.push({ start: cursor, end: fr(a) });
    cursor = fr(b);
  }
  if (cursor < fr(total)) ranges.push({ start: cursor, end: fr(total) });
  return step(["ripple_delete", { track_id: "v1", ranges }]);
}
/** Place spans of sources one after another from frame 0. */
export function placeSpans(spans: readonly (readonly [string, number, number])[]): ReferenceStep {
  let at = 0;
  const entries = spans.map(([media_ref, a, b]) => {
    const entry = { media_ref, timeline_in: at, source_span: [a, b] };
    at += fr(b) - fr(a);
    return entry;
  });
  return step(["add_clips", { entries }]);
}
const overview = (ref: string): ReferenceStep =>
  step(["inspect_media", { media_ref: ref, overview: true }]);
const overviewClip = (): ReferenceStep =>
  step(["inspect_media", { clip_id: "full", overview: true }]);
const listen = (ref: string, from: number, to: number): ReferenceStep =>
  step(["inspect_media", { media_ref: ref, start_seconds: from, end_seconds: to }]);

// â”€â”€ the cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const tags = (
  gap: "highlights" | "import-layout",
  turns: number,
  clips: number,
  ...more: string[]
) => [`gap:${gap}`, "lang:en", `turns:${turns}`, `clips:${clips}`, ...more];

const goalMoment = (g: (typeof MATCH.goals)[number], i: number): Moment => ({
  name: `goal ${i + 1} (${g.team}, ${g.at} s)`,
  at: [g.at - 3, g.at + 1],
  pieceLen: [12, 30],
});
const goalWindow = (g: (typeof MATCH.goals)[number]) => ({ span: [g.at - 30, g.at + 25] as Span });
const BLUE_GOALS = MATCH.goals.filter((g) => g.team === "blue");
const MARA_SAYS: Span[] = PANEL.mara.map(([a, b]) => [a, b]);
/** Where Mara's words start and end in each of her turns: what "where she is talking" means. */
const MARA_WORDS: Span[] = MARA_SAYS.map(([a, b]) => {
  const rows = (PANEL_CLIP.words ?? []).filter(([, s, e]) => s >= a && e <= b);
  return [Math.min(...rows.map((r) => r[1])), Math.max(...rows.map((r) => r[2]))];
});

const HIGHLIGHTS: Scenario[] = [
  {
    id: "hl_every_goal",
    title: "A highlights reel of every goal in a 96-minute match",
    tags: tags("highlights", 1, 2),
    surface: "studio",
    footage: { clips: [MATCH_CLIP] },
    seed: onTimeline(MATCH.ref, MATCH.seconds),
    prompt:
      "Make a highlights reel of every goal in this match, in the order they went in. Give each goal " +
      "about twenty seconds and cut everything else.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    expect: (final) =>
      checkReel(final, {
        refs: [MATCH.ref],
        moments: MATCH.goals.map(goalMoment),
        allowed: MATCH.goals.map(goalWindow),
        slack: 0,
        maxOutside: 6,
        order: true,
      }),
    reference: [
      overviewClip(),
      keepOnly(
        MATCH.goals.map((g): Span => [g.at - 12, g.at + 8]),
        MATCH.seconds,
      ),
      say(
        "Done: the four goals, twenty seconds each, in the order they went in (1-0, 1-1, 2-1, 3-1).",
      ),
    ],
  },
  {
    id: "hl_our_goals_only",
    title: "Only one team's goals, from a match in the library",
    tags: tags("highlights", 1, 1, "library"),
    surface: "studio",
    footage: { clips: [MATCH_CLIP] },
    seed: emptyHD,
    prompt:
      "There's a recording of our cup final in my library. We played in blue. Put together just our " +
      "goals, one after another, and nothing else.",
    scope: PLACE_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    expect: (final) =>
      checkReel(final, {
        refs: [MATCH.ref],
        moments: BLUE_GOALS.map((g, i) => ({ ...goalMoment(g, i), pieceLen: undefined })),
        allowed: BLUE_GOALS.map(goalWindow),
        slack: 0,
        maxOutside: 6,
        order: true,
      }),
    reference: [
      overview(MATCH.ref),
      placeSpans(BLUE_GOALS.map((g) => [MATCH.ref, g.at - 12, g.at + 8] as const)),
      say(
        "Here are your three goals in a row: the first-half strike, the penalty and the long shot.",
      ),
    ],
  },
  {
    id: "hl_best_of_45s",
    title: "A best-of from a long match, no longer than 45 seconds",
    tags: tags("highlights", 1, 1, "library", "length-cap"),
    surface: "studio",
    footage: { clips: [MATCH_CLIP] },
    seed: emptyHD,
    prompt:
      "Cut me a best-of from the cup final recording in my library, no longer than 45 seconds.",
    scope: PLACE_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    // Which moments are "best" is taste; that they are moments at all (goals, the red card, the
    // trophy) and not open play or the empty half-time pitch is not.
    expect: (final) =>
      checkReel(final, {
        refs: [MATCH.ref],
        moments: [],
        allowed: [
          ...MATCH.goals.map((g) => ({ span: g.shot as Span })),
          { span: MATCH.redCard as Span },
          { span: MATCH.trophy as Span },
        ],
        slack: 6,
        maxOutside: 4,
        minPieces: 2,
        total: [10, 45],
      }),
    reference: [
      overview(MATCH.ref),
      placeSpans([
        [MATCH.ref, 790, 804],
        [MATCH.ref, 4285, 4299],
        [MATCH.ref, 5295, 5309],
      ]),
      say("A 42-second best-of: the three blue goals."),
    ],
  },
  {
    id: "hl_cut_halftime",
    title: "Take a long dead stretch (half time) out of a match",
    tags: tags("highlights", 1, 2, "remove-section"),
    surface: "studio",
    footage: { clips: [MATCH_CLIP] },
    seed: onTimeline(MATCH.ref, MATCH.seconds),
    prompt: "Take the half-time break out of this match recording and keep both halves.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 12,
    expect: (final) =>
      checkReel(final, {
        refs: [MATCH.ref],
        moments: [
          { name: "the first half", at: [10, MATCH.halfTime[0] - 10] },
          { name: "the second half", at: [MATCH.halfTime[1] + 10, MATCH.seconds - 10] },
        ],
        allowed: [{ span: [0, MATCH.halfTime[0]] }, { span: [MATCH.halfTime[1], MATCH.seconds] }],
        slack: 10,
        maxOutside: 20,
        order: true,
      }),
    reference: [
      overviewClip(),
      keepOnly(
        [
          [0, MATCH.halfTime[0]],
          [MATCH.halfTime[1], MATCH.seconds],
        ],
        MATCH.seconds,
      ),
      say(
        "Removed the 15-minute half-time break (45:00 to 60:00); both halves now run straight on.",
      ),
    ],
  },
  {
    id: "hl_named_speaker",
    title: "Every part where one named person speaks, from a 72-minute panel",
    tags: tags("highlights", 1, 2, "speaker"),
    surface: "studio",
    footage: { clips: [PANEL_CLIP] },
    seed: onTimeline(PANEL.ref, PANEL.seconds),
    prompt:
      "Pull out every part where Mara is talking and put them together in order. Leave everyone else out.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 16,
    expect: (final) =>
      checkReel(final, {
        refs: [PANEL.ref],
        moments: MARA_WORDS.map(([a, b], i) => ({
          name: `Mara's turn ${i + 1}`,
          at: [a + 0.5, b - 0.5] as Span,
        })),
        allowed: MARA_SAYS.map((span) => ({ span })),
        slack: 4,
        maxOutside: 10,
        order: true,
      }),
    reference: [
      overviewClip(),
      listen(PANEL.ref, 0, PANEL.seconds),
      keepOnly(MARA_SAYS, PANEL.seconds),
      say(
        "Kept Mara's five turns, in order: her opening, her two discussion answers and her two answers to the audience.",
      ),
    ],
  },
  {
    id: "hl_qa_questions_only",
    title: "Only the audience's questions from a panel in the library",
    tags: tags("highlights", 1, 1, "library", "q-and-a"),
    surface: "studio",
    footage: { clips: [PANEL_CLIP] },
    seed: emptyHD,
    prompt:
      "From the panel recording in my library, make a video of just the audience questions: only the " +
      "people asking at the microphone, not the panel's answers. I'll answer them myself in another video.",
    scope: PLACE_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 16,
    expect: (final) =>
      checkReel(final, {
        refs: [PANEL.ref],
        moments: PANEL.asked.map(([a, b], i) => ({
          name: `question ${i + 1}`,
          at: [a, b] as Span,
        })),
        allowed: PANEL.questions.map(([a, b]) => ({ span: [a, b] as Span })),
        slack: 2,
        maxOutside: 4,
        order: true,
      }),
    reference: [
      overview(PANEL.ref),
      listen(PANEL.ref, 2800, 4000),
      placeSpans(PANEL.asked.map(([a, b]) => [PANEL.ref, a - 1, b + 1] as const)),
      say("Here are the four questions from the floor, one after another, without the answers."),
    ],
  },
  {
    id: "hl_find_one_demo",
    title: "Cut a one-hour lecture down to its one demonstration",
    tags: tags("highlights", 1, 2, "single-moment"),
    surface: "studio",
    footage: { clips: [LECTURE_CLIP] },
    seed: onTimeline(LECTURE.ref, LECTURE.seconds),
    prompt:
      "Somewhere in this lecture she pours coloured water into a tank. Cut the video down to just that demonstration.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 12,
    expect: (final) =>
      checkReel(final, {
        refs: [LECTURE.ref],
        moments: [
          {
            name: "the water-tank demonstration",
            at: [LECTURE.demo[0] + 10, LECTURE.demo[1] - 10],
          },
        ],
        allowed: [{ span: LECTURE.demo as Span }],
        slack: 10,
        maxOutside: 12,
      }),
    reference: [
      overviewClip(),
      step(["inspect_media", { clip_id: "full", start_seconds: 1690, end_seconds: 1900 }]),
      keepOnly([LECTURE.demo as Span], LECTURE.seconds),
      say(
        "Cut down to the demonstration, from 28:30 to 31:30, where she pours the blue water into the tank.",
      ),
    ],
  },
  {
    id: "hl_ceremony_moments",
    title: "Four named moments of a 48-minute ceremony, in order, nothing else",
    tags: tags("highlights", 1, 1, "library", "named-moments"),
    surface: "studio",
    footage: { clips: [CEREMONY_CLIP] },
    seed: emptyHD,
    prompt:
      "Make a short film from the ceremony recording in my library: the walk down the aisle, the vows, " +
      "the rings and the kiss, in that order, and nothing else.",
    scope: PLACE_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    expect: (final) =>
      checkReel(final, {
        refs: [CEREMONY.ref],
        moments: [
          { name: "the walk down the aisle", window: CEREMONY.aisle as Span, minKeep: 10 },
          { name: "the vows", at: [CEREMONY.vows[0] + 5, CEREMONY.vows[1] - 5] },
          { name: "the rings", window: CEREMONY.rings as Span, minKeep: 10 },
          { name: "the kiss", at: [CEREMONY.kiss[0] + 1, CEREMONY.kiss[1] - 1] },
        ],
        allowed: [
          { span: CEREMONY.aisle as Span },
          { span: CEREMONY.vows as Span },
          { span: [1680, CEREMONY.rings[1]] },
          { span: CEREMONY.kiss as Span },
        ],
        slack: 5,
        maxOutside: 10,
        order: true,
      }),
    reference: [
      overview(CEREMONY.ref),
      listen(CEREMONY.ref, 1490, 1820),
      placeSpans([
        [CEREMONY.ref, 440, 480],
        [CEREMONY.ref, 1500, 1680],
        [CEREMONY.ref, 1700, 1745],
        [CEREMONY.ref, 1798, 1815],
      ]),
      say("Your short film: the walk down the aisle, both sets of vows, the rings and the kiss."),
    ],
  },
  {
    id: "hl_teaser_followup",
    title: "Cut to two moments, then put a third first as a teaser",
    tags: tags("highlights", 2, 2, "follow-up", "custom-order"),
    surface: "studio",
    footage: { clips: [CEREMONY_CLIP] },
    seed: onTimeline(CEREMONY.ref, CEREMONY.seconds),
    prompt: "Cut this down to just the vows and the ring exchange.",
    followUps: ["Now open it with the kiss, as a teaser before the vows."],
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 16,
    expect: (final) =>
      checkReel(final, {
        refs: [CEREMONY.ref],
        moments: [
          { name: "the kiss", at: [CEREMONY.kiss[0] + 1, CEREMONY.kiss[1] - 1] },
          { name: "the vows", at: [CEREMONY.vows[0] + 5, CEREMONY.vows[1] - 5] },
          { name: "the ring exchange", window: CEREMONY.rings as Span, minKeep: 20 },
        ],
        allowed: [
          { span: CEREMONY.kiss as Span },
          { span: CEREMONY.vows as Span },
          { span: [1680, CEREMONY.rings[1]] },
        ],
        slack: 5,
        maxOutside: 10,
        order: true,
      }),
    reference: [
      overviewClip(),
      keepOnly([CEREMONY.vows as Span, CEREMONY.rings as Span], CEREMONY.seconds),
      say("Cut down to the vows and the ring exchange."),
      step([
        "insert_clips",
        { at: 0, entries: [{ media_ref: CEREMONY.ref, source_span: [1798, 1815] }] },
      ]),
      say("The kiss now opens the film, before the vows."),
    ],
  },
  {
    id: "hl_finder_too_long",
    title: "The AI moment search asked for on a two-hour stream it cannot take",
    tags: tags("highlights", 1, 2, "error-reply", "paid-look"),
    surface: "studio",
    footage: { clips: [STREAM_CLIP] },
    seed: onTimeline(STREAM.ref, STREAM.seconds),
    prompt:
      "Run the AI moment search on my stream to find where I finally beat the dragon, then cut the stream " +
      "down to just that fight.",
    // The search the person asked for refuses a video over 30 minutes: one refusal is allowed, and
    // what is graded is the cut and an honest word about the search, not whether it was tried.
    paidTools: ["video_find_moment", "video_ask"],
    maxToolErrors: 1,
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    expect: (final) =>
      checkReel(final, {
        refs: [STREAM.ref],
        moments: [{ name: "the fight that was won", at: [STREAM.win[0] + 10, STREAM.win[1] - 10] }],
        allowed: [{ span: STREAM.win as Span }],
        slack: 15,
        maxOutside: 20,
      }),
    expectTrace: (t) => {
      if (callsOf(t, "video_find_moment").length > 1)
        throw new Error("asked the moment search again after it refused the video");
      if (
        !/too long|longer than|that long|this long|so long|exceed|over (30|thirty)[ -]?min|(30|thirty)[ -]?min|half an hour|limit|(two|2)[ -]hours?\b/i.test(
          said(t),
        )
      )
        throw new Error(
          "the reply does not tell the person the moment search cannot take a video this long",
        );
    },
    reference: [
      step([
        "video_find_moment",
        { clip_id: "full", query: "the player defeats the red dragon, VICTORY banner" },
      ]),
      overviewClip(),
      step(["inspect_media", { clip_id: "full", start_seconds: 6280, end_seconds: 6800 }]),
      keepOnly([STREAM.win as Span], STREAM.seconds),
      say(
        "The AI moment search only takes videos up to 30 minutes, and your stream is two hours long, so I " +
          "found the fight by looking through it instead: the third try at the dragon, from 1:45:00 to 1:53:00, " +
          "where you win. The stream is now cut down to that fight.",
      ),
    ],
  },
  {
    id: "hl_topic_30s",
    title: "Thirty seconds of one topic from an 88-minute podcast in the library",
    tags: tags("highlights", 1, 1, "library", "topic"),
    surface: "studio",
    footage: { clips: [PODCAST_CLIP] },
    seed: emptyHD,
    prompt:
      "In the podcast episode in my library, find where she explains how she prices her bread, and give " +
      "me a 30-second clip of just that.",
    scope: PLACE_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 12,
    expect: (final) =>
      checkReel(final, {
        refs: [PODCAST.ref],
        moments: [
          { name: "how she prices her bread", window: PODCAST.breadPricing as Span, minKeep: 25 },
        ],
        allowed: [{ span: PODCAST.breadPricing as Span }],
        slack: 3,
        maxOutside: 3,
        total: [27, 33],
      }),
    reference: [
      listen(PODCAST.ref, 1200, 2700),
      placeSpans([[PODCAST.ref, 1832, 1862]]),
      say(
        "Here's a 30-second clip from 30:32 where she explains pricing bread by the weight of the loaf.",
      ),
    ],
  },
  {
    id: "hl_topic_recap",
    title: "A two-minute recap with one piece from each of four parts",
    tags: tags("highlights", 1, 2, "recap"),
    surface: "studio",
    footage: { clips: [PODCAST_CLIP] },
    seed: onTimeline(PODCAST.ref, PODCAST.seconds),
    prompt:
      "Make a recap of this episode: one short bit from each of its four parts, in the order they come up, " +
      "about two minutes in total.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    expect: (final) => {
      checkReel(final, {
        refs: [PODCAST.ref],
        moments: PODCAST.topics.map(([a, b], i) => ({
          name: `part ${i + 1}`,
          window: [a, b] as Span,
          minKeep: 5,
        })),
        allowed: PODCAST.topics.map(([a, b]) => ({ span: [a, b] as Span })),
        slack: 2,
        maxOutside: 4,
        total: [90, 150],
      });
      // One bit from EACH part, in the order the parts come: a piece per part, none across two.
      const bits = segments(pieces(final, [PODCAST.ref]));
      const partOf = (p: Piece) =>
        PODCAST.topics.findIndex(([a, b]) => p.s >= a - 2 && p.e <= b + 2);
      const parts = bits.map(partOf);
      if (parts.some((i) => i < 0)) throw new Error("a piece runs across two parts of the episode");
      if (parts.join() !== "0,1,2,3")
        throw new Error(
          `the pieces come from parts ${parts.map((i) => i + 1).join(", ")}; asked for one from each of the four, in order`,
        );
    },
    reference: [
      overviewClip(),
      listen(PODCAST.ref, 0, PODCAST.seconds),
      keepOnly(
        [
          [30, 60],
          [1832, 1862],
          [2712, 2742],
          [4201, 4231],
        ],
        PODCAST.seconds,
      ),
      say(
        "A two-minute recap: how the bakery started, pricing bread, hiring, and the listener questions.",
      ),
    ],
  },
  {
    id: "hl_songs_only",
    title: "Just the songs of a 42-minute gig, the talking between them cut",
    tags: tags("highlights", 1, 2, "remove-between"),
    surface: "studio",
    footage: { clips: [GIG_CLIP] },
    seed: onTimeline(GIG.ref, GIG.seconds),
    prompt:
      "Cut out all the talking and tuning between songs so it's just the music, one song straight into the next.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 14,
    expect: (final) =>
      checkReel(final, {
        refs: [GIG.ref],
        moments: GIG.songs.map(([a, b], i) => ({
          name: `song ${i + 1}`,
          at: [a + 3, b - 3] as Span,
        })),
        allowed: GIG.songs.map(([a, b]) => ({ span: [a, b] as Span })),
        slack: 4,
        maxOutside: 15,
        order: true,
      }),
    reference: [
      overviewClip(),
      keepOnly(
        GIG.songs.map(([a, b]): Span => [a, b]),
        GIG.seconds,
      ),
      say("All seven songs now run straight into each other, with the talking and tuning cut."),
    ],
  },
  {
    id: "hl_boat_shots",
    title: "Footage with no sound: keep only the shots with one subject in them",
    tags: tags("highlights", 1, 1, "visual-only"),
    surface: "studio",
    footage: { clips: [DRONE_CLIP] },
    seed: onTimeline(DRONE.ref, DRONE.seconds, false),
    prompt:
      "This drone footage has no sound. Keep only the shots with the red sailing boat in them, in the order " +
      "they were filmed.",
    scope: CUT_SCOPE_SILENT,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 12,
    expect: (final) =>
      checkReel(final, {
        refs: [DRONE.ref],
        moments: DRONE.boat.map(([a, b], i) => ({
          name: `boat shot ${i + 1}`,
          at: [a + 2, b - 2] as Span,
        })),
        allowed: DRONE.boat.map(([a, b]) => ({ span: [a, b] as Span })),
        slack: 3,
        maxOutside: 5,
        order: true,
      }),
    reference: [
      overviewClip(),
      keepOnly(
        DRONE.boat.map(([a, b]): Span => [a, b]),
        DRONE.seconds,
      ),
      say("Kept the three shots of the red sailing boat, in the order they were filmed."),
    ],
  },
  {
    id: "hl_three_days_reel",
    title: "One named moment from each of three long vlogs, in day order",
    tags: tags("highlights", 1, 3, "library", "multi-source"),
    surface: "studio",
    footage: { clips: TRIP_CLIPS },
    seed: emptyHD,
    prompt:
      "I've got three long travel vlogs in my library, one for each day. Make a one-minute reel with one " +
      "moment from each: reaching the summit, the whale, and the fireworks, in day order.",
    scope: PLACE_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 16,
    expect: (final) =>
      checkReel(final, {
        refs: TRIP.days.map((d) => d.ref),
        moments: [
          {
            name: "the summit",
            ref: TRIP.days[0].ref,
            window: TRIP.days[0].moment as Span,
            minKeep: 8,
          },
          {
            name: "the whale",
            ref: TRIP.days[1].ref,
            window: TRIP.days[1].moment as Span,
            minKeep: 8,
          },
          {
            name: "the fireworks",
            ref: TRIP.days[2].ref,
            window: TRIP.days[2].moment as Span,
            minKeep: 8,
          },
        ],
        allowed: TRIP.days.map((d) => ({ ref: d.ref, span: d.moment as Span })),
        slack: 4,
        maxOutside: 6,
        order: true,
        total: [45, 75],
      }),
    reference: [
      step(
        ...TRIP.days.map((d): [string, Record<string, unknown>] => [
          "inspect_media",
          { media_ref: d.ref, overview: true },
        ]),
      ),
      placeSpans([
        [TRIP.days[0].ref, 1530, 1555],
        [TRIP.days[1].ref, 980, 1000],
        [TRIP.days[2].ref, 1705, 1720],
      ]),
      say(
        "A one-minute reel: the summit on day one, the whale on day two and the fireworks on day three.",
      ),
    ],
  },
  {
    id: "hl_vertical_short_chip",
    title: "The 'Make a vertical short' starter, on a 28-minute session",
    tags: tags("highlights", 1, 2, "starter-chip", "vertical"),
    surface: "studio",
    footage: { clips: [SKATE_CLIP] },
    seed: onTimeline(SKATE.ref, SKATE.seconds),
    // The app's own starter text, as the chip puts it in the composer.
    prompt: STARTER_PROMPTS.find((p) => p.label === "Make a vertical short")!.text,
    // The chip names the moment search among its tools; the session is under its 30-minute limit.
    paidTools: ["video_find_moment", "video_ask"],
    scope: { ...CUT_SCOPE, canvas: ["width", "height"] },
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 16,
    expect: (final) => {
      const { width, height } = final.canvas;
      if (Math.abs(width / height - 9 / 16) > 0.01)
        throw new Error(`the canvas is ${width}x${height}, not 9:16`);
      // A short is a minute or so; which moments are strongest is taste, that they are moments is not.
      checkReel(final, {
        refs: [SKATE.ref],
        moments: [],
        allowed: SKATE.moments.map(([a, b]) => ({ span: [a, b] as Span })),
        slack: 3,
        maxOutside: 4,
        minPieces: 2,
        total: [4, 90],
      });
      // Vertical means the picture fills the frame: a 16:9 picture boxed inside 9:16 is mostly black.
      for (const t of final.tracks ?? [])
        for (const c of t.clips ?? []) {
          if (c.media_ref !== SKATE.ref || clipKind(c) !== "video") continue;
          const scale = Math.max(
            lowest(c.transform?.scale, 1),
            Math.min(lowest(c.transform?.scale_x, 1), lowest(c.transform?.scale_y, 1)),
          );
          if (c.fit !== "cover" && scale < 3.1)
            throw new Error(
              `clip ${String(c.id)} is letterboxed in the vertical frame (fit ${String(c.fit ?? "contain")}, scale ${scale})`,
            );
        }
    },
    reference: [
      overviewClip(),
      step(["set_project_settings", { size: { aspect_ratio: "9:16" } }]),
      keepOnly(
        [
          [212, 220],
          [640, 650],
          [1105, 1114],
          [1590, 1602],
        ],
        SKATE.seconds,
      ),
      step(["get_timeline", {}]),
      {
        calls: (req) => {
          const tl = results(req, "get_timeline")[0]?.timeline as { tracks?: Track[] } | undefined;
          const ids = (tl?.tracks ?? [])
            .filter((t) => t.kind === "video")
            .flatMap((t) => t.clips ?? [])
            .filter((c) => c.media_ref === SKATE.ref)
            .map((c) => String(c.id));
          return [["set_clip_properties", { clip_ids: ids, fit: "cover" }]];
        },
      },
      say(
        "A 39-second vertical short: the kickflip, the heelflip down the stairs, the tre flip and the 50-50 on the big rail.",
      ),
    ],
  },
  {
    id: "hl_given_timestamps",
    title: "Three spans given as timestamps (one over an hour), in the person's order",
    tags: tags("highlights", 1, 2, "timestamps", "custom-order"),
    surface: "studio",
    footage: { clips: [PODCAST_CLIP] },
    seed: onTimeline(PODCAST.ref, PODCAST.seconds),
    prompt:
      "Keep only these parts of the episode, in this order: 1:02:10 to 1:03:40, then 12:05 to 13:00, then " +
      "41:30 to 42:15. Drop everything else.",
    scope: CUT_SCOPE,
    mustNotCall: ["run_ffmpeg"],
    maxRounds: 10,
    expect: (final) => {
      const asked: [string, Span][] = [
        ["1:02:10 to 1:03:40", [3730, 3820]],
        ["12:05 to 13:00", [725, 780]],
        ["41:30 to 42:15", [2490, 2535]],
      ];
      checkReel(final, {
        refs: [PODCAST.ref],
        moments: asked.map(([name, [a, b]]) => ({
          name,
          at: [a + 1, b - 1] as Span,
          pieceLen: [b - a - 1.5, b - a + 1.5] as Span,
        })),
        allowed: asked.map(([, span]) => ({ span })),
        slack: 1,
        maxOutside: 3,
        order: true,
      });
    },
    reference: [
      step(["remove_clips", { clip_ids: ["full"] }]),
      placeSpans([
        [PODCAST.ref, 3730, 3820],
        [PODCAST.ref, 725, 780],
        [PODCAST.ref, 2490, 2535],
      ]),
      say("Kept 1:02:10-1:03:40, then 12:05-13:00, then 41:30-42:15, in that order."),
    ],
  },
];

// â”€â”€ gap 6: bringing media in and laying it out â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const whole = (ref: string, seconds: number): Placed => ({ ref, frames: fr(seconds) });

/** Place what the previous round imported, in `order` of filenames, back to back from `from`; a
 *  file without a `frames` length plays whole (its length is the fixture's: the reply carries none). */
export function placeImported(
  order: readonly string[],
  frames: (file: string) => number | undefined = () => undefined,
  from = 0,
): ReferenceStep {
  return {
    calls: (req) => {
      const refs = importedRefs(req);
      let at = from;
      const entries = order.map((file) => {
        const n = frames(file);
        const entry: Record<string, unknown> = {
          media_ref: refs.get(file) ?? `(not imported: ${file})`,
          timeline_in: at,
          ...(n !== undefined ? { duration: n } : {}),
        };
        at += n ?? fr(LENGTHS.get(file) ?? 0);
        return entry;
      });
      return [["add_clips", { entries }]];
    },
  };
}
/** Every fixture file's length in seconds, by filename, for the correct runs' arithmetic. */
const LENGTHS = new Map<string, number>(
  [
    ...SHOOT_CLIPS,
    ...harbourClips(() => false),
    ...TAKES_CLIPS,
    ...MARKET_CLIPS,
    ...LISBON_CLIPS,
    ...INTERVIEW_CLIPS,
    ...AUDIO_CLIPS,
  ].map((c) => [c.filename, c.duration_s ?? 0]),
);

const harbourSeed = (): Timeline => {
  let at = 0;
  const clips = HARBOUR.slice(0, 4).map(([ref, , seconds], i) => {
    const c = vclip(`h${i + 1}`, ref, at, at + fr(seconds));
    at += fr(seconds);
    return c;
  });
  return timeline([vtrack("v1", 0, clips)], HD);
};
const HARBOUR_SEED_END = HARBOUR.slice(0, 4).reduce((n, [, , s]) => n + fr(s), 0);

const tutorialSeed = (): Timeline =>
  timeline(
    [vtrack("v1", 0, [vclip("screen", TUTORIAL.screen.ref, 0, fr(TUTORIAL.screen.seconds))])],
    HD,
  );
const interviewSeed = (): Timeline =>
  timeline(
    [
      vtrack("v1", 0, [
        vclip("interview", INTERVIEW.ref, 0, fr(INTERVIEW.seconds), { link_group: "lg_iv" }),
      ]),
      atrack("a1", 0, [
        aclip("interview_audio", INTERVIEW.ref, 0, fr(INTERVIEW.seconds), { link_group: "lg_iv" }),
      ]),
    ],
    HD,
  );
const narrationSeed = (): Timeline =>
  timeline(
    [
      atrack("a1", 0, [
        aclip("narration", LIGHTHOUSE.narration.ref, 0, fr(LIGHTHOUSE.narration.seconds)),
      ]),
    ],
    HD,
  );
const introSeed = (): Timeline =>
  timeline([vtrack("v1", 0, [vclip("intro", "media_intro_card", 0, 150)])], HD);

/** The reply names what is still importing, as the import note asks (agent/importNote.ts). */
const IMPORTING_ROWS = GARDEN.importing.map((name, i) => ({
  path: `D:/Videos/garden/${name}`,
  name,
  fraction: i === 0 ? 0.4 : null,
}));

const LAYOUT: Scenario[] = [
  {
    id: "lay_named_order",
    title: "Import four files and lay them out in an order the person names",
    tags: tags("import-layout", 1, 0, "import", "order"),
    surface: "studio",
    footage: { clips: SHOOT_CLIPS },
    seed: emptyHD,
    prompt:
      "Import these four files and lay them back to back in this order: the drone opener, then the market " +
      "b-roll, then the interview, then the sunset outro. D:\\Shoot\\interview_a.mp4, " +
      "D:\\Shoot\\outro_sunset.mp4, D:\\Shoot\\drone_open.mp4, D:\\Shoot\\broll_market.mp4",
    expectTools: ["import_media", "add_clips"],
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        [SHOOT.drone, SHOOT.market, SHOOT.interview, SHOOT.sunset].map((s) =>
          whole(s.ref, s.seconds),
        ),
        { only: true },
      ),
    reference: [
      step(
        ...[SHOOT.interview, SHOOT.sunset, SHOOT.drone, SHOOT.market].map(
          (s): [string, Record<string, unknown>] => [
            "import_media",
            { source: { path: `D:\\Shoot\\${s.file}` } },
          ],
        ),
      ),
      placeImported([SHOOT.drone.file, SHOOT.market.file, SHOOT.interview.file, SHOOT.sunset.file]),
      say(
        "Imported all four and laid them out: drone opener, market b-roll, interview, sunset outro.",
      ),
    ],
  },
  {
    id: "lay_folder_all",
    title: "Import a whole folder and put every clip on the timeline",
    tags: tags("import-layout", 1, 0, "import", "folder"),
    surface: "studio",
    footage: { clips: harbourClips(() => false) },
    seed: emptyHD,
    prompt:
      "Bring in everything from the folder D:\\Footage\\harbour and put all of it on the timeline, one clip " +
      "after another.",
    expectTools: ["import_media", "add_clips"],
    scope: PLACE_SCOPE,
    maxRounds: 8,
    // No order was asked for: every clip once, whole, with no gaps, is the whole request.
    expect: (final) =>
      checkSequence(
        final,
        HARBOUR.map(([ref, , s]) => whole(ref, s)),
        { ordered: false, only: true },
      ),
    reference: [
      step(["import_media", { source: { path: "D:\\Footage\\harbour" } }]),
      placeImported(HARBOUR.map(([, file]) => file)),
      say("Imported the six harbour clips and placed them one after another."),
    ],
  },
  {
    id: "lay_photos_and_videos",
    title: "A folder of photos and videos: filename order, each photo a set length",
    tags: tags("import-layout", 1, 0, "import", "folder", "photos"),
    surface: "studio",
    footage: { clips: LISBON_CLIPS },
    seed: emptyHD,
    prompt:
      "Import the folder D:\\Trip\\lisbon and put everything on the timeline in filename order. Show each " +
      "photo for 3 seconds and play the videos in full.",
    expectTools: ["import_media", "add_clips"],
    scope: PLACE_ALL_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        LISBON.map((m) =>
          m.kind === "image" ? { ref: m.ref, frames: fr(3) } : whole(m.ref, m.seconds),
        ),
        { only: true },
      ),
    reference: [
      step(["import_media", { source: { path: "D:\\Trip\\lisbon" } }]),
      placeImported(
        LISBON.map((m) => m.file),
        (file) => (file.endsWith(".jpg") ? fr(3) : undefined),
      ),
      say(
        "Imported the folder and placed all five in filename order: photos for 3 seconds each, videos in full.",
      ),
    ],
  },
  {
    id: "lay_slideshow_to_song",
    title: "Library photos as a slideshow that lasts exactly as long as a song",
    tags: tags("import-layout", 1, 9, "library", "photos", "music"),
    surface: "studio",
    footage: { clips: QUAY_CLIPS },
    seed: emptyHD,
    prompt:
      "Make a slideshow from the eight quay photos in my library, in the order they're numbered, every photo " +
      "on screen for the same length, so the whole thing lasts exactly as long as the song evening_walk.mp3. " +
      "Put the song underneath.",
    scope: PLACE_ALL_SCOPE,
    maxRounds: 10,
    expect: (final) => {
      const each = fr(QUAY.song.seconds / QUAY.photos.length);
      checkSequence(
        final,
        QUAY.photos.map((ref) => ({ ref, frames: each })),
        { only: true },
      );
      const song = pieces(final, [QUAY.song.ref], ["audio"]);
      if (song.length !== 1) throw new Error(`the song is placed ${song.length} times, not once`);
      if (song[0].tin > 1)
        throw new Error(`the song starts at frame ${song[0].tin}, not under the first photo`);
      if (Math.abs(song[0].tout - song[0].tin - fr(QUAY.song.seconds)) > 1)
        throw new Error(
          `the song runs ${song[0].tout - song[0].tin} frames, not its whole ${fr(QUAY.song.seconds)}`,
        );
    },
    reference: [
      step(["library_op", { action: "list" }]),
      step(["inspect_media", { media_ref: QUAY.song.ref }]),
      step([
        "add_clips",
        {
          entries: [
            ...QUAY.photos.map((ref, i) => ({
              media_ref: ref,
              timeline_in: i * 180,
              duration: 180,
            })),
            { media_ref: QUAY.song.ref, timeline_in: 0 },
          ],
        },
      ]),
      say(
        "The song runs 48 seconds, so each of the eight photos is on screen for 6 seconds, with the song underneath.",
      ),
    ],
  },
  {
    id: "lay_pip_webcam",
    title: "A webcam recording as a small picture-in-picture over a screen recording",
    tags: tags("import-layout", 1, 2, "library", "pip"),
    surface: "studio",
    footage: { clips: TUTORIAL_CLIPS },
    seed: tutorialSeed,
    prompt:
      "Put my webcam recording over the screen recording as a small picture-in-picture in the bottom-right " +
      "corner. Start them together and keep it there the whole way through.",
    scope: PLACE_SCOPE,
    maxRounds: 10,
    expect: (final) => {
      const screen = (final.tracks ?? []).find((t) =>
        (t.clips ?? []).some((c) => c.id === "screen"),
      );
      const sc = screen?.clips?.find((c) => c.id === "screen");
      if (!sc || sc.timeline_in !== 0 || sc.timeline_out !== fr(TUTORIAL.screen.seconds))
        throw new Error("the screen recording was moved, cut or removed");
      const cams = visualClips(final).filter(({ clip }) => clip.media_ref === TUTORIAL.webcam.ref);
      if (cams.length !== 1) throw new Error(`the webcam is placed ${cams.length} times, not once`);
      const { clip, track } = cams[0];
      if (Number(track.z ?? 0) <= Number(screen?.z ?? 0))
        throw new Error(
          "the webcam is not on a track above the screen recording, so it would not show over it",
        );
      if (Math.abs(Number(clip.timeline_in)) > 1)
        throw new Error(`the webcam starts at frame ${clip.timeline_in}, not with the screen`);
      const len = Number(clip.timeline_out) - Number(clip.timeline_in);
      if (Math.abs(len - fr(TUTORIAL.webcam.seconds)) > 2)
        throw new Error(`the webcam runs ${len} frames, not the whole way through`);
      const tf = clip.transform ?? {};
      // At its largest and at its most left and top, if it is animated.
      const sx = highest(tf.scale_x, highest(tf.scale, 1));
      const sy = highest(tf.scale_y, highest(tf.scale, 1));
      if (!(sx <= 0.5 && sy <= 0.5 && sx >= 0.1 && sy >= 0.1))
        throw new Error(
          `the webcam is scaled ${sx}x${sy}; a small picture-in-picture is a tenth to half the frame`,
        );
      const x = lowest(tf.position?.x, 0.5);
      const y = lowest(tf.position?.y, 0.5);
      if (!(x >= 0.6 && y >= 0.6))
        throw new Error(`the webcam's centre is at (${x}, ${y}), not in the bottom-right corner`);
    },
    reference: [
      step(["library_op", { action: "list" }]),
      step(["add_track", { kind: "video", z: 1 }]),
      {
        calls: (req) => {
          const track = String(results(req, "add_track")[0]?.track_id ?? "");
          return [
            [
              "add_clips",
              { entries: [{ media_ref: TUTORIAL.webcam.ref, timeline_in: 0, track_id: track }] },
            ],
          ];
        },
      },
      {
        calls: (req) => [
          [
            "set_clip_properties",
            {
              clip_ids: createdPictures(req),
              transform: { position: { x: 0.83, y: 0.8 }, scale: 0.28 },
            },
          ],
        ],
      },
      say(
        "Your webcam now sits small in the bottom-right corner over the screen recording, for the full ten minutes.",
      ),
    ],
  },
  {
    id: "lay_broll_cutaways",
    title: "Import cutaways and lay them over an interview at given times",
    tags: tags("import-layout", 1, 2, "import", "folder", "cutaways"),
    surface: "studio",
    footage: { clips: INTERVIEW_CLIPS },
    seed: interviewSeed,
    prompt:
      "Import the three clips in D:\\Footage\\broll and use them as cutaways over the interview: the oven at " +
      "0:10, the flour at 0:45 and the shop front at 1:20, five seconds each. Keep the interview's sound.",
    expectTools: ["import_media", "add_clips"],
    // A cutaway may sit on a track above or overwrite the interview's picture on its own track: both
    // look and sound the same, so both are graded on what plays. An overwrite re-links the sound,
    // which must still play whole (checked below).
    scope: { change: ["interview", "interview_audio"], add: ["video", "audio"], addTracks: true },
    maxRounds: 10,
    expect: (final) => {
      const total = fr(INTERVIEW.seconds);
      const sound = pieces(final, [INTERVIEW.ref], ["audio"]);
      if (sound.length !== 1 || sound[0].tin !== 0 || sound[0].tout !== total || sound[0].s !== 0)
        throw new Error("the interview's sound no longer plays whole from the start");
      const brollSound = pieces(
        final,
        Object.values(BROLL).map((b) => b.ref),
        ["audio"],
      );
      if (brollSound.length)
        throw new Error(
          `a cutaway's own sound plays (${brollSound.map((p) => p.ref).join(", ")}); the interview's sound was to be kept`,
        );
      const zOf = (id: string) => Number((final.tracks ?? []).find((t) => t.id === id)?.z ?? 0);
      const picture = pieces(final, [INTERVIEW.ref]);
      const shown: Span[] = [];
      for (const b of Object.values(BROLL)) {
        const hits = pieces(final, [b.ref]);
        if (hits.length !== 1)
          throw new Error(`${b.file} is placed ${hits.length} times, not once`);
        const h = hits[0];
        if (Math.abs(h.tin - fr(b.at)) > 3)
          throw new Error(`${b.file} starts at frame ${h.tin}, not at ${fr(b.at)} (${b.at} s)`);
        if (Math.abs(h.tout - h.tin - fr(5)) > 3)
          throw new Error(`${b.file} runs ${h.tout - h.tin} frames, not five seconds`);
        if (
          picture.some(
            (p) =>
              p.tin < h.tout &&
              p.tout > h.tin &&
              p.track !== h.track &&
              zOf(p.track) >= zOf(h.track),
          )
        )
          throw new Error(`${b.file} is under the interview's picture, so it does not show`);
        shown.push([h.tin, h.tout]);
      }
      for (const p of picture)
        if (Math.abs(p.tin - p.s * FPS) > 1)
          throw new Error(
            `the interview's picture at frame ${p.tin} is out of step with its sound (it shows ${p.s.toFixed(1)} s of the recording)`,
          );
      const black = uncovered([0, total], [...picture.map((p): Span => [p.tin, p.tout]), ...shown]);
      if (black > 1) throw new Error(`${black} frames of the interview show no picture`);
    },
    reference: [
      step(["import_media", { source: { path: "D:\\Footage\\broll" } }]),
      step(["add_track", { kind: "video", z: 1 }]),
      {
        calls: (req) => {
          const track = String(results(req, "add_track")[0]?.track_id ?? "");
          return [
            [
              "add_clips",
              {
                entries: Object.values(BROLL).map((b) => ({
                  media_ref: b.ref,
                  timeline_in: fr(b.at),
                  duration: fr(5),
                  track_id: track,
                  with_audio: false,
                })),
              },
            ],
          ];
        },
      },
      say(
        "The oven, flour and shop-front cutaways sit over the interview at 0:10, 0:45 and 1:20, five seconds each, without their own sound.",
      ),
    ],
  },
  {
    id: "lay_black_gaps",
    title: "Library clips in a given order with two seconds of black between them",
    tags: tags("import-layout", 1, 3, "library", "gaps"),
    surface: "studio",
    footage: { clips: SCENES_CLIPS },
    seed: emptyHD,
    prompt:
      "Put scene one, scene two and scene three from my library on the timeline in that order, with two " +
      "seconds of black between each.",
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        SCENES.map((s) => whole(s.ref, s.seconds)),
        { gap: fr(2), only: true },
      ),
    reference: [
      step(["library_op", { action: "list" }]),
      step([
        "add_clips",
        {
          entries: [
            { media_ref: SCENES[0].ref, timeline_in: 0 },
            { media_ref: SCENES[1].ref, timeline_in: fr(10 + 2) },
            { media_ref: SCENES[2].ref, timeline_in: fr(10 + 2 + 8 + 2) },
          ],
        },
      ]),
      say(
        "Scenes one, two and three are on the timeline in order, with two seconds of black between each.",
      ),
    ],
  },
  {
    id: "lay_day2_by_time",
    title: "Every clip of one library folder, in the order the filenames' times say",
    tags: tags("import-layout", 1, BIG_LIBRARY.length, "library", "big-library", "order"),
    surface: "studio",
    footage: { clips: BIG_LIBRARY },
    seed: emptyHD,
    prompt:
      "Put every clip from the Day 2 folder of my library on the timeline in the order they were filmed. The " +
      "filenames start with the time of day.",
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        DAY2_IN_SHOOTING_ORDER.map((ref) => whole(ref, DAY2.find((d) => d.ref === ref)!.seconds)),
        { only: true },
      ),
    reference: [
      step(["library_op", { action: "list", folder: "Day 2" }]),
      (() => {
        let at = 0;
        const entries = DAY2_IN_SHOOTING_ORDER.map((ref) => {
          const e = { media_ref: ref, timeline_in: at };
          at += fr(DAY2.find((d) => d.ref === ref)!.seconds);
          return e;
        });
        return step(["add_clips", { entries }]);
      })(),
      say("The six Day 2 clips are on the timeline from 07:42 sunrise to 19:55 dinner."),
    ],
  },
  {
    id: "lay_takes_number_order",
    title: "Numbered takes from a folder, in number order (take 10 after take 9)",
    tags: tags("import-layout", 1, 0, "import", "folder", "order"),
    surface: "studio",
    footage: { clips: TAKES_CLIPS },
    seed: emptyHD,
    prompt:
      "Import all the takes from E:\\Shoot\\takes and put them on the timeline in number order, take 1 first, " +
      "back to back.",
    expectTools: ["import_media", "add_clips"],
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        TAKES.map((t) => whole(t.ref, t.seconds)),
        { only: true },
      ),
    reference: [
      step(["import_media", { source: { path: "E:\\Shoot\\takes" } }]),
      placeImported(TAKES.map((t) => t.filename)),
      say("All eleven takes are on the timeline in number order, take 1 to take 11."),
    ],
  },
  {
    id: "imp_did_it_import",
    title: "Import a folder without placing it, then answer whether it all came in",
    tags: tags("import-layout", 2, 0, "import", "folder", "question"),
    surface: "studio",
    footage: { clips: MARKET_CLIPS },
    seed: emptyHD,
    prompt:
      "Bring the clips in D:\\Footage\\market into my library. Don't put them on the timeline yet.",
    followUps: ["Did they all come in? How many is that?"],
    scope: {},
    maxRounds: 8,
    expect: untouched(emptyHD),
    expectTrace: (t) => {
      const imports = t.toolCalls.filter((c) => c.name === "import_media" && c.ok);
      const brought = new Set<string>();
      for (const c of imports) {
        if (names(c.args, "footage/market")) brought.add("folder");
      }
      if (!brought.size) throw new Error("the market clips were never imported");
      if (t.toolCalls.some((c) => c.name === "import_media" && (c.turn ?? 0) > 0))
        throw new Error("imported again when asked whether the import worked");
      if (!/\b(5|five)\b/i.test(said(t)))
        throw new Error("the answer does not say how many clips came in (five)");
    },
    reference: [
      step(["import_media", { source: { path: "D:\\Footage\\market" } }]),
      say("Done: the market clips are in your library, not on the timeline."),
      step(["library_op", { action: "list" }]),
      say(
        "Yes, all five came in: market_fruit, market_fish, market_flowers, market_bread and market_crowd.",
      ),
    ],
  },
  {
    id: "imp_new_files_only",
    title: "Two files added to a folder already imported: bring in and append only the new ones",
    tags: tags("import-layout", 1, 4, "import", "folder", "already-imported"),
    surface: "studio",
    footage: { clips: harbourClips((i) => i < 4) },
    seed: harbourSeed,
    prompt:
      "I've added two more clips to D:\\Footage\\harbour. Bring the new ones in and put them at the end of the timeline.",
    expectTools: ["import_media", "add_clips"],
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        HARBOUR.map(([ref, , s]) => whole(ref, s)),
        { only: true },
      ),
    reference: [
      step(["import_media", { source: { path: "D:\\Footage\\harbour" } }]),
      placeImported([HARBOUR[4][1], HARBOUR[5][1]], () => undefined, HARBOUR_SEED_END),
      say("harbour_05 and harbour_06 were the new ones; they now follow harbour_04 at the end."),
    ],
  },
  {
    id: "imp_note_still_importing",
    title: "Place the library's clips while two more are still importing",
    tags: tags("import-layout", 1, 4, "library", "import-note"),
    surface: "studio",
    footage: { clips: GARDEN_CLIPS },
    seed: emptyHD,
    // Composed exactly as the app sends a message while files are importing (agent/compose.ts with
    // agent/importNote.ts): the person's words, then the note the app adds.
    prompt: composeModelText("Put all my garden clips on the timeline in order.", [], [], {
      importNote: importNote(IMPORTING_ROWS) ?? undefined,
    }),
    // The note says the two files arrive by themselves and must not be imported again.
    mustNotCall: ["import_media"],
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) =>
      checkSequence(
        final,
        GARDEN.inLibrary.map((ref, i) => whole(ref, 6 + i)),
        { only: true },
      ),
    expectTrace: (t) => {
      if (
        !/garden_5|garden_6|\b(two|2) (more|other|remaining|still|clips|files)\b|still (importing|coming|loading|being imported|in progress|on (their|the) way)|on (their|the) way/i.test(
          said(t),
        )
      )
        throw new Error("the reply does not tell the person that two clips are still coming in");
    },
    reference: [
      step(["library_op", { action: "list" }]),
      step([
        "add_clips",
        {
          entries: GARDEN.inLibrary.map((ref, i) => ({
            media_ref: ref,
            timeline_in: GARDEN.inLibrary.slice(0, i).reduce((n, _, k) => n + fr(6 + k), 0),
          })),
        },
      ]),
      say(
        "Garden clips 1 to 4 are on the timeline in order. garden_5 and garden_6 are still importing; once they land I can add them to the end.",
      ),
    ],
  },
  {
    id: "imp_missing_file",
    title: "A file that is not where the person says: report it, change nothing",
    tags: tags("import-layout", 1, 1, "import", "error-reply"),
    surface: "studio",
    footage: {
      clips: [
        {
          media_ref: "media_intro_card",
          filename: "intro_card.mp4",
          kind: "video",
          duration_s: 5,
          audio: false,
        },
      ],
    },
    seed: introSeed,
    prompt: "Import D:\\Exports\\final_cut_v3.mov and put it at the start of the timeline.",
    // The import is refused (no such file) on purpose: once, plus one other path tried in good faith.
    maxToolErrors: 2,
    scope: {},
    maxRounds: 6,
    expect: untouched(introSeed),
    expectTrace: (t) => {
      if (!callsOf(t, "import_media").length) throw new Error("never tried to import the file");
      if (
        !/couldn'?t|could not|can'?t|cannot|unable|wasn'?t able|was not able|no file|not found|doesn'?t exist|does not exist|isn'?t there|is not there/i.test(
          said(t),
        )
      )
        throw new Error("the reply does not say the file could not be found");
    },
    reference: [
      step(["import_media", { source: { path: "D:\\Exports\\final_cut_v3.mov" } }]),
      say(
        "I couldn't import it: there is no file at D:\\Exports\\final_cut_v3.mov. Could you check the name and folder? Nothing on the timeline was changed.",
      ),
    ],
  },
  {
    id: "lay_everything_in_library",
    title: "Everything in a small library on the timeline: pictures in a row, the song under them",
    tags: tags("import-layout", 1, SMALL_LIBRARY_CLIPS.length, "library", "mixed-kinds"),
    surface: "studio",
    footage: { clips: SMALL_LIBRARY_CLIPS },
    seed: emptyHD,
    prompt: "Put everything in my library on the timeline.",
    scope: PLACE_ALL_SCOPE,
    maxRounds: 8,
    // Neither an order nor a length per photo was asked for: every asset once, pictures with no
    // black between them, and the song on an audio track, is what the request makes plain.
    expect: (final) => {
      const vis = visualClips(final);
      const want = [...SMALL_LIBRARY.videos, ...SMALL_LIBRARY.photos];
      for (const ref of want) {
        const n = vis.filter(({ clip }) => clip.media_ref === ref).length;
        if (n !== 1) throw new Error(`${ref} is on the timeline ${n} times, not once`);
      }
      const ps = pieces(final, want);
      oneAfterAnother(ps);
      for (const ref of SMALL_LIBRARY.videos) {
        const c = SMALL_LIBRARY_CLIPS.find((x) => x.media_ref === ref)!;
        const p = ps.find((x) => x.ref === ref)!;
        if (Math.abs(p.tout - p.tin - fr(c.duration_s ?? 0)) > 1)
          throw new Error(`${ref} is not played whole`);
      }
      const song = pieces(final, [SMALL_LIBRARY.song], ["audio"]);
      if (song.length !== 1) throw new Error(`the song is placed ${song.length} times, not once`);
    },
    reference: [
      step(["library_op", { action: "list" }]),
      (() => {
        let at = 0;
        const entries: Record<string, unknown>[] = [];
        for (const c of SMALL_LIBRARY_CLIPS) {
          if (c.kind === "audio") continue;
          entries.push({ media_ref: c.media_ref, timeline_in: at });
          at += c.kind === "image" ? fr(5) : fr(c.duration_s ?? 0);
        }
        entries.push({ media_ref: SMALL_LIBRARY.song, timeline_in: 0 });
        return step(["add_clips", { entries }]);
      })(),
      say(
        "All nine are on the timeline: the five videos and three photos one after another, and the song underneath from the start.",
      ),
    ],
  },
  {
    id: "lay_two_angles_stacked",
    title: "Two camera angles stacked on separate tracks, lined up at the start",
    tags: tags("import-layout", 1, 2, "library", "tracks"),
    surface: "studio",
    footage: { clips: ANGLES_CLIPS },
    seed: emptyHD,
    prompt:
      "Line up my two camera angles on separate tracks, both starting at the beginning, with the close-up on " +
      "the upper track so I can cut between them later.",
    scope: PLACE_SCOPE,
    maxRounds: 8,
    expect: (final) => {
      const vis = visualClips(final);
      const at = (ref: string) => {
        const hits = vis.filter(({ clip }) => clip.media_ref === ref);
        if (hits.length !== 1) throw new Error(`${ref} is placed ${hits.length} times, not once`);
        const { clip, track } = hits[0];
        if (Math.abs(Number(clip.timeline_in)) > 1)
          throw new Error(`${ref} starts at frame ${clip.timeline_in}, not at the beginning`);
        if (Math.abs(Number(clip.timeline_out) - Number(clip.timeline_in) - fr(300)) > 1)
          throw new Error(`${ref} is not placed whole`);
        return track;
      };
      const wide = at(ANGLES.wide.ref);
      const close = at(ANGLES.close.ref);
      if (wide.id === close.id) throw new Error("both angles are on the same track");
      if (Number(close.z ?? 0) <= Number(wide.z ?? 0))
        throw new Error("the close-up is not on the upper track");
    },
    reference: [
      step(["library_op", { action: "list" }]),
      step(["add_clips", { entries: [{ media_ref: ANGLES.wide.ref, timeline_in: 0 }] }]),
      step(["add_track", { kind: "video", z: 5 }]),
      {
        calls: (req) => [
          [
            "add_clips",
            {
              entries: [
                {
                  media_ref: ANGLES.close.ref,
                  timeline_in: 0,
                  track_id: String(results(req, "add_track")[0]?.track_id ?? ""),
                },
              ],
            },
          ],
        ],
      },
      say(
        "The wide angle is on the lower track and the close-up on the track above it, both from the start.",
      ),
    ],
  },
  {
    id: "lay_voice_and_music",
    title: "Import a voiceover and music: music under the voice, quieter, ending with it",
    tags: tags("import-layout", 1, 0, "import", "audio"),
    surface: "studio",
    footage: { clips: AUDIO_CLIPS },
    seed: emptyHD,
    prompt:
      "Import D:\\Audio\\voiceover_final.wav and D:\\Audio\\calm_piano.mp3. Put the voiceover at the start and " +
      "the piano underneath it on its own track, quieter than the voice, ending when the voiceover ends.",
    expectTools: ["import_media", "add_clips"],
    scope: PLACE_SCOPE,
    maxRounds: 10,
    expect: (final) => {
      const voice = pieces(final, [VOICE.ref], ["audio"]);
      const piano = pieces(final, [PIANO.ref], ["audio"]);
      if (voice.length !== 1 || piano.length !== 1)
        throw new Error(
          `the voiceover is placed ${voice.length} times and the piano ${piano.length}; each once`,
        );
      const [v, p] = [voice[0], piano[0]];
      if (v.tin > 1 || Math.abs(v.tout - fr(VOICE.seconds)) > 1)
        throw new Error("the voiceover is not whole at the start");
      if (p.track === v.track)
        throw new Error("the piano is on the voiceover's track, not its own");
      if (p.tin > 1)
        throw new Error(`the piano starts at frame ${p.tin}, not under the start of the voice`);
      if (Math.abs(p.tout - v.tout) > 2)
        throw new Error(`the piano ends at frame ${p.tout}; the voiceover ends at ${v.tout}`);
      const clipOf = (piece: Piece) =>
        (final.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === piece.id)!;
      const vc = clipOf(v);
      const pc = clipOf(p);
      const ducked = Boolean(pc.duck);
      // "Quieter than the voice": the music's loudest level stays under the voice's quietest.
      const [music, voiceLevel] = [highest(pc.volume, 1), lowest(vc.volume, 1)];
      if (!(music < voiceLevel && music <= 0.8) && !ducked)
        throw new Error(
          `the piano is at volume ${music} against the voice's ${voiceLevel}: not quieter`,
        );
    },
    reference: [
      step(
        ["import_media", { source: { path: "D:\\Audio\\voiceover_final.wav" } }],
        ["import_media", { source: { path: "D:\\Audio\\calm_piano.mp3" } }],
      ),
      step(["add_clips", { entries: [{ media_ref: VOICE.ref, timeline_in: 0 }] }]),
      step(["add_track", { kind: "audio" }]),
      {
        calls: (req) => [
          [
            "add_clips",
            {
              entries: [
                {
                  media_ref: PIANO.ref,
                  timeline_in: 0,
                  timeline_out: fr(VOICE.seconds),
                  track_id: String(results(req, "add_track")[0]?.track_id ?? ""),
                },
              ],
            },
          ],
        ],
      },
      {
        calls: (req) => {
          const created = results(req, "add_clips").flatMap(
            (r) => (r.created as { clip_id: string }[]) ?? [],
          );
          return [
            ["set_clip_properties", { clip_ids: created.map((c) => c.clip_id), volume: 0.3 }],
          ];
        },
      },
      say(
        "The voiceover starts the timeline, with the piano under it on its own track at 30% volume, ending with the voice at 1:35.",
      ),
    ],
  },
  {
    id: "lay_photos_to_narration",
    title: "One photo per spoken sentence, each on screen while its sentence plays",
    tags: tags("import-layout", 1, 6, "library", "photos", "transcript"),
    surface: "studio",
    footage: { clips: LIGHTHOUSE_CLIPS },
    seed: narrationSeed,
    prompt:
      "Put the five lighthouse photos from my library over the narration, one for each sentence, each on " +
      "screen while its sentence is spoken, in order.",
    scope: PLACE_ALL_SCOPE,
    maxRounds: 10,
    expect: (final) => {
      const vis = visualClips(final);
      LIGHTHOUSE.photos.forEach((ref, i) => {
        const hits = vis.filter(({ clip }) => clip.media_ref === ref);
        if (hits.length !== 1)
          throw new Error(`photo ${i + 1} is placed ${hits.length} times, not once`);
        const tin = Number(hits[0].clip.timeline_in);
        const tout = Number(hits[0].clip.timeline_out);
        const [a, b] = LIGHTHOUSE.sentences[i];
        const shown = Math.max(0, Math.min(tout, fr(b)) - Math.max(tin, fr(a)));
        if (shown < 0.85 * (fr(b) - fr(a)))
          throw new Error(
            `photo ${i + 1} (frames ${tin}-${tout}) is on screen for only ${shown} of sentence ${i + 1}'s ${fr(b) - fr(a)} frames`,
          );
        LIGHTHOUSE.sentences.forEach(([c, d], j) => {
          const mid = fr((c + d) / 2);
          if (j !== i && tin <= mid && mid < tout)
            throw new Error(`photo ${i + 1} is still on screen in the middle of sentence ${j + 1}`);
        });
      });
      const narration = pieces(final, [LIGHTHOUSE.narration.ref], ["audio"]);
      if (
        narration.length !== 1 ||
        narration[0].tin !== 0 ||
        narration[0].tout !== fr(LIGHTHOUSE.narration.seconds)
      )
        throw new Error("the narration was moved or cut");
    },
    reference: [
      step(["get_transcript", {}]),
      step([
        "add_clips",
        {
          entries: LIGHTHOUSE.photos.map((ref, i) => ({
            media_ref: ref,
            timeline_in: fr(LIGHTHOUSE.sentences[i][0]),
            timeline_out:
              i + 1 < LIGHTHOUSE.sentences.length
                ? fr(LIGHTHOUSE.sentences[i + 1][0])
                : fr(LIGHTHOUSE.narration.seconds),
          })),
        },
      ]),
      say(
        "Each photo now shows while its sentence is spoken: the rock, the keeper, the storm, the lamp and the museum.",
      ),
    ],
  },
];

export const GAP_MEDIA_SCENARIOS: Scenario[] = [...HIGHLIGHTS, ...LAYOUT];
