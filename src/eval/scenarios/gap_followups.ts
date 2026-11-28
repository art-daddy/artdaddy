// Follow-up and long-session cases: the person corrects the last edit, narrows or widens it,
// changes their mind, says "continue", "try again" or "undo that", refers to "the one you just
// added", or keeps an instruction from the first message standing for the whole session.
//
// Every case is graded on the FINAL project and on the edits the person accepted on the way: a
// correction that wipes an earlier, accepted edit fails, and so does one that lands on the wrong
// clip. Where the final project alone cannot tell "did it, then undid it" from "never did it",
// the trace says what landed and in which turn. Taste is never graded: only what the words make
// unambiguous ("a bit higher" is higher than before, not a particular height).
//
// Each case carries its correct run (`reference`): the calls a careful editor makes, one model
// round per step, a text step ending each turn. The tests replay it through the real harness
// with no model (scenarios.gap_followups.test.ts), next to realistic wrong runs that must fail.
import { toolEffect } from "../../agent/toolEffect";
import type { Clip, Timeline } from "../../timeline/model";
import { clipText, compactClip } from "../../timeline/shape";
import type { InferenceRequest } from "../harness";
import type { ReferenceCalls, ReferenceStep } from "../reference";
import type { Scenario, ToolCall, Trace } from "../types";
import {
  aclip,
  allClips,
  assert,
  atrack,
  clipById,
  near,
  span,
  timeline,
  vclip,
  vtrack,
} from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- graders read uncommon clip fields (color/fade/style/transition_in)
type Any = any;

// ── the correct run ─────────────────────────────────────────────────────────

/** A case here always carries its correct run. */
export type FollowupCase = Scenario & { reference: ReferenceStep[] };

/** The project a get_timeline call in the previous round returned. */
export function timelineRead(req: InferenceRequest): Timeline {
  const hit = (req.round_input.tool_results ?? []).find((r) => r.name === "get_timeline");
  if (!hit) throw new Error("the previous round read no timeline");
  return (hit.result as { timeline: Timeline }).timeline;
}
const read: ReferenceStep = { calls: [["get_timeline", {}]] };
/** A round that acts on the project the previous round read. */
const onRead = (f: (tl: Timeline) => ReferenceCalls): ReferenceStep => ({
  calls: (req) => f(timelineRead(req)),
});
const say = (text: string): ReferenceStep => ({ text });
const call = (name: string, args: Record<string, unknown>): ReferenceStep => ({
  calls: [[name, args]],
});

// ── readers ─────────────────────────────────────────────────────────────────

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
/** A scalar, or the last value of a keyframed one. */
const lastValue = (v: unknown, fallback: number): number =>
  Array.isArray(v) && v.length ? num((v[v.length - 1] as Any)?.v, fallback) : num(v, fallback);

const isText = (c: Clip): boolean => (c as Any).kind === "text";
const textClips = (tl: Timeline): Clip[] => allClips(tl).filter(isText);
const words = (c: Clip): string => clipText(c).replace(/\s+/g, " ").trim();
/** The one text clip that reads `want` (case and spacing ignored). */
function textReading(tl: Timeline, want: string): Clip {
  const hits = textClips(tl).filter((c) => words(c).toLowerCase() === want.toLowerCase());
  assert(
    hits.length === 1,
    `expected one text clip reading "${want}", got ${hits.length} (texts: ${JSON.stringify(textClips(tl).map(words))})`,
  );
  return hits[0];
}
/** Clips that play `ref`. */
const playing = (tl: Timeline, ref: string): Clip[] =>
  allClips(tl).filter((c) => String(c.media_ref ?? "") === ref);
function onlyOne(tl: Timeline, ref: string): Clip {
  const hits = playing(tl, ref);
  assert(hits.length === 1, `expected one clip playing ${ref}, got ${hits.length}`);
  return hits[0];
}
/** The picture clips (not text, not sound) by start, across every video track. */
function pictureOrder(tl: Timeline): Clip[] {
  return (tl.tracks ?? [])
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips ?? [])
    .filter((c) => !isText(c) && (c as Any).kind !== "audio")
    .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));
}
function assertOrder(tl: Timeline, refs: string[]): void {
  const got = pictureOrder(tl).map((c) => String(c.media_ref));
  assert(
    JSON.stringify(got) === JSON.stringify(refs),
    `expected the clips in the order ${refs.join(", ")}; got ${got.join(", ")}`,
  );
}
/** The picture clips run back to back from frame 0. */
function assertBackToBack(tl: Timeline, tol = 2): void {
  let cursor = 0;
  for (const c of pictureOrder(tl)) {
    assert(
      Math.abs(Number(c.timeline_in) - cursor) <= tol,
      `${c.media_ref} starts at ${c.timeline_in}f, the clip before it ends at ${cursor}f`,
    );
    cursor = Number(c.timeline_out);
  }
}

/** A clip as it plays, wherever it sits: everything but its place on the timeline. */
function content(c: Clip | undefined): string {
  const rest = { ...compactClip(c ?? ({} as Clip)) } as Record<string, unknown>;
  delete rest.timeline_in;
  delete rest.timeline_out;
  return JSON.stringify(sortKeys(rest));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort())
    if ((v as Record<string, unknown>)[k] != null)
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
  return out;
}
/** The seed clip `id` plays exactly as it did, at the same length (it may have moved). */
function asSeeded(seed: () => Timeline, final: Timeline, id: string): void {
  const was = clipById(seed(), id);
  const now = clipById(final, id);
  assert(now, `clip ${id} is gone`);
  assert(content(now) === content(was), `clip ${id} was changed: ${content(now)}`);
  assert(span(now) === span(was), `clip ${id} is ${span(now)}f long, it was ${span(was)}f`);
}

// ── colour ──────────────────────────────────────────────────────────────────

/** Every knob apply_color can set, at the value that changes nothing. */
const NEUTRAL_GRADE: Record<string, number> = {
  exposure: 0,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  vibrance: 0,
  temperature: 6500,
  tint: 0,
  highlights: 0,
  shadows: 0,
  blacks: 0,
  whites: 0,
  shadowsAmount: 0,
  shadowsLum: 0,
  midsAmount: 0,
  midsGamma: 1,
  highsAmount: 0,
  highsGain: 1,
};
/** The hue of a push is moot while its amount is zero. */
const HUE_KNOBS = new Set(["shadowsHue", "midsHue", "highsHue"]);
const gradeOf = (c: Clip | undefined): Record<string, unknown> =>
  ((c as Any)?.color ?? {}) as Record<string, unknown>;
const knob = (c: Clip | undefined, k: string): number => num(gradeOf(c)[k], NEUTRAL_GRADE[k] ?? 0);
/** Why the clip's grade is not the untouched one, or null when it is. */
function gradeChange(c: Clip | undefined): string | null {
  for (const [k, v] of Object.entries(gradeOf(c))) {
    if (v == null || HUE_KNOBS.has(k)) continue;
    if (k in NEUTRAL_GRADE) {
      if (Math.abs(num(v, NEUTRAL_GRADE[k]) - NEUTRAL_GRADE[k]) > (k === "temperature" ? 60 : 0.03))
        return `${k} is ${JSON.stringify(v)}`;
      continue;
    }
    return `${k} is set (${JSON.stringify(v).slice(0, 60)})`;
  }
  return null;
}
function assertUngraded(tl: Timeline, id: string, who = `clip ${id}`): void {
  const why = gradeChange(clipById(tl, id));
  assert(why === null, `${who} should look as it did: ${why}`);
}
const isBlackAndWhite = (c: Clip | undefined): boolean => knob(c, "saturation") <= 0.15;
function assertBlackAndWhite(tl: Timeline, id: string): void {
  assert(
    isBlackAndWhite(clipById(tl, id)),
    `clip ${id} is not black and white (saturation ${knob(clipById(tl, id), "saturation")})`,
  );
}

/** [r, g, b] in 0..1 of a hex colour (#rgb, #rrggbb, #rrggbbaa) or a few plain names. */
function rgbOf(colour: unknown): [number, number, number] | null {
  const named: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    yellow: "#ffff00",
    gold: "#ffd700",
  };
  let s = String(colour ?? "")
    .trim()
    .toLowerCase();
  s = named[s] ?? s;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (!m) return null;
  const hex =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((x) => x + x)
          .join("")
      : m[1].slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}
/** The style a text clip draws with: its own, or its first run's. */
function textStyle(c: Clip): Record<string, Any> {
  const own = ((c as Any).style ?? {}) as Record<string, Any>;
  const runs = Array.isArray((c as Any).content) ? ((c as Any).content as Any[]) : [];
  return { ...(runs[0]?.style ?? {}), ...own };
}
const isYellow = (rgb: [number, number, number] | null): boolean =>
  !!rgb && rgb[0] >= 0.75 && rgb[1] >= 0.75 && rgb[2] <= 0.45;
const isWhite = (rgb: [number, number, number] | null): boolean =>
  !!rgb && rgb.every((x) => x >= 0.9);
const isDark = (rgb: [number, number, number] | null): boolean =>
  !!rgb && 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] <= 0.25;
const isBold = (c: Clip): boolean => {
  const s = textStyle(c);
  return s.bold === true || num(s.weight, 400) >= 600;
};
/** The text's centre height, 0 (top) .. 1 (bottom); the centre when it was never placed. */
const textY = (c: Clip | Record<string, Any> | undefined): number =>
  lastValue((c as Any)?.transform?.position?.y, 0.5);

