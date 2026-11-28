// Whole-video edits from a person's own footage (gap 3 of the 27 Nov coverage report): a library of
// clips whose content is known (gap_wholevideo_footage.ts), and a request for a finished video, from one
// sentence to a long brief.
//
// GRADING: only what the request makes unambiguous, read from the final project: the length window it
// gave, the clips it named for use or exclusion, an order it named, the shape of the frame, a title at
// the start, captions on what is said, music under the cut, no black gaps. Never taste: which shots,
// how long each holds, which transitions, when the person left it open. Every check names what it
// found in the words of the request, so a failed run reads as the person's complaint.
//
// The footage stand-ins (footage.ts) tell a look what each clip shows in words and what is said in it,
// so a careful agent learns the library the way it would in the app: by listing it and looking.
import type { InferenceRequest } from "../harness";
import type { ReferenceStep } from "../reference";
import { buildScene } from "../../preview/scene";
import { clipSourceSpanSeconds, clipSpanToFrames } from "../../timeline/helpers";
import type { Clip, Timeline, Track } from "../../timeline/model";
import { clipText } from "../../timeline/shape";
import { footageClip, footageWordRows, type Footage } from "../footage";
import type { EditScope, Scenario, Trace } from "../types";
import {
  BAKE,
  BAKE_REF as V,
  CAFE,
  CAFE_REF as K,
  EVENT,
  EVENT_REF as E,
  HOME,
  HOME_REF as H,
  LESSON,
  LESSON_REF as P,
  PARTY,
  PARTY_REF as B,
  TRIP,
  TRIP_REF as T,
  newProject,
  placedProject,
} from "./gap_wholevideo_footage";

const FPS = 30;

// ── reading the final project ────────────────────────────────────────────────────

const fail = (why: string): never => {
  throw new Error(why);
};
const fpsOf = (tl: Timeline): number => (Number(tl.canvas?.fps) > 0 ? Number(tl.canvas.fps) : 30);
const tin = (c: Clip): number => Number(c.timeline_in) || 0;
const tout = (c: Clip): number => Number(c.timeline_out) || 0;
const secs = (tl: Timeline, frames: number): string => (frames / fpsOf(tl)).toFixed(2);
const on = (c: Clip): boolean => c.disabled !== true && tout(c) > tin(c);
const tracksOf = (tl: Timeline): Track[] => (Array.isArray(tl?.tracks) ? tl.tracks : []);

interface Placed {
  clip: Clip;
  track: Track;
  /** Draw order: the track's z, then its place in the list. */
  layer: number;
}

/** Every picture that draws: a video or still on a shown video track. */
function pictures(tl: Timeline): Placed[] {
  return tracksOf(tl).flatMap((t, i) =>
    t.kind !== "video" || t.hidden
      ? []
      : (t.clips ?? [])
          .filter((c) => on(c) && c.kind !== "text" && c.kind !== "audio" && !!c.media_ref)
          .map((clip) => ({ clip, track: t, layer: (Number(t.z) || 0) * 1000 + i })),
  );
}
/** Every text clip that draws, on any shown track. */
function texts(tl: Timeline): Clip[] {
  return tracksOf(tl).flatMap((t) =>
    t.hidden ? [] : (t.clips ?? []).filter((c) => on(c) && c.kind === "text"),
  );
}
/** Every sound that can be heard: an audio clip on an unmuted audio track, not turned to silence. */
function sounds(tl: Timeline): Placed[] {
  return tracksOf(tl).flatMap((t, i) =>
    t.kind !== "audio" || t.mute
      ? []
      : (t.clips ?? [])
          .filter((c) => on(c) && !!c.media_ref && c.volume !== 0)
          .map((clip) => ({ clip, track: t, layer: i })),
  );
}
/** Where the exported video ends: the last frame anything is on the timeline. */
function programEnd(tl: Timeline): number {
  return Math.max(0, ...tracksOf(tl).flatMap((t) => (t.clips ?? []).filter(on).map(tout)));
}
function pictureEnd(tl: Timeline): number {
  return Math.max(0, ...pictures(tl).map((p) => tout(p.clip)));
}
const refOf = (lib: Footage, c: Clip): string | undefined =>
  footageClip(lib, c.media_ref)?.media_ref;
/** A clip as the person would name it: its file and what it shows. */
function nameOf(lib: Footage, ref: string): string {
  const c = lib.clips.find((x) => x.media_ref === ref);
  if (!c) return ref;
  const shows = c.shots?.[0]?.shows ?? c.sound ?? "";
  return `${c.filename} (${shows.length > 48 ? `${shows.slice(0, 45)}...` : shows})`;
}
/** The picture seen at frame `f`: the top one of those that cover it. */
function seenAt(tl: Timeline, f: number): Placed | undefined {
  return pictures(tl)
    .filter((p) => tin(p.clip) <= f && f < tout(p.clip))
    .sort((a, b) => b.layer - a.layer)[0];
}
/** Frames of [0, end) that nothing in `spans` covers. */
function uncovered(spans: [number, number][], end: number): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [s, e] of sorted) {
    if (s > at) out.push([at, Math.min(s, end)]);
    at = Math.max(at, e);
    if (at >= end) break;
  }
  if (at < end) out.push([at, end]);
  return out.filter(([s, e]) => e > s);
}
/** Length of the union of `spans` inside [lo, hi). */
function coveredWithin(spans: [number, number][], lo: number, hi: number): number {
  const clipped = spans
    .map(([s, e]): [number, number] => [Math.max(s, lo), Math.min(e, hi)])
    .filter(([s, e]) => e > s);
  return (
    hi -
    lo -
    uncovered(
      clipped.map(([s, e]) => [s - lo, e - lo]),
      hi - lo,
    ).reduce((n, [s, e]) => n + e - s, 0)
  );
}

/** Words as code compares them: lower case, apostrophes dropped, punctuation as a break. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
const said = (text: string): string => tokens(text).join(" ");
const textHas = (c: Clip, want: string): boolean =>
  ` ${said(clipText(c))} `.includes(` ${said(want)} `);

/** One word as it is heard on the timeline: which source, its source span, where it plays. */
interface Heard {
  ref: string;
  word: string;
  /** Index among the source's single words. */
  index: number;
  from: number;
  to: number;
  /** Timeline frames of the part that plays. */
  at: [number, number];
}

/** Every word that is heard, in timeline order (a word cut in two by an edit is heard twice). */
function heardWords(tl: Timeline, lib: Footage): Heard[] {
  const fps = fpsOf(tl);
  const out: Heard[] = [];
  for (const { clip } of sounds(tl)) {
    const c = footageClip(lib, clip.media_ref);
    if (!c?.words) continue;
    const [s0, s1] = clipSourceSpanSeconds(clip, fps);
    footageWordRows(c).forEach(([word, from, to], index) => {
      const a = Math.max(from, s0);
      const b = Math.min(to, s1);
      if (b - a <= 0.01) return;
      const at = clipSpanToFrames(clip, a, b, fps);
      if (at) out.push({ ref: c.media_ref, word, index, from, to, at });
    });
  }
  return out.sort((x, y) => x.at[0] - y.at[0]);
}

/** How much of the source span [from, to) of `ref` is heard, 0..1 (counted once where clips repeat it). */
function heardShare(tl: Timeline, lib: Footage, ref: string, from: number, to: number): number {
  const fps = fpsOf(tl);
  const spans = sounds(tl)
    .filter((p) => refOf(lib, p.clip) === ref)
    .map((p) => clipSourceSpanSeconds(p.clip, fps) as [number, number]);
  const scale = 1000;
  const covered = coveredWithin(
    spans.map(([a, b]) => [Math.round(a * scale), Math.round(b * scale)]),
    Math.round(from * scale),
    Math.round(to * scale),
  );
  return covered / Math.max(1, Math.round((to - from) * scale));
}

/** A clip's volume at timeline frame `f`: its level, or its keyframes there (linear between keys). */
function levelAt(c: Clip, f: number): number {
  const v = c.volume;
  if (typeof v === "number") return v;
  if (!Array.isArray(v) || !v.length) return 1;
  const t = f - tin(c);
  const keys = [...v].sort((a, b) => a.t - b.t);
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++)
    if (t <= keys[i].t) {
      const [a, b] = [keys[i - 1], keys[i]];
      return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(1, b.t - a.t);
    }
  return keys[keys.length - 1].v;
}

// ── the checks a request can make ───────────────────────────────────────────────

/** One unambiguous part of a request, checked on the final timeline. Throws with the reason. */
type Check = (tl: Timeline, lib: Footage) => void;

/** Every check, each run; all that fail are reported together. */
function all(lib: Footage, ...checks: Check[]): (tl: Timeline) => void {
  return (tl) => {
    const why: string[] = [];
    for (const check of checks)
      try {
        check(tl, lib);
      } catch (e) {
        why.push(e instanceof Error ? e.message : String(e));
      }
    if (why.length) throw new Error(why.join("; "));
  };
}

const lengthBetween =
  (lo: number, hi: number): Check =>
  (tl) => {
    const s = programEnd(tl) / fpsOf(tl);
    if (s < lo - 0.5 / fpsOf(tl) || s > hi + 0.5 / fpsOf(tl))
      fail(
        `the video runs ${s.toFixed(2)} s; the request asked for ${lo === hi ? lo : `${lo} to ${hi}`} s`,
      );
  };

const noBlackGaps: Check = (tl) => {
  const covers = [
    ...pictures(tl).map((p): [number, number] => [tin(p.clip), tout(p.clip)]),
    ...texts(tl).map((c): [number, number] => [tin(c), tout(c)]),
  ];
  const holes = uncovered(covers, programEnd(tl));
  if (holes.length)
    fail(
      `black with nothing on screen at ${holes
        .slice(0, 4)
        .map(([s, e]) => `${secs(tl, s)}-${secs(tl, e)} s`)
        .join(", ")}; the request said no black gaps`,
    );
};

const usedRefs = (tl: Timeline, lib: Footage): Set<string> =>
  new Set(pictures(tl).flatMap((p) => refOf(lib, p.clip) ?? []));

const distinctClips =
  (n: number, except: readonly string[] = []): Check =>
  (tl, lib) => {
    const used = [...usedRefs(tl, lib)].filter((r) => !except.includes(r));
    if (used.length < n)
      fail(
        `the video shows ${used.length} of the person's clips; a video made from their clips needs at least ${n}`,
      );
  };

const uses =
  (...refs: string[]): Check =>
  (tl, lib) => {
    const used = usedRefs(tl, lib);
    const missing = refs.filter((r) => !used.has(r));
    if (missing.length)
      fail(
        `not in the video, though the request asked for it: ${missing.map((r) => nameOf(lib, r)).join(", ")}`,
      );
  };

const avoids =
  (...refs: string[]): Check =>
  (tl, lib) => {
    const used = usedRefs(tl, lib);
    const there = refs.filter((r) => used.has(r));
    if (there.length)
      fail(
        `in the video, though the request said to leave it out: ${there.map((r) => nameOf(lib, r)).join(", ")}`,
      );
  };

const onlyFrom =
  (...refs: string[]): Check =>
  (tl, lib) => {
    const other = [...usedRefs(tl, lib)].filter((r) => !refs.includes(r));
    if (other.length)
      fail(
        `the request allowed only some of the clips, and the video also shows ${other.map((r) => nameOf(lib, r)).join(", ")}`,
      );
  };

const opensWith =
  (ref: string): Check =>
  (tl, lib) => {
    const first = seenAt(tl, 0);
    if (!first || refOf(lib, first.clip) !== ref)
      fail(
        `the video opens on ${first ? nameOf(lib, refOf(lib, first.clip) ?? String(first.clip.media_ref)) : "nothing"}; the request asked to open on ${nameOf(lib, ref)}`,
      );
  };

