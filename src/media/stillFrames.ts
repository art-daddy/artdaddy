// Which frame of an animated still (GIF, APNG, animated WebP) the export shows at a project frame.
//
// The export loops the still and converts it to the project rate with
// `fps=fps=FPS:start_time=0:round=near`. Measured on the shipped ffmpeg for a GIF with irregular
// delays at 24, 25, 30 and 60 fps (357 frames, 0 mismatches): project frame k shows the LAST frame,
// over the looped sequence, whose start rounded to the nearest project frame is not after k. The
// preview follows this rule, so it shows the frame the export shows.
//
// Times stay integers in the stream's own time base, as ffmpeg keeps them: a start of 15/100 s at
// 30 fps is exactly 4.5 frames, which ffmpeg rounds up and floating point (4.4999999999999991)
// would round down.

export interface StillTiming {
  /** Time base denominator of `pts` and `period` (GIF: 100, animated WebP: 1000). */
  den: number;
  /** Each frame's start, ascending, in 1/den s; the first is 0. */
  pts: number[];
  /** One pass of the animation, in 1/den s: where the next pass starts. */
  period: number;
  /** How many passes play: Infinity loops for as long as the clip runs. */
  passes: number;
}

/** The project frame a still's frame starts on: round half away from zero, in integers. */
function tick(start: number, fps: number, den: number): number {
  return Math.floor((2 * start * fps + den) / (2 * den));
}

/** The index of the still's frame the export shows at clip-relative project frame `k`. Before the
 *  clip (a transition's lead-in) it shows what it shows at 0: the export clones that frame. */
export function stillFrameAt(t: StillTiming, fps: number, k: number): number {
  const n = t.pts.length;
  if (n <= 1 || t.period <= 0) return 0;
  // Several frames can start before the first project frame rounds: the LAST of them shows at 0
  // (measured: frames at 0, 1 and 2 cs show the third at 24 and 30 fps, the first at 60).
  k = Math.max(0, k);
  const lastPass = Number.isFinite(t.passes) ? Math.max(0, t.passes - 1) : Infinity;
  // The pass k falls in, give or take one for rounding at the boundary.
  let pass = Math.min(lastPass, Math.max(0, Math.floor((k * t.den) / (fps * t.period))));
  while (pass > 0 && tick(pass * t.period, fps, t.den) > k) pass--;
  while (pass < lastPass && tick((pass + 1) * t.period, fps, t.den) <= k) pass++;
  let shown = 0;
  for (let i = 0; i < n; i++) if (tick(pass * t.period + t.pts[i], fps, t.den) <= k) shown = i;
  return shown;
}

/** The frame in view just before `end` (in 1/den s, from the clip's start): the last frame STARTING
 *  before it, over the passes the still plays. What the export holds once a still's span ends:
 *  its input is cut there and the hold repeats the last frame it decoded (measured, 64 of 64). */
export function stillFrameBefore(t: StillTiming, end: number): number {
  const n = t.pts.length;
  if (n <= 1 || t.period <= 0 || !(end > 0)) return 0;
  const lastPass = Number.isFinite(t.passes) ? Math.max(0, t.passes - 1) : Infinity;
  const pass = Math.min(lastPass, Math.floor(end / t.period));
  const into = end - pass * t.period;
  // A span ending exactly on a pass boundary leaves the previous pass's last frame in view.
  if (into <= 0) return n - 1;
  if (pass === lastPass && into >= t.period) return n - 1;
  let shown = 0;
  for (let i = 0; i < n; i++) if (t.pts[i] < into) shown = i;
  return shown;
}

/** The frame a still's clip shows at clip-relative project frame `k`: its first frame before the
 *  clip (a lead-in), its stream frame at the clip's speed inside it, and after its `len` frames the
 *  frame its export holds. One answer for the preview and for an inspect look. */