/** How many frames a clip fades in, as a fade or as an opacity ramp up from (near) zero. */
function fadeInFrames(c: Clip | undefined): number {
  const f = num((c as Any)?.fade?.in, 0);
  if (f > 0) return f;
  const op = (c as Any)?.opacity;
  if (!Array.isArray(op) || op.length < 2) return 0;
  const pts = [...op].sort((a, b) => num(a.t, 0) - num(b.t, 0));
  if (num(pts[0].v, 1) > 0.1) return 0;
  const full = pts.find((k) => num(k.v, 0) >= 0.8);
  return full ? num(full.t, 0) - num(pts[0].t, 0) : 0;
}
/** How many frames a clip fades out, as a fade or as an opacity ramp down to (near) zero. */
function fadeOutFrames(c: Clip | undefined): number {
  const f = num((c as Any)?.fade?.out, 0);
  if (f > 0) return f;
  const op = (c as Any)?.opacity;
  if (!Array.isArray(op) || op.length < 2) return 0;
  const pts = [...op].sort((a, b) => num(a.t, 0) - num(b.t, 0));
  const end = pts[pts.length - 1];
  if (num(end.v, 1) > 0.1) return 0;
  const full = [...pts].reverse().find((k) => num(k.v, 0) >= 0.8);
  return full ? num(end.t, 0) - num(full.t, 0) : 0;
}

// ── the trace ───────────────────────────────────────────────────────────────

function turnOf(c: ToolCall): number {
  assert(typeof c.turn === "number", `the run does not say which turn called ${c.name}`);
  return c.turn as number;
}
/** A call that succeeded and changes the project. */
const landed = (c: ToolCall): boolean => c.ok && toolEffect(c.name) === "write";
/** The person had to answer a question before anything could be done right. */
function nothingDoneInTurn(t: Trace, turn: number, why: string): void {
  const edits = t.toolCalls.filter((c) => landed(c) && turnOf(c) === turn);
  assert(edits.length === 0, `${why}: ${edits.map((c) => c.name).join(", ")} in that turn`);
}
const landedIn = (t: Trace, turn: number, name: string): ToolCall[] =>
  t.toolCalls.filter((c) => c.ok && c.name === name && turnOf(c) === turn);
const names = (c: ToolCall): string[] =>
  Array.isArray(c.args?.clip_ids) ? (c.args.clip_ids as unknown[]).map(String) : [];
/** A grade knob an apply_color call set, as a flat knob or inside a whole `color` object. */
const gradeArg = (c: ToolCall, k: string): number | undefined => {
  const v = c.args?.[k] ?? (c.args?.color as Any)?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** The volume each successful call set on clip `id`, in call order, with its turn. */
function volumesSet(t: Trace, id: string): { turn: number; v: number }[] {
  const out: { turn: number; v: number }[] = [];
  for (const c of t.toolCalls) {
    if (!c.ok) continue;
    if (
      c.name === "set_clip_properties" &&
      names(c).includes(id) &&
      typeof c.args.volume === "number"
    )
      out.push({ turn: turnOf(c), v: c.args.volume });
    if (
      c.name === "set_keyframes" &&
      c.args.clip_id === id &&
      c.args.property === "volume" &&
      Array.isArray(c.args.keyframes) &&
      c.args.keyframes.length
    )
      out.push({ turn: turnOf(c), v: lastValue(c.args.keyframes, NaN) });
  }
  return out;
}
/** The last value set in or before `turn`. */
function lastBy(sets: { turn: number; v: number }[], turn: number, what: string): number {
  const hit = sets.filter((s) => s.turn <= turn).pop();
  assert(hit, `no ${what} was set by turn ${turn + 1}`);
  return hit.v;
}

// ── seeds ───────────────────────────────────────────────────────────────────

/** A trip: six shots of three seconds each, back to back. */
const TRIP = ["beach", "city", "market", "sunset", "harbour", "night"] as const;
const trip = (): Timeline =>
  timeline([
    vtrack(
      "v1",
      0,
      TRIP.map((id, i) => vclip(id, `${id}.mp4`, i * 90, (i + 1) * 90)),
    ),
  ]);
const TRIP_ORDER = TRIP.map((id) => `${id}.mp4`);

/** The tags every case here carries, plus its kind of follow-up. */
function tags(kind: string, seed: () => Timeline, turns: number, lang = "en"): string[] {
  const clips = (seed().tracks ?? []).reduce((n, t) => n + (t.clips ?? []).length, 0);
  return ["gap:followups", `followup:${kind}`, `lang:${lang}`, `turns:${turns}`, `clips:${clips}`];
}

// ── the cases ───────────────────────────────────────────────────────────────

const fourShots = (prefix: string) => (): Timeline =>
  timeline([
    vtrack(
      "v1",
      0,
      [1, 2, 3, 4].map((i) => vclip(`${prefix}${i}`, `${prefix}${i}.mp4`, (i - 1) * 90, i * 90)),
    ),
  ]);

const harbourLong = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("beach", "beach.mp4", 0, 90),
      vclip("city", "city.mp4", 90, 180),
      vclip("harbour", "harbour.mp4", 180, 300),
      vclip("night", "night.mp4", 300, 390),
    ]),
  ]);

const talkWithMusic = (): Timeline =>
  timeline([
    vtrack(
      "v1",
      0,
      [1, 2, 3, 4].map((i) => vclip(`t${i}`, `talk${i}.mp4`, (i - 1) * 120, i * 120)),
    ),
    atrack("a1", 0, [aclip("music", "music.mp3", 0, 480)]),
  ]);

const openHouse = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("porch", "porch.mp4", 0, 90),
      vclip("kitchen", "kitchen.mp4", 90, 180),
      vclip("garden", "garden.mp4", 180, 270),
    ]),
  ]);

const roadTrip = (): Timeline =>
  timeline([
    vtrack(
      "v1",
      0,
      ["a", "b", "c", "d"].map((id, i) => vclip(id, `road_${id}.mp4`, i * 90, (i + 1) * 90)),
    ),
    atrack("a1", 0, [aclip("music", "music.mp3", 0, 360)]),
  ]);

const eightTakes = (): Timeline =>
  timeline([
    vtrack(
      "v1",
      0,
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => vclip(`s${i}`, `take${i}.mp4`, (i - 1) * 90, i * 90)),
    ),
  ]);

const threeForCrossfade = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("x1", "lake.mp4", 0, 120),
      vclip("x2", "forest.mp4", 120, 240),
      vclip("x3", "cabin.mp4", 240, 360),
    ]),
  ]);

const lisbon = fourShots("lisbon");

const withInterview = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("b1", "street1.mp4", 0, 90),
      vclip("b2", "street2.mp4", 90, 180),
      vclip("interview", "interview.mp4", 180, 330),
      vclip("b3", "street3.mp4", 330, 420),
      vclip("b4", "street4.mp4", 420, 510),
      vclip("b5", "street5.mp4", 510, 600),
    ]),
  ]);

const promo = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("city", "city.mp4", 0, 90),
      vclip("beach", "beach.mp4", 90, 180),
      vclip("sunset", "sunset.mp4", 180, 270),
      vclip("market", "market.mp4", 270, 360),
    ]),
    atrack("a1", 0, [aclip("music", "music.mp3", 0, 360)]),
  ]);

const twoDogs = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("intro", "intro.mp4", 0, 90),
      vclip("dog_beach", "dog_beach.mp4", 90, 180),
      vclip("cafe", "cafe.mp4", 180, 270),
      vclip("dog_park", "dog_park.mp4", 270, 360),
      vclip("street", "street.mp4", 360, 450),
      vclip("outro", "outro.mp4", 450, 540),
    ]),
  ]);

const walkthrough = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("kitchen", "kitchen.mp4", 0, 90),
      vclip("garden", "garden.mp4", 90, 150),
      vclip("hallway", "hallway.mp4", 150, 330),
      vclip("bedroom", "bedroom.mp4", 330, 420),
      vclip("balcony", "balcony.mp4", 420, 480),
    ]),
  ]);

const lakeTrip = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("lake", "lake.mp4", 0, 150),
      vclip("forest", "forest.mp4", 150, 240),
      vclip("cabin", "cabin.mp4", 240, 330),
    ]),
  ]);

const hike = fourShots("hike");

const cooking = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("food1", "food1.mp4", 0, 90),
      vclip("food2", "food2.mp4", 90, 180),
      vclip("chef", "chef_interview.mp4", 180, 330),
      vclip("food3", "food3.mp4", 330, 420),
      vclip("food4", "food4.mp4", 420, 510),
      vclip("food5", "food5.mp4", 510, 600),
    ]),
  ]);

const interviewWithVoice = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("intro", "intro.mp4", 0, 90),
      vclip("interview", "interview.mp4", 90, 240),
      vclip("outro", "outro.mp4", 240, 330),
    ]),
    atrack("a1", 0, [aclip("vo", "voiceover.wav", 90, 240)]),
  ]);

const layered = (): Timeline =>
  timeline([
    vtrack("v1", 0, [vclip("footage", "footage.mp4", 0, 300)]),
    vtrack("v2", 1, [vclip("logo", "logo.png", 0, 300, { kind: "image" } as Partial<Clip>)]),
    atrack("a1", 0, [aclip("music", "music.mp3", 0, 300)]),
    atrack("a2", 1, [aclip("sfx", "whoosh.wav", 0, 300)]),
  ]);

const market = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("m1", "street.mp4", 0, 90),
      vclip("market", "market.mp4", 90, 270),
      vclip("m3", "harbour.mp4", 270, 360),
    ]),
  ]);

const STUDIO_OCEAN = "media_broll_ocean";
const STUDIO_CITY = "media_broll_city";
const STUDIO_BED = "media_bed";
const brollCut = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("a", "a.mp4", 0, 150),
      vclip("cityShot", STUDIO_CITY, 150, 240),
      vclip("b", "b.mp4", 240, 390),
    ]),
  ]);
const oneShot = (): Timeline => timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]);

const landscape = (): Timeline =>
  timeline(
    [
      vtrack("v1", 0, [
        vclip("g1", "garden1.mp4", 0, 90),
        vclip("g2", "garden2.mp4", 90, 180),
        vclip("g3", "garden3.mp4", 180, 270),
      ]),
    ],
    { width: 1920, height: 1080 },
  );

/** Spanish names for the trip, for the case a Spanish speaker writes. */
const VIAJE = ["playa", "ciudad", "mercado", "atardecer", "puerto", "noche"] as const;
const viaje = (): Timeline =>
  timeline([
    vtrack(
      "v1",
      0,
      VIAJE.map((id, i) => vclip(id, `${id}.mp4`, i * 90, (i + 1) * 90)),
    ),
  ]);