const endsWith =
  (ref: string): Check =>
  (tl, lib) => {
    const last = seenAt(tl, pictureEnd(tl) - 1);
    if (!last || refOf(lib, last.clip) !== ref)
      fail(
        `the video ends on ${last ? nameOf(lib, refOf(lib, last.clip) ?? String(last.clip.media_ref)) : "nothing"}; the request asked to end on ${nameOf(lib, ref)}`,
      );
  };

/** Where each clip is first seen. */
function firstSeen(tl: Timeline, lib: Footage, ref: string): number | null {
  const at = pictures(tl)
    .filter((p) => refOf(lib, p.clip) === ref)
    .map((p) => tin(p.clip));
  return at.length ? Math.min(...at) : null;
}

const inOrder =
  (...refs: string[]): Check =>
  (tl, lib) => {
    const at = refs.map((r) => firstSeen(tl, lib, r));
    const missing = refs.filter((_, i) => at[i] === null);
    if (missing.length)
      fail(
        `missing from an order the request named: ${missing.map((r) => nameOf(lib, r)).join(", ")}`,
      );
    for (let i = 1; i < refs.length; i++)
      if ((at[i] ?? 0) <= (at[i - 1] ?? 0))
        fail(
          `${nameOf(lib, refs[i])} comes before ${nameOf(lib, refs[i - 1])}; the request named the opposite order`,
        );
  };

/** The second shot seen (after the opening one ends) is `ref`. */
const secondIs =
  (ref: string): Check =>
  (tl, lib) => {
    const first = seenAt(tl, 0);
    if (!first) fail("nothing is on screen at the start");
    const next = seenAt(tl, tout(first!.clip));
    if (!next || refOf(lib, next.clip) !== ref)
      fail(
        `after the opening shot comes ${next ? nameOf(lib, refOf(lib, next.clip) ?? "?") : "nothing"}; the request asked for ${nameOf(lib, ref)} next`,
      );
  };

const shapeIs =
  (w: number, h: number, label: string): Check =>
  (tl) => {
    const { width, height } = tl.canvas;
    if (Math.abs(width / height - w / h) > 0.01)
      fail(`the frame is ${width}x${height}; the request asked for ${label} (${w}:${h})`);
  };

/** Every picture fills the frame wherever it shows: no bars. Read from what the compositor draws. */
const fillsFrame: Check = (tl, lib) => {
  const dims = new Map(
    pictures(tl).flatMap((p) => {
      const c = footageClip(lib, p.clip.media_ref);
      return c
        ? [[String(p.clip.media_ref), { w: c.width ?? 1920, h: c.height ?? 1080 }] as const]
        : [];
    }),
  );
  const { width: cw, height: ch } = tl.canvas;
  const fps = fpsOf(tl);
  for (const p of pictures(tl)) {
    const f = Math.floor((tin(p.clip) + tout(p.clip)) / 2);
    let layers: ReturnType<typeof buildScene>["layers"] = [];
    try {
      layers = buildScene(tl, f / fps, dims).layers;
    } catch (e) {
      fail(`the frame could not be composed at ${secs(tl, f)} s: ${String(e)}`);
    }
    const filled = layers.some((l) => {
      const box = l.clipBox ?? l.dst;
      const d = l.dst;
      return (
        Math.max(box.x, d.x) <= 1 &&
        Math.max(box.y, d.y) <= 1 &&
        Math.min(box.x + box.w, d.x + d.w) >= cw - 1 &&
        Math.min(box.y + box.h, d.y + d.h) >= ch - 1
      );
    });
    if (!filled)
      fail(
        `at ${secs(tl, f)} s ${nameOf(lib, refOf(lib, p.clip) ?? "?")} does not fill the ${cw}x${ch} frame; the request said no black bars`,
      );
  }
};

const textClipsWith = (tl: Timeline, want: string): Clip[] =>
  texts(tl).filter((c) => textHas(c, want));

/** `want` is on screen from the start (within `by` seconds), for at least a second. */
const titleAtStart =
  (want: string, by = 1): Check =>
  (tl) => {
    const hit = textClipsWith(tl, want).filter(
      (c) => tin(c) <= by * fpsOf(tl) && tout(c) - tin(c) >= fpsOf(tl),
    );
    if (!hit.length) {
      const seen = texts(tl).map((c) => `"${clipText(c)}" at ${secs(tl, tin(c))} s`);
      fail(
        `no title "${want}" on screen at the start (text on the timeline: ${seen.length ? seen.slice(0, 4).join(", ") : "none"})`,
      );
    }
  };

/** `want` is on screen while `ref` is, for at least `seconds` (and starting within `by` seconds of it). */
const textDuring =
  (want: string, ref: string, seconds = 1.5): Check =>
  (tl, lib) => {
    const shown = pictures(tl)
      .filter((p) => refOf(lib, p.clip) === ref)
      .map((p): [number, number] => [tin(p.clip), tout(p.clip)]);
    const best = Math.max(
      0,
      ...textClipsWith(tl, want).map((c) => coveredWithin(shown, tin(c), tout(c))),
    );
    if (best < seconds * fpsOf(tl))
      fail(
        `"${want}" is on screen for ${secs(tl, best)} s while ${nameOf(lib, ref)} shows; the request put it over that shot`,
      );
  };

/** No text reading exactly `old` is left anywhere (a title that was to be changed, not added to). */
const noTextExactly =
  (old: string): Check =>
  (tl) => {
    const stale = texts(tl).filter((c) => said(clipText(c)) === said(old));
    if (stale.length)
      fail(`the old title "${old}" is still on screen at ${secs(tl, tin(stale[0]))} s`);
  };

/** `ref`'s music plays under the whole picture, and not on past its end over black. */
const musicUnder =
  (ref: string): Check =>
  (tl, lib) => {
    const music = sounds(tl).filter((p) => refOf(lib, p.clip) === ref);
    if (!music.length) fail(`${nameOf(lib, ref)} is not under the video`);
    const end = pictureEnd(tl);
    const covered = coveredWithin(
      music.map((p) => [tin(p.clip), tout(p.clip)]),
      0,
      end,
    );
    if (covered < 0.95 * end)
      fail(
        `the music plays under ${Math.round((100 * covered) / Math.max(1, end))}% of the video; the request put it under the whole thing`,
      );
    const past = Math.max(...music.map((p) => tout(p.clip))) - end;
    if (past > fpsOf(tl))
      fail(`the music runs ${secs(tl, past)} s past the last picture, over a black screen`);
  };

/** The music is down (at most `max`) wherever words are heard (of `only`, when given). */
const musicQuietUnderSpeech =
  (ref: string, max = 0.5, only?: readonly string[]): Check =>
  (tl, lib) => {
    const music = sounds(tl).filter((p) => refOf(lib, p.clip) === ref);
    const words = heardWords(tl, lib).filter((w) => !only || only.includes(w.ref));
    if (!words.length)
      fail("no speech is heard in the video, so nothing could be heard over the music");
    const loud = words.filter((w) => {
      const mid = Math.floor((w.at[0] + w.at[1]) / 2);
      return music.some(
        (p) =>
          tin(p.clip) <= mid && mid < tout(p.clip) && !p.clip.duck && levelAt(p.clip, mid) > max,
      );
    });
    if (loud.length > 0.1 * words.length)
      fail(
        `the music is above ${max} while ${loud.length} of ${words.length} spoken words play (first "${loud[0].word}" at ${secs(tl, loud[0].at[0])} s); the request asked for it to be quieter under the talking`,
      );
  };

const speechHeard =
  (min = 3): Check =>
  (tl, lib) => {
    const n = heardWords(tl, lib).length;
    if (n < min)
      fail(`${n} spoken words are heard in the video; the request was about what is said in it`);
  };

/** Every word of `ref` is heard whole (90% of it or more). */
const everyWordOf =
  (ref: string): Check =>
  (tl, lib) => {
    const c = lib.clips.find((x) => x.media_ref === ref)!;
    const lost = footageWordRows(c).filter(([, a, b]) => heardShare(tl, lib, ref, a, b) < 0.9);
    if (lost.length)
      fail(
        `${lost.length} words of ${nameOf(lib, ref)} are cut or missing (first "${lost[0][0]}"); the request asked to keep everything said`,
      );
  };

/** No sentence of `ref` is cut off part of the way through, and at least one is heard. */
const sentencesWhole =
  (ref: string): Check =>
  (tl, lib) => {
    const c = lib.clips.find((x) => x.media_ref === ref)!;
    const shares = (c.words ?? []).map(
      ([text, a, b]) => [text, heardShare(tl, lib, ref, a, b)] as const,
    );
    const cut = shares.filter(([, s]) => s > 0.1 && s < 0.9);
    if (cut.length)
      fail(
        `"${cut[0][0]}" is cut off part of the way through; the request said not to cut off a sentence`,
      );
    if (!shares.some(([, s]) => s >= 0.9)) fail(`nothing said in ${nameOf(lib, ref)} is heard`);
  };

/** Every word heard (of `only`, when given) has a caption with that word on screen as it is said. */
const captioned =
  (share = 0.85, only?: readonly string[]): Check =>
  (tl, lib) => {
    const words = heardWords(tl, lib).filter((w) => !only || only.includes(w.ref));
    if (!words.length) fail("nothing said is heard in the video, so there is nothing to caption");
    const tol = Math.round(0.3 * fpsOf(tl));
    const caps = texts(tl).map((c) => ({
      in: tin(c),
      out: tout(c),
      words: new Set(tokens(clipText(c))),
    }));
    const missed = words.filter((w) => {
      const mid = Math.floor((w.at[0] + w.at[1]) / 2);
      const key = tokens(w.word).join("");
      return !caps.some(
        (c) =>
          c.in - tol <= mid &&
          mid < c.out + tol &&
          (c.words.has(key) || tokens(w.word).every((t) => c.words.has(t))),
      );
    });
    if (missed.length > (1 - share) * words.length)
      fail(
        `${words.length - missed.length} of ${words.length} spoken words have a caption with them on screen as they are said (first missing: "${missed[0].word}" at ${secs(tl, missed[0].at[0])} s)`,
      );
  };

/** The filler words a "cut the filler words" request removes. */
const FILLERS = new Set(["um", "uh", "er", "erm", "uhm", "hmm"]);
const isFiller = (word: string): boolean => FILLERS.has(tokens(word).join(""));

/** Silences and filler words gone from every take, every other word heard whole, in order. */
const deadAirGone =
  (maxGap = 1.0): Check =>
  (tl, lib) => {
    const fps = fpsOf(tl);
    for (const c of lib.clips.filter((x) => x.words)) {
      for (const [word, a, b] of footageWordRows(c)) {
        const share = heardShare(tl, lib, c.media_ref, a, b);
        if (isFiller(word) && share > 0.25)
          fail(`the filler "${word}" in ${c.filename} is still heard`);
        if (!isFiller(word) && share < 0.9)
          fail(
            `"${word}" in ${c.filename} is cut or missing; only silences and filler words were to go`,
          );
      }
    }
    const kept = heardWords(tl, lib).filter((w) => !isFiller(w.word));
    for (let i = 1; i < kept.length; i++) {
      const gap = kept[i].at[0] - kept[i - 1].at[1];
      if (gap > maxGap * fps)
        fail(
          `${(gap / fps).toFixed(2)} s of silence between "${kept[i - 1].word}" and "${kept[i].word}" at ${secs(tl, kept[i - 1].at[1])} s`,
        );
    }
    if (kept.length && kept[0].at[0] > maxGap * fps)
      fail(`the video opens on ${secs(tl, kept[0].at[0])} s of silence`);
    const tail = pictureEnd(tl) - (kept[kept.length - 1]?.at[1] ?? 0);
    if (tail > fps) fail(`the video ends on ${secs(tl, tail)} s of silence`);
    const order = kept.map((w) => `${w.ref}#${w.index}`);
    const want = lib.clips.flatMap((c) =>
      footageWordRows(c).flatMap(([w], i) => (isFiller(w) ? [] : [`${c.media_ref}#${i}`])),
    );
    if (order.join() !== want.join()) fail("the words are no longer in the order they were said");
  };