export function stillFrameShown(
  t: StillTiming,
  fps: number,
  k: number,
  len: number,
  speed: number,
): number {
  if (k >= len) return stillFrameBefore(t, (len * speed * t.den) / fps);
  return stillFrameAt(t, fps, k < 0 ? 0 : Math.floor(k * speed + 1e-6));
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A still's timing from ffprobe's JSON (`-show_entries stream=time_base,width,height:frame=pts,duration`),
 *  with its picture size, or null when the numbers cannot be trusted. `passes` is how many passes
 *  the export plays (stillReader.exportPasses). */
export function timingFromProbe(
  probe: unknown,
  passes: number,
): { timing: StillTiming; w: number; h: number } | null {
  if (!probe || typeof probe !== "object") return null;
  const p = probe as { frames?: unknown; streams?: unknown };
  const stream = Array.isArray(p.streams)
    ? (p.streams[0] as Record<string, unknown> | undefined)
    : undefined;
  const frames = Array.isArray(p.frames) ? (p.frames as Record<string, unknown>[]) : [];
  if (!stream || frames.length === 0) return null;
  const tb = /^(\d+)\/(\d+)$/.exec(String(stream.time_base ?? ""));
  const num = tb ? Number(tb[1]) : 0;
  const den = tb ? Number(tb[2]) : 0;
  // A time base of 1/den is what every animated reader uses; anything else is not one we measured.
  if (num !== 1 || !(den > 0)) return null;
  const w = Number(stream.width);
  const h = Number(stream.height);
  if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) return null;
  const raw = frames.map((f) => Number(f?.pts));
  if (!raw.every((v) => Number.isInteger(v))) return null;
  const pts = raw.map((v) => v - raw[0]);
  for (let i = 1; i < pts.length; i++) if (!(pts[i] > pts[i - 1])) return null;
  const last = Number(frames[frames.length - 1]?.duration);
  if (!(Number.isInteger(last) && last > 0)) return null;
  // A GIF with anything after its last picture (a comment, a loop count kept at the end) has a packet
  // more than pictures: it decodes to nothing, yet the export's `-stream_loop` waits it out before the
  // next pass (measured). So the pictures are the first `nb_frames`, and the pass ends where the
  // last packet does. A count that is absent or not below the packets removes nothing.
  const count = Number(stream.nb_frames);
  const pictures = Number.isInteger(count) && count > 0 && count < pts.length ? count : pts.length;
  return {
    timing: { den, pts: pts.slice(0, pictures), period: pts[pts.length - 1] + last, passes },
    w,
    h,
  };
}

/** Longest side of a preview frame, and the most pixels all of a still's frames may take together. */
const PACK_EDGE = 1024;
const PACK_PIXELS = 64e6;
const PACK_MIN_EDGE = 64;

/** The size the preview decodes a still's `n` frames at: its own size, bounded on the long edge,
 *  then shrunk until every frame together fits the budget. Null when that would be too small to be
 *  worth showing (the still then stays unmoving in the preview, as it was). */
export function packSize(n: number, w: number, h: number): { w: number; h: number } | null {
  if (!(n > 0 && w > 0 && h > 0)) return null;
  const long = Math.max(w, h);
  let edge = Math.min(PACK_EDGE, long);
  const area = (e: number) => {
    const s = e / long;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  };
  const budget = Math.floor(Math.sqrt(PACK_PIXELS / n / ((w * h) / (long * long))));
  edge = Math.min(edge, budget);
  // Never shrunk below a usable size; a still already smaller than that keeps its own.
  const floor = Math.min(PACK_MIN_EDGE, long);
  // Rounding can tip a side up a pixel: step down until the total truly fits.
  while (edge >= floor) {
    const s = area(edge);
    if (s.w * s.h * n <= PACK_PIXELS) return s;
    edge--;
  }
  return null;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Byte ranges of the PNGs ffmpeg wrote back to back (`-f image2pipe -c:v png`), each walked by its
 *  own chunks to IEND. Null unless the whole stream is PNGs, end to end. */
export function splitPngStream(bytes: Uint8Array): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  let at = 0;
  while (at < bytes.length) {
    const start = at;
    if (at + 8 > bytes.length || !PNG_SIG.every((v, i) => bytes[at + i] === v)) return null;
    at += 8;
    for (;;) {
      if (at + 12 > bytes.length) return null;
      const len =
        ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
      const iend =
        bytes[at + 4] === 0x49 &&
        bytes[at + 5] === 0x45 &&
        bytes[at + 6] === 0x4e &&
        bytes[at + 7] === 0x44;
      at += 12 + len;
      if (at > bytes.length) return null;
      if (iend) break;
    }
    out.push([start, at]);
  }
  return out.length ? out : null;
}

/** What the preview needs beside a still's frames: when each shows, and the frames' size. */
export interface PackIndex {
  timing: StillTiming;
  w: number;
  h: number;
}

const PACK_INDEX_VERSION = 1;

/** The index as written to disk. `passes` 0 means forever (JSON has no Infinity). */
export function serializePackIndex(index: PackIndex): string {
  const { timing: t, w, h } = index;
  return JSON.stringify({
    v: PACK_INDEX_VERSION,
    den: t.den,
    pts: t.pts,
    period: t.period,
    passes: Number.isFinite(t.passes) ? t.passes : 0,
    w,
    h,
  });
}

/** Read an index back, or null for anything that is not one this version wrote and the rule can use. */
export function parsePackIndex(text: string): PackIndex | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || j.v !== PACK_INDEX_VERSION) return null;
  const { den, period, passes, w, h } = j;
  const pts = j.pts;
  if (
    !isCount(den) ||
    den === 0 ||
    !isCount(period) ||
    !isCount(passes) ||
    !isCount(w) ||
    !isCount(h)
  )
    return null;
  if (w === 0 || h === 0 || !Array.isArray(pts) || pts.length === 0 || pts[0] !== 0) return null;
  for (let i = 0; i < pts.length; i++)
    if (!isCount(pts[i]) || (i > 0 && !(pts[i] > pts[i - 1]))) return null;
  if (!(period > pts[pts.length - 1])) return null;
  return {
    timing: { den, pts: pts as number[], period, passes: passes === 0 ? Infinity : passes },
    w,
    h,
  };
}