/** The id of the clip that plays `ref` in a project the model read. */
const idPlaying = (tl: Timeline, ref: string): string => {
  const hit = allClips(tl).find((c) => c.media_ref === ref && (c as Any).kind !== "audio");
  if (!hit) throw new Error(`no clip plays ${ref}`);
  return String(hit.id);
};
/** The id of the text clip that reads `want` in a project the model read. */
const idReading = (tl: Timeline, want: string): string => {
  const hit = textClips(tl).find((c) => words(c).toLowerCase() === want.toLowerCase());
  if (!hit) throw new Error(`no text reads ${want}`);
  return String(hit.id);
};

const WHITE_OUTLINED = { color: "#FFFFFF", outline: { color: "#000000", width: 4 } };

const boats = (): Timeline =>
  timeline([
    vtrack("v1", 0, [
      vclip("boat1", "boat1.mp4", 0, 90),
      vclip("boat2", "boat2.mp4", 90, 180),
      vclip("boat3", "boat3.mp4", 180, 270),
    ]),
  ]);
const DRONE_URL = "https://example.com/media/drone.mp4";
/** The media the import stand-in brings in: any ref no seed clip plays. */
const importedClips = (tl: Timeline, seed: () => Timeline): Clip[] => {
  const seeded = new Set(allClips(seed()).map((c) => c.media_ref));
  return allClips(tl).filter((c) => (c as Any).kind !== "audio" && !seeded.has(c.media_ref));
};

/** The app's answer to a search the engine blocked (tools/web.ts webSearchTool: `blocked: true`,
 *  and the helper's own words or this default). */
const blockedSearch = (args: Record<string, unknown>): Record<string, unknown> => ({
  ok: false,
  query: String(args.query ?? "").trim(),
  blocked: true,
  error: "search engine blocked the request",
});
/** The app's answer to a link whose server answered 503 (tools/import.ts, `download failed`). */
const unavailableDownload = (): Record<string, unknown> => ({
  ok: false,
  error: "download failed: HTTP 503",
});

/** Cut the first half second off each take that still starts at its first frame, latest first
 *  so no cut moves the frames of a cut still to come. */
const trimUntrimmedHeads = (tl: Timeline): ReferenceCalls => {
  const ranges = allClips(tl)
    .filter((c) => /^take\d\.mp4$/.test(String(c.media_ref)) && !Number((c as Any).source_in ?? 0))
    .map((c) => ({ start: Number(c.timeline_in), end: Number(c.timeline_in) + 15 }));
  return [["ripple_delete", { track_id: "v1", ranges }]];
};
/** Each take lost its first half second exactly once, and the takes still play back to back. */
function eachTakeTrimmedOnce(tl: Timeline): void {
  for (let i = 1; i <= 8; i++) {
    const c = onlyOne(tl, `take${i}.mp4`);
    near(Number((c as Any).source_in ?? 0), 15, 1, `take${i}'s first source frame`);
    near(span(c), 75, 1, `take${i}'s length`);
  }
  assertOrder(
    tl,
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `take${i}.mp4`),
  );
  assertBackToBack(tl, 1);
}
const EIGHT_TAKES_SCOPE = {
  change: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"],
  remove: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"],
  add: ["video" as const],
};