/** The clips of the seed's main track keep the order they had, among those still there. */
const keepsSeedOrder =
  (refs: readonly string[]): Check =>
  (tl, lib) => {
    const kept = refs.filter((r) => firstSeen(tl, lib, r) !== null);
    for (let i = 1; i < kept.length; i++)
      if ((firstSeen(tl, lib, kept[i]) ?? 0) < (firstSeen(tl, lib, kept[i - 1]) ?? 0))
        fail(
          `${nameOf(lib, kept[i])} now comes before ${nameOf(lib, kept[i - 1])}; the request said to keep the order`,
        );
  };

/** Each of `refs` still plays all of its picture: nothing was trimmed away. */
const keptWhole =
  (refs: readonly string[]): Check =>
  (tl, lib) => {
    const fps = fpsOf(tl);
    for (const r of refs) {
      const c = lib.clips.find((x) => x.media_ref === r)!;
      const spans = pictures(tl)
        .filter((p) => refOf(lib, p.clip) === r)
        .map(
          (p) =>
            clipSourceSpanSeconds(p.clip, fps).map((s) => Math.round(s * fps)) as [number, number],
        );
      const len = Math.round((c.duration_s ?? 0) * fps);
      if (coveredWithin(spans, 0, len) < len - 2)
        fail(`${nameOf(lib, r)} lost part of its picture; the request only asked to rearrange`);
    }
  };

const runsFor =
  (seconds: number): Check =>
  (tl) => {
    const got = programEnd(tl);
    if (Math.abs(got - seconds * fpsOf(tl)) > 2)
      fail(
        `the video now runs ${secs(tl, got)} s; rearranging the ${seconds} s cut should not change its length`,
      );
  };

/** The first two pictures are the two `photos`, each on screen `seconds` (within 0.2 s), and every
 *  other picture comes after them. */
const photosFirst =
  (photos: readonly string[], seconds: number): Check =>
  (tl, lib) => {
    const fps = fpsOf(tl);
    const shown = pictures(tl).sort((a, b) => tin(a.clip) - tin(b.clip));
    const first = shown.slice(0, photos.length).map((p) => refOf(lib, p.clip));
    if ([...first].sort().join() !== [...photos].sort().join())
      fail(
        `the video opens on ${first.map((r) => nameOf(lib, r ?? "?")).join(" and ")}; the request asked for the old photos first`,
      );
    for (const p of shown.slice(0, photos.length)) {
      const len = tout(p.clip) - tin(p.clip);
      if (Math.abs(len - seconds * fps) > 0.2 * fps)
        fail(
          `${nameOf(lib, refOf(lib, p.clip) ?? "?")} is on screen ${secs(tl, len)} s; the request asked for ${seconds} s`,
        );
    }
    const photosEnd = Math.max(...shown.slice(0, photos.length).map((p) => tout(p.clip)));
    const early = shown.slice(photos.length).filter((p) => tin(p.clip) < photosEnd - 1);
    if (early.length)
      fail(`${nameOf(lib, refOf(lib, early[0].clip) ?? "?")} plays before the photos are done`);
  };

/** While `speaker` talks, a picture of `cover` is what is seen, for at least `share` of the words. */
const coveredWhileTalking =
  (speaker: string, cover: readonly string[], share: number): Check =>
  (tl, lib) => {
    const words = heardWords(tl, lib).filter((w) => w.ref === speaker);
    if (!words.length) fail(`${nameOf(lib, speaker)} is not heard`);
    const covered = words.filter((w) => {
      const seen = seenAt(tl, Math.floor((w.at[0] + w.at[1]) / 2));
      return seen && cover.includes(refOf(lib, seen.clip) ?? "");
    });
    if (covered.length < share * words.length)
      fail(
        `only ${covered.length} of ${words.length} of his words play over the booths or the workshop; the request asked to cover him with them while he talks`,
      );
  };

/** Each step's title is on screen while that step's clip shows, and the titles come in order. */
const stepTitles =
  (steps: readonly (readonly [string, string])[]): Check =>
  (tl, lib) => {
    let last = -1;
    for (const [title, ref] of steps) {
      const shown = pictures(tl)
        .filter((p) => refOf(lib, p.clip) === ref)
        .map((p): [number, number] => [tin(p.clip), tout(p.clip)]);
      const hit = texts(tl).filter(
        (c) =>
          tokens(clipText(c)).includes(said(title)) &&
          coveredWithin(shown, tin(c), tout(c)) >= fpsOf(tl),
      );
      if (!hit.length) fail(`no "${title}" title on screen while ${nameOf(lib, ref)} shows`);
      const at = Math.min(...hit.map(tin));
      if (at <= last) fail(`the "${title}" title comes before the step before it`);
      last = at;
    }
  };

/** Every transition between two shots on the main track is a crossfade. */
const crossfadesEverywhere: Check = (tl) => {
  const main = tracksOf(tl)
    .filter((t) => t.kind === "video" && !t.hidden)
    .sort((a, b) => (b.clips?.length ?? 0) - (a.clips?.length ?? 0))[0];
  const shots = (main?.clips ?? [])
    .filter((c) => on(c) && c.kind !== "text")
    .sort((a, b) => tin(a) - tin(b));
  const missing = shots
    .slice(1)
    .filter(
      (c) => c.transition_in?.kind !== "crossfade" || !(Number(c.transition_in?.duration) >= 6),
    );
  if (missing.length)
    fail(
      `${missing.length} of ${shots.length - 1} cuts have no crossfade (first at ${secs(tl, tin(missing[0]))} s)`,
    );
};

/** The last shot fades out (to black): a fade-out, or its opacity keyed down to nothing at its end. */
const fadesToBlack: Check = (tl) => {
  const last = seenAt(tl, pictureEnd(tl) - 1);
  if (!last) fail("nothing is on screen at the end");
  const c = last!.clip;
  const fadeOut = Number((c.fade as { out?: number } | undefined)?.out ?? 0);
  const keys = Array.isArray(c.opacity) ? [...c.opacity].sort((a, b) => a.t - b.t) : [];
  const keyed =
    keys.length > 1 &&
    keys[keys.length - 1].v <= 0.05 &&
    keys[keys.length - 1].t >= tout(c) - tin(c) - 2;
  if (fadeOut < 6 && !keyed)
    fail("the last shot does not fade out; the request asked to fade out to black at the end");
};

/** The music of `ref` that plays last fades out at its end. */
const musicFadesOut =
  (ref: string): Check =>
  (tl, lib) => {
    const music = sounds(tl)
      .filter((p) => refOf(lib, p.clip) === ref)
      .sort((a, b) => tout(b.clip) - tout(a.clip))[0];
    if (!music) fail(`${nameOf(lib, ref)} is not under the video`);
    const c = music!.clip;
    const fadeOut = Number((c.fade as { out?: number } | undefined)?.out ?? 0);
    const len = tout(c) - tin(c);
    const keyed =
      Array.isArray(c.volume) &&
      levelAt(c, tout(c) - 1) <= 0.1 &&
      levelAt(c, tin(c) + Math.floor(len / 2)) > 0.3;
    if (fadeOut < 15 && !keyed)
      fail("the music does not fade out at the end; the request asked for it to");
  };

/** Every picture of the cut carries the same warm colour grade. */
/** White balance is in kelvin, 6500 neutral, and a higher value is warmer (apply_color). */
const NEUTRAL_KELVIN = 6500;
/** A grade warms the picture: white balance above neutral, or a colour wheel pushed toward red,
 *  orange or yellow. */
function warms(color: unknown): boolean {
  const c = (color ?? {}) as Record<string, unknown>;
  if (Number(c.temperature) > NEUTRAL_KELVIN) return true;
  return (["shadows", "mids", "highs"] as const).some((w) => {
    const hue = Number(c[`${w}Hue`]);
    const amount = Number(c[`${w}Amount`]);
    return amount > 0.02 && ((hue >= 0 && hue <= 70) || hue >= 330);
  });
}

/** Every shot of the cut carries the same grade, and it warms the picture. */
const sameWarmLook: Check = (tl, lib) => {
  const shots = pictures(tl).filter((p) => footageClip(lib, p.clip.media_ref)?.kind === "video");
  const looks = shots.map((p) => JSON.stringify(p.clip.color ?? null));
  const cold = shots.filter((p) => !warms(p.clip.color));
  if (cold.length)
    fail(
      `${cold.length} of ${shots.length} shots have no warm grade (first ${nameOf(lib, refOf(lib, cold[0].clip) ?? "?")}: ${JSON.stringify(cold[0].clip.color ?? null)})`,
    );
  if (new Set(looks).size > 1)
    fail(
      `the shots carry ${new Set(looks).size} different grades; the request asked for the same look on every one`,
    );
};

/** `ref` plays in slow motion: at most `max` speed. */
const slowMotion =
  (ref: string, max = 0.6): Check =>
  (tl, lib) => {
    const shown = pictures(tl).filter((p) => refOf(lib, p.clip) === ref);
    if (!shown.some((p) => Number(p.clip.speed ?? 1) > 0 && Number(p.clip.speed ?? 1) <= max))
      fail(
        `${nameOf(lib, ref)} plays at ${shown.map((p) => p.clip.speed ?? 1).join(", ") || "no"} speed; the request asked for slow motion`,
      );
  };

/** Where the compositor draws `ref` at frame `f`, if anywhere. */
function drawnAt(tl: Timeline, lib: Footage, ref: string, f: number) {
  const dims = new Map(
    pictures(tl).flatMap((p) => {
      const c = footageClip(lib, p.clip.media_ref);
      return c
        ? [[String(p.clip.media_ref), { w: c.width ?? 1920, h: c.height ?? 1080 }] as const]
        : [];
    }),
  );
  return buildScene(tl, f / fpsOf(tl), dims).layers.find(
    (l) => footageClip(lib, l.source)?.media_ref === ref,
  );
}

/** The logo is on screen the whole time, small, in the top-right corner. */
const cornerLogo =
  (ref: string): Check =>
  (tl, lib) => {
    const { width: cw, height: ch } = tl.canvas;
    const end = programEnd(tl);
    const logo = pictures(tl).filter((p) => refOf(lib, p.clip) === ref);
    const covered = coveredWithin(
      logo.map((p) => [tin(p.clip), tout(p.clip)]),
      0,
      end,
    );
    if (covered < 0.95 * end)
      fail(
        `the logo is on screen for ${secs(tl, covered)} of ${secs(tl, end)} s; the request asked for the whole time`,
      );
    for (const f of [Math.floor(end * 0.1), Math.floor(end / 2), end - 2]) {
      const l = drawnAt(tl, lib, ref, f);
      if (!l) fail(`the logo is not drawn at ${secs(tl, f)} s`);
      const { x, y, w, h } = l!.dst;
      if (w > 0.35 * cw)
        fail(
          `the logo is ${Math.round((100 * w) / cw)}% of the frame's width; the request asked for it small`,
        );
      if (x + w / 2 < 0.6 * cw || y + h / 2 > 0.4 * ch)
        fail(
          `the logo sits at ${Math.round(x + w / 2)},${Math.round(y + h / 2)} in a ${cw}x${ch} frame; the request asked for the top-right corner`,
        );
    }
  };

