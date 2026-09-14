// NLE-style scalar clamping — nearest-bound instead of reject.
// Ports renderer._clamp_timeline_values / _clamp_clip_values.
import { isNum } from "./frames";
import type { Clip, Timeline } from "./model";

function clampNum(v: number, lo: number, hi: number | null): number {
  const x = v < lo ? lo : v;
  return hi !== null && x > hi ? hi : x;
}

/** The rail a fade edge must stop at, in FRAMES. Exported because the clip's fade knob has to
 *  stop the ghost exactly where the commit below would clamp it — a drag that promises a longer
 *  fade than the write accepts is the "it snapped back" bug.
 *
 *  Clamps only. A fractional fade is legal (the renderer reads `fade/fps` seconds), so rounding
 *  here would quietly rewrite a value the agent set on purpose; the knob rounds its own pixels. */
export function clampFadeFrames(frames: number, spanFrames: number): number {
  return clampNum(frames, 0, Math.max(0, spanFrames));
}

/** Clamp one clip's out-of-range scalar knobs IN PLACE; return `field old->new`
 *  notes. Types/enums/keyframes/timing are left for validation. `spanFrames` is the
 *  clip's timeline length in frames, the upper bound for its fades. */
export function clampClipValues(clip: Clip, spanFrames: number | null): string[] {
  const notes: string[] = [];
  const rec = clip as Record<string, unknown>;

  const top = (key: string, lo: number, hi: number | null): void => {
    const v = rec[key];
    if (isNum(v)) {
      const c = clampNum(v, lo, hi);
      if (c !== v) {
        rec[key] = c;
        notes.push(`${key} ${v}->${c}`);
      }
    }
  };
  const sub = (
    d: Record<string, unknown>,
    key: string,
    lo: number,
    hi: number | null,
    label: string,
  ): void => {
    const v = d[key];
    if (isNum(v)) {
      const c = clampNum(v, lo, hi);
      if (c !== v) {
        d[key] = c;
        notes.push(`${label} ${v}->${c}`);
      }
    }
  };

  top("opacity", 0, 1);
  top("volume", 0, null);

  const g = rec.glow;
  if (isNum(g)) top("glow", 0, 100);
  else if (g !== null && typeof g === "object") {
    const go = g as Record<string, unknown>;
    sub(go, "amount", 0, 100, "glow.amount");
    sub(go, "opacity", 0, 1, "glow.opacity");
  }

  const cr = rec.crop;
  if (cr !== null && typeof cr === "object") {
    const cro = cr as Record<string, unknown>;
    for (const side of ["left", "top", "right", "bottom"]) sub(cro, side, 0, 0.98, `crop.${side}`);
    for (const [a, b] of [
      ["left", "right"],
      ["top", "bottom"],
    ] as const) {
      const va = cro[a];
      const vb = cro[b];
      if (isNum(va) && isNum(vb) && va + vb >= 0.99) {
        const s = 0.98 / (va + vb);
        cro[a] = va * s;
        cro[b] = vb * s;
        notes.push(`crop.${a}+${b} scaled to <1`);
      }
    }
  }

  const dk = rec.duck;
  if (dk !== null && typeof dk === "object") {
    const dko = dk as Record<string, unknown>;
    sub(dko, "ratio", 1, null, "duck.ratio");
    sub(dko, "threshold", 0.001, 1, "duck.threshold");
  }

  const fd = rec.fade;
  if (fd !== null && typeof fd === "object" && spanFrames !== null) {
    const fdo = fd as Record<string, unknown>;
    // fade.in/out are FRAME counts (the renderer reads them as fade/fps), so the
    // bound is the clip's frame span -- NOT the span in seconds.
    for (const key of ["in", "out"] as const) {
      const v = fdo[key];
      if (!isNum(v)) continue;
      const c = clampFadeFrames(v, spanFrames);
      if (c !== v) {
        fdo[key] = c;
        notes.push(`fade.${key} ${v}->${c}`);
      }
    }
  }

  return notes;
}

/** Clamp every clip's scalar knobs in place; return located notes
 *  (`track.clips[i]: field old->new`). Fade bounds are the clip's frame span. */
export function clampTimelineValues(timeline: Timeline): string[] {
  const notes: string[] = [];
  const tracks = (timeline as Timeline | null | undefined)?.tracks;
  if (!Array.isArray(tracks)) return notes;
  for (const track of tracks) {
    if (track === null || typeof track !== "object") continue;
    const tid = track.id ?? "?";
    const clips = track.clips;
    if (!Array.isArray(clips)) continue;
    for (let ci = 0; ci < clips.length; ci++) {
      const clip = clips[ci];
      if (clip === null || typeof clip !== "object") continue;
      let spanFrames: number | null = null;
      const ti = clip.timeline_in;
      const to = clip.timeline_out;
      if (isNum(ti) && isNum(to)) spanFrames = to - ti;
      for (const note of clampClipValues(clip, spanFrames))
        notes.push(`${tid}.clips[${ci}]: ${note}`);
    }
  }
  return notes;
}