export const GAP_FOLLOWUPS: FollowupCase[] = [
  // ── the wrong clip ────────────────────────────────────────────────────────
  {
    id: "fu_wrong_clip_bw",
    title: "Black and white on one clip, then: no, the other one, and put the first back",
    tags: tags("wrong-target", trip, 2),
    seed: trip,
    prompt: "Make the market clip black and white.",
    followUps: [
      "Sorry, wrong one. I meant the sunset clip. Put the market clip back the way it was.",
    ],
    scope: { change: ["market", "sunset"] },
    expectTools: ["apply_color"],
    maxRounds: 8,
    expect: (tl) => {
      assertBlackAndWhite(tl, "sunset");
      assertUngraded(tl, "market", "the market clip");
    },
    reference: [
      call("apply_color", { clip_ids: ["market"], saturation: 0 }),
      say("The market clip is black and white now."),
      {
        calls: [
          ["apply_color", { clip_ids: ["market"], reset: true }],
          ["apply_color", { clip_ids: ["sunset"], saturation: 0 }],
        ],
      },
      say("Done: the market clip is back in colour and the sunset clip is black and white."),
    ],
  },
  {
    id: "fu_es_wrong_clip_deleted",
    title: "Spanish: delete a clip, then: not that one, the other, and put the first back",
    tags: tags("wrong-target", viaje, 2, "es"),
    seed: viaje,
    prompt: "Borra el clip del mercado.",
    followUps: [
      "No, ese no. Quería borrar el del puerto. Devuelve el del mercado a su sitio, como estaba.",
    ],
    scope: {
      change: [...VIAJE],
      remove: ["mercado", "puerto"],
      add: ["video"],
    },
    expectTools: ["remove_clips", "undo"],
    maxRounds: 8,
    expect: (tl) => {
      assert(playing(tl, "puerto.mp4").length === 0, "the harbour clip (puerto) is still there");
      const back = onlyOne(tl, "mercado.mp4");
      near(span(back), 90, 2, "the restored market clip's length");
      near(Number((back as Any).source_in ?? 0), 0, 1, "the restored market clip's first frame");
      assertOrder(
        tl,
        ["playa", "ciudad", "mercado", "atardecer", "noche"].map((n) => `${n}.mp4`),
      );
      near(Number(back.timeline_in), 180, 2, "where the market clip is back");
    },
    reference: [
      call("remove_clips", { clip_ids: ["mercado"] }),
      say("He borrado el clip del mercado."),
      { calls: [["undo", {}]] },
      call("remove_clips", { clip_ids: ["puerto"] }),
      say("Listo: el clip del mercado vuelve a estar en su sitio y he borrado el del puerto."),
    ],
  },

  // ── which one: references to what the person or the agent just named ─────
  {
    id: "fu_second_title_yellow",
    title: "Two titles, then: make the second one yellow",
    tags: tags("reference", trip, 2),
    seed: trip,
    prompt:
      "Add two titles: 'Day One' over the first two seconds, and 'Day Two' starting at six " +
      "seconds, also for two seconds.",
    followUps: ["Make the second one yellow."],
    scope: { add: ["text"], addTracks: true },
    expectTools: ["add_text_clips", "update_text"],
    maxRounds: 8,
    expect: (tl) => {
      assert(textClips(tl).length === 2, `expected 2 titles, got ${textClips(tl).length}`);
      const one = textReading(tl, "Day One");
      const two = textReading(tl, "Day Two");
      near(Number(one.timeline_in), 0, 3, "'Day One' start");
      near(Number(two.timeline_in), 180, 3, "'Day Two' start");
      near(span(two), 60, 3, "'Day Two' length");
      assert(
        isYellow(rgbOf(textStyle(two).color)),
        `'Day Two' is not yellow (${textStyle(two).color})`,
      );
      assert(!isYellow(rgbOf(textStyle(one).color)), "'Day One' was made yellow too");
    },
    reference: [
      call("add_text_clips", {
        entries: [
          { timeline_in: 0, timeline_out: 60, content: "Day One" },
          { timeline_in: 180, timeline_out: 240, content: "Day Two" },
        ],
      }),
      say("Added 'Day One' at the start and 'Day Two' at six seconds."),
      read,
      onRead((tl) => [
        ["update_text", { clip_ids: [idReading(tl, "Day Two")], style: { color: "#FFFF00" } }],
      ]),
      say("'Day Two' is yellow now."),
    ],
  },
  {
    id: "fu_fade_clip_just_added",
    title: "Cut in b-roll from the library, then fade out the clip just added",
    tags: [...tags("reference", brollCut, 2), "studio"],
    surface: "studio",
    seed: brollCut,
    prompt: "Put the ocean b-roll from my library right after the city shot.",
    followUps: ["Now fade out the clip you just added over its last second."],
    scope: { change: ["b"], add: ["video", "audio"], addTracks: true },
    expectTools: ["library_op", "insert_clips", "set_clip_properties"],
    maxRounds: 10,
    expect: (tl) => {
      const ocean = onlyOne(tl, STUDIO_OCEAN);
      near(
        Number(ocean.timeline_in),
        240,
        2,
        "where the ocean shot starts (right after the city shot)",
      );
      near(fadeOutFrames(ocean), 30, 5, "the ocean shot's fade-out");
      const b = clipById(tl, "b");
      assert(b && span(b) === 150, `the shot after it lost frames (${span(b)}f, was 150f)`);
      assert(
        Number(b.timeline_in) >= Number(ocean.timeline_out) - 2,
        "the ocean shot covers the start of the next shot",
      );
      for (const id of ["a", "cityShot", "b"])
        assert(fadeOutFrames(clipById(tl, id)) === 0, `clip ${id} was faded out instead`);
    },
    reference: [
      call("library_op", { action: "list" }),
      call("insert_clips", { at: 240, entries: [{ media_ref: STUDIO_OCEAN }] }),
      say("The ocean b-roll now plays right after the city shot."),
      read,
      onRead((tl) => [
        ["set_clip_properties", { clip_ids: [idPlaying(tl, STUDIO_OCEAN)], fade: { out: 30 } }],
      ]),
      say("The ocean shot fades out over its last second."),
    ],
  },
  {
    id: "fu_split_then_drop_middle",
    title: "Split a clip twice, then delete the middle piece and close the gap",
    tags: tags("reference", market, 2),
    seed: market,
    prompt: "Split the market clip one second and two seconds into it.",
    followUps: ["Now delete the middle piece and close the gap."],
    scope: { change: ["market", "m3"], remove: ["market"], add: ["video"] },
    expectTools: ["split_clips", "ripple_delete"],
    maxRounds: 8,
    expect: (tl) => {
      const pieces = playing(tl, "market.mp4").sort(
        (a, b) => Number(a.timeline_in) - Number(b.timeline_in),
      );
      assert(pieces.length === 2, `expected 2 pieces of the market clip, got ${pieces.length}`);
      const windows = pieces.map((c) => [
        Number((c as Any).source_in ?? 0),
        Number((c as Any).source_in ?? 0) + span(c),
      ]);
      near(windows[0][0], 0, 1, "first piece's first source frame");
      near(windows[0][1], 30, 1, "first piece's last source frame");
      near(windows[1][0], 60, 1, "second piece's first source frame");
      near(windows[1][1], 180, 1, "second piece's last source frame");
      assertOrder(tl, ["street.mp4", "market.mp4", "market.mp4", "harbour.mp4"]);
      assertBackToBack(tl);
    },
    reference: [
      call("split_clips", {
        splits: [
          { clip_id: "market", at: 150 },
          { clip_id: "market", at: 120 },
        ],
      }),
      say("Split the market clip at one and two seconds into it: three pieces."),
      call("ripple_delete", { track_id: "v1", start: 120, end: 150 }),
      say("Deleted the middle piece and closed the gap."),
    ],
  },
  {
    id: "fu_same_for_last_and_before",
    title: "Black and white, then 'same for the last clip', then 'and the one before it'",
    tags: tags("reference", trip, 3),
    seed: trip,
    prompt: "Make the beach clip black and white.",
    followUps: ["Same for the last clip.", "And the one before it."],
    scope: { change: ["beach", "night", "harbour"] },
    expectTools: ["apply_color"],
    maxRounds: 9,
    expect: (tl) => {
      for (const id of ["beach", "night", "harbour"]) assertBlackAndWhite(tl, id);
    },
    reference: [
      call("apply_color", { clip_ids: ["beach"], saturation: 0 }),
      say("The beach clip is black and white."),
      call("apply_color", { clip_ids: ["night"], saturation: 0 }),
      say("The night clip, the last one, is black and white too."),
      call("apply_color", { clip_ids: ["harbour"], saturation: 0 }),
      say("And the harbour clip before it."),
    ],
  },
  {
    id: "fu_question_then_that_one",
    title: "Ask which clip is longest, then: trim that one",
    tags: tags("reference", walkthrough, 2),
    seed: walkthrough,
    prompt: "Which of my clips is the longest?",
    followUps: ["Trim that one down to three seconds."],
    scope: { change: ["hallway"] },
    expectTools: ["get_timeline", "set_clip_properties"],
    maxRounds: 6,
    expect: (tl) => near(span(clipById(tl, "hallway")), 90, 2, "the hallway clip's length"),
    // A question is not a request to edit.
    expectTrace: (t) => nothingDoneInTurn(t, 0, "the project was edited in answer to a question"),
    reference: [
      read,
      say("The hallway clip is the longest, at six seconds."),
      call("set_clip_properties", { clip_ids: ["hallway"], duration: 90 }),
      say("The hallway clip is three seconds now."),
    ],
  },

  // ── relative corrections, against the agent's own last edit ───────────────
  {
    id: "fu_half_then_trim_end",
    title: "Halve a clip, then take another half second off its end",
    tags: tags("relative", harbourLong, 2),
    seed: harbourLong,
    prompt: "Make the harbour clip half as long. Keep the first half.",
    followUps: ["Still too long. Take another half second off the end of it."],
    scope: { change: ["harbour", "night"] },
    expectTools: ["set_clip_properties"],
    maxRounds: 6,
    expect: (tl) => {
      const h = onlyOne(tl, "harbour.mp4");
      near(span(h), 45, 2, "the harbour clip's length");
      near(
        Number((h as Any).source_in ?? 0),
        0,
        1,
        "the harbour clip's first frame (its start was kept)",
      );
    },
    reference: [
      call("set_clip_properties", { clip_ids: ["harbour"], duration: 60 }),
      say("The harbour clip is two seconds now, its first half."),
      call("set_clip_properties", { clip_ids: ["harbour"], duration: 45 }),
      say("Took another half second off the end: it is a second and a half."),
    ],
  },
  {
    id: "fu_music_down_down_up",
    title: "Music down, still too loud, then a little back up",
    tags: tags("relative", talkWithMusic, 3),
    seed: talkWithMusic,
    prompt: "The background music is way too loud. Turn it down.",
    followUps: ["Still too loud.", "Hmm, now I can barely hear it. Turn it up a little."],
    scope: { change: ["music"] },
    expectTools: ["set_clip_properties"],
    maxRounds: 9,
    expect: (tl) => {
      const v = lastValue((clipById(tl, "music") as Any)?.volume, 1);
      assert(
        v > 0.02 && v < 0.97,
        `the music should end up quieter than it started, but audible (volume ${v})`,
      );
    },
    expectTrace: (t, final) => {
      const sets = volumesSet(t, "music");
      const first = lastBy(sets, 0, "music volume");
      const second = lastBy(sets, 1, "music volume");
      assert(first < 0.95, `the first answer did not turn the music down (volume ${first})`);
      assert(
        second < first - 0.02,
        `"still too loud" did not lower it further (${first} -> ${second})`,
      );
      const end = lastValue((clipById(final!, "music") as Any)?.volume, 1);
      assert(end > second + 0.01, `"turn it up a little" did not raise it (${second} -> ${end})`);
    },
    reference: [
      call("set_clip_properties", { clip_ids: ["music"], volume: 0.5 }),
      say("Brought the music down to half."),
      call("set_clip_properties", { clip_ids: ["music"], volume: 0.3 }),
      say("Lowered it to 30%."),
      call("set_clip_properties", { clip_ids: ["music"], volume: 0.4 }),
      say("Raised it a little, to 40%."),
    ],
  },
  {
    id: "fu_title_nudges",
    title: "A title near the bottom, nudged up twice, made bold, then reworded",
    tags: tags("relative", openHouse, 5),
    seed: openHouse,
    prompt: "Add the title 'Open House' near the bottom of the screen for the first three seconds.",
    followUps: [
      "Move it up a bit.",
      "A little more.",
      "Make it bold.",
      "Change the words to 'Open House Sunday'.",
    ],
    scope: { add: ["text"], addTracks: true },
    expectTools: ["add_text_clips", "update_text"],
    maxRounds: 14,
    expect: (tl) => {
      assert(textClips(tl).length === 1, `expected one title, got ${textClips(tl).length}`);
      const title = textReading(tl, "Open House Sunday");
      near(Number(title.timeline_in), 0, 3, "the title's start");
      near(Number(title.timeline_out), 90, 3, "the title's end");
      assert(isBold(title), "the title is not bold");
    },
    expectTrace: (t, final) => {
      // Where the title sat after each turn, from every call that placed or moved it.
      const titleId = String(textClips(final!)[0]?.id ?? "");
      const placedBy = (turn: number): number => {
        let y: number | null = null;
        for (const c of t.toolCalls) {
          if (!c.ok || turnOf(c) > turn) continue;
          const a = c.args as Any;
          if (c.name === "add_text_clips")
            for (const e of (a.entries as Any[]) ?? [])
              if (/open house/i.test(JSON.stringify(e.content ?? ""))) y = textY(e);
          const onTitle = names(c).includes(titleId) || a.clip_id === titleId;
          if (!onTitle) continue;
          if (
            ["update_text", "set_clip_properties"].includes(c.name) &&
            a.transform?.position?.y !== undefined
          )
            y = textY(a);
          if (c.name === "set_keyframes" && a.property === "position" && a.keyframes?.length)
            y = num(a.keyframes[a.keyframes.length - 1].y, y ?? 0.5);
        }
        assert(y !== null, `the title was not placed by turn ${turn + 1}`);
        return y;
      };
      const start = placedBy(0);
      const once = placedBy(1);
      const end = textY(textClips(final!)[0]);
      assert(start >= 0.6, `"near the bottom" put the title at height ${start} (0 top, 1 bottom)`);
      assert(once < start - 0.01, `"up a bit" did not move it up (${start} -> ${once})`);
      assert(end < once - 0.01, `"a little more" did not move it up again (${once} -> ${end})`);
      assert(end >= 0.35, `two small nudges took the title from ${start} to ${end}`);
    },
    reference: [
      call("add_text_clips", {
        entries: [
          {
            timeline_in: 0,
            timeline_out: 90,
            content: "Open House",
            transform: { position: { x: 0.5, y: 0.85 } },
          },
        ],
      }),
      say("Added 'Open House' near the bottom for the first three seconds."),
      read,
      onRead((tl) => [
        [
          "update_text",
          {
            clip_ids: [idReading(tl, "Open House")],
            transform: { position: { x: 0.5, y: 0.78 } },
          },
        ],
      ]),
      say("Moved it up a little."),
      read,
      onRead((tl) => [
        [
          "update_text",
          {
            clip_ids: [idReading(tl, "Open House")],
            transform: { position: { x: 0.5, y: 0.7 } },
          },
        ],
      ]),
      say("A bit higher again."),
      read,
      onRead((tl) => [
        ["update_text", { clip_ids: [idReading(tl, "Open House")], style: { bold: true } }],
      ]),
      say("It is bold now."),
      read,
      onRead((tl) => [
        ["update_text", { clip_ids: [idReading(tl, "Open House")], content: "Open House Sunday" }],
      ]),
      say("It now reads 'Open House Sunday'."),
    ],
  },
  {
    id: "fu_crossfade_try_again_longer",
    title: "A crossfade, then: I can barely see it, try again longer",
    tags: tags("relative", threeForCrossfade, 2),
    seed: threeForCrossfade,
    prompt: "Add a crossfade between the first two clips.",
    followUps: ["I can barely see it. Try again with a much longer one."],
    scope: { change: ["x2", "x3"] },
    expectTools: ["set_transition"],
    maxRounds: 6,
    expect: (tl) => {
      const t = (clipById(tl, "x2") as Any)?.transition_in;
      assert(t && num(t.duration, 0) > 0, "there is no transition into the second clip");
      assert(
        !(clipById(tl, "x3") as Any)?.transition_in,
        "a transition was added to the third clip",
      );
    },
    expectTrace: (t, final) => {
      const first = landedIn(t, 0, "set_transition")
        .filter((c) => c.args.clip_id === "x2")
        .pop();
      assert(first, "no crossfade was added into the second clip in the first turn");
      const before = num((first.args.transition_in as Any)?.duration, 0);
      const after = num((clipById(final!, "x2") as Any)?.transition_in?.duration, 0);
      assert(
        after >= Math.max(before * 1.5, before + 10),
        `"much longer" went from ${before} to ${after} frames`,
      );
    },
    reference: [
      call("set_transition", { clip_id: "x2", transition_in: { kind: "crossfade", duration: 10 } }),
      say("Added a short crossfade between the first two clips."),
      call("set_transition", { clip_id: "x2", transition_in: { kind: "crossfade", duration: 30 } }),
      say("Made it a full second long."),
    ],
  },
  {
    id: "fu_cool_tone_down_keep_trim",
    title: "Trim, then a cold look, then 'too blue, tone it down': the trim stays",
    tags: tags("relative", lakeTrip, 3),
    seed: lakeTrip,
    prompt: "Trim the lake clip to three seconds.",
    followUps: ["Good. Now give it a colder, bluer look.", "Too blue. Tone it down a bit."],
    scope: { change: ["lake"] },
    expectTools: ["set_clip_properties", "apply_color"],
    maxRounds: 9,
    expect: (tl) => {
      near(span(clipById(tl, "lake")), 90, 2, "the lake clip's length (the trim they accepted)");
      const k = knob(clipById(tl, "lake"), "temperature");
      assert(k < 6450, `the lake clip is no longer cold at all (temperature ${k})`);
    },
    expectTrace: (t, final) => {
      const colder = landedIn(t, 1, "apply_color").filter((c) => names(c).includes("lake"));
      const set = colder
        .map((c) => gradeArg(c, "temperature"))
        .filter((v): v is number => v !== undefined);
      assert(set.length, "the colder look set no white balance");
      const cold = set[set.length - 1];
      const end = knob(clipById(final!, "lake"), "temperature");
      assert(end > cold + 100, `"tone it down" did not warm it back a little (${cold} -> ${end})`);
    },
    reference: [
      call("set_clip_properties", { clip_ids: ["lake"], duration: 90 }),
      say("The lake clip is three seconds now."),
      call("apply_color", { clip_ids: ["lake"], temperature: 5000 }),
      say("Gave it a colder, bluer look."),
      call("apply_color", { clip_ids: ["lake"], temperature: 5800 }),
      say("Toned the blue down a bit."),
    ],
  },

  // ── undo and go back ──────────────────────────────────────────────────────
  {
    id: "fu_undo_all_of_that",
    title: "Fades on every clip plus a title, then: undo all of that",
    tags: tags("undo", roadTrip, 2),
    seed: roadTrip,
    prompt:
      "Give every clip a half-second fade in and fade out, and put the title 'Summer' over the " +
      "first two seconds.",
    followUps: ["Undo all of that, I liked it better before."],
    scope: { change: ["a", "b", "c", "d"], add: ["text"], addTracks: true },
    expectTools: ["undo"],
    maxRounds: 8,
    expect: (tl) => {
      assert(textClips(tl).length === 0, "the title is still there");
      for (const id of ["a", "b", "c", "d"]) asSeeded(roadTrip, tl, id);
    },
    expectTrace: (t) => {
      assert(landedIn(t, 0, "add_text_clips").length, "the title was never added");
      const faded = t.toolCalls.some(
        (c) =>
          c.ok &&
          turnOf(c) === 0 &&
          ((c.name === "set_clip_properties" && c.args.fade) ||
            (c.name === "set_keyframes" && c.args.property === "opacity")),
      );
      assert(faded, "the fades were never added");
    },
    reference: [
      {
        calls: [
          ["set_clip_properties", { clip_ids: ["a", "b", "c", "d"], fade: { in: 15, out: 15 } }],
          [
            "add_text_clips",
            { entries: [{ timeline_in: 0, timeline_out: 60, content: "Summer" }] },
          ],
        ],
      },
      say(
        "Every clip fades in and out over half a second, and 'Summer' is on the first two seconds.",
      ),
      {
        calls: [
          ["undo", {}],
          ["undo", {}],
        ],
      },
      say("Undone: no fades and no title, as it was before."),
    ],
  },
  {
    id: "fu_undo_first_keep_second",
    title:
      "Black and white, then slow motion, then: undo the black and white, keep the slow motion",
    tags: tags("undo", trip, 3),
    seed: trip,
    prompt: "Make the city clip black and white.",
    followUps: [
      "And slow the night clip down to half speed.",
      "Undo the black and white but keep the slow motion.",
    ],
    scope: { change: ["city", "night"] },
    expectTools: ["apply_color", "set_clip_properties"],
    maxRounds: 9,
    expect: (tl) => {
      assertUngraded(tl, "city", "the city clip");
      near(num((clipById(tl, "night") as Any)?.speed, 1), 0.5, 0.05, "the night clip's speed");
    },
    expectTrace: (t) =>
      assert(
        t.toolCalls.some((c) => c.ok && c.name === "apply_color" && names(c).includes("city")),
        "the city clip was never made black and white",
      ),
    reference: [
      call("apply_color", { clip_ids: ["city"], saturation: 0 }),
      say("The city clip is black and white."),
      call("set_clip_properties", { clip_ids: ["night"], speed: 0.5 }),
      say("The night clip plays at half speed."),
      call("apply_color", { clip_ids: ["city"], reset: true }),
      say("The city clip is back in colour; the night clip stays in slow motion."),
    ],
  },
  {
    id: "fu_back_to_before_title",
    title: "Trim, title, warm grade, then: go back to before the title, keep the trim",
    tags: tags("undo", roadTrip, 4),
    seed: roadTrip,
    prompt: "Trim the first clip to two seconds.",
    followUps: [
      "Now add a title 'Road Trip' over the start.",
      "And make the last clip warmer.",
      "Hmm, go back to how it was before you added the title. Keep the trim.",
    ],
    scope: { change: ["a", "d"], add: ["text"], addTracks: true },
    expectTools: ["undo"],
    maxRounds: 12,
    expect: (tl) => {
      near(span(clipById(tl, "a")), 60, 2, "the first clip's length (the trim they kept)");
      assert(textClips(tl).length === 0, "the title is still there");
      assertUngraded(tl, "d", "the last clip");
      for (const id of ["b", "c"]) asSeeded(roadTrip, tl, id);
    },
    expectTrace: (t) => {
      assert(
        t.toolCalls.some((c) => c.ok && c.name === "add_text_clips"),
        "the title was never added",
      );
      assert(
        t.toolCalls.some((c) => c.ok && c.name === "apply_color" && names(c).includes("d")),
        "the last clip was never made warmer",
      );
    },
    reference: [
      call("set_clip_properties", { clip_ids: ["a"], duration: 60 }),
      say("The first clip is two seconds now."),
      call("add_text_clips", {
        entries: [{ timeline_in: 0, timeline_out: 60, content: "Road Trip" }],
      }),
      say("Added 'Road Trip' over the start."),
      call("apply_color", { clip_ids: ["d"], temperature: 7500 }),
      say("The last clip is warmer."),
      {
        calls: [
          ["undo", {}],
          ["undo", {}],
        ],
      },
      say("Back to before the title: the warmer grade and the title are gone, the trim stays."),
    ],
  },

  // ── a change of mind ──────────────────────────────────────────────────────
  {
    id: "fu_bw_then_colour_warmer",
    title: "Whole video black and white, then: colour after all, just warmer",
    tags: tags("change-of-mind", fourShots("park"), 2),
    seed: fourShots("park"),
    prompt: "Make the whole video black and white.",
    followUps: ["Actually no, I want it in colour after all, just a bit warmer."],
    scope: { change: ["park1", "park2", "park3", "park4"] },
    expectTools: ["apply_color"],
    maxRounds: 6,
    expect: (tl) => {
      for (const id of ["park1", "park2", "park3", "park4"]) {
        const c = clipById(tl, id);
        assert(knob(c, "saturation") >= 0.85, `clip ${id} is still drained of colour`);
        assert(
          knob(c, "temperature") > 6600,
          `clip ${id} is not warmer (temperature ${knob(c, "temperature")})`,
        );
      }
    },
    expectTrace: (t) =>
      assert(
        landedIn(t, 0, "apply_color").some((c) => (gradeArg(c, "saturation") ?? 1) <= 0.15),
        "the video was never made black and white",
      ),
    reference: [
      call("apply_color", { clip_ids: ["park1", "park2", "park3", "park4"], saturation: 0 }),
      say("The whole video is black and white."),
      call("apply_color", {
        clip_ids: ["park1", "park2", "park3", "park4"],
        saturation: 1,
        temperature: 7200,
      }),
      say("Back in colour, a little warmer."),
    ],
  },
  {
    id: "fu_reorder_change_mind",
    title: "Move a clip to the start, then: no, put it back and move another one there",
    tags: tags("change-of-mind", trip, 2),
    seed: trip,
    prompt: "Move the night clip to the very start.",
    followUps: ["Hmm, no. Put it back at the end, and move the sunset clip to the start instead."],
    scope: { change: [...TRIP] },
    expectTools: ["move_clips"],
    maxRounds: 8,
    expect: (tl) => {
      assertOrder(
        tl,
        ["sunset", "beach", "city", "market", "harbour", "night"].map((n) => `${n}.mp4`),
      );
      assertBackToBack(tl);
      for (const id of TRIP) asSeeded(trip, tl, id);
    },
    reference: [
      call("move_clips", {
        moves: [
          { clip_id: "night", to_timeline_in: 0 },
          { clip_id: "beach", to_timeline_in: 90 },
          { clip_id: "city", to_timeline_in: 180 },
          { clip_id: "market", to_timeline_in: 270 },
          { clip_id: "sunset", to_timeline_in: 360 },
          { clip_id: "harbour", to_timeline_in: 450 },
        ],
      }),
      say("The night clip opens the video now."),
      call("move_clips", {
        moves: [
          { clip_id: "sunset", to_timeline_in: 0 },
          { clip_id: "beach", to_timeline_in: 90 },
          { clip_id: "city", to_timeline_in: 180 },
          { clip_id: "market", to_timeline_in: 270 },
          { clip_id: "harbour", to_timeline_in: 360 },
          { clip_id: "night", to_timeline_in: 450 },
        ],
      }),
      say("The night clip is back at the end and the sunset clip opens the video."),
    ],
  },
  {
    id: "fu_restore_deleted_shorter",
    title: "Delete a clip, then: I need it after all, back where it was but shorter",
    tags: tags("change-of-mind", trip, 2),
    seed: trip,
    prompt: "Delete the market clip.",
    followUps: [
      "Wait, I need that clip after all. Bring it back where it was, but only two seconds of it.",
    ],
    scope: { change: [...TRIP], remove: ["market"], add: ["video"] },
    expectTools: ["undo", "set_clip_properties"],
    maxRounds: 8,
    expect: (tl) => {
      const back = onlyOne(tl, "market.mp4");
      near(span(back), 60, 2, "the market clip's length");
      assertOrder(tl, TRIP_ORDER);
      near(Number(back.timeline_in), 180, 2, "where the market clip is back");
      for (const id of ["beach", "city", "sunset", "harbour", "night"]) asSeeded(trip, tl, id);
    },
    expectTrace: (t) =>
      assert(
        t.toolCalls.some(
          (c) => landed(c) && turnOf(c) === 0 && ["remove_clips", "ripple_delete"].includes(c.name),
        ),
        "the market clip was never deleted",
      ),
    reference: [
      call("remove_clips", { clip_ids: ["market"] }),
      say("Deleted the market clip."),
      { calls: [["undo", {}]] },
      call("set_clip_properties", { clip_ids: ["market"], duration: 60 }),
      say("The market clip is back in its place, two seconds long."),
    ],
  },
  {
    id: "fu_canvas_square_then_tall",
    title: "Square canvas, then: actually tall, for stories",
    tags: tags("change-of-mind", landscape, 2),
    seed: landscape,
    prompt: "Make the video square.",
    followUps: ["Actually, make it tall instead, shaped for a phone screen, for stories."],
    scope: { canvas: ["width", "height"], change: ["g1", "g2", "g3"] },
    expectTools: ["set_project_settings"],
    maxRounds: 6,
    expect: (tl) => {
      const { width, height, fps } = tl.canvas as Any;
      near(Number(width) / Number(height), 9 / 16, 0.01, "the canvas shape (width / height)");
      assert(Number(fps) === 30, `the frame rate changed to ${fps}`);
    },
    expectTrace: (t) =>
      assert(
        landedIn(t, 0, "set_project_settings").length,
        "the video was never made square in the first turn",
      ),
    reference: [
      call("set_project_settings", { size: { aspect_ratio: "1:1" }, fps: null }),
      say("The canvas is square now."),
      call("set_project_settings", { size: { aspect_ratio: "9:16" }, fps: null }),
      say("The canvas is tall now, 9:16, the shape of a phone screen."),
    ],
  },

  // ── continue ──────────────────────────────────────────────────────────────
  {
    id: "fu_continue_staged_trims",
    title: "Trim the head of every clip, the first four now, then: keep going",
    tags: tags("continue", eightTakes, 2),
    seed: eightTakes,
    prompt:
      "Cut the first half second off every clip and close up the gaps. Do the first four now so " +
      "I can check them.",
    followUps: ["Looks good. Keep going with the rest."],
    scope: EIGHT_TAKES_SCOPE,
    expectTools: ["ripple_delete"],
    maxRounds: 10,
    // Each clip loses its first half second exactly once: "keep going" must not cut the first
    // four again.
    expect: eachTakeTrimmedOnce,
    reference: [
      call("ripple_delete", {
        track_id: "v1",
        ranges: [
          { start: 0, end: 15 },
          { start: 90, end: 105 },
          { start: 180, end: 195 },
          { start: 270, end: 285 },
        ],
      }),
      say("Cut the first half second off the first four clips and closed the gaps. Have a look."),
      call("ripple_delete", {
        track_id: "v1",
        ranges: [
          { start: 300, end: 315 },
          { start: 390, end: 405 },
          { start: 480, end: 495 },
          { start: 570, end: 585 },
        ],
      }),
      say("Done the other four the same way."),
    ],
  },

  // ── a standing instruction over a long session ────────────────────────────
  {
    id: "fu_long_text_style_rule",
    title: "Six turns: a text style set in the first message holds for every later title",
    tags: tags("long-session", lisbon, 6),
    seed: lisbon,
    prompt:
      "For all the text in this video, use white letters with a black outline. Start with a " +
      "title 'Lisbon' over the first two seconds.",
    followUps: [
      "Add 'Day 1' at three seconds, for two seconds.",
      "Make the second clip black and white.",
      "Add 'Day 2' at six seconds, same length as 'Day 1'.",
      "Change 'Day 1' to say 'Day One'.",
      "Last one: 'See you soon' over the final two seconds of the video.",
    ],
    scope: { change: ["lisbon2"], add: ["text"], addTracks: true },
    expectTools: ["add_text_clips", "update_text", "apply_color"],
    maxRounds: 18,
    expect: (tl) => {
      const at: [string, number][] = [
        ["Lisbon", 0],
        ["Day One", 90],
        ["Day 2", 180],
        ["See you soon", 300],
      ];
      assert(textClips(tl).length === 4, `expected 4 titles, got ${textClips(tl).length}`);
      for (const [w, tin] of at) {
        const c = textReading(tl, w);
        near(Number(c.timeline_in), tin, 3, `'${w}' start`);
        near(span(c), 60, 3, `'${w}' length`);
        const s = textStyle(c);
        assert(isWhite(rgbOf(s.color)), `'${w}' is not white (${s.color})`);
        assert(
          num(s.outline?.width, 0) > 0 && isDark(rgbOf(s.outline?.color ?? "#000000")),
          `'${w}' has no black outline (${JSON.stringify(s.outline)})`,
        );
      }
      assertBlackAndWhite(tl, "lisbon2");
    },
    reference: [
      call("add_text_clips", {
        entries: [{ timeline_in: 0, timeline_out: 60, content: "Lisbon", style: WHITE_OUTLINED }],
      }),
      say("Added 'Lisbon' in white with a black outline; I'll keep every title that way."),
      call("add_text_clips", {
        entries: [{ timeline_in: 90, timeline_out: 150, content: "Day 1", style: WHITE_OUTLINED }],
      }),
      say("Added 'Day 1' at three seconds."),
      call("apply_color", { clip_ids: ["lisbon2"], saturation: 0 }),
      say("The second clip is black and white."),
      call("add_text_clips", {
        entries: [{ timeline_in: 180, timeline_out: 240, content: "Day 2", style: WHITE_OUTLINED }],
      }),
      say("Added 'Day 2' at six seconds, two seconds long."),
      read,
      onRead((tl) => [["update_text", { clip_ids: [idReading(tl, "Day 1")], content: "Day One" }]]),
      say("'Day 1' now says 'Day One'."),
      call("add_text_clips", {
        entries: [
          { timeline_in: 300, timeline_out: 360, content: "See you soon", style: WHITE_OUTLINED },
        ],
      }),
      say(
        "Added 'See you soon' over the last two seconds, in the same white with a black outline.",
      ),
    ],
  },
  {
    id: "fu_long_hands_off_interview",
    title: "Five turns: the interview clip stays untouched through edits to 'everything'",
    tags: tags("long-session", withInterview, 5),
    seed: withInterview,
    prompt:
      "Don't change the interview clip at all, it's approved as it is. To start, brighten the " +
      "first clip a little.",
    followUps: [
      "Brighten all the other clips the same way.",
      "Make everything a touch faster, 1.25x.",
      "Fade in at the start of the video and fade out at the end.",
      "Last thing: make every clip fill the frame.",
    ],
    scope: { change: ["b1", "b2", "b3", "b4", "b5", "interview"] },
    expectTools: ["apply_color", "set_clip_properties"],
    maxRounds: 16,
    expect: (tl) => {
      asSeeded(withInterview, tl, "interview");
      const b1 = clipById(tl, "b1");
      const brighter =
        knob(b1, "brightness") > 0.005 ||
        knob(b1, "exposure") > 0.01 ||
        knob(b1, "gamma") > 1.01 ||
        knob(b1, "shadows") > 0.01;
      assert(brighter, `the first clip is not brighter (${JSON.stringify(gradeOf(b1))})`);
      for (const id of ["b1", "b2", "b3", "b4", "b5"]) {
        const c = clipById(tl, id);
        assert(
          JSON.stringify(sortKeys(gradeOf(c))) === JSON.stringify(sortKeys(gradeOf(b1))),
          `clip ${id} was not brightened the same way as the first`,
        );
        near(num((c as Any)?.speed, 1), 1.25, 0.03, `clip ${id}'s speed`);
        assert((c as Any)?.fit === "cover", `clip ${id} does not fill the frame`);
      }
      assert(fadeInFrames(b1) > 0, "the video does not fade in at the start");
      assert(fadeOutFrames(clipById(tl, "b5")) > 0, "the video does not fade out at the end");
    },
    reference: [
      call("apply_color", { clip_ids: ["b1"], brightness: 0.08 }),
      say("Brightened the first clip a little. I won't touch the interview."),
      call("apply_color", { clip_ids: ["b2", "b3", "b4", "b5"], brightness: 0.08 }),
      say("Brightened the other clips the same way, leaving the interview as it is."),
      call("set_clip_properties", { clip_ids: ["b1", "b2", "b3", "b4", "b5"], speed: 1.25 }),
      say("Everything but the interview plays at 1.25x."),
      {
        calls: [
          ["set_clip_properties", { clip_ids: ["b1"], fade: { in: 15 } }],
          ["set_clip_properties", { clip_ids: ["b5"], fade: { out: 15 } }],
        ],
      },
      say("The video fades in at the start and out at the end."),
      call("set_clip_properties", { clip_ids: ["b1", "b2", "b3", "b4", "b5"], fit: "cover" }),
      say("Every clip but the interview fills the frame now."),
    ],
  },
  {
    id: "fu_long_promo_session",
    title:
      "Eight turns building a promo: each accepted edit survives, and 'that's all' changes nothing",
    tags: tags("long-session", promo, 8),
    seed: promo,
    prompt: "Remove the market clip and close the gap.",
    followUps: [
      "Now put the rest in this order: sunset, beach, city.",
      "Add a half-second crossfade between each of them.",
      "Put the title 'Weekend' over the first two seconds.",
      "Make the title yellow.",
      "Mute the music.",
      "Actually don't mute it, just make it quieter.",
      "Perfect, that's all for now.",
    ],
    scope: {
      change: ["city", "beach", "sunset", "music"],
      remove: ["market"],
      tracks: ["a1"],
      add: ["text", "audio"],
      addTracks: true,
    },
    expectTools: ["remove_clips", "move_clips", "set_transition", "add_text_clips", "update_text"],
    maxRounds: 24,
    expect: (tl) => {
      assertOrder(tl, ["sunset.mp4", "beach.mp4", "city.mp4"]);
      for (const id of ["beach", "city"]) {
        const t = (clipById(tl, id) as Any)?.transition_in;
        assert(t, `no crossfade into the ${id} clip`);
        near(num(t.duration, 0), 15, 3, `the crossfade into the ${id} clip`);
      }
      assert(textClips(tl).length === 1, `expected one title, got ${textClips(tl).length}`);
      const title = textReading(tl, "Weekend");
      near(Number(title.timeline_in), 0, 3, "the title's start");
      near(span(title), 60, 3, "the title's length");
      assert(isYellow(rgbOf(textStyle(title).color)), "the title is not yellow");
      const music = playing(tl, "music.mp3");
      assert(music.length >= 1, "the music is gone");
      const track = (tl.tracks ?? []).find((t) => (t.clips ?? []).includes(music[0]));
      assert((track as Any)?.mute !== true, "the music track is still muted");
      for (const m of music) {
        const v = lastValue((m as Any).volume, 1);
        assert(v > 0.02 && v < 0.95, `the music should be quieter but not silent (volume ${v})`);
      }
    },
    expectTrace: (t) => nothingDoneInTurn(t, 7, `"that's all for now" still edited the project`),
    reference: [
      call("remove_clips", { clip_ids: ["market"] }),
      say("Removed the market clip; it was the last one, so there is no gap."),
      call("move_clips", {
        moves: [
          { clip_id: "sunset", to_timeline_in: 0 },
          { clip_id: "beach", to_timeline_in: 90 },
          { clip_id: "city", to_timeline_in: 180 },
        ],
      }),
      say("The order is sunset, beach, city."),
      {
        calls: [
          [
            "set_transition",
            { clip_id: "beach", transition_in: { kind: "crossfade", duration: 15 } },
          ],
          [
            "set_transition",
            { clip_id: "city", transition_in: { kind: "crossfade", duration: 15 } },
          ],
        ],
      },
      say("Half-second crossfades between each clip."),
      call("add_text_clips", {
        entries: [{ timeline_in: 0, timeline_out: 60, content: "Weekend" }],
      }),
      say("'Weekend' is over the first two seconds."),
      read,
      onRead((tl) => [
        ["update_text", { clip_ids: [idReading(tl, "Weekend")], style: { color: "#FFFF00" } }],
      ]),
      say("The title is yellow."),
      call("set_track", { track_id: "a1", mute: true }),
      say("The music is muted."),
      {
        calls: [
          ["set_track", { track_id: "a1", mute: false }],
          ["set_clip_properties", { clip_ids: ["music"], volume: 0.5 }],
        ],
      },
      say("The music is back on, at half the volume."),
      say("Great, glad it works. Nothing else changed."),
    ],
  },

  // ── ask only when it is truly unclear ─────────────────────────────────────
  {
    id: "fu_ask_which_dog_clip",
    title: "'Delete the dog clip' with two dog clips: ask which, then delete the one named",
    tags: tags("ask-when-ambiguous", twoDogs, 2),
    seed: twoDogs,
    prompt: "Delete the dog clip.",
    followUps: ["The one in the park."],
    scope: { change: ["street", "outro"], remove: ["dog_park"] },
    expectTools: ["get_timeline"],
    maxRounds: 6,
    expect: (tl) => {
      assert(playing(tl, "dog_park.mp4").length === 0, "the park dog clip is still there");
      asSeeded(twoDogs, tl, "dog_beach");
      for (const id of ["intro", "cafe", "street", "outro"]) asSeeded(twoDogs, tl, id);
    },
    // Two clips show a dog: deleting either one before asking is a coin toss with the person's work.
    expectTrace: (t) => nothingDoneInTurn(t, 0, "deleted before asking which dog clip"),
    reference: [
      read,
      say(
        "There are two dog clips: one on the beach and one in the park. Which one should I delete?",
      ),
      call("ripple_delete", { track_id: "v1", start: 270, end: 360 }),
      say("Deleted the park dog clip and closed the gap."),
    ],
  },

  // ── narrower or wider than the last edit ──────────────────────────────────
  {
    id: "fu_vivid_except_interview",
    title: "More vivid everywhere, then: not the interview, leave that natural",
    tags: tags("scope", cooking, 2),
    seed: cooking,
    prompt: "Make the clips more vivid.",
    followUps: ["Oh, not the interview. Leave that one natural."],
    scope: { change: ["food1", "food2", "chef", "food3", "food4", "food5"] },
    expectTools: ["apply_color"],
    maxRounds: 6,
    expect: (tl) => {
      for (const id of ["food1", "food2", "food3", "food4", "food5"]) {
        const c = clipById(tl, id);
        assert(
          knob(c, "saturation") > 1.05 || knob(c, "vibrance") > 0.05,
          `clip ${id} is not more vivid (${JSON.stringify(gradeOf(c))})`,
        );
      }
      assertUngraded(tl, "chef", "the interview");
    },
    reference: [
      call("apply_color", {
        clip_ids: ["food1", "food2", "chef", "food3", "food4", "food5"],
        saturation: 1.3,
      }),
      say("Made all six clips more vivid."),
      call("apply_color", { clip_ids: ["chef"], reset: true }),
      say("The interview is back to its natural look; the rest stay vivid."),
    ],
  },
  {
    id: "fu_same_zoom_on_all",
    title: "A slow zoom on the first clip, then: do the same on all the others",
    tags: tags("scope", hike, 2),
    seed: hike,
    prompt: "On the first clip, add a slow zoom in from normal size to 110% over the whole clip.",
    followUps: ["Nice. Do the same on all the other clips."],
    scope: { change: ["hike1", "hike2", "hike3", "hike4"] },
    expectTools: ["set_keyframes"],
    maxRounds: 8,
    expect: (tl) => {
      const first = (clipById(tl, "hike1") as Any)?.transform ?? {};
      const scale = first.scale ?? first.scale_x;
      assert(Array.isArray(scale) && scale.length >= 2, "the first clip has no zoom");
      const pts = [...scale].sort((a: Any, b: Any) => num(a.t, 0) - num(b.t, 0));
      near(num(pts[0].v, 0), 1, 0.03, "the zoom's starting size");
      near(num(pts[pts.length - 1].v, 0), 1.1, 0.03, "the zoom's end size");
      assert(num(pts[pts.length - 1].t, 0) >= 80, "the zoom does not run over the whole clip");
      for (const id of ["hike2", "hike3", "hike4"]) {
        const t = (clipById(tl, id) as Any)?.transform ?? {};
        assert(
          JSON.stringify(sortKeys(t)) === JSON.stringify(sortKeys(first)),
          `clip ${id} does not have the same zoom as the first`,
        );
      }
    },
    reference: [
      call("set_keyframes", {
        clip_id: "hike1",
        property: "scale",
        keyframes: [
          { t: 0, v: 1 },
          { t: 89, v: 1.1 },
        ],
      }),
      say("The first clip zooms slowly from 100% to 110%."),
      {
        calls: ["hike2", "hike3", "hike4"].map((id) => [
          "set_keyframes",
          {
            clip_id: id,
            property: "scale",
            keyframes: [
              { t: 0, v: 1 },
              { t: 89, v: 1.1 },
            ],
          },
        ]) as ReferenceCalls,
      },
      say("The other three clips get the same slow zoom."),
    ],
  },

  // ── tracks and links over follow-ups ──────────────────────────────────────
  {
    id: "fu_link_move_unlink",
    title: "Link a voiceover to its clip, move them together, then unlink and nudge the voiceover",
    tags: tags("tracks-links", interviewWithVoice, 3),
    seed: interviewWithVoice,
    prompt: "Link the voiceover to the interview clip so they always move together.",
    followUps: [
      "Now move the interview to the end of the video, after the outro.",
      "Unlink them, and then push just the voiceover one second later.",
    ],
    scope: { change: ["interview", "vo", "outro"] },
    expectTools: ["link_clips", "move_clips", "unlink_clips"],
    maxRounds: 10,
    expect: (tl) => {
      const interview = clipById(tl, "interview") as Any;
      const vo = clipById(tl, "vo") as Any;
      const outro = clipById(tl, "outro");
      assert(interview && vo && outro, "a clip is gone");
      assert(
        Number(interview.timeline_in) >= Number(outro!.timeline_out) - 2,
        `the interview (${interview.timeline_in}f) is not after the outro (ends ${outro!.timeline_out}f)`,
      );
      near(
        Number(vo.timeline_in) - Number(interview.timeline_in),
        30,
        2,
        "how far the voiceover sits after the interview's start",
      );
      assert(
        span(vo) === 150 && span(interview) === 150,
        "the interview or the voiceover changed length",
      );
      assert(
        !vo.link_group || vo.link_group !== interview.link_group,
        "the voiceover is still linked to the interview",
      );
    },
    expectTrace: (t) =>
      assert(
        landedIn(t, 0, "link_clips").some(
          (c) => names(c).includes("vo") || names(c).includes("interview"),
        ),
        "the voiceover was never linked to the interview",
      ),
    reference: [
      call("link_clips", { clip_ids: ["interview", "vo"] }),
      say("The voiceover and the interview are linked: they move together."),
      call("move_clips", { moves: [{ clip_id: "interview", to_timeline_in: 330 }] }),
      say("The interview, with its voiceover, now plays after the outro."),
      {
        calls: [
          ["unlink_clips", { clip_ids: ["interview"] }],
          ["move_clips", { moves: [{ clip_id: "vo", to_timeline_in: 360 }] }],
        ],
      },
      say("Unlinked them and moved just the voiceover a second later."),
    ],
  },
  {
    id: "fu_tracks_mute_then_partial",
    title: "Mute music and effects, bring the effects back, then hide the logo layer",
    tags: tags("tracks-links", layered, 3),
    seed: layered,
    prompt: "Mute the music and the sound effects.",
    followUps: [
      "Bring back the sound effects, but keep the music muted.",
      "And hide the logo layer for now.",
    ],
    scope: { change: ["music", "sfx", "logo"], tracks: ["a1", "a2", "v2"] },
    expectTools: ["set_tracks", "set_track"],
    maxRounds: 8,
    expect: (tl) => {
      const track = (id: string) => (tl.tracks ?? []).find((t) => t.id === id) as Any;
      const music = clipById(tl, "music") as Any;
      const sfx = clipById(tl, "sfx") as Any;
      const logo = clipById(tl, "logo") as Any;
      assert(
        track("a1")?.mute === true || lastValue(music?.volume, 1) <= 0.001,
        "the music is not muted",
      );
      assert(track("a2")?.mute !== true, "the sound effects track is still muted");
      assert(lastValue(sfx?.volume, 1) >= 0.5, "the sound effects are still turned down");
      assert(
        track("v2")?.hidden === true || lastValue(logo?.opacity, 1) <= 0.01,
        "the logo layer is still showing",
      );
      asSeeded(layered, tl, "footage");
    },
    reference: [
      call("set_tracks", {
        tracks: [
          { track_id: "a1", mute: true },
          { track_id: "a2", mute: true },
        ],
      }),
      say("Muted the music and the sound effects."),
      call("set_track", { track_id: "a2", mute: false }),
      say("The sound effects are back; the music stays muted."),
      call("set_track", { track_id: "v2", hidden: true }),
      say("The logo layer is hidden for now."),
    ],
  },

  // ── it did not work: fix what was done ────────────────────────────────────
  {
    id: "fu_music_runs_to_end",
    title:
      "Lay the library's music bed under the video, then: it stops early, make it run to the end",
    tags: [...tags("retry", oneShot, 2), "studio"],
    surface: "studio",
    seed: oneShot,
    prompt: "Add the music bed from my library under the video.",
    followUps: ["The music stops before the video ends. Make it last all the way to the end."],
    scope: { add: ["audio"], addTracks: true },
    expectTools: ["library_op", "add_clips", "set_clip_properties"],
    maxRounds: 10,
    expect: (tl) => {
      const beds = playing(tl, STUDIO_BED).sort(
        (a, b) => Number(a.timeline_in) - Number(b.timeline_in),
      );
      assert(beds.length >= 1, "the music bed is not on the timeline");
      let cursor = 0;
      for (const c of beds) {
        assert(Number(c.timeline_in) <= cursor + 2, `the music has a hole at ${cursor}f`);
        cursor = Math.max(cursor, Number(c.timeline_out));
      }
      near(cursor, 300, 3, "where the music ends (the video ends at 300f)");
      near(Number(beds[0].timeline_in), 0, 2, "where the music starts");
    },
    reference: [
      call("library_op", { action: "list" }),
      call("add_clips", { entries: [{ media_ref: STUDIO_BED, timeline_in: 0 }] }),
      say("The music bed is under the video."),
      read,
      onRead((tl) => {
        const bed = allClips(tl).find((c) => c.media_ref === STUDIO_BED);
        if (!bed) throw new Error("no music bed in the project read");
        return [["set_clip_properties", { clip_ids: [String(bed.id)], duration: 300, loop: true }]];
      }),
      say("The music now loops to the very end of the video."),
    ],
  },

  // ── try again after a failure ─────────────────────────────────────────────
  {
    id: "fu_retry_blocked_search",
    title: "A lookup the search engine blocks, reported without a guess; then 'try again'",
    tags: [...tags("retry", oneShot, 2), "studio"],
    surface: "studio",
    seed: oneShot,
    prompt:
      "Look up when the launch window at example.com opens and put that time on screen as a " +
      "caption over the first two seconds.",
    followUps: ["Try again."],
    faults: [{ tool: "web_search", times: 1, reply: blockedSearch }],
    maxToolErrors: 1,
    scope: { add: ["text"], addTracks: true },
    expectTools: ["web_search", "add_text_clips"],
    maxRounds: 10,
    expect: (tl) => {
      const captions = textClips(tl);
      assert(captions.length >= 1, "no caption was put on screen");
      for (const c of captions)
        assert(/\b0?9:40\b/.test(words(c)), `a caption does not carry the time: "${words(c)}"`);
      near(Number(captions[0].timeline_in), 0, 3, "the caption's start");
      near(span(captions[0]), 60, 3, "the caption's length");
    },
    expectTrace: (t) => {
      const searches = t.toolCalls.filter((c) => c.name === "web_search");
      assert(
        searches[0] && !searches[0].ok && turnOf(searches[0]) === 0,
        "the first search did not fail in the first turn",
      );
      // The engine blocked it: searching on in the same turn is running into the same wall.
      assert(
        !searches.some((c) => c.ok && turnOf(c) === 0),
        "kept searching after the engine blocked it, instead of telling the person",
      );
      assert(
        searches.some((c) => c.ok && turnOf(c) === 1),
        "never searched again when asked to",
      );
      nothingDoneInTurn(t, 0, "put text on screen before the time was known");
    },
    reference: [
      call("web_search", { query: "example.com launch window opens time" }),
      say("I couldn't look it up: the search engine blocked the request. Want me to try again?"),
      call("web_search", { query: "example.com launch window opens time" }),
      call("add_text_clips", {
        entries: [{ timeline_in: 0, timeline_out: 60, content: "Launch window opens 09:40 UTC" }],
      }),
      say(
        "The search worked this time: the window opens at 09:40 UTC, and that is on screen for the first two seconds.",
      ),
    ],
  },
  {
    id: "fu_retry_failed_import",
    title: "A link import the server refuses, then 'try again': imported and placed at the end",
    tags: [...tags("retry", boats, 2), "journey"],
    surface: "journey",
    seed: boats,
    prompt: `Import the drone shot from ${DRONE_URL} and put it at the end of the video.`,
    followUps: ["Their site was down for a minute. Try again."],
    faults: [{ tool: "import_media", times: 1, reply: unavailableDownload }],
    maxToolErrors: 1,
    scope: { add: ["video", "audio"], addTracks: true },
    expectTools: ["import_media", "add_clips"],
    maxRounds: 8,
    expect: (tl) => {
      const drone = importedClips(tl, boats);
      assert(drone.length === 1, `expected the drone shot placed once, got ${drone.length}`);
      near(
        Number(drone[0].timeline_in),
        270,
        2,
        "where the drone shot starts (the end of the video)",
      );
      near(span(drone[0]), 300, 3, "the drone shot's length (the whole 10 s file)");
      for (const id of ["boat1", "boat2", "boat3"]) asSeeded(boats, tl, id);
    },
    expectTrace: (t) => {
      const imports = t.toolCalls.filter((c) => c.name === "import_media");
      assert(
        imports[0] && !imports[0].ok && turnOf(imports[0]) === 0,
        "the first import did not fail in the first turn",
      );
      assert(
        !imports.some((c) => c.ok && turnOf(c) === 0),
        "repeated the failed download on its own instead of telling the person",
      );
      assert(
        imports.some((c) => c.ok && turnOf(c) === 1),
        "never imported again when asked to",
      );
      nothingDoneInTurn(t, 0, "changed the project while the download had failed");
    },
    reference: [
      call("import_media", { source: { url: DRONE_URL }, name: "drone" }),
      say(
        "The download failed: the site answered 503, so it is unavailable right now. Shall I try again?",
      ),
      call("import_media", { source: { url: DRONE_URL }, name: "drone" }),
      call("add_clips", { entries: [{ media_ref: "media_drone", timeline_in: 270 }] }),
      say("Imported it this time and put the drone shot at the end of the video."),
    ],
  },

  // ── Stop, then carry on (in-app only) ─────────────────────────────────────
  {
    id: "fu_stop_then_carry_on",
    title: "Stop pressed part-way through trimming every clip, then 'carry on'",
    tags: tags("continue", eightTakes, 2),
    seed: eightTakes,
    prompt: "Cut the first half second off every clip and close up the gaps.",
    followUps: ["Sorry, I hit stop by mistake. Carry on."],
    stopAfter: { turn: 0, calls: 2 },
    inAppOnly:
      "The person presses Stop part-way through the first turn, and the next message carries the " +
      "app's answers for the calls that never ran; the Copilot lane cannot stop a run.",
    scope: EIGHT_TAKES_SCOPE,
    expectTools: ["ripple_delete"],
    maxRounds: 10,
    // The calls that ran before Stop are done; "carry on" finishes the rest without cutting those
    // two again.
    expect: eachTakeTrimmedOnce,
    reference: [
      {
        calls: [8, 7, 6, 5, 4, 3, 2, 1].map((i) => [
          "ripple_delete",
          { clip_id: `s${i}`, start: (i - 1) * 90, end: (i - 1) * 90 + 15 },
        ]) as ReferenceCalls,
      },
      read,
      onRead(trimUntrimmedHeads),
      say("Carried on: the first half second is off every clip now, and the gaps are closed."),
    ],
  },
];