/** The last `seconds` show the logo, with `want` on screen below it. */
const endCard =
  (logo: string, want: string, seconds: number): Check =>
  (tl, lib) => {
    const fps = fpsOf(tl);
    const end = pictureEnd(tl);
    const from = end - seconds * fps;
    const shown = pictures(tl)
      .filter((p) => refOf(lib, p.clip) === logo)
      .map((p): [number, number] => [tin(p.clip), tout(p.clip)]);
    if (coveredWithin(shown, from, end) < (seconds - 0.3) * fps)
      fail(
        `the logo is on screen for ${secs(tl, coveredWithin(shown, from, end))} of the last ${seconds} s`,
      );
    const words = textClipsWith(tl, want).filter(
      (c) => coveredWithin([[tin(c), tout(c)]], from, end) >= (seconds - 0.5) * fps,
    );
    if (!words.length) fail(`"${want}" is not on screen for the last ${seconds} s`);
    const l = drawnAt(tl, lib, logo, end - Math.round(fps / 2));
    const logoY = l ? (l.dst.y + l.dst.h / 2) / tl.canvas.height : 0.5;
    const textY = Number(
      (words[0].transform as { position?: { y?: number } } | undefined)?.position?.y ?? 0.5,
    );
    if (textY <= logoY + 0.05)
      fail(
        `"${want}" sits at height ${textY.toFixed(2)}, not under the logo (at ${logoY.toFixed(2)})`,
      );
  };

/** `want` is in the lower third while `ref` shows, for at least two seconds. */
const lowerThird =
  (want: string, ref: string): Check =>
  (tl, lib) => {
    const shown = pictures(tl)
      .filter((p) => refOf(lib, p.clip) === ref)
      .map((p): [number, number] => [tin(p.clip), tout(p.clip)]);
    const hit = textClipsWith(tl, want).filter(
      (c) => coveredWithin(shown, tin(c), tout(c)) >= 2 * fpsOf(tl),
    );
    if (!hit.length) fail(`"${want}" is not on screen while ${nameOf(lib, ref)} shows`);
    const y = Number(
      (hit[0].transform as { position?: { y?: number } } | undefined)?.position?.y ?? 0.5,
    );
    if (y < 0.6)
      fail(`"${want}" sits at height ${y.toFixed(2)}; the request asked for the lower third`);
  };

/** The opening picture is `ref`, held between `lo` and `hi` seconds. */
const opensHolding =
  (ref: string, lo: number, hi: number): Check =>
  (tl, lib) => {
    const first = seenAt(tl, 0);
    if (!first || refOf(lib, first.clip) !== ref) return opensWith(ref)(tl, lib);
    const len = (tout(first.clip) - tin(first.clip)) / fpsOf(tl);
    if (len < lo || len > hi)
      fail(
        `the opening photo holds ${len.toFixed(2)} s; the request asked for about ${(lo + hi) / 2} s`,
      );
  };

// ── what the agent said and did ─────────────────────────────────────────────────

const NEGATION =
  /\b(no|not|none|nothing|never|without|missing|unable|couldn'?t|can'?t|cannot|didn'?t|don'?t|doesn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|haven'?t|hasn'?t)\b/i;

/** The reply tells the person that `thing` is not in their footage. */
function saysMissing(thing: RegExp): (trace: Trace) => void {
  return (trace) => {
    const sentences = trace.finalText.split(/(?<=[.!?])\s+|\n+/);
    if (!sentences.some((s) => thing.test(s) && NEGATION.test(s)))
      fail(
        "the reply does not tell the person that the shot they asked for is not in their footage",
      );
  };
}

/** Tools that change the timeline: an export after the last of them rendered the finished cut. */
const EDITS = new Set([
  "add_clips",
  "insert_clips",
  "add_text_clips",
  "update_text",
  "move_clips",
  "split_clips",
  "remove_clips",
  "ripple_delete",
  "set_clip_properties",
  "set_keyframes",
  "apply_effects",
  "apply_color",
  "set_transition",
  "add_captions",
  "set_project_settings",
  "add_track",
  "remove_tracks",
  "set_track",
  "set_tracks",
  "link_clips",
  "unlink_clips",
  "undo",
  "redo",
]);
function exportsOnceAfterEditing(trace: Trace): void {
  const calls = trace.toolCalls.filter((c) => c.ok);
  const exports = calls.filter((c) => c.name === "export");
  if (!exports.length) fail("the video was never exported; the request asked for it");
  if (exports.length > 1)
    fail(`exported ${exports.length} times; the request asked for one export`);
  const lastEdit = calls.map((c) => EDITS.has(c.name)).lastIndexOf(true);
  if (calls.indexOf(exports[0]) < lastEdit) fail("exported before the edit was finished");
}

// ── declarations ─────────────────────────────────────────────────────────────────

/** What a request over a new project may change: add anything, and the frame the first clip set. */
const NEW_PROJECT_SCOPE: EditScope = {
  add: ["video", "image", "audio", "text"],
  addTracks: true,
  tracks: ["v1", "a1"],
  canvas: ["width", "height"],
};
/** What a request over a placed cut may change: any of its clips, plus new ones. */
function placedScope(seed: Timeline, extra: Partial<EditScope> = {}): EditScope {
  const ids = tracksOf(seed).flatMap((t) => (t.clips ?? []).map((c) => String(c.id)));
  return {
    change: ids,
    remove: ids,
    add: ["video", "image", "audio", "text"],
    addTracks: true,
    tracks: tracksOf(seed).map((t) => t.id),
    ...extra,
  };
}
const tags = (kind: string, size: number, turns = 1): string[] => [
  "gap:wholevideo",
  "lang:en",
  `turns:${turns}`,
  `clips:${size}`,
  `kind:${kind}`,
  "studio",
];
const LOOK = ["library_op", "get_project_state", "inspect_media", "add_clips"];

// ── correct runs ─────────────────────────────────────────────────────────────────
// The calls a careful editor makes, one step per model round (a text step ends the turn): each case's
// `reference`. scenarios.reference.test.ts replays it through the real harness with no model, which
// proves the request can be done with these tools and that the checks accept the right result.

type Step = ReferenceStep;

/** List the library, then look at every clip in it: how the agent learns what the person filmed. */
function lookAtAll(lib: Footage): Step[] {
  return [
    { calls: [["library_op", { action: "list" }]] },
    {
      calls: lib.clips
        .filter((c) => c.kind !== "audio")
        .map((c): [string, Record<string, unknown>] => [
          "inspect_media",
          { media_ref: c.media_ref },
        ]),
    },
  ];
}

/** Source spans [ref, fromSeconds, toSeconds] laid back to back from frame `at`, as add_clips entries. */
function back2back(
  parts: readonly (readonly [string, number, number])[],
  at = 0,
  extra: Record<string, unknown> = {},
): Record<string, unknown>[] {
  let f = at;
  return parts.map(([ref, a, b]) => {
    const len = Math.round(b * FPS) - Math.round(a * FPS);
    const entry = ref.includes(".")
      ? { media_ref: ref, timeline_in: f, timeline_out: f + len, ...extra }
      : { media_ref: ref, timeline_in: f, source_span: [a, b], ...extra };
    f += len;
    return entry;
  });
}
const lengthOf = (parts: readonly (readonly [string, number, number])[]): number =>
  parts.reduce((n, [, a, b]) => n + Math.round(b * FPS) - Math.round(a * FPS), 0);

/** The clips the previous round's add_clips made (`kind` to keep one kind). */
export function made(
  req: InferenceRequest,
  kind?: string,
): { clip_id: string; kind?: string; track_id?: string }[] {
  return (req.round_input.tool_results ?? [])
    .filter((r) => r.name === "add_clips" || r.name === "add_text_clips")
    .flatMap((r) =>
      Array.isArray(r.result.created)
        ? (r.result.created as { clip_id: string; kind?: string; track_id?: string }[])
        : [],
    )
    .filter((c) => !kind || c.kind === kind);
}
/** The music the previous round placed: the one audio clip a song's placement makes. */
const musicMade = (req: InferenceRequest): string[] => made(req, "audio").map((c) => c.clip_id);

const place = (entries: Record<string, unknown>[]): Step => ({
  calls: [["add_clips", { entries }]],
});
const titleAt = (content: string, from: number, to: number, y?: number): Step => ({
  calls: [
    [
      "add_text_clips",
      {
        entries: [
          {
            content,
            timeline_in: from,
            timeline_out: to,
            ...(y === undefined ? {} : { transform: { position: { x: 0.5, y } } }),
          },
        ],
      },
    ],
  ],
});
const music = (ref: string, frames: number): Step =>
  place([{ media_ref: ref, timeline_in: 0, source_span: [0, frames / FPS] }]);
const say = (text: string): Step => ({ text });

// ── the cases ───────────────────────────────────────────────────────────────────

const TRAILER: (readonly [string, number, number])[] = [
  [T.bay, 0, 5],
  [T.jump, 4, 10],
  [T.cave, 0, 5],
  [T.waves, 0, 4],
  [T.toast, 1, 5],
  [T.sunset, 4, 10],
];
const HIGHLIGHT: (readonly [string, number, number])[] = [
  [E.hall, 0, 8],
  [E.banner, 0, 6],
  [E.keynote, 0, 11],
  [E.printer, 0, 7],
  [E.handshake, 0, 8],
  [E.kids, 0, 8],
  [E.interview, 0, 10],
  [E.trophy, 0, 10],
  [E.volunteers, 0, 9],
];
const TRAVEL_45: (readonly [string, number, number])[] = [
  [T.bay, 0, 6],
  [T.lane, 0, 6],
  [T.boats, 0, 5],
  [T.jump, 3, 11],
  [T.cave, 0, 7],
  [T.lighthouse, 0, 6],
  [T.sunset, 6, 13],
];
/** The weekend's rough cut: twelve clips, whole, in the order they were shot (118 s). */
const ROUGH = [
  T.lane,
  T.harbourTalk,
  T.boats,
  T.octopus,
  T.cave,
  T.toast,
  T.sunset,
  T.pocket,
  T.market,
  T.cat,
  T.cliffPath,
  T.hikeTalk,
];
const roughSeed = () => placedProject(TRIP, ROUGH);
/** Five seconds of each, the talking whole, the pocket clip gone: ranges on the rough cut's frames. */
const ROUGH_CUTS = [
  { start: 150, end: 270 },
  { start: 480, end: 630 },
  { start: 780, end: 870 },
  { start: 1020, end: 1170 },
  { start: 1320, end: 1500 },
  { start: 1650, end: 1710 },
  { start: 1860, end: 2370 },
  { start: 2520, end: 2640 },
  { start: 2790, end: 2880 },
  { start: 3030, end: 3180 },
  { start: 3360, end: 3540 },
];
const RECAP_30: (readonly [string, number, number])[] = [
  [T.bay, 0, 5],
  [T.lane, 0, 5],
  [T.jump, 4, 9],
  [T.cave, 0, 5],
  [T.toast, 0, 5],
  [T.sunset, 6, 11],
];
const REEL: (readonly [string, number, number])[] = [
  [T.bay, 0, 5],
  [T.jump, 4, 10],
  [T.cave, 6, 11],
  [T.sunset, 6, 12],
];
const DRONES: (readonly [string, number, number])[] = [
  [T.bay, 0, 6],
  [T.lighthouse, 0, 6],
  [T.waves, 0, 6],
];
const BAKE_DAY: (readonly [string, number, number])[] = [
  [V.intro, 0, 6],
  [V.mix, 0, 4],
  [V.knead, 0, 4],
  [V.restTalk, 0, 5.5],
  [V.run, 0, 3],
  [V.shape, 0, 4],
  [V.bake, 0, 4],
  [V.crustTalk, 0, 8.5],
  [V.slice, 0, 3],
];
const BAKE_40: (readonly [string, number, number])[] = BAKE_DAY.filter(([r]) => r !== V.run);
const TOUR: (readonly [string, number, number])[] = [
  [H.outside, 0, 9],
  [H.hallway, 0, 9],
  [H.living, 0, 12],
  [H.kitchen, 0, 10],
  [H.bedroom, 0, 11],
  [H.bathroom, 0, 9],
  [H.balcony, 0, 8],
];
const EVENT_ROUGH = [
  E.hall,
  E.banner,
  E.keynote,
  E.applause,
  E.printer,
  E.handshake,
  E.panel,
  E.kids,
  E.interview,
  E.coffee,
  E.trophy,
  E.volunteers,
];
const eventRoughSeed = () => placedProject(EVENT, EVENT_ROUGH);
const PRODUCT: (readonly [string, number, number])[] = [
  [K.beans, 0, 5],
  [K.bag, 0, 5],
  [K.espresso, 2, 8],
  [K.logo, 0, 4],
];
const AD: (readonly [string, number, number])[] = [
  [K.beans, 0, 4],
  [K.espresso, 3, 7],
  [K.sip, 2, 6],
  [K.logo, 0, 3],
];
const PARTY_MONTAGE: (readonly [string, number, number])[] = [
  [B.candles, 0, 8],
  [B.balloons, 0, 6],
  [B.present, 0, 7],
  [B.dancing, 0, 8],
  [B.cakeCut, 0, 5],
  [B.hug, 0, 8],
];
const MEETUP_MINUTE: (readonly [string, number, number])[] = [
  [E.hall, 0, 6],
  [E.keynote, 0, 11],
  [E.printer, 0, 5],
  [E.kids, 0, 6],
  [E.interview, 0, 10],
  [E.trophy, 0, 8],
  [E.handshake, 0, 6],
  [E.volunteers, 0, 6],
];
const LESSON_SEED = () =>
  placedProject(LESSON, [P.intro, P.wheel, P.tyre, P.hole, P.patch, P.done]);
/** The lesson's silences and filler words, in its seed's frames (worked out from the words: each
 *  pause keeps 0.2 s either side, each filler goes whole). */
const DEAD_AIR = [
  [0, 12],
  [39, 49],
  [150, 222],
  [288, 369],
  [435, 533],
  [594, 678],
  [828, 1062],
  [1134, 1149],
  [1194, 1275],
  [1386, 1461],
  [1530, 1569],
  [1610, 1621],
  [1683, 1800],
].map(([start, end]) => ({ start, end }));
const TALKING: (readonly [string, number, number])[] = [
  [V.intro, 0, 10.5],
  [V.restTalk, 0, 5.5],
  [V.crustTalk, 0, 8.5],
];
const STEPS: (readonly [string, number, number])[] = [
  [V.mix, 0, 6],
  [V.knead, 0, 6],
  [V.shape, 0, 6],
  [V.bake, 0, 6],
];
const THEN_NOW: (readonly [string, number, number])[] = [
  [B.photo1986, 0, 4],
  [B.photo1994, 0, 4],
  [B.candles, 0, 6],
  [B.present, 0, 6],
  [B.dancing, 0, 8],
  [B.hug, 0, 8],
];
const COAST_45: (readonly [string, number, number])[] = [
  [T.bay, 0, 5],
  [T.lane, 0, 5],
  [T.boats, 0, 5],
  [T.jump, 5, 10],
  [T.cave, 0, 5],
  [T.lighthouse, 0, 5],
  [T.toast, 0, 5],
  [T.sunset, 6, 11],
  [T.ferry, 0, 5],
];
const TOUR_ORDER = [H.outside, H.hallway, H.living, H.kitchen, H.bedroom, H.bathroom, H.balcony];
const tourSeed = () => placedProject(HOME, TOUR_ORDER);
const FILM: (readonly [string, number, number])[] = [
  [T.bay, 0, 6],
  [T.harbourTalk, 0, 11],
  [T.lane, 0, 5],
  [T.boats, 0, 5],
  [T.jump, 3, 12],
  [T.cave, 0, 8],
  [T.snorkel, 0, 5],
  [T.lighthouse, 0, 6],
  [T.toast, 0, 5],
  [T.sunset, 4, 14],
];
const BRAND: (readonly [string, number, number])[] = [
  [K.beans, 0, 6],
  [K.roaster, 0, 6],
  [K.founder, 0, 10],
  [K.espresso, 2, 8],
  [K.latte, 0, 7],
  [K.bag, 0, 5],
  [K.sip, 2, 9],
  [K.logo, 0, 4],
];
const BIRTHDAY: (readonly [string, number, number])[] = [
  [B.photo1986, 0, 4],
  [B.candles, 0, 8],
  [B.balloons, 0, 5],
  [B.toast, 0, 10.5],
  [B.album, 0, 6],
  [B.present, 0, 6],
  [B.dancing, 0, 8],
  [B.cakeCut, 0, 5],
  [B.hug, 0, 8],
];
const RECAP_PAGE: (readonly [string, number, number])[] = [
  [E.banner, 0, 8],
  [E.hall, 0, 10],
  [E.keynote, 0, 12],
  [E.applause, 0, 7],
  [E.printer, 0, 8],
  [E.handshake, 0, 9],
  [E.panel, 0, 8],
  [E.kids, 0, 9],
  [E.interview, 0, 10],
  [E.coffee, 0, 6],
  [E.trophy, 0, 10],
  [E.volunteers, 0, 9],
];
const LISTING_45: (readonly [string, number, number])[] = [
  [H.outside, 0, 8],
  [H.hallway, 0, 7],
  [H.living, 0, 9],
  [H.kitchen, 0, 8],
  [H.bedroom, 0, 7],
  [H.balcony, 0, 8],
];
const POST: (readonly [string, number, number])[] = [
  [E.banner, 0, 6],
  [E.keynote, 0, 11],
  [E.kids, 0, 6],
  [E.trophy, 0, 6],
  [E.volunteers, 0, 6],
];
const PARTY_VIDEOS = [
  B.candles,
  B.toast,
  B.balloons,
  B.album,
  B.present,
  B.dancing,
  B.cakeCut,
  B.hug,
];
const EVERY_CLIP: (readonly [string, number, number])[] = PARTY_VIDEOS.map(
  (r) => [r, 0, 5] as const,
);
const TV: (readonly [string, number, number])[] = [
  [B.candles, 0, 6],
  [B.balloons, 0, 6],
  [B.present, 0, 6],
  [B.dancing, 0, 6],
  [B.cakeCut, 0, 5],
  [B.hug, 0, 6],
];
const GRADE_ORDER = [K.beans, K.roaster, K.espresso, K.latte, K.bag, K.sip];
const gradeSeed = () => placedProject(CAFE, GRADE_ORDER);
const WATERMARKED: (readonly [string, number, number])[] = [
  [K.beans, 0, 6],
  [K.roaster, 0, 6],
  [K.espresso, 2, 8],
  [K.latte, 0, 6],
  [K.sip, 2, 8],
];
const MEETUP_60: (readonly [string, number, number])[] = [
  [E.hall, 0, 6],
  [E.banner, 0, 6],
  [E.keynote, 0, 8],
  [E.printer, 0, 5],
  [E.handshake, 0, 6],
  [E.kids, 0, 6],
  [E.interview, 0, 10],
  [E.trophy, 0, 7],
  [E.volunteers, 0, 6],
];
const TEASER: (readonly [string, number, number])[] = [
  [H.outside, 0, 4],
  [H.living, 0, 5],
  [H.kitchen, 0, 4],
  [H.bedroom, 0, 3],
  [H.balcony, 0, 4],
];

const sizeOf = (lib: Footage): number => lib.clips.length;

/** The cases, each with its correct run as its `reference`. */
const CASES: Scenario[] = [
  // ── one sentence, choices left open ─────────────────────────────────────────
  {
    id: "wv_trailer_30s",
    title: "A 30-second trailer from a library of trip clips",
    tags: tags("trailer", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt: "Make a 30 second trailer from my trip footage.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(TRIP, lengthBetween(27, 33), distinctClips(3)),
    reference: [
      ...lookAtAll(TRIP),
      place(back2back(TRAILER)),
      say("Your 30-second trailer is on the timeline: six shots from the bay to the sunset."),
    ],
  },
  {
    id: "wv_vague_post_it",
    title: "A vague one-liner: make something postable from the clips",
    tags: tags("vague", sizeOf(EVENT)),
    surface: "studio",
    footage: EVENT,
    seed: newProject,
    prompt: "turn my clips into something i can post",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    // The person chose nothing: only that a video was made from their clips is graded.
    expect: all(EVENT, distinctClips(2), lengthBetween(5, 600)),
    reference: [
      ...lookAtAll(EVENT),
      place(back2back(POST)),
      say("I cut a 35-second highlight of the meetup you can post."),
    ],
  },

  // ── a length window and clips named for use, exclusion or position ──────────
  {
    id: "wv_highlight_open_close_must",
    title:
      "Event highlight: a length window, the opening and closing shots named, one shot required",
    tags: tags("highlight", sizeOf(EVENT)),
    surface: "studio",
    footage: EVENT,
    seed: newProject,
    prompt:
      "Event highlight from today's footage, 60 to 90 seconds. Open on the hall filling up, end on the volunteers' group photo, and the trophy moment has to be in there.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(
      EVENT,
      lengthBetween(60, 90),
      opensWith(E.hall),
      endsWith(E.volunteers),
      uses(E.trophy),
    ),
    reference: [
      ...lookAtAll(EVENT),
      place(back2back(HIGHLIGHT)),
      say(
        "A 77-second highlight: it opens on the hall, has the trophy, and ends on the volunteers.",
      ),
    ],
  },
  {
    id: "wv_travel_skip_food_and_shaky",
    title: "Travel video that leaves out a class of shots (food) and one accidental clip",
    tags: tags("travel", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt:
      "Make a 45 second travel video from my clips. Leave out the one I filmed by accident and anything with food in it.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(
      TRIP,
      lengthBetween(40.5, 49.5),
      avoids(T.pocket, T.octopus, T.market, T.iceCream),
      distinctClips(4),
    ),
    reference: [
      ...lookAtAll(TRIP),
      place(back2back(TRAVEL_45)),
      say("45 seconds of the coast, without the accidental clip or the food shots."),
    ],
  },
  {
    id: "wv_missing_shot_honest",
    title: "A recap that should end on a shot the footage does not have: say so",
    tags: tags("recap", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt: "Make a 30 second recap of the trip and end it on the fireworks.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(TRIP, lengthBetween(27, 33)),
    // There are no fireworks in the library: the honest reply says so instead of claiming the ending.
    expectTrace: saysMissing(/firework/i),
    reference: [
      ...lookAtAll(TRIP),
      place(back2back(RECAP_30)),
      say(
        "Here's a 30-second recap. I couldn't find any fireworks in your clips, so it ends on the sunset from the hill instead.",
      ),
    ],
  },
  {
    id: "wv_listing_room_order",
    title: "Property walkthrough in the room order the person named",
    tags: tags("tour", sizeOf(HOME)),
    surface: "studio",
    footage: HOME,
    seed: newProject,
    prompt:
      "Make a walkthrough video of the flat for the listing: start outside, then the hallway, the living room, the kitchen, the bedroom and the bathroom, and finish on the view from the balcony. About a minute long.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(
      HOME,
      inOrder(H.outside, H.hallway, H.living, H.kitchen, H.bedroom, H.bathroom, H.balcony),
      opensWith(H.outside),
      endsWith(H.balcony),
      lengthBetween(50, 70),
    ),
    reference: [
      ...lookAtAll(HOME),
      place(back2back(TOUR)),
      say("The walkthrough runs 68 seconds, room by room in your order."),
    ],
  },
  {
    id: "wv_use_every_clip_under_45",
    title: "Every party clip, in under 45 seconds",
    tags: tags("montage", sizeOf(PARTY)),
    surface: "studio",
    footage: PARTY,
    seed: newProject,
    prompt: "Use every video clip from the party, but keep the whole thing under 45 seconds.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(PARTY, uses(...PARTY_VIDEOS), lengthBetween(8, 45)),
    reference: [
      ...lookAtAll(PARTY),
      place(back2back(EVERY_CLIP)),
      say("All eight party clips, five seconds each: 40 seconds."),
    ],
  },
  {
    id: "wv_slowmo_named_moment",
    title: "Three named shots, one in slow motion",
    tags: tags("speed", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt:
      "Make a 30 second edit of our day at the sea: the jump, the kayak cave and the snorkelling, with the jump in slow motion.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "set_clip_properties"],
    maxRounds: 30,
    expect: all(TRIP, uses(T.jump, T.cave, T.snorkel), slowMotion(T.jump), lengthBetween(27, 33)),
    reference: [
      ...lookAtAll(TRIP),
      place(back2back([[T.jump, 5, 11]])),
      {
        calls: (req) => [
          [
            "set_clip_properties",
            { clip_ids: made(req, "video").map((c) => c.clip_id), speed: 0.5 },
          ],
        ],
      },
      place(
        back2back(
          [
            [T.cave, 0, 9],
            [T.snorkel, 0, 9],
          ],
          360,
        ),
      ),
      say("The jump plays at half speed (12 s), then the cave and the snorkelling: 30 seconds."),
    ],
  },

  // ── clips already on the timeline ───────────────────────────────────────────
  {
    id: "wv_rough_cut_to_a_minute",
    title: "Cut a 2-minute rough cut down to a minute, same order, one clip out",
    tags: tags("rough-cut", ROUGH.length),
    surface: "studio",
    footage: TRIP,
    seed: roughSeed,
    prompt:
      "These are my clips from the weekend, in the order I shot them. Cut it down to about a minute, keep them in the same order, and take out the one where my phone was in my pocket.",
    scope: placedScope(roughSeed()),
    mustNotCall: ["run_ffmpeg"],
    expectTools: ["get_timeline", "inspect_media", "ripple_delete"],
    maxRounds: 30,
    expect: all(
      TRIP,
      lengthBetween(54, 66),
      avoids(T.pocket),
      keepsSeedOrder(ROUGH),
      distinctClips(3),
    ),
    reference: [
      { calls: [["get_timeline", {}]] },
      {
        calls: ROUGH.map((r): [string, Record<string, unknown>] => [
          "inspect_media",
          { media_ref: r },
        ]),
      },
      { calls: [["ripple_delete", { track_id: "v1", ranges: ROUGH_CUTS }]] },
      say("Down to 58 seconds, same order, and the pocket clip is gone."),
    ],
  },
  {
    id: "wv_reorder_event_timeline",
    title: "Rearrange a placed cut: two shots to the front, one to the end, the rest in place",
    tags: tags("reorder", EVENT_ROUGH.length),
    surface: "studio",
    footage: EVENT,
    seed: eventRoughSeed,
    prompt:
      "Rearrange this so it starts with the trophy moment, then the keynote, then everything else in the order it's in now, and ends on the volunteers' group photo.",
    scope: placedScope(eventRoughSeed()),
    expectTools: ["get_timeline", "inspect_media", "move_clips"],
    maxRounds: 30,
    expect: all(
      EVENT,
      opensWith(E.trophy),
      secondIs(E.keynote),
      endsWith(E.volunteers),
      keepsSeedOrder(EVENT_ROUGH.filter((r) => r !== E.trophy && r !== E.keynote)),
      keptWhole(EVENT_ROUGH),
      runsFor(130),
    ),
    reference: [
      { calls: [["get_timeline", {}]] },
      {
        calls: EVENT_ROUGH.map((r): [string, Record<string, unknown>] => [
          "inspect_media",
          { media_ref: r },
        ]),
      },
      {
        calls: [
          [
            "move_clips",
            {
              moves: [
                ["c11", 0],
                ["c03", 360],
                ["c01", 810],
                ["c02", 1170],
                ["c04", 1410],
                ["c05", 1710],
                ["c06", 1980],
                ["c07", 2310],
                ["c08", 2730],
                ["c09", 3030],
                ["c10", 3420],
                ["c12", 3630],
              ].map(([clip_id, to]) => ({ clip_id, to_timeline_in: to, to_track: "v2" })),
            },
          ],
        ],
      },
      say(
        "Rearranged: the trophy, then the keynote, then the rest in order, ending on the volunteers.",
      ),
    ],
  },
  {
    id: "wv_polish_title_crossfades_fade",
    title: "Finish a placed cut: title, a crossfade at every cut, fade to black",
    tags: tags("polish", TOUR_ORDER.length),
    surface: "studio",
    footage: HOME,
    seed: tourSeed,
    prompt:
      "Finish this off for me: put the title 'Maple Court, Flat 4' at the start, crossfade between every shot, and fade out to black at the end.",
    scope: placedScope(tourSeed()),
    expectTools: ["add_text_clips", "set_transition", "set_clip_properties"],
    maxRounds: 30,
    expect: all(
      HOME,
      titleAtStart("Maple Court, Flat 4"),
      crossfadesEverywhere,
      fadesToBlack,
      inOrder(...TOUR_ORDER),
    ),
    reference: [
      { calls: [["get_timeline", {}]] },
      {
        calls: [
          [
            "add_text_clips",
            { entries: [{ content: "Maple Court, Flat 4", timeline_in: 0, timeline_out: 90 }] },
          ],
          ...["c02", "c03", "c04", "c05", "c06", "c07"].map(
            (id): [string, Record<string, unknown>] => [
              "set_transition",
              { clip_id: id, transition_in: { kind: "crossfade", duration: 15 } },
            ],
          ),
          ["set_clip_properties", { clip_ids: ["c07"], fade: { out: 30 } }],
        ],
      },
      say(
        "Title added, a half-second crossfade at every cut, and a one-second fade to black at the end.",
      ),
    ],
  },
  {
    id: "wv_same_warm_look_all",
    title: "One warm grade across every shot of a placed cut",
    tags: tags("colour", GRADE_ORDER.length),
    surface: "studio",
    footage: CAFE,
    seed: gradeSeed,
    prompt: "Give every shot the same warm look so the whole video matches.",
    scope: { change: placedScope(gradeSeed()).change },
    expectTools: ["inspect_color", "apply_color"],
    maxRounds: 20,
    expect: all(CAFE, sameWarmLook, uses(...GRADE_ORDER)),
    reference: [
      { calls: [["get_timeline", {}]] },
      // Measure first: the shots are graded from what inspect_color reads, not blind.
      { calls: [["inspect_color", { clip_id: "c01" }]] },
      {
        calls: [
          [
            "apply_color",
            {
              clip_ids: ["c01", "c02", "c03", "c04", "c05", "c06"],
              temperature: 7200,
              saturation: 1.05,
            },
          ],
        ],
      },
      say(
        "Every shot now has the same warm grade: white balance at 7200 K and a touch more saturation.",
      ),
    ],
  },
  {
    id: "wv_dead_air_chip",
    title: "The app's 'Cut the dead air' starter on a six-take lesson",
    tags: tags("dead-air", 6),
    surface: "studio",
    footage: LESSON,
    seed: LESSON_SEED,
    // The app's own starter chip, word for word (components/starterPrompts.ts).
    prompt: "Cut the silences and filler words, and close the gaps.",
    scope: placedScope(LESSON_SEED()),
    mustNotCall: ["run_ffmpeg"],
    expectTools: ["get_transcript", "ripple_delete"],
    maxRounds: 30,
    expect: all(LESSON, deadAirGone(), noBlackGaps),
    reference: [
      { calls: [["get_transcript", {}]] },
      { calls: [["ripple_delete", { track_id: "v1", ranges: DEAD_AIR }]] },
      say("Cut the pauses and the four filler words; the lesson now runs about 33 seconds."),
    ],
  },

  // ── the shape of the frame ───────────────────────────────────────────────────
  {
    id: "wv_reel_vertical_under_30",
    title: "Vertical reel under 30 seconds with no black gaps",
    tags: tags("reel", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt:
      "Cut an Instagram reel from these. Vertical, under 30 seconds, and no black gaps anywhere.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "set_project_settings"],
    maxRounds: 30,
    expect: all(
      TRIP,
      shapeIs(9, 16, "vertical"),
      lengthBetween(5, 30),
      noBlackGaps,
      distinctClips(2),
    ),
    reference: [
      ...lookAtAll(TRIP),
      { calls: [["set_project_settings", { size: { aspect_ratio: "9:16" } }]] },
      place(back2back(REEL)),
      say("A 22-second vertical reel."),
    ],
  },
  {
    id: "wv_drone_only_vertical_filled",
    title: "Vertical clip from the drone shots only, filling the frame",
    tags: tags("reel", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt:
      "Make a 15 to 20 second vertical clip using only the drone shots, and fill the whole frame, no black bars.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "set_project_settings", "set_clip_properties"],
    maxRounds: 30,
    expect: all(
      TRIP,
      shapeIs(9, 16, "vertical"),
      onlyFrom(T.bay, T.lighthouse, T.waves),
      distinctClips(2),
      lengthBetween(15, 20),
      fillsFrame,
    ),
    reference: [
      ...lookAtAll(TRIP),
      { calls: [["set_project_settings", { size: { aspect_ratio: "9:16" } }]] },
      place(back2back(DRONES)),
      {
        calls: (req) => [
          [
            "set_clip_properties",
            { clip_ids: made(req, "video").map((c) => c.clip_id), fit: "cover" },
          ],
        ],
      },
      say("18 seconds of the three drone shots, filling the vertical frame."),
    ],
  },
  {
    id: "wv_square_teaser_end_balcony",
    title: "Square teaser that ends on a named shot",
    tags: tags("teaser", sizeOf(HOME)),
    surface: "studio",
    footage: HOME,
    seed: newProject,
    prompt:
      "Make a square 20 second teaser of the flat for Instagram, ending on the view from the balcony.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "set_project_settings"],
    maxRounds: 30,
    expect: all(HOME, shapeIs(1, 1, "square"), lengthBetween(18, 22), endsWith(H.balcony)),
    reference: [
      ...lookAtAll(HOME),
      { calls: [["set_project_settings", { size: { aspect_ratio: "1:1" } }]] },
      place(back2back(TEASER)),
      say("A square 20-second teaser ending on the balcony view."),
    ],
  },
  {
    id: "wv_mixed_aspect_fill_landscape",
    title: "Widescreen from landscape and upright clips, frame filled",
    tags: tags("aspect", sizeOf(PARTY)),
    surface: "studio",
    footage: PARTY,
    seed: newProject,
    prompt:
      "Make a widescreen video of the party for the family TV. Some of the clips are upright from my phone, so don't leave black bars down the sides: fill the frame.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "set_clip_properties"],
    maxRounds: 30,
    expect: all(
      PARTY,
      shapeIs(16, 9, "widescreen"),
      uses(B.balloons, B.present, B.cakeCut),
      fillsFrame,
    ),
    reference: [
      ...lookAtAll(PARTY),
      place(back2back(TV)),
      {
        calls: (req) => {
          const upright = made(req, "video").filter((_, i) => [1, 2, 4].includes(i));
          return [
            ["set_clip_properties", { clip_ids: upright.map((c) => c.clip_id), fit: "cover" }],
          ];
        },
      },
      say("Widescreen, with the three upright clips filling the frame."),
    ],
  },

  // ── text on screen ─────────────────────────────────────────────────────────────
  {
    id: "wv_product_title_logo",
    title: "20-second product video: a title at the start, three named shots, end on the logo",
    tags: tags("product", sizeOf(CAFE)),
    surface: "studio",
    footage: CAFE,
    seed: newProject,
    prompt:
      "Make a 20 second product video for our coffee. Open with the title 'Small Batch, Big Flavour', show the bag, the beans and the espresso being pulled, and end on our logo.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_text_clips"],
    maxRounds: 30,
    expect: all(
      CAFE,
      lengthBetween(18, 22),
      titleAtStart("Small Batch, Big Flavour"),
      uses(K.bag, K.beans, K.espresso),
      endsWith(K.logo),
    ),
    reference: [
      ...lookAtAll(CAFE),
      place(back2back(PRODUCT)),
      titleAt("Small Batch, Big Flavour", 0, 90),
      say("20 seconds: the title over the beans, the bag, the espresso, and the logo to finish."),
    ],
  },
  {
    id: "wv_ad_15s_end_card",
    title: "15-second ad with an end card: the logo, a line of text under it, one shot left out",
    tags: tags("ad", sizeOf(CAFE)),
    surface: "studio",
    footage: CAFE,
    seed: newProject,
    prompt:
      "Cut a 15 second ad from the coffee footage. The last 3 seconds should be our logo with 'Order at freshbeans.example' underneath it. Leave out the grey test shot.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_text_clips"],
    maxRounds: 30,
    expect: all(
      CAFE,
      lengthBetween(14.5, 15.5),
      endCard(K.logo, "Order at freshbeans.example", 3),
      avoids(K.greyCard),
    ),
    reference: [
      ...lookAtAll(CAFE),
      place(back2back(AD)),
      titleAt("Order at freshbeans.example", 360, 450, 0.85),
      say("A 15-second ad; the last three seconds are the logo with the order line under it."),
    ],
  },
  {
    id: "wv_recipe_step_titles",
    title: "Recipe steps in order, each with its title on screen",
    tags: tags("recipe", sizeOf(BAKE)),
    surface: "studio",
    footage: BAKE,
    seed: newProject,
    prompt:
      "Make a recipe video of the sourdough: show the steps in order, with a title on screen for each one: Mix, Knead, Shape, Bake.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_text_clips"],
    maxRounds: 30,
    expect: all(
      BAKE,
      inOrder(V.mix, V.knead, V.shape, V.bake),
      stepTitles([
        ["Mix", V.mix],
        ["Knead", V.knead],
        ["Shape", V.shape],
        ["Bake", V.bake],
      ]),
    ),
    reference: [
      ...lookAtAll(BAKE),
      place(back2back(STEPS)),
      {
        calls: [
          [
            "add_text_clips",
            {
              entries: ["Mix", "Knead", "Shape", "Bake"].map((content, i) => ({
                content,
                timeline_in: i * 180,
                timeline_out: i * 180 + 60,
              })),
            },
          ],
        ],
      },
      say("Four steps, each with its title."),
    ],
  },
  {
    id: "wv_logo_corner_watermark",
    title: "A logo small in the top-right corner for the whole video",
    tags: tags("watermark", sizeOf(CAFE)),
    surface: "studio",
    footage: CAFE,
    seed: newProject,
    prompt:
      "Make a 30 second video from the coffee clips and keep our logo small in the top right corner the whole time.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "set_clip_properties"],
    maxRounds: 30,
    expect: all(CAFE, lengthBetween(27, 33), cornerLogo(K.logo), distinctClips(3, [K.logo])),
    reference: [
      ...lookAtAll(CAFE),
      place(back2back(WATERMARKED)),
      place([
        { media_ref: K.logo, track_id: "v2", timeline_in: 0, timeline_out: lengthOf(WATERMARKED) },
      ]),
      {
        calls: (req) => [
          [
            "set_clip_properties",
            {
              clip_ids: made(req).map((c) => c.clip_id),
              transform: { scale: 0.2, position: { x: 0.88, y: 0.15 } },
            },
          ],
        ],
      },
      say("30 seconds of the coffee clips with the logo small in the top-right corner throughout."),
    ],
  },

  // ── speech: captions, keeping it whole, cutting it tight ─────────────────────
  {
    id: "wv_tiktok_captions_vlog",
    title: "Vertical vlog under a minute with captions on everything said",
    tags: tags("vlog", sizeOf(BAKE)),
    surface: "studio",
    footage: BAKE,
    seed: newProject,
    prompt: "Make a TikTok of my sourdough day, under a minute, with captions on everything I say.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_captions"],
    maxRounds: 30,
    expect: all(
      BAKE,
      shapeIs(9, 16, "vertical"),
      lengthBetween(15, 60),
      speechHeard(),
      captioned(),
    ),
    reference: [
      ...lookAtAll(BAKE),
      place(back2back(BAKE_DAY)),
      { calls: [["add_captions", {}]] },
      say("A 42-second vertical vlog, captioned."),
    ],
  },
  {
    id: "wv_event_caption_speakers",
    title: "One-minute highlight with captions where people talk",
    tags: tags("captions", sizeOf(EVENT)),
    surface: "studio",
    footage: EVENT,
    seed: newProject,
    prompt:
      "Make a one minute highlight of the meetup and put captions on the parts where people are talking.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_captions"],
    maxRounds: 30,
    expect: all(EVENT, lengthBetween(54, 66), speechHeard(), captioned()),
    reference: [
      ...lookAtAll(EVENT),
      place(back2back(MEETUP_MINUTE)),
      { calls: [["add_captions", {}]] },
      say("A 58-second highlight with the keynote and the interview captioned."),
    ],
  },
  {
    id: "wv_only_talking_parts",
    title: "Only the talking-to-camera clips, in shooting order, every word kept",
    tags: tags("talking", sizeOf(BAKE)),
    surface: "studio",
    footage: BAKE,
    seed: newProject,
    prompt:
      "Make a short video of just the bits where I'm talking to the camera, in the order I filmed them.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(
      BAKE,
      onlyFrom(V.intro, V.restTalk, V.crustTalk),
      inOrder(V.intro, V.restTalk, V.crustTalk),
      everyWordOf(V.intro),
      everyWordOf(V.restTalk),
      everyWordOf(V.crustTalk),
    ),
    reference: [
      ...lookAtAll(BAKE),
      place(back2back(TALKING)),
      say("The three bits where you talk to the camera, in order: 24.5 seconds."),
    ],
  },
  {
    id: "wv_interview_broll_cover",
    title: "An interview as the spine, covered with b-roll while he talks",
    tags: tags("interview", sizeOf(EVENT)),
    surface: "studio",
    footage: EVENT,
    seed: newProject,
    prompt:
      "Use the interview with the guy in the beanie as the backbone: we should hear everything he says, and while he's talking, cover him with shots of the booths and the workshop.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_track"],
    maxRounds: 30,
    expect: all(
      EVENT,
      everyWordOf(E.interview),
      coveredWhileTalking(E.interview, [E.printer, E.handshake, E.kids], 0.4),
      noBlackGaps,
    ),
    reference: [
      ...lookAtAll(EVENT),
      place(back2back([[E.interview, 0, 10]])),
      place(
        back2back(
          [
            [E.printer, 0, 3],
            [E.kids, 0, 4],
            [E.handshake, 0, 2],
          ],
          30,
          { track_id: "v2", with_audio: false },
        ),
      ),
      say(
        "The interview plays whole; from one second in, the booths and the workshop cover him while he talks.",
      ),
    ],
  },

  // ── music ──────────────────────────────────────────────────────────────────────
  {
    id: "wv_party_montage_some_music",
    title:
      "Party montage with 'some music': the song in the library, under the cut and not past it",
    tags: tags("montage", sizeOf(PARTY)),
    surface: "studio",
    footage: PARTY,
    seed: newProject,
    prompt: "Put together a montage of mum's birthday party with some music under it.",
    scope: NEW_PROJECT_SCOPE,
    // The library holds a song: generating one would charge the person for what they already have.
    mustNotCall: ["generate_music"],
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(PARTY, musicUnder(B.song), distinctClips(3)),
    reference: [
      ...lookAtAll(PARTY),
      place(back2back(PARTY_MONTAGE)),
      music(B.song, lengthOf(PARTY_MONTAGE)),
      say("A 42-second montage with the piano song from your library under it."),
    ],
  },
  {
    id: "wv_music_quiet_under_voice",
    title: "Library music under a talking vlog, low enough to hear the voice",
    tags: tags("music", sizeOf(BAKE)),
    surface: "studio",
    footage: BAKE,
    seed: newProject,
    prompt:
      "Make a 40 second video of my baking day with the music from my library underneath, quiet enough that you can still hear me talking.",
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "set_clip_properties"],
    maxRounds: 30,
    expect: all(
      BAKE,
      lengthBetween(36, 44),
      musicUnder(V.music),
      speechHeard(),
      musicQuietUnderSpeech(V.music),
    ),
    reference: [
      ...lookAtAll(BAKE),
      place(back2back(BAKE_40)),
      music(V.music, lengthOf(BAKE_40)),
      {
        calls: (req) => [["set_clip_properties", { clip_ids: musicMade(req), volume: 0.3 }]],
      },
      say("39 seconds, with your music at 30% under your voice."),
    ],
  },

  // ── follow-ups ─────────────────────────────────────────────────────────────────
  {
    id: "wv_followup_shorter_retitle",
    title: "A trip video, then: shorter, and change the title",
    tags: tags("followup", sizeOf(TRIP), 2),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt: "Make a 45 second video of our trip with the title 'Coast Days' at the start.",
    followUps: ["Nice. Now cut it down to 30 seconds and change the title to 'Coast Days 2026'."],
    scope: NEW_PROJECT_SCOPE,
    expectTools: [...LOOK, "add_text_clips", "update_text"],
    maxRounds: 40,
    expect: all(
      TRIP,
      lengthBetween(27, 33),
      titleAtStart("Coast Days 2026"),
      noTextExactly("Coast Days"),
    ),
    reference: [
      ...lookAtAll(TRIP),
      place(back2back(COAST_45)),
      titleAt("Coast Days", 0, 90),
      say("45 seconds with 'Coast Days' at the start."),
      { calls: [["get_timeline", {}]] },
      {
        calls: (req) => {
          const timeline = JSON.stringify(req.round_input.tool_results?.[0]?.result ?? {});
          const title = /"(txt_[A-Za-z0-9_-]+)"/.exec(timeline)?.[1] ?? "";
          return [
            ["ripple_delete", { track_id: "v1", start: 900, end: 1350 }],
            ["update_text", { clip_ids: [title], content: "Coast Days 2026" }],
          ];
        },
      },
      say("Now 30 seconds, titled 'Coast Days 2026'."),
    ],
  },
  {
    id: "wv_followup_add_music_fade",
    title: "A one-minute recap, then: music under it, faded out at the end",
    tags: tags("followup", sizeOf(EVENT), 2),
    surface: "studio",
    footage: EVENT,
    seed: newProject,
    prompt: "Make a one minute recap of the meetup.",
    followUps: [
      "Now add the theme music from my library under the whole thing, and fade it out at the end.",
    ],
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "set_clip_properties"],
    maxRounds: 40,
    expect: all(EVENT, lengthBetween(54, 66), musicUnder(E.theme), musicFadesOut(E.theme)),
    reference: [
      ...lookAtAll(EVENT),
      place(back2back(MEETUP_60)),
      say("A one-minute recap."),
      music(E.theme, lengthOf(MEETUP_60)),
      {
        calls: (req) => [["set_clip_properties", { clip_ids: musicMade(req), fade: { out: 60 } }]],
      },
      say("The theme is under the whole recap and fades out over the last two seconds."),
    ],
  },
  {
    id: "wv_then_and_now_photos",
    title: "Two old photos first, four seconds each, then the party",
    tags: tags("photos", sizeOf(PARTY)),
    surface: "studio",
    footage: PARTY,
    seed: newProject,
    prompt:
      "Make a 'then and now' video for mum: the two old photos first, four seconds each, then the best bits of the party.",
    scope: NEW_PROJECT_SCOPE,
    expectTools: LOOK,
    maxRounds: 30,
    expect: all(PARTY, photosFirst([B.photo1986, B.photo1994], 4), distinctClips(5)),
    reference: [
      ...lookAtAll(PARTY),
      place(back2back(THEN_NOW)),
      say("The two old photos for four seconds each, then the party."),
    ],
  },

  // ── long briefs: every constraint must hold ──────────────────────────────────
  {
    id: "wv_long_brief_travel_film",
    title:
      "A long travel brief: length, opener, closer, kept speech, required and banned shots, title, ducked song, shape",
    tags: tags("long-brief", sizeOf(TRIP)),
    surface: "studio",
    footage: TRIP,
    seed: newProject,
    prompt:
      "Here's what I'm after for the trip video. It's for the family group chat, so nothing fancy, but I'd like it to feel like a proper little film. " +
      "Keep it between 60 and 75 seconds. Start with the drone shot over the bay, that's the opener, no question. Then the bit where I'm talking on the " +
      "harbour wall, and please don't cut me off mid-sentence. After that use whatever you think works from the rest, but the jump into the sea has to be " +
      "in there and so does the kayak in the cave, and I don't want the clip where my phone was filming the inside of my pocket. End on the sunset from " +
      "the hill. Put 'Summer on the Coast' as a title over the opening shot, and use my guitar song under the whole thing, turned down while I'm talking. " +
      "Widescreen, please.",
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "add_text_clips", "set_clip_properties"],
    maxRounds: 40,
    expect: all(
      TRIP,
      lengthBetween(60, 75),
      opensWith(T.bay),
      secondIs(T.harbourTalk),
      sentencesWhole(T.harbourTalk),
      uses(T.jump, T.cave),
      avoids(T.pocket),
      endsWith(T.sunset),
      titleAtStart("Summer on the Coast"),
      textDuring("Summer on the Coast", T.bay),
      musicUnder(T.song),
      musicQuietUnderSpeech(T.song),
      shapeIs(16, 9, "widescreen"),
    ),
    reference: [
      ...lookAtAll(TRIP),
      place(back2back(FILM)),
      titleAt("Summer on the Coast", 0, 120),
      music(T.song, lengthOf(FILM)),
      {
        calls: (req) => [["set_clip_properties", { clip_ids: musicMade(req), volume: 0.3 }]],
      },
      say(
        "70 seconds: the bay with the title, your harbour talk in full, the jump, the cave, and the sunset to close, with the song low under it.",
      ),
    ],
  },
  {
    id: "wv_long_brief_brand_film",
    title:
      "A long brand-film brief: opener, early title, founder whole and captioned, required shots, logo end, ducked beat",
    tags: tags("long-brief", sizeOf(CAFE)),
    surface: "studio",
    footage: CAFE,
    seed: newProject,
    prompt:
      "We need a short brand film for our website, somewhere between 45 seconds and a minute. Open on the beans pouring into the grinder, and get the " +
      "words 'Roasted This Week' on screen within the first three seconds. Somewhere in the middle I want the founder talking about how we roast: keep " +
      "everything he says, and put captions on it so it works with the sound off. Make sure the latte art and the customer taking her first sip are both " +
      "in there. Finish on our logo for at least three seconds. Put the lo-fi track from the library under the whole thing, low enough that he's easy to " +
      "hear. Don't use the grey test shot. Landscape.",
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "add_text_clips", "add_captions", "set_clip_properties"],
    maxRounds: 40,
    expect: all(
      CAFE,
      lengthBetween(45, 60),
      opensWith(K.beans),
      titleAtStart("Roasted This Week", 3),
      everyWordOf(K.founder),
      captioned(0.85, [K.founder]),
      uses(K.latte, K.sip),
      endsWith(K.logo),
      endCardHolds(K.logo, 3),
      musicUnder(K.beat),
      musicQuietUnderSpeech(K.beat),
      avoids(K.greyCard),
      shapeIs(16, 9, "landscape"),
    ),
    reference: [
      ...lookAtAll(CAFE),
      place(back2back(BRAND)),
      titleAt("Roasted This Week", 30, 120),
      { calls: [["add_captions", {}]] },
      music(K.beat, lengthOf(BRAND)),
      {
        calls: (req) => [["set_clip_properties", { clip_ids: musicMade(req), volume: 0.25 }]],
      },
      say(
        "A 51-second brand film: beans first with the title, the founder in full with captions, latte art, the first sip, and the logo to close.",
      ),
    ],
  },
  {
    id: "wv_long_brief_birthday",
    title:
      "A long birthday brief: an opening photo with a caption, required shots, an ending, a captioned toast, music down for the toast",
    tags: tags("long-brief", sizeOf(PARTY)),
    surface: "studio",
    footage: PARTY,
    seed: newProject,
    prompt:
      "It's my mum's 60th and I want to play a video at her party. Please make it between one and one and a half minutes. Start with the old photo of her " +
      "on the beach from the eighties, on screen for about four seconds, with 'Happy 60th, Mum' over it. Then mix the party clips however you like, but the " +
      "candles and her hug with her sister must be in it, and it should end on that hug. Keep my brother's toast in full, every word, and put captions on it " +
      "because the room will be noisy. Use the piano song from my library underneath, but bring it right down during the toast. No black gaps anywhere please.",
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "add_text_clips", "add_captions", "set_keyframes"],
    maxRounds: 40,
    expect: all(
      PARTY,
      lengthBetween(60, 90),
      opensHolding(B.photo1986, 3, 5),
      textDuring("Happy 60th, Mum", B.photo1986),
      uses(B.candles, B.hug),
      endsWith(B.hug),
      everyWordOf(B.toast),
      captioned(0.85, [B.toast]),
      musicUnder(B.song),
      musicQuietUnderSpeech(B.song, 0.35, [B.toast]),
      noBlackGaps,
    ),
    reference: [
      ...lookAtAll(PARTY),
      place(back2back(BIRTHDAY)),
      titleAt("Happy 60th, Mum", 0, 120),
      { calls: [["add_captions", {}]] },
      music(B.song, lengthOf(BIRTHDAY)),
      {
        calls: (req) => [
          [
            "set_keyframes",
            {
              clip_id: musicMade(req)[0],
              property: "volume",
              keyframes: [
                { t: 0, v: 1 },
                { t: 495, v: 1 },
                { t: 510, v: 0.2 },
                { t: 825, v: 0.2 },
                { t: 840, v: 1 },
              ],
            },
          ],
        ],
      },
      say(
        "A 60-second video for your mum: the beach photo with 'Happy 60th, Mum', the party, the toast in full with captions and the music down under it, ending on the hug.",
      ),
    ],
  },
  {
    id: "wv_long_brief_event_recap",
    title:
      "A long event-recap brief: opener, a lower third, required shots, a captioned interview, one shot out, closer, theme, shape, no gaps",
    tags: tags("long-brief", sizeOf(EVENT)),
    surface: "studio",
    footage: EVENT,
    seed: newProject,
    prompt:
      "Can you make the recap video for our meetup page? Between a minute and a half and two minutes. Open on the entrance banner so people know which " +
      "event it is. When Ana gives her welcome speech, put her name on screen in the lower third as 'Ana Ruiz, Organiser'. Include the kids building " +
      "robots at the workshop, and the guy in the beanie saying why he came: caption what he says. Leave out the out-of-focus shot of the carpet. Finish on the " +
      "volunteers waving. Put the theme track from the library under all of it. Landscape, and no black gaps.",
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "add_text_clips", "add_captions"],
    maxRounds: 40,
    expect: all(
      EVENT,
      lengthBetween(90, 120),
      opensWith(E.banner),
      lowerThird("Ana Ruiz, Organiser", E.keynote),
      uses(E.kids, E.interview),
      captioned(0.85, [E.interview]),
      avoids(E.carpet),
      endsWith(E.volunteers),
      musicUnder(E.theme),
      shapeIs(16, 9, "landscape"),
      noBlackGaps,
    ),
    reference: [
      ...lookAtAll(EVENT),
      place(back2back(RECAP_PAGE)),
      titleAt("Ana Ruiz, Organiser", 570, 720, 0.82),
      { calls: [["add_captions", {}]] },
      music(E.theme, lengthOf(RECAP_PAGE)),
      say(
        "A 106-second recap, opening on the banner and closing on the volunteers, with Ana's name, the interview captioned and the theme underneath.",
      ),
    ],
  },
  {
    id: "wv_listing_export",
    title: "A listing tour with a room left out and music, then exported",
    tags: tags("export", sizeOf(HOME)),
    surface: "studio",
    footage: HOME,
    seed: newProject,
    prompt:
      "Make a 45 second tour of the flat for the listing, starting outside and ending on the balcony view. Skip the bathroom, it's being redone. Put the piano track under it and export it when you're done.",
    scope: NEW_PROJECT_SCOPE,
    mustNotCall: ["generate_music"],
    expectTools: [...LOOK, "export"],
    maxRounds: 30,
    expect: all(
      HOME,
      lengthBetween(40, 50),
      opensWith(H.outside),
      endsWith(H.balcony),
      avoids(H.bathroom),
      musicUnder(H.piano),
    ),
    expectTrace: exportsOnceAfterEditing,
    reference: [
      ...lookAtAll(HOME),
      place(back2back(LISTING_45)),
      music(H.piano, lengthOf(LISTING_45)),
      { calls: [["export", {}]] },
      say(
        "The 47-second tour is exporting now; it goes to your Downloads folder when it finishes.",
      ),
    ],
  },
];

/** The logo holds the last `seconds` (within 0.3 s). */
function endCardHolds(ref: string, seconds: number): Check {
  return (tl, lib) => {
    const end = pictureEnd(tl);
    const from = end - seconds * fpsOf(tl);
    const shown = pictures(tl)
      .filter((p) => refOf(lib, p.clip) === ref)
      .map((p): [number, number] => [tin(p.clip), tout(p.clip)]);
    const held = coveredWithin(shown, from, end);
    if (held < (seconds - 0.3) * fpsOf(tl))
      fail(
        `the logo holds ${secs(tl, held)} s at the end; the request asked for at least ${seconds} s`,
      );
  };
}

export const GAP_WHOLEVIDEO: Scenario[] = CASES;
