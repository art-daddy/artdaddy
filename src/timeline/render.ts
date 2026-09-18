// Scoped client renderer: compile a timeline to a real mp4 via one ffmpeg
// filter_complex. Mirrors the core of renderer.py::_build_ffmpeg_cmd for the
// COMMON case — a black canvas base, per-clip scale/fit + z-ordered overlays
// gated by an `enable` window, and audio adelay+volume+amix. Deferred (emit a
// warning, not rendered yet): keyframes, rotate/crop/flip/glow/blend, color
// grade, effects, transitions, text clips, audio fade/duck/loop/stretch. These
// grow toward full parity alongside the WebGL preview.
import type { ClientToolContext } from "../tools/context";
import { stderrExcerpt, type CommandResult } from "../tools/command";
import {
  isAbsolutePath,
  joinPath,
  type LibraryClip,
  type ProjectStoreAccess,
} from "../tools/store";
import { undecodableImageReason } from "../tools/imageDims";
import { useExportJob } from "../store/exportJob";
import { compileAnim, sampleAnim } from "./anim";
import { brandRatio, endcardFile, watermarkFile, type Branding } from "./branding";
import { loadTimeline } from "./engine";
import { createProgressReader, etaSeconds, progressFraction } from "./ffmpegProgress";
import { canvasFps, isNum, toSecondsView } from "./frames";
import { crfFor, outputFps, outputSize, type ExportOptions } from "./exportOptions";
import { clipKind } from "./helpers";
import type { Animatable, Clip, Timeline } from "./model";
import { validateTimeline } from "./validate";
import {
  resolveRenderPlan,
  type BlendKind,
  type FitKind,
  type ResolvedTransition,
} from "./renderPlan";
import { buildBandAss, unrenderableFlags, type CaptionSpec } from "./assCaption";
import { ExportRunError, isDestinationReserved, submitExport } from "./exportQueue";
import { sourceHasAudio } from "./placement";
import { clipPlays, outputGate, suppressClip } from "./visibility";
import { assertNever } from "./transition";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

const DEFERRED_FIELDS: string[] = [];

/** How long the OUTPUT is: the last frame that anything actually contributing to it occupies.
 *
 *  It used to be the last frame on ANY track. The render plan filters hidden/muted tracks, so the
 *  two disagreed and the file was padded to the length of material it did not contain: a 15.8s cut
 *  exported as a 40.8s file, 25 seconds of it black, because a hidden track still ran to 40.8s. The
 *  user's workaround was to delete the track rather than hide it.
 *
 *  Same gate the compositor uses, so hiding a lane cannot change the picture and the length by two
 *  different rules again. Deliberately does NOT consult `clipPlays`: `suppressClip` sets the same
 *  `disabled` flag for a purely technical reason (a source with no audio stream, which ffmpeg would
 *  otherwise reject), and reading it here made a normal export come out zero-length. A clip the USER
 *  disabled at the tail therefore still sets the length — a residual, and the smaller of the two. */
export function canvasDuration(timeline: Timeline): number {
  const gate = outputGate(timeline);
  let end = 0;
  for (const t of gate.tracks) {
    for (const c of t.clips ?? []) {
      if (!gate.admits(t, String(c.kind ?? "video"))) continue;
      const to = Number(c.timeline_out);
      if (!Number.isNaN(to)) end = Math.max(end, to);
    }
  }
  return end;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  fit: FitKind;
}

function hasVal(v: unknown): boolean {
  return isNum(v) || Array.isArray(v);
}

/** Chroma-safe pixel size: >= 2 and EVEN. Every dimension handed to scale/crop/pad
 *  must satisfy this because the composite runs in a 4:2:0 pixel format. */
function evenPx(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

function boxOf(clip: Clip, cw: number, ch: number, fit: FitKind): Box {
  const t = clip.transform;
  if (t && (t.position || hasVal(t.scale) || hasVal(t.scale_x) || hasVal(t.scale_y))) {
    // Normalized centre position + scale -> internal top-left px box (mirrors
    // renderer.py::_parse_transform). Sampled at frame 0 (keyframed transform is
    // a later slice). fit describes how the source fills the box.
    const px = hasVal(t.position?.x) ? sampleAnim(t.position!.x, 0) : 0.5;
    const py = hasVal(t.position?.y) ? sampleAnim(t.position!.y, 0) : 0.5;
    const s = hasVal(t.scale) ? sampleAnim(t.scale as Animatable, 0) : 1;
    const sx = hasVal(t.scale_x) ? sampleAnim(t.scale_x as Animatable, 0) : s;
    const sy = hasVal(t.scale_y) ? sampleAnim(t.scale_y as Animatable, 0) : s;
    // EVEN, always: we composite in a 4:2:0 pixel format, and `pad` rounds its INPUT up
    // to chroma alignment before comparing — so an odd box (scale 0.29 of 1080 -> 313)
    // makes pad see 313 < 314 and abort the whole render with a misleading "padded
    // dimensions cannot be smaller than input dimensions". The keyframed path below
    // already rounds to even; this static one did not.
    const w = evenPx(sx * cw);
    const h = evenPx(sy * ch);
    return { x: Math.round(px * cw - w / 2), y: Math.round(py * ch - h / 2), w, h, fit };
  }
  return { x: 0, y: 0, w: cw, h: ch, fit };
}

/** Per-frame px anims for the ffmpeg overlay/scale, derived from the normalized
 *  transform. When position OR scale is KEYFRAMED, returns CENTRE-px posX/posY and
 *  size-px sizeW/sizeH anims with posCenter:true (the overlay then places the clip
 *  centre at posX/posY via `-overlay_w/2`, so position and scale compose without
 *  coupling). Otherwise returns the static top-left box (byte-identical to the
 *  non-animated path). */
function transformAnims(
  clip: Clip,
  box: Box,
  cw: number,
  ch: number,
): {
  posX: Animatable;
  posY: Animatable;
  sizeW: Animatable;
  sizeH: Animatable;
  posCenter: boolean;
} {
  const t = clip.transform;
  const scaleAnimPx = (a: unknown, dim: number): Animatable =>
    (Array.isArray(a)
      ? a.map((k) => ({
          ...(k as Record<string, unknown>),
          v: Number((k as { v: number }).v) * dim,
        }))
      : Number(a) * dim) as Animatable;
  if (t) {
    const effX = t.scale_x ?? t.scale;
    const effY = t.scale_y ?? t.scale;
    const px = t.position?.x;
    const py = t.position?.y;
    if ([px, py, effX, effY].some((v) => Array.isArray(v))) {
      return {
        posX: scaleAnimPx(px ?? 0.5, cw), // centre px
        posY: scaleAnimPx(py ?? 0.5, ch),
        sizeW: scaleAnimPx(effX ?? 1, cw),
        sizeH: scaleAnimPx(effY ?? 1, ch),
        posCenter: true,
      };
    }
  }
  return { posX: box.x, posY: box.y, sizeW: box.w, sizeH: box.h, posCenter: false };
}

/** HSV (h,s,v in 0..1) -> RGB 0..1. For colour-wheel hue pushes. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** A tone-curve param ([[x,y]..] in 0..1) -> ffmpeg curves point string, or null. */
function curveStr(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const pts = v
    .filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]))
    .map((p) => `${(p[0] as number).toFixed(4)}/${(p[1] as number).toFixed(4)}`);
  return pts.length ? pts.join(" ") : null;
}

/** Static colour grade -> ffmpeg filters (mirrors renderer.py::_parse_color for
 *  the common knobs). Values are used in ffmpeg's native ranges. Primaries, then
 *  levels, colour wheels, tone curves, and a LUT last (on top of the grade). */
function colorFilters(color: unknown): string[] {
  if (!color || typeof color !== "object") return [];
  const c = color as Record<string, unknown>;
  const num = (k: string, d: number): number => (isNum(c[k]) ? (c[k] as number) : d);
  const out: string[] = [];
  if (isNum(c.exposure)) out.push(`exposure=exposure=${num("exposure", 0).toFixed(4)}`);
  const b = num("brightness", 0);
  const con = num("contrast", 1);
  const sat = num("saturation", 1);
  const gam = num("gamma", 1);
  if (b !== 0 || con !== 1 || sat !== 1 || gam !== 1) {
    out.push(
      `eq=brightness=${b.toFixed(4)}:contrast=${con.toFixed(4)}:saturation=${sat.toFixed(4)}:gamma=${gam.toFixed(4)}`,
    );
  }
  if (isNum(c.temperature))
    out.push(`colortemperature=temperature=${filterKelvin(num("temperature", 6500)).toFixed(1)}`);
  if (isNum(c.tint)) out.push(`colorbalance=gm=${num("tint", 0).toFixed(4)}`);
  if (isNum(c.vibrance)) out.push(`vibrance=intensity=${num("vibrance", 0).toFixed(4)}`);
  // Levels: black/white points (colorlevels). blacks >0 lifts (faded) / <0 crushes;
  // whites >0 brightens highlights / <0 dims.
  const blacks = num("blacks", 0);
  const whites = num("whites", 0);
  if (blacks !== 0 || whites !== 0) {
    const imin = (blacks < 0 ? -blacks * 0.5 : 0).toFixed(4);
    const omin = (blacks > 0 ? blacks * 0.5 : 0).toFixed(4);
    const imax = (whites > 0 ? 1 - whites * 0.5 : 1).toFixed(4);
    const omax = (whites < 0 ? 1 + whites * 0.5 : 1).toFixed(4);
    out.push(
      `colorlevels=rimin=${imin}:gimin=${imin}:bimin=${imin}:rimax=${imax}:gimax=${imax}:bimax=${imax}:romin=${omin}:gomin=${omin}:bomin=${omin}:romax=${omax}:gomax=${omax}:bomax=${omax}`,
    );
  }
  // Colour wheels: a hue+amount push per tonal zone -> colorbalance shadows/mids/highs.
  const push = (hKey: string, aKey: string): [number, number, number] => {
    const amt = num(aKey, 0);
    if (amt <= 0) return [0, 0, 0];
    const [r, g, bl] = hsvToRgb((((num(hKey, 0) % 360) + 360) % 360) / 360, 1, 1);
    const k = amt * 0.5;
    return [(r - 0.5) * 2 * k, (g - 0.5) * 2 * k, (bl - 0.5) * 2 * k];
  };
  const [rs, gs, bs] = push("shadowsHue", "shadowsAmount");
  const [rm, gm, bm] = push("midsHue", "midsAmount");
  const [rh, gh, bh] = push("highsHue", "highsAmount");
  if (rs || gs || bs || rm || gm || bm || rh || gh || bh) {
    out.push(
      `colorbalance=rs=${rs.toFixed(4)}:gs=${gs.toFixed(4)}:bs=${bs.toFixed(4)}:rm=${rm.toFixed(4)}:gm=${gm.toFixed(4)}:bm=${bm.toFixed(4)}:rh=${rh.toFixed(4)}:gh=${gh.toFixed(4)}:bh=${bh.toFixed(4)}`,
    );
  }
  // Wheel luminance (shadowsLum lift + highsGain) via a tone curve; midsGamma via eq.
  const sLum = num("shadowsLum", 0);
  const hGain = num("highsGain", 1);
  if (sLum !== 0 || hGain !== 1) {
    const lo = Math.max(0, Math.min(1, 0.2 + sLum * 0.3)).toFixed(4);
    const hi = Math.max(0, Math.min(1, 0.8 * hGain)).toFixed(4);
    out.push(`curves=master='0/0 0.2/${lo} 0.8/${hi} 1/1'`);
  }
  const mGamma = num("midsGamma", 1);
  if (mGamma !== 1) out.push(`eq=gamma=${mGamma.toFixed(4)}`);
  // Highlights / shadows recovery via a synthesised master curve.
  const hl = num("highlights", 0);
  const sh = num("shadows", 0);
  if (hl !== 0 || sh !== 0) {
    const p1 = Math.max(0, Math.min(1, 0.25 + sh * 0.15)).toFixed(4);
    const p2 = Math.max(0, Math.min(1, 0.75 + hl * 0.15)).toFixed(4);
    out.push(`curves=master='0/0 0.25/${p1} 0.75/${p2} 1/1'`);
  }
  // Tone curves (master / R / G / B).
  const cm = curveStr(c.masterCurve);
  const cr = curveStr(c.redCurve);
  const cg = curveStr(c.greenCurve);
  const cbl = curveStr(c.blueCurve);
  if (cm || cr || cg || cbl) {
    const cp: string[] = [];
    if (cm) cp.push(`master='${cm}'`);
    if (cr) cp.push(`red='${cr}'`);
    if (cg) cp.push(`green='${cg}'`);
    if (cbl) cp.push(`blue='${cbl}'`);
    out.push(`curves=${cp.join(":")}`);
  }
  if (typeof c.lut === "string" && c.lut.trim())
    out.push(`lut3d=file=${escFilterPath(c.lut.trim())}`);
  return out;
}

/** Ordered per-clip effects -> ffmpeg filters (mirrors renderer.py::_compile_effect). */
function effectFilters(effects: unknown, clipId: unknown, warnings: string[]): string[] {
  if (!Array.isArray(effects)) return [];
  const out: string[] = [];
  for (const fx of effects) {
    if (!fx || typeof fx !== "object") continue;
    const e = fx as Record<string, unknown>;
    if (e.enabled === false) continue;
    const type = String(e.type ?? "");
    const p = (e.params ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number): number => (isNum(p[k]) ? (p[k] as number) : d);
    if (type === "blur") out.push(`gblur=sigma=${num("radius", 8).toFixed(4)}`);
    else if (type === "denoise") out.push(`hqdn3d=${num("strength", 4).toFixed(4)}`);
    else if (type === "sharpen")
      out.push(
        `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${num("sharpness", 1).toFixed(4)}`,
      );
    else if (type === "grain") out.push(`noise=alls=${num("grain", 15).toFixed(4)}:allf=t`);
    else if (type === "vignette") {
      const a = Math.max(0, Math.min(1, num("vignette", 0.3)));
      out.push(`vignette=angle=${(a * (Math.PI / 2)).toFixed(4)}`);
    } else if (type === "motion") {
      // Temporal motion blur: average N consecutive frames (video only; a no-op on stills).
      const frames = Math.max(2, Math.min(12, Math.round(num("frames", 3))));
      out.push(`tmix=frames=${frames}`);
    } else if (type === "clarity") {
      const cl = num("clarity", 0);
      const dh = num("dehaze", 0);
      if (cl !== 0)
        out.push(`unsharp=luma_msize_x=7:luma_msize_y=7:luma_amount=${(cl * 1.5).toFixed(4)}`);
      if (dh !== 0)
        out.push(
          `eq=contrast=${(1 + dh * 0.3).toFixed(4)}:saturation=${(1 + dh * 0.2).toFixed(4)}`,
        );
    } else if (type === "chroma") {
      const col = String(p.color ?? "#00FF00").replace(/^#/, "") || "00FF00";
      const sim = Math.max(0, Math.min(1, num("similarity", 0.3)));
      const bl = Math.max(0, Math.min(1, num("blend", 0.1)));
      out.push(`chromakey=0x${col}:${sim.toFixed(4)}:${bl.toFixed(4)}`);
    } else if (type === "glow") {
      // Rendered as a bloom sub-graph via the clip.glow path (glowFromEffects), not a comma filter.
    } else if (type === "custom") {
      const raw = String(p.expr ?? p.filter ?? "").trim();
      if (raw) {
        out.push(raw);
        warnings.push(`clip ${clipId}: UNVERIFIED custom effect injected: ${raw}`);
      }
    } else warnings.push(`clip ${clipId}: unknown effect '${type}' skipped`);
  }
  return out;
}

/** Ordered per-clip AUDIO effects -> ffmpeg afilters, applied in a canonical
 *  clean -> tone -> dynamics -> space -> balance -> loudness order. */
function audioEffectFilters(effects: unknown): string[] {
  if (!Array.isArray(effects)) return [];
  const byType = new Map<string, Record<string, unknown>>();
  for (const fx of effects) {
    if (fx && typeof fx === "object" && (fx as Record<string, unknown>).type) {
      const e = fx as Record<string, unknown>;
      if (e.enabled === false) continue;
      byType.set(String(e.type), e);
    }
  }
  const out: string[] = [];
  const n = (e: Record<string, unknown>, k: string, d: number): number => {
    const p = (e.params ?? {}) as Record<string, unknown>;
    return isNum(p[k]) ? (p[k] as number) : d;
  };
  const denoise = byType.get("denoise");
  if (denoise)
    out.push(
      `afftdn=nr=${Math.max(0.01, Math.min(97, n(denoise, "reduction_db", 12))).toFixed(2)}`,
    );
  const eq = byType.get("eq");
  if (eq) {
    const bass = n(eq, "bass", 0);
    const treble = n(eq, "treble", 0);
    if (bass !== 0) out.push(`bass=g=${bass.toFixed(2)}`);
    if (treble !== 0) out.push(`treble=g=${treble.toFixed(2)}`);
  }
  const comp = byType.get("compressor");
  if (comp) {
    const thDb = Math.max(-60, Math.min(0, n(comp, "threshold", -18)));
    const ratio = Math.max(1, Math.min(20, n(comp, "ratio", 4)));
    out.push(
      `acompressor=threshold=${Math.pow(10, thDb / 20).toFixed(6)}:ratio=${ratio.toFixed(2)}`,
    );
  }
  const reverb = byType.get("reverb");
  if (reverb) {
    const amt = Math.max(0, Math.min(1, n(reverb, "room", 0.3)));
    out.push(`aecho=0.8:0.9:1000:${(0.2 + amt * 0.5).toFixed(3)}`);
  }
  const pan = byType.get("pan");
  if (pan) {
    const p = Math.max(-1, Math.min(1, n(pan, "balance", 0)));
    out.push(
      "aformat=channel_layouts=stereo",
      `pan=stereo|c0=${Math.min(1, 1 - p).toFixed(4)}*c0|c1=${Math.min(1, 1 + p).toFixed(4)}*c1`,
    );
  }
  const loud = byType.get("loudnorm");
  if (loud)
    out.push(`loudnorm=I=${Math.max(-70, Math.min(-5, n(loud, "target", -14))).toFixed(1)}`);
  return out;
}

/** A `glow` effect in the effects[] stack -> the clip-level glow value, so glow
 *  authored via apply_effects renders through the same bloom sub-graph. */
function glowFromEffects(effects: unknown): unknown {
  if (!Array.isArray(effects)) return undefined;
  const g = effects.find(
    (e) => e && typeof e === "object" && (e as Record<string, unknown>).type === "glow",
  ) as Record<string, unknown> | undefined;
  if (!g || g.enabled === false) return undefined;
  const p = (g.params ?? {}) as Record<string, unknown>;
  // Registry default (25) applies when intensity is missing, so a glow authored
  // without params still blooms instead of silently rendering nothing.
  const amount = isNum(p.intensity) ? (p.intensity as number) : 25;
  return isNum(p.opacity) ? { amount, opacity: p.opacity } : { amount };
}

/** Parse glow (number or {amount,opacity}) -> blur sigma + screen opacity, or null. */
function parseGlow(glow: unknown): { sig: number; op: number } | null {
  if (glow === undefined || glow === null) return null;
  let amount: number;
  let opacity: number | undefined;
  if (isNum(glow)) amount = glow;
  else if (typeof glow === "object") {
    const g = glow as Record<string, unknown>;
    amount = isNum(g.amount) ? (g.amount as number) : 0;
    opacity = isNum(g.opacity) ? (g.opacity as number) : undefined;
  } else return null;
  if (amount <= 0) return null;
  const sig = (amount / 100) * 14;
  const op = opacity ?? Math.min(0.6, 0.2 + (amount / 100) * 0.35);
  return { sig, op };
}

const BLEND_TO_FFMPEG: Record<Exclude<BlendKind, "normal">, string> = {
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  add: "addition",
};
/** Map a clip blend mode to an ffmpeg blend all_mode, or null for normal (plain overlay). The plan
 *  resolves `blend` to the closed BlendKind, so this dispatches exhaustively — assertNever catches a new
 *  contract blend value at compile time. "add" -> ffmpeg's "addition". */
function parseBlend(blend: BlendKind): string | null {
  switch (blend) {
    case "normal":
      return null;
    case "multiply":
    case "screen":
    case "overlay":
    case "add":
      return BLEND_TO_FFMPEG[blend];
    default:
      return assertNever(blend);
  }
}

/** Neutral white point. Both the contract and the preview treat this as "no change". */
const NEUTRAL_K = 6500;

/** Translate the contract's `temperature` into the Kelvin ffmpeg's `colortemperature` wants.
 *
 *  They run in OPPOSITE directions and the export was passing the value straight through. The
 *  contract uses the grading-suite convention every NLE uses — a white-balance TARGET, so higher
 *  Kelvin is WARMER — and the preview implements exactly that (`scene.ts colorGrade`: wb red rises
 *  and blue falls as K climbs). ffmpeg's filter models the LIGHT SOURCE instead, so higher Kelvin
 *  is COOLER. Measured on neutral grey with the bundled binary: K=4500 -> V 137 / U 119 (warm),
 *  K=9200 -> V 124 / U 137 (cool).
 *
 *  So a grade authored in the preview inverted itself on export, and an agent following the
 *  documented "higher is warmer" graded every clip the wrong way. Reflect around neutral in
 *  RECIPROCAL space, not linear: a linear reflection reaches the filter's 1000 K floor at only
 *  12000 K, so everything above that exported as the SAME frame — most of the contract's
 *  1000..40000 range was one indistinguishable look. Measured on neutral grey with the bundled
 *  binary, the reciprocal keeps 12 of 13 sampled settings visually distinct against the linear
 *  form's 9. */
function filterKelvin(kelvin: number): number {
  return Math.min(40000, Math.max(1000, (NEUTRAL_K * NEUTRAL_K) / kelvin));
}

/** Map a clip fit mode to ffmpeg's force_original_aspect_ratio token. Closed FitKind dispatch so a new
 *  contract fit value is caught at compile time (assertNever): cover fills the box (increase, overflow
 *  cropped), contain fits inside it (decrease, padded). */
function fitAspect(fit: FitKind): "increase" | "decrease" {
  switch (fit) {
    case "cover":
      return "increase";
    case "contain":
      return "decrease";
    default:
      return assertNever(fit);
  }
}

/** ffmpeg alpha-multiplier expression for a clip's fade in/out (SECONDS), or null.
 *  Linear alpha ramp 0->1 over `fin` at the head, 1->0 over `fout` at the tail — the
 *  visual twin of the audio `afade`. Mirrors the preview's fadeMul so both agree. */
function fadeAlphaExpr(tin: number, tout: number, fin: number, fout: number): string | null {
  const parts: string[] = [];
  if (fin > 0) parts.push(`clip((T-${tin.toFixed(6)})/${fin.toFixed(6)},0,1)`);
  if (fout > 0) parts.push(`clip((${tout.toFixed(6)}-T)/${fout.toFixed(6)},0,1)`);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `min(${parts[0]},${parts[1]})`;
}

/** The schema's closed font enum -> bundled .ttf filename (resources/fonts). The render EXECUTION path
 *  copies these into the per-render temp dir's `fonts/` so libass resolves each caption's family via
 *  `fontsdir=fonts` (no fontconfig on the desktop). Exported so the preview's FontFace registry
 *  (preview/fonts.ts) can be checked against it — the two drifting is invisible at runtime. */
export const FONT_FILES: Record<string, string> = {
  Anton: "Anton-Regular.ttf",
  "Bebas Neue": "BebasNeue-Regular.ttf",
  Oswald: "Oswald-VF.ttf",
  "Playfair Display": "PlayfairDisplay-VF.ttf",
  Poppins: "Poppins-Regular.ttf",
};

/** Escape a path for use inside a filtergraph option value (forward slashes;
 *  escape the Windows drive colon). Mirrors the backend's _ff_filter_path. */
function escFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// The bundled font directory (resources/fonts), resolved lazily via the Tauri
// path API and cached. null outside a Tauri context (tests / browser bundle) —
// then runRenderPlan skips the font copy and libass falls back to its built-in default.
let _fontDirCache: string | null | undefined;
export async function bundledFontDir(): Promise<string | null> {
  if (_fontDirCache !== undefined) return _fontDirCache;
  try {
    const { resolveResource } = await import("@tauri-apps/api/path");
    _fontDirCache = await resolveResource("resources/fonts");
  } catch {
    _fontDirCache = null;
  }
  return _fontDirCache;
}

// The bundled brand assets (resources/brand), same lazy resolve as the fonts. null outside a
// Tauri context, which is why `exportBranding` reports rather than throws: a web/dev build
// with no bundled resources must still export the user's video.
let _brandDirCache: string | null | undefined;
export async function bundledBrandDir(): Promise<string | null> {
  if (_brandDirCache !== undefined) return _brandDirCache;
  try {
    const { resolveResource } = await import("@tauri-apps/api/path");
    _brandDirCache = await resolveResource("resources/brand");
  } catch {
    _brandDirCache = null;
  }
  return _brandDirCache;
}

/** The watermark + end card for a canvas, or null with the reason when they aren't available.
 *
 *  Both files are checked to EXIST here rather than left for ffmpeg: a missing input aborts the
 *  whole render, so an export that would have been fine unbranded must not die because the
 *  bundle is incomplete. */
export async function exportBranding(
  store: Pick<ProjectStoreAccess, "exists">,
  runner: ClientToolContext["runner"],
  canvas: { width: number; height: number },
): Promise<{ branding: Branding | null; warning?: string }> {
  const dir = await bundledBrandDir();
  if (!dir) return { branding: null, warning: "brand assets unavailable — exported unbranded" };
  const ratio = brandRatio(canvas.width, canvas.height);
  const watermark = joinPath(dir, watermarkFile(ratio));
  const endcard = joinPath(dir, endcardFile(ratio));
  for (const p of [watermark, endcard]) {
    // `exists` throws for a path the fs scope refuses to answer for; that is "can't tell",
    // not "missing", and the resource dir is inside the scope, so a throw here means the
    // check itself is unavailable and the assets are used as-is.
    const there = await store.exists(p).catch(() => true);
    if (!there)
      return {
        branding: null,
        warning: `brand asset missing (${p.split(/[\\/]/).pop()}) — exported unbranded`,
      };
  }
  const probe = await runner.run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    endcard,
  ]);
  const endcardDuration = Number(probe.stdout.trim());
  if (probe.code !== 0 || !Number.isFinite(endcardDuration) || endcardDuration <= 0) {
    return {
      branding: null,
      warning: `brand end card could not be measured (${stderrExcerpt(probe.stderr) || "no duration"}) — exported unbranded`,
    };
  }
  return { branding: { watermark, endcard, endcardDuration } };
}

export interface RenderPlan {
  args: string[];
  filterComplex: string;
  duration: number;
  warnings: string[];
  /** libass caption files (one per z-band) the CALLER writes into the ffmpeg working dir before the
   *  run and deletes after (the graph references them by bare name: `ass=f=cap_bandN.ass`). */
  assFiles: { name: string; content: string }[];
  /** Bundled font FILES (resources/fonts basenames) the captions actually REFERENCE — the caller copies
   *  only these into the temp `fonts/` dir, not every bundled family. Empty when there are no captions. */
  fonts: string[];
  /** Absolute paths of the STILL inputs (fed with `-loop 1`). runRenderPlan checks each one is
   *  decodable first: ffmpeg loops forever on an oversized image rather than reporting it. */
  stillImages: string[];
  /** Branded exports pad audio through the end card. Successful ffmpeg exit is not enough for
   *  those plans: the encoded stream is probed before the staged artifact can be committed. */
  audioMustSpanVideo: boolean;
  /** What the DELIVERED file will be, after the delivery scale and fps override — not the
   *  canvas. Reported with the export, where the canvas would describe the wrong artifact. */
  output: { width: number; height: number; fps: number };
}

interface Input {
  path: string;
  si: number;
  so: number;
  isImage: boolean;
}
interface VRec {
  inputIdx: number;
  ord: number;
  tin: number;
  tout: number;
  box: Box;
  opacity: Animatable | undefined;
  fadeIn: number;
  fadeOut: number;
  speed: number;
  cropExpr: string | null;
  flipH: boolean;
  flipV: boolean;
  rotate: Animatable | undefined;
  posX: Animatable;
  posY: Animatable;
  sizeW: Animatable | undefined;
  sizeH: Animatable | undefined;
  posCenter: boolean;
  preAlpha: string[];
  glow: unknown;
  blend: BlendKind;
  transition: ResolvedTransition | null;
  holdDur: number;
}
interface ARec {
  inputIdx: number;
  tin: number;
  /** Constant gain, or a keyframe curve compiled into a per-frame ffmpeg expression. */
  volume: Animatable;
  fadeIn: number;
  fadeOut: number;
  tempo: number;
  tlSpan: number;
  loop: boolean;
  loopSpeed: number;
  srcSpan: number;
  audioEffects: unknown;
  /** The track this clip sits on — what `duck.against` names. */
  trackId: string;
  duck?: { against: string; ratio?: number; threshold?: number };
}

/** Decompose a tempo ratio into ffmpeg atempo factors, each within [0.5, 2] (a
 *  single atempo only spans that range); chaining keeps a speed change
 *  PITCH-PRESERVING instead of resampling, which would chipmunk the audio. */
function atempoChain(tempo: number): number[] {
  if (!(tempo > 0) || Math.abs(tempo - 1) < 1e-6) return [];
  const out: number[] = [];
  let t = tempo;
  while (t > 2) {
    out.push(2);
    t /= 2;
  }
  while (t < 0.5) {
    out.push(0.5);
    t *= 2;
  }
  out.push(t);
  return out;
}

/** Build the ffmpeg args + filter_complex from a timeline.
 *
 *  The whole body works in SECONDS, so a frames-view timeline is normalised here rather than at
 *  each caller. `validateTimeline` and `buildScene` already self-normalise; leaving this one to
 *  the caller made "forgot to convert" a silent 30x-wrong render plan instead of an error, and it
 *  bit twice — the eval oracle's Tier-0 render check was compiling a plan no export would ever
 *  produce. `toSecondsView` is a no-op for a timeline that is already seconds, so this is safe for
 *  the callers that convert first. */
export function buildRenderCommand(
  raw: Timeline,
  outPath: string,
  options: ExportOptions = {},
): RenderPlan {
  const timeline = toSecondsView(raw);
  assertSourcesResolved(timeline);
  const canvas = timeline.canvas;
  // The ONE place canvas pixels enter the render, so the chroma-alignment rule is
  // enforced here rather than at each producer. An odd canvas cannot encode to
  // yuv420p h264 at all, and it fails the same misleading way an odd transform box
  // did: pad rounds its input up to even, then reports the padded size as "smaller".
  const cw = evenPx(Math.trunc(Number(canvas.width)));
  const ch = evenPx(Math.trunc(Number(canvas.height)));
  const fps = Math.trunc(canvasFps(timeline));
  const duration = canvasDuration(timeline);
  const warnings: string[] = [];
  if (cw !== Math.trunc(Number(canvas.width)) || ch !== Math.trunc(Number(canvas.height))) {
    warnings.push(
      `canvas ${canvas.width}x${canvas.height} is not even; rendered at ${cw}x${ch} (h264/yuv420p requires it)`,
    );
  }

  // ONE resolved look plan (transitions, per-clip visibility incl. the neighbour hold, text
  // constraints), in canonical z-then-id clip order. The exporter reads the LOOK decisions from here
  // (killing its private parseTransition + inline hold scan); it still owns media compositing via
  // pc.clipRef. Built from the SECONDS view, so plan times are seconds — byte-exact for ffmpeg.
  const plan = resolveRenderPlan(timeline);

  const inputs: Input[] = [];
  const vrecs: VRec[] = [];
  const arecs: ARec[] = [];
  // Captions grouped into contiguous z-BANDS: a run of text clips with no VIDEO between them (in the
  // plan's z order) shares one .ass file + one `ass` overlay, so a higher-z video can cover lower
  // captions (a video breaks the band). `ord` is the overlay z-index across all non-audio clips — the
  // key the phase-2 loop interleaves captions and video by.
  const captionBands: { ord: number; specs: CaptionSpec[] }[] = [];
  const usedFontFiles = new Set<string>(); // only the bundled font FILES the captions reference get copied
  let curBand: { ord: number; specs: CaptionSpec[] } | null = null;
  let ord = 0;

  for (const pc of plan.clips) {
    const clip = pc.clipRef;
    if (clip.kind === "audio") {
      const aSi = Number(clip.source_in) || 0;
      const aTin = Number(clip.timeline_in) || 0;
      const aTout = Number(clip.timeline_out) || 0;
      // source_out is OPTIONAL for audio in the model + validator; when it's absent or
      // degenerate, derive it from the timeline span AT THE CLIP'S SPEED (mirrors
      // appendMediaClip / deriveSourceSpans: source_out = source_in + span*speed) so a
      // source-window-less clip plays its duration at the right tempo instead of
      // collapsing to `-ss 0 -to 0` silence or silently dropping a non-1x speed.
      const aSpeed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      const aRawSo = Number(clip.source_out);
      const aSo =
        Number.isFinite(aRawSo) && aRawSo > aSi ? aRawSo : aSi + Math.max(0, aTout - aTin) * aSpeed;
      inputs.push({ path: String(clip.media_ref), si: aSi, so: aSo, isImage: false });
      const fade = (clip.fade ?? {}) as { in?: number; out?: number };
      const tlSpan = Math.max(0, aTout - aTin);
      const srcSpan = Math.max(0, aSo - aSi);
      arecs.push({
        inputIdx: inputs.length - 1,
        tin: aTin,
        volume: clip.volume === undefined || clip.volume === null ? 1 : clip.volume,
        fadeIn: isNum(fade.in) ? fade.in / fps : 0,
        fadeOut: isNum(fade.out) ? fade.out / fps : 0,
        // Pitch-preserving time factor. A `speed`'d clip (whose audio source span
        // differs from its timeline span) OR an explicit `stretch` both fill the
        // slot via atempo, so 1.2x plays 1.2x faster at the SAME pitch instead of
        // resampling to a chipmunk. Loop clips fill by repetition (below), not tempo.
        tempo:
          !clip.loop && srcSpan > 0 && tlSpan > 0 && Math.abs(srcSpan - tlSpan) > 1e-4
            ? srcSpan / tlSpan
            : 1,
        tlSpan,
        loop: clip.loop === true && srcSpan > 0,
        loopSpeed: aSpeed,
        srcSpan,
        audioEffects: (clip as Record<string, unknown>).audio_effects,
        trackId: pc.srcTrackId,
        ...(clip.duck ? { duck: clip.duck } : {}),
      });
      continue;
    }
    if (clip.kind === "text") {
      // The plan resolved this caption's look (box + align + wrap + colour, unified C2 defaults). Append
      // it to the current z-band (a preceding text with no video between); a video closed the band.
      const rt = pc.text!;
      // A phrase-chunks caption emits ONE timed Dialogue per chunk (one visible at a time); a plain
      // caption emits one. Skip a wholly-empty caption (no glyphs, no chunks, no raw override).
      const chunks = rt.chunks && rt.chunks.length > 0 ? rt.chunks : null;
      if (!chunks && !rt.text.trim() && !rt.rawAss.trim()) continue;
      // Dropped by assEscape because no bundled face can draw them; say so rather than let the
      // caption come out quietly missing a character the author asked for.
      const flags = unrenderableFlags(rt.text);
      if (flags.length)
        warnings.push(
          `clip ${clip.id}: dropped ${flags.length} flag emoji (${[...new Set(flags)].join("")}) — no bundled font can draw them, and keeping them would print their letters instead`,
        );
      if (!curBand) {
        curBand = { ord, specs: [] };
        captionBands.push(curBand);
      }
      const look = {
        font: rt.font,
        sizePx: rt.sizePx,
        color: rt.color,
        align: rt.align,
        anchorV: rt.anchorV,
        bold: rt.bold,
        italic: rt.italic,
        underline: rt.underline,
        strike: rt.strike,
        weight: rt.weight,
        spacingPx: rt.spacingPx,
        scalePct: 100,
        fadeInMs: rt.fadeInMs,
        fadeOutMs: rt.fadeOutMs,
        entranceMotion: rt.entranceMotion,
        karaoke: null as CaptionSpec["karaoke"],
        highlightColor: "",
        karaokeReveal: rt.karaokeReveal,
        runs: rt.runs,
        emphasisSpec: rt.emphasis,
        outline: rt.outline,
        shadow: rt.shadow,
        box: rt.box,
        cxPx: rt.cxPx,
        cyPx: rt.cyPx,
        wPx: rt.wPx,
      };
      if (chunks) {
        const inSec = pc.visibility.inSec;
        for (const ck of chunks) {
          if (!ck.text.trim()) continue;
          // A hero chunk (emphasis:true) gets the emphasis look. A chunk is its OWN Dialogue, so
          // `highlight` can give it a real coloured BOX (its own BorderStyle=3 style) behind base-colour
          // text; `box-invert` boxes it AND inverts the text to black; `color` recolours; `pop` scales.
          const em = ck.emphasis && rt.emphasis ? rt.emphasis : null;
          let color = rt.color;
          let scalePct = 100;
          let box = rt.box;
          if (em) {
            if (em.kind === "pop") scalePct = em.scalePct;
            else if (em.kind === "color") color = em.color || rt.color;
            else if (em.kind === "highlight")
              box = {
                color: em.color || "#ffd400",
                opacity: 1,
                paddingPx: Math.round(rt.sizePx * 0.12),
              };
            else if (em.kind === "box-invert") {
              box = {
                color: em.color || "#ffd400",
                opacity: 1,
                paddingPx: Math.round(rt.sizePx * 0.12),
              };
              color = "#000000";
            }
          }
          curBand.specs.push({
            ...look,
            color,
            scalePct,
            box,
            text: ck.text,
            rawAss: "",
            startSec: inSec + ck.relInSec,
            endSec: inSec + ck.relOutSec,
          });
        }
      } else if (rt.karaoke && rt.karaoke.length) {
        // Word-highlight: ONE karaoke Dialogue over the whole window (the words sweep via \k). The
        // highlight colour is the emphasis colour when set, else the base colour.
        curBand.specs.push({
          ...look,
          karaoke: rt.karaoke,
          highlightColor: rt.emphasis?.color || rt.color,
          text: rt.text,
          rawAss: "",
          startSec: pc.visibility.inSec,
          endSec: pc.visibility.outSec,
        });
      } else {
        curBand.specs.push({
          ...look,
          text: rt.text,
          rawAss: rt.rawAss,
          startSec: pc.visibility.inSec,
          endSec: pc.visibility.outSec,
        });
      }
      const fontFile = FONT_FILES[rt.font];
      if (fontFile) usedFontFiles.add(fontFile); // copy this family's .ttf into the render's fonts/ dir
      ord++;
      continue;
    }
    // A video/image clip closes any open caption band (it will overlay ABOVE lower captions) and takes
    // the next overlay ord.
    curBand = null;
    const vord = ord++;
    const isImg = clipKind(clip) === "image";
    const tin = Number(clip.timeline_in) || 0;
    const tout = Number(clip.timeline_out) || 0;
    const si = isImg ? 0 : Number(clip.source_in) || 0;
    const so = isImg ? Math.max(0, tout - tin) : Number(clip.source_out) || 0;
    inputs.push({ path: String(clip.media_ref), si, so, isImage: isImg });
    const deferred = DEFERRED_FIELDS.find((f) => clip[f] !== undefined);
    if (deferred) warnings.push(`clip ${clip.id}: '${deferred}' not rendered (scoped)`);
    const { left: cl, top: ct, right: cr, bottom: cb } = pc.media.crop;
    const box = boxOf(clip, cw, ch, pc.media.fit);
    const ta = transformAnims(clip, box, cw, ch);
    // The outgoing hold (this clip persists past its out so the NEXT same-track clip's centred
    // incoming transition has it underneath, 0 across a gap) is the neighbour decision the plan
    // resolved — render.ts's old inline scan.
    const holdDur = pc.visibility.holdSec;
    const vfade = (clip.fade ?? {}) as { in?: number; out?: number };
    vrecs.push({
      inputIdx: inputs.length - 1,
      ord: vord,
      tin: pc.visibility.inSec, // the plan's single declared sampling offset (== Number(clip.timeline_in) in the seconds view)
      tout,
      box,
      opacity: pc.media.opacity,
      fadeIn: isNum(vfade.in) ? (vfade.in as number) / fps : 0,
      fadeOut: isNum(vfade.out) ? (vfade.out as number) / fps : 0,
      speed: Number(clip.speed ?? 1) || 1,
      cropExpr:
        cl || ct || cr || cb
          ? `crop=iw*${(1 - cl - cr).toFixed(6)}:ih*${(1 - ct - cb).toFixed(6)}:iw*${cl.toFixed(6)}:ih*${ct.toFixed(6)}`
          : null,
      flipH: pc.media.flip.h,
      flipV: pc.media.flip.v,
      rotate: pc.media.rotate,
      posX: ta.posX,
      posY: ta.posY,
      sizeW: ta.sizeW,
      sizeH: ta.sizeH,
      posCenter: ta.posCenter,
      preAlpha: [
        ...colorFilters(pc.media.color),
        ...effectFilters(clip.effects, clip.id, warnings),
      ],
      glow: clip.glow ?? glowFromEffects(clip.effects),
      blend: pc.media.blend,
      transition: pc.transition,
      holdDur,
    });
  }

  // `-progress pipe:1` writes machine-readable key=value blocks to stdout, which nothing else in a
  // render reads; `-nostats` drops the human stderr line it duplicates. The encoded bytes are
  // unaffected — this only makes an otherwise silent multi-minute job observable.
  const cmd: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-progress",
    "pipe:1",
  ];
  for (const inp of inputs) {
    const dur = Math.max(0, inp.so - inp.si);
    if (inp.isImage)
      cmd.push("-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(6), "-i", inp.path);
    else cmd.push("-ss", inp.si.toFixed(6), "-to", inp.so.toFixed(6), "-i", inp.path);
  }
  // The branding inputs go LAST so every clip keeps the input index it had; an unbranded plan
  // pushes nothing and is byte-identical to what it was before branding existed.
  const brand = options.branding ?? null;
  const wmIdx = inputs.length;
  const ecIdx = wmIdx + 1;
  if (brand) {
    cmd.push(
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-t",
      duration.toFixed(6),
      "-i",
      brand.watermark,
    );
    cmd.push("-i", brand.endcard);
  }

  const chains: string[] = [`color=c=black:s=${cw}x${ch}:r=${fps}:d=${duration.toFixed(6)}[base]`];
  let last = "base";
  // Caption z-bands interleave with the video overlays by `ord`: each band burns ONE libass `ass` filter
  // straight onto the running `last` (the .ass Dialogue lines carry their own timing, so NO enable= gate).
  // Emitting a band BELOW a video's ord before that video overlays means a higher-z video covers lower
  // captions (was: text unconditionally last). Video-only renders are byte-identical (no bands -> no-op).
  const assFiles: { name: string; content: string }[] = [];
  let bandPtr = 0;
  const emitBandsBelow = (ordLimit: number): void => {
    while (bandPtr < captionBands.length && captionBands[bandPtr].ord < ordLimit) {
      const b = captionBands[bandPtr];
      const name = `cap_band${bandPtr}.ass`;
      assFiles.push({ name, content: buildBandAss(b.specs, { w: cw, h: ch }) });
      // Burn the band DIRECTLY onto the accumulated stream. libass's `ass` filter draws over its input's
      // pixels but does NOT write an alpha plane, so the old "draw on a transparent canvas then overlay"
      // produced a fully-transparent layer that composited NOTHING (verified against the bundled binary).
      // Applying `ass` to `[last]` at the band's z-position keeps interleaving intact — a higher-z video
      // overlaid afterwards still paints over the caption.
      chains.push(`[${last}]ass=f=${name}:fontsdir=fonts[capov${bandPtr}]`);
      last = `capov${bandPtr}`;
      bandPtr++;
    }
  };
  vrecs.forEach((r, i) => {
    emitBandsBelow(r.ord); // captions strictly BELOW this video's z paint first
    const { w, h, fit } = r.box;
    // Every transition is CENTRED on the cut: leadIn = half its duration, so the incoming clip
    // renders a frozen lead-in over [tin-leadIn, tin] (tpad below) while the outgoing clip holds
    // under it (holdDur). crossfade/custom dissolve the alpha, wipe/whip mask it spatially, dip
    // flashes a colour between the two — all across this one window (mirrors the preview's centring).
    const cross = r.transition;
    // `custom` carries a raw xfade expr we deliberately do NOT evaluate (an ffmpeg-injection surface); it
    // renders as a plain crossfade. Warn so that silent downgrade is visible (the pre-refactor code warned).
    if (cross?.kind === "custom")
      warnings.push(
        `transition at ${r.tin.toFixed(2)}s: custom expr not evaluated (rendered as a crossfade)`,
      );
    const leadIn = cross ? cross.durSec / 2 : 0;
    const parts = [`[${r.inputIdx}:v]setsar=1`];
    if (r.cropExpr) parts.push(r.cropExpr);
    if (r.flipH) parts.push("hflip");
    if (r.flipV) parts.push("vflip");
    const wAnimated = r.sizeW !== undefined && !isNum(r.sizeW);
    const hAnimated = r.sizeH !== undefined && !isNum(r.sizeH);
    // Set when the box size animates: the overlay (below) re-centers the
    // aspect-preserved clip in its box. Box-size exprs here are in TIMELINE `t`
    // (offset=tin) to match the post-setpts overlay.
    let sizeAnim: { wBox: string; hBox: string } | null = null;
    if (wAnimated || hAnimated) {
      // Animated size (Ken Burns zoom): scale to the per-frame box PRESERVING
      // the source aspect — cover fills the box (crop overflow), contain fits
      // inside it — then the overlay re-centers the result. Mirrors the preview
      // (scene.ts fitRects). `t` is clip-relative here (this stage runs BEFORE
      // setpts) so the keyframe offset is 0; the overlay uses timeline `t`+tin.
      const wSc = r.sizeW !== undefined ? compileAnim(r.sizeW, "t", 0) : String(w);
      const hSc = r.sizeH !== undefined ? compileAnim(r.sizeH, "t", 0) : String(h);
      const foar = fitAspect(fit);
      parts.push(
        `scale=w='max(2,round((${wSc})/2)*2)':h='max(2,round((${hSc})/2)*2)':force_original_aspect_ratio=${foar}:force_divisible_by=2:eval=frame`,
      );
      sizeAnim = {
        wBox: r.sizeW !== undefined ? compileAnim(r.sizeW, "t", r.tin) : String(w),
        hBox: r.sizeH !== undefined ? compileAnim(r.sizeH, "t", r.tin) : String(h),
      };
    } else {
      switch (fit) {
        case "cover":
          parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`);
          break;
        case "contain":
          parts.push(
            `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
          );
          break;
        default:
          assertNever(fit);
      }
    }
    // Screen recorders (especially macOS) may advertise 120 fps while emitting no samples for
    // hundreds of milliseconds when the screen is static. CFR-normalize each occupied clip here,
    // in the renderer, so ffmpeg repeats the previous picture through source PTS gaps instead of
    // exposing the black canvas below it. `start_time=0` also anchors the first project frame after
    // input seeking; real empty TIMELINE spans remain black because no clip overlay is enabled there.
    parts.push(`fps=fps=${fps}:start_time=0:round=near:eof_action=round`);
    // Centered crossfade: freeze a lead-in at the FRONT (leadIn) so this clip's
    // dissolve starts half the window before the cut, and hold the last frame at
    // the BACK (holdDur) so the outgoing clip persists under the next clip's
    // incoming fade. tpad runs pre-setpts, so scale durations by speed.
    //
    // The back pad gains one output frame on a RETIMED clip. Its retimed stream ends a fraction
    // of a frame before its slot does whenever the source span doesn't divide evenly by the speed
    // (206 source frames at 1.2x fills 171.67 of its 172 frames), and the compositor's black base
    // showed through for that last frame — a black flash at the end of every such clip, in the
    // EXPORT as well as the preview. `enable` still cuts the clip off at its own tout, so the
    // extra frame can only cover a gap, never overrun the next clip. At speed 1 the source and
    // timeline frames are 1:1, so there is no gap to cover and the graph is left untouched.
    const retimed = Math.abs(r.speed - 1) > 1e-6;
    const backPad = r.holdDur + (retimed ? 1 / fps : 0);
    if (leadIn > 0 || backPad > 0) {
      const opts: string[] = [];
      if (leadIn > 0)
        opts.push("start_mode=clone", `start_duration=${(leadIn * r.speed).toFixed(6)}`);
      if (backPad > 0)
        opts.push("stop_mode=clone", `stop_duration=${(backPad * r.speed).toFixed(6)}`);
      parts.push(`tpad=${opts.join(":")}`);
    }
    // The front pad shifts the stream leadIn earlier, so anchor at tin-leadIn.
    const off = (r.tin - leadIn).toFixed(6);
    parts.push(
      Math.abs(r.speed - 1) < 1e-6
        ? `setpts=PTS-STARTPTS+${off}/TB`
        : `setpts=(PTS-STARTPTS)/${r.speed.toFixed(6)}+${off}/TB`,
    );
    // Colour grade + ordered effects act on the opaque, scaled clip.
    for (const f of r.preAlpha) parts.push(f);
    // Alpha-aware transform stage: rotate (transparent corners, clipped to the
    // box via ow=iw:oh=ih) then per-clip opacity. format=yuva420p adds the alpha
    // plane only when one of them is present so the no-transform path is unchanged.
    const opaAnim = r.opacity !== undefined && !isNum(r.opacity) ? r.opacity : null;
    const dimConst = isNum(r.opacity) && r.opacity < 1;
    const rotAnim = r.rotate !== undefined && !isNum(r.rotate) ? r.rotate : null;
    const hasRotate = isNum(r.rotate) || rotAnim !== null;
    // Fade in/out ramps the clip's ALPHA (visual fade) — the video twin of `afade`,
    // the same `fade` field for both media; mirrors the preview's fadeMul.
    const fadeExpr = fadeAlphaExpr(r.tin, r.tout, r.fadeIn, r.fadeOut);
    const alpha: string[] = [];
    if (hasRotate || dimConst || opaAnim !== null || cross !== null || fadeExpr !== null)
      alpha.push("format=yuva420p");
    if (hasRotate) {
      const aExpr =
        rotAnim !== null
          ? compileAnim(rotAnim, "t", r.tin)
          : isNum(r.rotate)
            ? r.rotate.toFixed(6)
            : "0.000000";
      // `c=black@0`, NOT `c=none`: ffmpeg does not clear the uncovered corners between frames, so
      // with `none` each frame keeps the previous one's pixels there. A constant angle hides it
      // (the uncovered area never moves); an ANIMATED angle smears, and a curve starting at 0
      // exports completely unrotated. Verified on the artifact — corner reads source-white with
      // `none` and background with `black@0`.
      alpha.push(`rotate=a='(${aExpr})*PI/180':c=black@0:ow=iw:oh=ih`);
    }
    if (isNum(r.opacity) && r.opacity < 1)
      alpha.push(`colorchannelmixer=aa=${r.opacity.toFixed(4)}`);
    else if (opaAnim !== null)
      alpha.push(
        `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip((${compileAnim(opaAnim, "T", r.tin)}),0,1)'`,
      );
    if (cross) {
      // The incoming clip's alpha over the CENTERED window [tin-leadIn, tin+leadIn]. `p` is the
      // shared progress 0->1 (clip((T-start)/dur,0,1), start=tin-leadIn) — the SAME curve the preview
      // reads (transitionProgress). crossfade/custom: linear dissolve (the preview does opacity*=tp
      // for both; a `custom` expr is not evaluated here either). wipe-l/r: hard spatial mask (keep the
      // left/right p of the frame, matching the shader's `discard`). whip: soft 0.12 left wipe =
      // smoothstep(x-0.12,x,p). dip: fade in over the SECOND half only (2p-1); the colour flash that
      // covers the first half is a separate full-canvas quad overlaid below.
      const start = (r.tin - leadIn).toFixed(6);
      const p = `clip((T-${start})/${cross.durSec.toFixed(6)},0,1)`;
      let a: string;
      switch (cross.kind) {
        case "wipe-l":
          a = `alpha(X,Y)*lt(X,W*${p})`;
          break;
        case "wipe-r":
          a = `alpha(X,Y)*gt(X,W*(1-${p}))`;
          break;
        case "whip": {
          const t = `clip((${p}-X/W+0.12)/0.12,0,1)`;
          a = `alpha(X,Y)*(${t})*(${t})*(3-2*(${t}))`;
          break;
        }
        case "dip-to-black":
        case "dip-to-white":
          a = `alpha(X,Y)*clip(2*${p}-1,0,1)`;
          break;
        case "crossfade":
        case "custom":
          a = `alpha(X,Y)*${p}`; // linear cross-dissolve (a `custom` expr is not evaluated here)
          break;
        default:
          a = assertNever(cross.kind); // a new TransitionKind must add a branch above (won't compile otherwise)
      }
      alpha.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${a}'`);
    }
    if (fadeExpr !== null)
      // Visual fade: multiply the alpha plane by the fade envelope over [tin, tout].
      alpha.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${fadeExpr})'`);
    // Glow (soft bloom) is spliced between the texture stage and the alpha stage:
    // brighten highlights, blur, screen-blend back, then apply rotate/opacity.
    const glow = parseGlow(r.glow);
    if (glow) {
      chains.push(`${parts.join(",")}[g${i}]`);
      chains.push(`[g${i}]split=2[g${i}a][g${i}b]`);
      chains.push(
        `[g${i}b]lutyuv=y='if(gt(val,200),val,16)':u=128:v=128,gblur=sigma=${glow.sig.toFixed(4)}[g${i}bl]`,
      );
      chains.push(`[g${i}a][g${i}bl]blend=c0_mode=screen:c0_opacity=${glow.op.toFixed(4)}[g${i}o]`);
      chains.push(alpha.length ? `[g${i}o]${alpha.join(",")}[v${i}]` : `[g${i}o]null[v${i}]`);
    } else {
      chains.push(
        alpha.length ? `${parts.join(",")},${alpha.join(",")}[v${i}]` : `${parts.join(",")}[v${i}]`,
      );
    }
    // Overlay position is integer-only in ffmpeg; round the animated expression
    // (and the WebGL box) so both snap to the same pixel. When the box size
    // animates, the clip was scaled aspect-preserving (so it over/undersizes the
    // box); offset by half the box↔clip delta to keep it centered in the box.
    const posXexpr = isNum(r.posX) ? r.posX.toFixed(6) : compileAnim(r.posX, "t", r.tin);
    const posYexpr = isNum(r.posY) ? r.posY.toFixed(6) : compileAnim(r.posY, "t", r.tin);
    const ovX = r.posCenter
      ? `'round((${posXexpr})-overlay_w/2)'`
      : sizeAnim
        ? `'round((${posXexpr})+((${sizeAnim.wBox})-overlay_w)/2)'`
        : isNum(r.posX)
          ? String(Math.round(r.posX))
          : `'round(${compileAnim(r.posX, "t", r.tin)})'`;
    const ovY = r.posCenter
      ? `'round((${posYexpr})-overlay_h/2)'`
      : sizeAnim
        ? `'round((${posYexpr})+((${sizeAnim.hBox})-overlay_h)/2)'`
        : isNum(r.posY)
          ? String(Math.round(r.posY))
          : `'round(${compileAnim(r.posY, "t", r.tin)})'`;
    const enable = `between(t,${(r.tin - leadIn).toFixed(6)},${(r.tout + r.holdDur).toFixed(6)})`;
    // Dip-to-colour: a full-canvas colour flash BETWEEN the outgoing clip (already in `last`) and
    // this incoming clip. Its alpha ramps clip(2p,0,1) — opaque by the midpoint — enable-gated to the
    // transition window so it vanishes after (the preview draws the same solid quad at z=track; a
    // higher-z clip, overlaid later here too, still paints over it). No xfade.
    if (cross && (cross.kind === "dip-to-black" || cross.kind === "dip-to-white")) {
      const dipRGB = cross.kind === "dip-to-white" ? "255" : "0";
      const dipStart = (r.tin - leadIn).toFixed(6);
      const dipEnd = (r.tin + leadIn).toFixed(6);
      chains.push(
        `color=c=black:s=${cw}x${ch}:r=${fps}:d=${duration.toFixed(6)},format=rgba,` +
          `geq=r='${dipRGB}':g='${dipRGB}':b='${dipRGB}':a='255*clip(2*(T-${dipStart})/${cross.durSec.toFixed(6)},0,1)'[dip${i}]`,
      );
      chains.push(
        `[${last}][dip${i}]overlay=x=0:y=0:enable='between(t,${dipStart},${dipEnd})':eof_action=pass[dipov${i}]`,
      );
      last = `dipov${i}`;
    }
    const blendMode = parseBlend(r.blend);
    if (blendMode) {
      // Blend the clip onto the accumulated result using its own alpha as a mask.
      const p = `bl${i}`;
      chains.push(`[${last}]split=2[${p}ca][${p}cb]`);
      chains.push(
        `color=c=black@0:s=${cw}x${ch}:r=${fps}:d=${duration.toFixed(6)},format=rgba[${p}ct]`,
      );
      chains.push(
        `[${p}ct][v${i}]overlay=x=${ovX}:y=${ovY}:enable='${enable}':shortest=0:eof_action=pass[${p}top]`,
      );
      chains.push(`[${p}top]split=2[${p}ta][${p}tb]`);
      chains.push(`[${p}ca]format=rgba[${p}caf]`);
      chains.push(`[${p}caf][${p}ta]blend=all_mode=${blendMode}:shortest=1[${p}blr]`);
      chains.push(`[${p}tb]alphaextract[${p}bal]`);
      chains.push(`[${p}blr][${p}bal]alphamerge[${p}brg]`);
      chains.push(`[${p}cb][${p}brg]overlay=x=0:y=0:eof_action=pass[ov${i}]`);
    } else {
      chains.push(
        `[${last}][v${i}]overlay=x=${ovX}:y=${ovY}:enable='${enable}':eof_action=pass[ov${i}]`,
      );
    }
    last = `ov${i}`;
  });
  // Any remaining caption bands sit ABOVE all video (highest z) — composite them on top.
  emitBandsBelow(Infinity);

  let aout: string | null = null;
  if (arecs.length) {
    const DECLICK_SEC = 0.005; // 5ms edge micro-fade: declick hard cuts (pops)
    arecs.forEach((r, i) => {
      const filt = ["asetpts=PTS-STARTPTS"];
      // Loop fill: resample to a known rate so aloop's sample-count `size` is
      // exact, repeat the trimmed source forever, then cut to the clip's slot.
      // tempo is 1 for loop clips, so nothing else retimes it.
      if (r.loop) {
        const SR = 48000;
        filt.push(`aresample=${SR}`, `aloop=loop=-1:size=${Math.round(r.srcSpan * SR)}`);
        // A loop clip fills its slot by REPETITION, so speed can't ride the srcSpan/tlSpan
        // ratio (`tempo` is forced to 1 for loops). Apply the clip's speed as a pitch-
        // preserving atempo to the repeated stream BEFORE trimming to the slot, so the loop
        // plays at the requested speed and still fills tlSpan — matching preview (which loops
        // at playbackRate=speed). loopSpeed=1 -> atempoChain returns [] (unchanged).
        for (const f of atempoChain(r.loopSpeed)) filt.push(`atempo=${f.toFixed(6)}`);
        filt.push(`atrim=duration=${r.tlSpan.toFixed(6)}`, "asetpts=PTS-STARTPTS");
      }
      for (const f of atempoChain(r.tempo)) filt.push(`atempo=${f.toFixed(6)}`);
      const delayMs = Math.round(r.tin * 1000);
      // `volume` sits AFTER adelay, so `t` here is TIMELINE seconds and r.tin makes it
      // clip-relative — the same offset the visual opacity/rotate expressions use.
      // eval=frame is required: without it ffmpeg evaluates the expression once.
      const vol = isNum(r.volume)
        ? r.volume.toFixed(4)
        : `'${compileAnim(r.volume, "t", r.tin)}':eval=frame`;
      filt.push(`adelay=${delayMs}|${delayMs}`, `volume=${vol}`);
      for (const f of audioEffectFilters(r.audioEffects)) filt.push(f);
      // A hard cut lands mid-waveform and pops (esp. after remove_silence's many
      // cuts); ramp a few ms at head + tail. A longer user fade supersedes it.
      const declick = Math.min(DECLICK_SEC, r.tlSpan / 2);
      const fin = Math.max(r.fadeIn, declick);
      const fout = Math.max(r.fadeOut, declick);
      if (fin > 0) filt.push(`afade=t=in:st=${r.tin.toFixed(6)}:d=${fin.toFixed(6)}`);
      if (fout > 0)
        filt.push(`afade=t=out:st=${(r.tin + r.tlSpan - fout).toFixed(6)}:d=${fout.toFixed(6)}`);
      chains.push(`[${r.inputIdx}:a]${filt.join(",")}[a${i}]`);
    });
    // Sidechain ducking. `duck` was accepted, persisted, clamped and PREVIEWED, and the exporter
    // emitted `duck not rendered (scoped)` — so the agent truthfully reported a mix the delivered
    // file did not contain (measured once: score -13.7 LUFS against a -21.3 LUFS voiceover, the
    // narration buried). The key is the whole named TRACK, which is what `against` means.
    const mixLabels = arecs.map((_, i) => `a${i}`);
    const duckers = arecs.map((r, i) => ({ r, i })).filter(({ r }) => r.duck && r.duck.against);
    if (duckers.length) {
      const SC_FMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
      /** Indices whose stream is the key for `against` — never the ducked clip itself. */
      const keysFor = (against: string, self: number): number[] =>
        arecs.map((_, j) => j).filter((j) => j !== self && arecs[j].trackId === against);
      // A stream used as a key is ALSO still in the mix, so it has to be split: an ffmpeg pad may
      // be consumed exactly once.
      const keyUses = new Map<number, number>();
      for (const { r, i } of duckers)
        for (const j of keysFor(String(r.duck!.against), i))
          keyUses.set(j, (keyUses.get(j) ?? 0) + 1);
      const keyTaps = new Map<number, string[]>();
      for (const [j, uses] of keyUses) {
        const outs = [`k${j}m`, ...Array.from({ length: uses }, (_, n) => `k${j}s${n}`)];
        chains.push(`[a${j}]asplit=${outs.length}${outs.map((o) => `[${o}]`).join("")}`);
        mixLabels[j] = outs[0]; // the mix now reads the split's first tap
        keyTaps.set(j, outs.slice(1));
      }
      const taken = new Map<number, number>();
      for (const { r, i } of duckers) {
        const against = String(r.duck!.against);
        const keys = keysFor(against, i).map((j) => {
          const n = taken.get(j) ?? 0;
          taken.set(j, n + 1);
          return keyTaps.get(j)![n];
        });
        // Nothing to duck under: leave the clip alone and SAY so, rather than silently emitting a
        // graph that does nothing.
        if (!keys.length) {
          warnings.push(
            `audio clip on track '${r.trackId}': duck against '${against}' had no audio to key off, so it was not applied`,
          );
          continue;
        }
        let key = keys[0];
        if (keys.length > 1) {
          key = `dk${i}`;
          chains.push(
            `${keys.map((k) => `[${k}]`).join("")}amix=inputs=${keys.length}:normalize=0[${key}]`,
          );
        }
        const ratio = Math.max(1, Number(r.duck!.ratio ?? 8));
        const threshold = Math.min(1, Math.max(0.001, Number(r.duck!.threshold ?? 0.03)));
        // sidechaincompress refuses mismatched inputs, and each chain above ends in whatever the
        // source happened to be — so normalise BOTH sides rather than hoping they agree.
        chains.push(`[${mixLabels[i]}]${SC_FMT}[dm${i}]`, `[${key}]${SC_FMT}[dk${i}f]`);
        chains.push(
          `[dm${i}][dk${i}f]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=20:release=250:level_sc=1[d${i}]`,
        );
        mixLabels[i] = `d${i}`;
      }
    }
    if (mixLabels.length === 1) {
      aout = mixLabels[0];
    } else {
      chains.push(
        `${mixLabels.map((l) => `[${l}]`).join("")}amix=inputs=${mixLabels.length}:normalize=0[amix]`,
      );
      aout = "amix";
    }
  }

  // Delivery size is applied once, at the END of the composite — as a chain inside the graph,
  // NOT as `-vf`. ffmpeg refuses to attach a simple filtergraph to a stream fed from a complex
  // one ("Simple and complex filtering cannot be used together"), so `-vf` here killed the whole
  // render with EINVAL before encoding a frame, while the args string looked perfectly sensible.
  const size = outputSize(cw, ch, options.resolution);
  if (size) {
    chains.push(`[${last}]scale=${size.w}:${size.h}:flags=lanczos[scaled]`);
    last = "scaled";
  }

  // Branding rides at the very end, on the DELIVERY-sized picture: the watermark asset is a
  // full frame with the bug already inset, so it scales to the output size and composites at
  // 0:0, and the end card is concatenated after it rather than under it.
  const outFps = outputFps(fps, options.fps);
  const ow = size ? size.w : cw;
  const oh = size ? size.h : ch;
  let totalDuration = duration;
  if (brand) {
    chains.push(`[${wmIdx}:v]scale=${ow}:${oh}[wm]`);
    chains.push(`[${last}][wm]overlay=0:0:format=auto[branded]`);
    // concat refuses inputs that disagree on size, pixel format or SAR, and drifts on
    // timestamps when they disagree on rate — so BOTH branches are normalised, not just the
    // card. Doing it only to the card is the version of this that works on one project and
    // fails on the next.
    chains.push(`[branded]fps=${outFps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS[mainv]`);
    chains.push(
      `[${ecIdx}:v]scale=${ow}:${oh}:flags=lanczos,fps=${outFps},format=yuv420p,setsar=1,setpts=PTS-STARTPTS[ecv]`,
    );
    chains.push(`[mainv][ecv]concat=n=2:v=1:a=0[outv]`);
    last = "outv";
    totalDuration = duration + brand.endcardDuration;
    // The card carries no audio. Without this the track simply stops at the cut and some
    // players report the file as ending there; apad gives it real silence, and `-shortest`
    // below then ends the file with the VIDEO -- which is how the output length comes from the
    // card's actual length rather than from a constant that could cut it off.
    if (aout) {
      // Reset timestamps BEFORE padding. ffmpeg 9 can otherwise send INT64_MAX out of apad,
      // after which every AAC packet is clamped to prev+1 and the delivered track is effectively
      // one silent frame. Bounding the pad also prevents the filter queue from filling forever
      // while `-shortest` waits for the video concat.
      chains.push(`[${aout}]asetpts=N/SR/TB,apad=whole_dur=${totalDuration.toFixed(6)}[abrand]`);
      aout = "abrand";
    }
  }

  const filterComplex = chains.join(";");
  cmd.push("-filter_complex", filterComplex, "-map", `[${last}]`);
  if (aout) cmd.push("-map", `[${aout}]`);
  cmd.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(outFps));
  if (options.preset) cmd.push("-preset", options.preset);
  const crf = crfFor(options.quality);
  if (crf !== null) cmd.push("-crf", String(crf));
  if (aout) cmd.push("-c:a", "aac");
  else cmd.push("-an");
  if (brand) cmd.push("-shortest");
  else cmd.push("-t", Math.min(duration, options.maxDurationSec ?? Infinity).toFixed(6));
  cmd.push(outPath);
  return {
    args: cmd,
    filterComplex,
    duration: totalDuration,
    warnings,
    assFiles,
    fonts: [...usedFontFiles],
    stillImages: [...new Set(inputs.filter((i) => i.isImage).map((i) => i.path))],
    audioMustSpanVideo: brand !== undefined && aout !== null,
    output: { width: ow, height: oh, fps: outFps },
  };
}

/** A source that is still a LIBRARY REF, not a path — `media_ab12…` or `library/<id>.<ext>`.
 *  ffmpeg cannot open either, and its only complaint is "No such file or directory", which reads
 *  like missing media rather than a step the caller skipped. */
function unresolvedRef(src: string): boolean {
  return /^media_[A-Za-z0-9]+$/.test(src) || src.startsWith("library/");
}

/** Refuse to build a plan whose sources were never resolved.
 *
 *  Resolution needs the filesystem and this builder is pure, so unlike the frames->seconds view it
 *  cannot be done here — only caught here. It was left to each caller to remember and, of the three
 *  that render, inspect_color forgot: measuring a CLIP failed for every user while the same tool on
 *  a raw asset worked. Throwing makes the omission impossible to ship quietly. */
function assertSourcesResolved(timeline: Timeline): void {
  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const src = typeof clip.media_ref === "string" ? clip.media_ref : "";
      if (src && unresolvedRef(src))
        throw new Error(
          `render plan built from an unresolved source '${src}' — call resolveClipSources(ctx, timeline) first`,
        );
    }
  }
}

/** Resolve each clip's PORTABLE source ("library/<id>.<ext>") to an absolute
 *  path IN PLACE so ffmpeg can open it. Falls back to the raw ref if it doesn't
 *  resolve (ffmpeg then surfaces the real "No such file"). Absolute paths are
 *  internal-only — never returned to the model. */
export async function resolveClipSources(
  ctx: ClientToolContext,
  timeline: Timeline,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const src = typeof clip.media_ref === "string" ? clip.media_ref : "";
      // After this pass a source is ALWAYS a path — resolved, or the path it was expected at.
      // Leaving an unresolvable ref as-is made "nobody resolved this" and "the file is gone" the
      // same string, so neither the guard below nor a reader could tell them apart. ffmpeg still
      // reports the real "No such file", now naming where it looked.
      if (src)
        clip.media_ref =
          (await ctx.store.resolveRef(src)) ?? joinPath(ctx.store.projectDir, "library", src);
      // ffmpeg rejects the ENTIRE graph with EINVAL when a `[N:a]` names a source with no audio
      // stream, so one such clip takes down every export AND every inspect_timeline. Placement
      // cannot always know (media still generating has no bytes to probe), and an external file
      // can lose its audio after the fact, so the check belongs at the render boundary every
      // path already passes through. `disabled` is the EXISTING "reaches neither backend" flag,
      // so resolveRenderPlan drops it via visibility.ts rather than a second rule here, and the
      // clip still contributes its duration. Only a POSITIVE "no audio stream" disables: a probe
      // that errors leaves the clip alone, so flaky ffprobe cannot silence real audio.
      if (clip.kind === "audio" && clipPlays(clip)) {
        const abs = typeof clip.media_ref === "string" ? clip.media_ref : "";
        if (abs && !(await hasAudioStreamForRender(ctx, abs))) {
          suppressClip(clip);
          warnings.push(
            `audio clip ${clip.id ?? "?"}: '${abs.split(/[\\/]/).pop()}' has no audio stream — not rendered`,
          );
        }
      }
      // An agent-supplied LUT is a library .cube asset — resolve it through the NARROW resolver so a
      // raw absolute / `..` path can never reach ffmpeg's `lut3d=file=`. Unsafe or unresolvable -> drop
      // it (the grade still applies without the LUT). Deepest boundary before ffmpeg; like media_ref
      // above it mutates this render-only copy, never the persisted timeline.
      const color = clip.color;
      if (color && typeof color.lut === "string" && color.lut.trim()) {
        color.lut = (await ctx.store.resolveMediaRef(color.lut.trim())) ?? "";
      }
    }
  }
  return warnings;
}

/** `sourceHasAudio` THROWS when ffprobe runs and fails; here that must not sink the render, so an
 *  unanswerable probe reads as "assume audio" and leaves ffmpeg to report the real problem. */
async function hasAudioStreamForRender(ctx: ClientToolContext, abs: string): Promise<boolean> {
  try {
    return await sourceHasAudio(ctx, abs);
  } catch {
    return true;
  }
}

/** Run an ffmpeg render whose filter_complex may reference libass caption files by BARE name
 *  (`ass=f=cap_bandN.ass`): stage a per-run scratch dir with those .ass files + the bundled fonts they
 *  resolve by family, run ffmpeg with it as cwd, and ALWAYS delete it (success, failure, OR throw) in
 *  the `finally` — never mid-run. Input media + the output are absolute, so cwd doesn't touch them; a
 *  caption-less render makes no scratch dir (the common path is unchanged). The SHARED boundary every
 *  buildRenderCommand runner goes through (renderTimelineToPath + inspect's timeline preview), so a
 *  captioned timeline can't render in one and silently lose its text in the other. */
export async function runRenderPlan(
  ctx: ClientToolContext,
  plan: RenderPlan,
): Promise<CommandResult> {
  // Backstop for stills that predate the import guard, or arrived by reference and changed on
  // disk since. ffmpeg answers an undecodable image under `-loop 1` by retrying forever, so this
  // has to happen BEFORE the spawn — afterwards there is nothing to observe but a hung process.
  for (const path of plan.stillImages) {
    let reason: string | null = null;
    try {
      reason = undecodableImageReason(await ctx.store.readBytes(path));
    } catch {
      continue; // unreadable/missing: let ffmpeg report it, it names the file better than we can
    }
    if (reason)
      return {
        code: -1,
        stdout: "",
        stderr: `render aborted: '${path.split(/[\\/]/).pop()}' ${reason}.`,
      };
  }
  let scratch: string | null = null;
  try {
    if (plan.assFiles.length) {
      const relBase = `renderer/caps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      scratch = ctx.store.artifactPath(relBase);
      for (const f of plan.assFiles)
        await ctx.store.writeText(
          await ctx.store.prepareArtifact(`${relBase}/${f.name}`),
          f.content,
        );
      const fontDir = plan.fonts.length ? await bundledFontDir() : null;
      if (fontDir) {
        for (const file of plan.fonts) {
          try {
            await ctx.store.writeBytes(
              joinPath(scratch, "fonts", file),
              await ctx.store.readBytes(joinPath(fontDir, file)),
            );
          } catch {
            /* a missing/unreadable bundled font: libass just falls back for that family */
          }
        }
      }
    }
    return await ctx.runner.run(
      "ffmpeg",
      plan.args,
      ctx.signal,
      scratch ?? undefined,
      progressReporter(plan.duration),
    );
  } finally {
    if (scratch) await ctx.store.remove(scratch).catch(() => undefined);
  }
}

/** Feed ffmpeg's `-progress` stream into the export job the UI is watching. */
function progressReporter(durationSec: number): (chunk: string) => void {
  const totalMs = Math.max(0, durationSec * 1000);
  return createProgressReader((r) => {
    useExportJob.getState().update({
      phase: "rendering",
      fraction: progressFraction(r.outMs, totalMs),
      etaSec: etaSeconds(r.outMs, totalMs, r.speed),
      speed: r.speed,
      frame: r.frame,
    });
  });
}

/** Clips whose media is still being generated, or whose generation failed. A render cannot
 *  encode what is not on disk, so it must refuse and NAME them: skipping them ships a video with
 *  holes the user may not notice until after they publish it. */
export async function unresolvedMediaBlockers(
  store: Pick<ProjectStoreAccess, "listClips">,
  timeline: Timeline,
): Promise<{ clip_id: string; media_ref: string; status: string; error?: string }[]> {
  const unresolved = new Map<string, { status: string; error?: string }>();
  for (const row of await store.listClips()) {
    const status = typeof row.status === "string" ? row.status : "";
    if (status === "generating" || status === "failed")
      unresolved.set(row.id, {
        status,
        error: typeof row.error === "string" ? row.error : undefined,
      });
  }
  if (!unresolved.size) return [];
  const out: { clip_id: string; media_ref: string; status: string; error?: string }[] = [];
  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const ref = typeof clip.media_ref === "string" ? clip.media_ref : "";
      const hit = ref ? unresolved.get(ref) : undefined;
      if (hit) out.push({ clip_id: String(clip.id ?? ""), media_ref: ref, ...hit });
    }
  }
  return out;
}

/** Everything that can REFUSE an export: loading, validation, unresolved media, an empty
 *  timeline, branding. Split from the encode so a submitted export still fails IN THE TURN
 *  that asked for it — a preflight error the agent only learns a minute later is useless. */
async function prepareRender(
  ctx: ClientToolContext,
  outPath: string,
  kind: "deliverable" | "working",
  options: ExportOptions = {},
): Promise<{ ok: false; result: Result } | { ok: true; plan: RenderPlan }> {
  let raw: Timeline;
  try {
    raw = await loadTimeline(ctx.store);
  } catch (e) {
    return {
      ok: false,
      result: { ok: false, error: `timeline.json not found — author it first (${String(e)})` },
    };
  }
  const errors = validateTimeline(raw);
  if (errors.length) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "timeline preflight failed — fix these before render",
        preflight_errors: errors.slice(0, 20),
      },
    };
  }
  // Before any work: a clip whose media is still generating has nothing to encode. Refusing here
  // covers the agent's export, the menu's Save As and the working render alike, because all three
  // land on this function.
  const unresolved = await unresolvedMediaBlockers(ctx.store, raw);
  if (unresolved.length) {
    const names = unresolved.map((u) => u.clip_id || u.media_ref).join(", ");
    const stillGoing = unresolved.some((u) => u.status === "generating");
    return {
      ok: false,
      result: {
        ok: false,
        error: stillGoing
          ? `still generating — ${names} ${unresolved.length === 1 ? "is" : "are"} not ready yet. Export once it finishes.`
          : `generation failed for ${names}; replace or remove ${unresolved.length === 1 ? "it" : "them"} before exporting.`,
        unresolved_media: unresolved,
      },
    };
  }
  const seconds = toSecondsView(raw);
  const duration = canvasDuration(seconds);
  if (duration <= 0)
    return {
      ok: false,
      result: { ok: false, error: "timeline is empty — add clips before rendering" },
    };

  const extraWarnings: string[] = await resolveClipSources(ctx, seconds);

  let branding: Branding | undefined;
  if (kind === "deliverable") {
    const b = await exportBranding(ctx.store, ctx.runner, seconds.canvas);
    branding = b.branding ?? undefined;
    if (b.warning) extraWarnings.push(b.warning);
  }

  const plan = buildRenderCommand(seconds, outPath, { ...options, branding });
  if (extraWarnings.length) plan.warnings.push(...extraWarnings);
  return { ok: true, plan };
}

/** Run a prepared plan and validate the encoded artifact before any caller may commit it. */
async function executeRender(
  ctx: ClientToolContext,
  plan: RenderPlan,
  outPath: string,
): Promise<Result> {
  const r = await runRenderPlan(ctx, plan);
  // Did ffmpeg actually produce the file? `null` means the platform REFUSED TO SAY, which is
  // not the same as "no". Tauri's fs scope ($DATA/ArtDaddy, $DOWNLOAD, $HOME/**) THROWS for a path
  // outside it, and a Save As destination legitimately can be — another drive, a network share.
  // ffmpeg is a sidecar process and writes there fine; only this check is blocked. Treating the
  // refusal as absence reports "render failed" for a video sitting exactly where the user asked.
  const produced = await ctx.store.exists(outPath).catch(() => null);
  if (r.code !== 0 || produced === false) {
    // Self-contained on purpose. It used to read "Read stderr_tail." and put the reason in a
    // SIBLING FIELD — which survives this return but not the export path, where the queue carries
    // only a string. Every export failure therefore reached the user as an instruction to read
    // something that was not there: `ffmpeg render failed (code=-22). Read stderr_tail.`
    const tail = stderrExcerpt(r.stderr);
    return {
      ok: false,
      error:
        `ffmpeg render failed (code=${r.code})` +
        (tail
          ? `: ${tail}`
          : produced === false
            ? ": it exited without writing the file and printed nothing."
            : ": it printed nothing."),
      stderr_tail: tail,
      warnings: plan.warnings,
    };
  }
  if (plan.audioMustSpanVideo) {
    let probe: CommandResult;
    try {
      probe = await ctx.runner.run(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,duration:format=duration",
          "-of",
          "json",
          outPath,
        ],
        ctx.signal,
      );
    } catch (e) {
      return {
        ok: false,
        error: `rendered audio could not be validated: ${e instanceof Error ? e.message : String(e)}`,
        stderr_tail: stderrExcerpt(r.stderr),
        warnings: plan.warnings,
      };
    }
    let videoDuration = NaN;
    let audioDuration = NaN;
    if (probe.code === 0) {
      try {
        const payload = JSON.parse(probe.stdout) as {
          streams?: Array<{ codec_type?: string; duration?: string }>;
          format?: { duration?: string };
        };
        const streams = Array.isArray(payload.streams) ? payload.streams : [];
        videoDuration = Number(
          streams.find((s) => s?.codec_type === "video")?.duration ?? payload.format?.duration,
        );
        audioDuration = Number(streams.find((s) => s?.codec_type === "audio")?.duration);
      } catch {
        // The structured failure below includes ffprobe's output and the original ffmpeg stderr.
      }
    }
    if (
      !Number.isFinite(videoDuration) ||
      !Number.isFinite(audioDuration) ||
      Math.abs(audioDuration - videoDuration) >= 0.2
    ) {
      const probeDetail =
        probe.code === 0
          ? `ffprobe reported video=${videoDuration}s audio=${audioDuration}s`
          : `ffprobe failed (code=${probe.code}): ${stderrExcerpt(probe.stderr)}`;
      return {
        ok: false,
        error: `rendered audio failed validation (${probeDetail})`,
        stderr_tail: stderrExcerpt(
          [r.stderr, probe.stderr, probe.stdout].filter(Boolean).join("\n"),
        ),
        warnings: plan.warnings,
      };
    }
  }
  return {
    ok: true,
    final_mp4: ctx.store.toRef(outPath),
    path: ctx.store.toRef(outPath),
    // The PLAN's duration, not the timeline's: a branded export carries the end card, so the
    // canvas length understates the file by ~2s and the model plans against a length that is
    // not what it can play.
    duration_s: Math.round(plan.duration * 1000) / 1000,
    warnings: plan.warnings,
  };
}

async function renderTimelineToPath(
  ctx: ClientToolContext,
  outPath: string,
  // Not optional, and not a boolean flag with a default: branding applies to the class "user
  // deliverable", and a new caller that forgets to opt in would ship an unbranded export while
  // every test still passed. Making it a required choice is the only version of that rule a
  // future caller cannot bypass by omission.
  kind: "deliverable" | "working",
  options: ExportOptions = {},
): Promise<Result> {
  const prepared = await prepareRender(ctx, outPath, kind, options);
  if (!prepared.ok) return prepared.result;
  return executeRender(ctx, prepared.plan, outPath);
}

export async function renderTimelineTool(
  _args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  // Internal working render — a regeneratable cache artifact the model iterates
  // on (other NLEs' in-app preview render), NOT the user's deliverable.
  const outPath = await ctx.store.prepareArtifact("renderer/final.mp4");
  return renderTimelineToPath(ctx, outPath, "working");
}

/** Basename of the project dir — the default export filename stem. Exported so the Save As
 *  dialog pre-fills the SAME name the tool would have chosen; a second copy of this rule in
 *  the UI would drift from the one the agent uses. */
export function defaultExportStem(projectDir: string): string {
  const base = projectDir
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return (base && base.trim()) || "artdaddy-export";
}

/** Windows refuses these names outright, whatever the extension follows them. */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Reduce a user/model-supplied export name to a SAFE filename stem: basename only
 *  (any directory part dropped, so no `..` traversal and no separators), trailing
 *  extension stripped, filesystem-hostile characters removed. Without this an
 *  export `name` like "../../evil" would ride joinPath(Downloads, name) OUT of the
 *  Downloads dir (joinPath does not resolve `..`) and let ffmpeg write to an
 *  arbitrary path — a prompt-injection-reachable arbitrary-write.
 *
 *  A sanitizer has TWO failure directions and this one used to be wrong in the quiet one: it
 *  allowed only `[\w.\- ]`, and `\w` is ASCII, so "Café" was delivered as "Caf" and any name
 *  in a non-Latin script was thrown away entirely and replaced by the project name. So it
 *  DENIES what is actually unsafe or unwritable instead of allowing only what is familiar.
 *  Admitting Unicode admits the bidi overrides with it — "evil\u202Egpj.mp4" renders as
 *  "evilfpm.jpg" — so those and the zero-width characters are denied by name.
 *  `exportStem.property.test.ts` fuzzes both directions. */
export function exportStem(raw: string, fallback: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? ""; // drop any directory part
  const cleaned = base
    .replace(/\.[^.]+$/, "") // strip a trailing extension
    // Separators, the Windows-reserved set, C0/C1 controls, and the invisible
    // zero-width/bidi characters used to disguise one filename as another.
    .replace(
      /[\/\\<>:"|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/gu,
      "",
    )
    .replace(/^\.+/, "") // no leading dots ("..", hidden files)
    .trim();
  // Filenames are bounded (255 bytes everywhere we ship), and Windows cannot create one that
  // ends in a dot or a space. Slice by CODE POINT so a multi-byte character is never cut in
  // half into an unpaired surrogate.
  const bounded = [...cleaned]
    .slice(0, 80)
    .join("")
    .replace(/[. ]+$/, "")
    .trim();
  if (!bounded || RESERVED_DEVICE_NAME.test(bounded)) return fallback;
  return bounded;
}

export type ExportDest =
  { ok: true; path: string; filename: string; defaulted: boolean } | { ok: false; error: string };

/**
 * The ONE rule for where an export deliverable is written. Both doors go through it:
 * the menu supplies the path the user chose in the Save As dialog, the agent usually
 * supplies nothing. Mirrors other NLEs' `exportDestination(outputPath:mode:format:)` —
 * given a path, honour it after validating; given none, write a project-named file into
 * the OS Downloads dir. Keeping this in one function is why a hand-typed agent path and
 * a picked UI path cannot land under different rules.
 *
 * The two branches deliberately differ on overwriting, exactly as other NLEs does:
 *   - explicit `output_path` OVERWRITES. Something already asked — the Save As dialog
 *     prompts to replace, and an agent path was named by the user.
 *   - the DEFAULT destination never clobbers: nobody chose it, so a second export must
 *     not silently destroy the first deliverable. It de-dupes to "name 2.mp4",
 *     "name 3.mp4" … (other NLEs' `uniqueExportURL`; Adobe Media Encoder does the same
 *     with a numeric suffix rather than overwriting).
 */
export async function exportDestination(
  store: Pick<ProjectStoreAccess, "exportPath" | "projectDir" | "isDirectory" | "exists">,
  opts: { name?: string; outputPath?: unknown },
): Promise<ExportDest> {
  const raw = typeof opts.outputPath === "string" ? opts.outputPath.trim() : "";
  if (!raw) {
    // Export is the user's DELIVERABLE: render straight into the OS Downloads dir
    // (NLE-style — never inside the project, nothing tracks it). The name is
    // sanitized to a bare basename so it can't traverse out of Downloads.
    const stem = exportStem(String(opts.name ?? "").trim(), defaultExportStem(store.projectDir));
    // Bounded: `exists` that always answers true (or a pathological folder) must not spin
    // forever in the render path. A thrown `exists` means "can't tell" — treat the name as
    // free, which is exactly today's behaviour rather than a refusal to export.
    for (let n = 1; n <= 999; n++) {
      const filename = n === 1 ? `${stem}.mp4` : `${stem} ${n}.mp4`;
      const path = await store.exportPath(filename);
      if (!(await store.exists(path).catch(() => false)))
        return { ok: true, path, filename, defaulted: true };
    }
    const filename = `${stem} ${Date.now()}.mp4`;
    return { ok: true, path: await store.exportPath(filename), filename, defaulted: true };
  }
  if (!isAbsolutePath(raw))
    return { ok: false, error: `output_path must be an absolute path (got '${raw}').` };
  // An existing directory would make ffmpeg fail with an unreadable muxer error; and a bare
  // `.../folder` is far likelier to mean "put it in here" than "overwrite this folder".
  if (await store.isDirectory(raw))
    return {
      ok: false,
      error: `output_path '${raw}' is a folder; include the filename, e.g. '${raw}/video.mp4'.`,
    };
  const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const head = cut > 0 ? raw.slice(0, cut) : "";
  // `C:\out.mp4` leaves head="C:", which is the process's CURRENT dir on that drive, not its
  // root. Spell the root out so the existence check and the join both mean the same place.
  const parent = /^[a-zA-Z]:$/.test(head) ? `${head}/` : head;
  const base = raw.slice(cut + 1);
  if (!base) return { ok: false, error: `output_path '${raw}' has no filename.` };
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  // The client renders mp4 and nothing else. Silently writing mp4 bytes into a `.mov` the
  // user asked for is worse than refusing: the file plays, so the mislabel is never noticed.
  if (ext && ext !== "mp4")
    return { ok: false, error: `mp4 exports must end in .mp4 (got '.${ext}').` };
  const filename = ext ? base : `${base}.mp4`;
  // Deliberately NOT checking that the parent folder exists: `isDirectory` degrades to
  // "listing it yields children" on a filesystem without stat, which cannot tell an EMPTY
  // folder from a missing one — and refusing a valid empty destination is worse than
  // letting ffmpeg report the missing directory itself.
  return {
    ok: true,
    path: parent ? joinPath(parent, filename) : `/${filename}`,
    filename,
    defaulted: false,
  };
}

/** Filenames of REFERENCED-in-place media whose source file is gone, limited to what THIS
 *  timeline actually uses. Only external entries are checked: media that lives inside the
 *  project cannot go offline, and reporting it would send the user hunting for a file that was
 *  never theirs to move.
 *
 *  Scoped to the timeline because it iterates the LIBRARY: an offline row that no clip
 *  references blocked every export of every timeline until the user found and deleted it.
 *  Deleting a source you have stopped using is ordinary housekeeping, so this refused a render
 *  it could have completed perfectly. `timeline` null (unreadable) falls back to checking
 *  everything — a preflight that cannot read the timeline should not go quiet. */
async function offlineSources(
  ctx: ClientToolContext,
  timeline: Timeline | null,
): Promise<string[]> {
  const used = timeline ? usedMediaRefs(timeline) : null;
  const out: string[] = [];
  for (const clip of await ctx.store.listClips()) {
    if (!clip.external) continue;
    if (used && !referencedBy(clip, used)) continue;
    if (!(await ctx.store.exists(clip.path)))
      out.push(String(clip.filename || clip.path.split(/[\\/]/).pop() || clip.id));
  }
  return out;
}

/** Every media_ref a clip on the timeline names. */
function usedMediaRefs(timeline: Timeline): Set<string> {
  const refs = new Set<string>();
  for (const track of timeline.tracks ?? [])
    for (const clip of track.clips ?? []) {
      const ref = (clip as Record<string, unknown>).media_ref;
      if (typeof ref === "string" && ref) refs.add(ref.replace(/\\/g, "/"));
    }
  return refs;
}

/** A clip can be named by its id, its path, its filename or an alias — match on any of them
 *  rather than the id alone, so a project that refers to media the older way still counts as
 *  referencing it (missing one here would SKIP a real offline file, not just fail to skip). */
function referencedBy(clip: LibraryClip, used: Set<string>): boolean {
  const names = [clip.id, clip.path, clip.filename, ...(clip.aliases ?? [])];
  return names.some((n) => typeof n === "string" && n && used.has(n.replace(/\\/g, "/")));
}

/** Returns as soon as the export is QUEUED. Everything that can refuse it — validation,
 *  unresolved media, offline sources, a busy destination — still happens in this turn; only the
 *  encode is deferred, and the chat is told when it lands. */
export async function exportTimelineTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const fmt = String(args.format ?? "mp4")
    .trim()
    .toLowerCase();
  if (!["mp4", "video", "mov"].includes(fmt)) {
    return {
      ok: false,
      error: `unsupported export format '${fmt}'; the client renders 'mp4'. NLE interchange (fcpxml) is deferred.`,
    };
  }
  const dest = await exportDestination(ctx.store, {
    name: String(args.name ?? args.filename ?? ""),
    outputPath: args.output_path,
  });
  if (!dest.ok) return dest;
  // Media linked in place can be moved or deleted between import and export. Premiere renders
  // red "Media Offline" frames; shipping a deliverable with holes in it is worse than being told,
  // so name what is gone. Checked here rather than in runRenderPlan: preview shares that path and
  // must keep working on a project with one missing file.
  const offline = await offlineSources(ctx, await loadTimeline(ctx.store).catch(() => null));
  if (offline.length)
    return {
      ok: false,
      error:
        `${offline.length} media file${offline.length > 1 ? "s are" : " is"} offline ` +
        `(${offline.join(", ")}). Relink ${offline.length > 1 ? "them" : "it"} in the library, then export again.`,
    };
  if (isDestinationReserved(dest.path))
    return {
      ok: false,
      error: `an export to ${dest.filename} is already queued or running; wait for it or choose another name.`,
    };
  // The plan is built against the STAGING path, so the destination only ever receives a finished
  // file. Built here, in the turn, because this is what can still refuse the request.
  // The extension MUST survive: ffmpeg picks its container from it, and a name ending
  // `.part-a1b2c3` dies with "Unable to find a suitable output format".
  const stagePath = dest.path.replace(
    /\.mp4$/i,
    `.part-${Math.random().toString(36).slice(2, 8)}.mp4`,
  );
  const target = ctx.store.canRename ? stagePath : dest.path;
  const prepared = await prepareRender(ctx, target, "deliverable", {
    resolution: args.resolution as ExportOptions["resolution"],
    quality: args.quality as ExportOptions["quality"],
    fps: typeof args.fps === "number" ? args.fps : undefined,
  });
  if (!prepared.ok) return prepared.result;

  const sub = await submitExport({
    store: ctx.store,
    destPath: dest.path,
    stagePath: target,
    filename: dest.filename,
    // Present only when the AGENT called this tool; the Export menu runs it with no origin.
    origin: ctx.origin,
    // Describes the artifact the plan will produce, captured here because a failed encode
    // leaves no file to measure and the metric still has to say what was attempted.
    meta: {
      duration_s: prepared.plan.duration,
      width: prepared.plan.output.width,
      height: prepared.plan.output.height,
      fps: prepared.plan.output.fps,
      quality: String(args.quality ?? ""),
      project_id: ctx.store.projectDir.split(/[\\/]/).pop() ?? "",
    },
    run: async (signal) => {
      // NOT the turn's signal: the turn is over by the time ffmpeg runs, and its abort must not
      // kill a render nobody cancelled. The queue's own signal is what Stop/cancel reaches.
      const detached: ClientToolContext = { ...ctx, signal };
      const res = (await executeRender(detached, prepared.plan, target)) as {
        ok?: boolean;
        error?: string;
        stderr_tail?: string;
        warnings?: string[];
      };
      if (!res.ok)
        throw new ExportRunError(
          String(res.error ?? "render failed"),
          typeof res.stderr_tail === "string" ? res.stderr_tail : undefined,
        );
      return { warnings: res.warnings ?? [] };
    },
  });

  // Don't leak the OS Downloads path to the model — return only the filename. When the caller
  // NAMED the destination it already knows the path, so there is nothing to disclose either way.
  return {
    ok: true,
    status: sub.queue_position > 0 ? "queued" : "exporting",
    job_id: sub.job_id,
    queue_position: sub.queue_position,
    format: "mp4",
    saved_to: dest.filename,
    duration_s: Math.round(prepared.plan.duration * 1000) / 1000,
    warnings: prepared.plan.warnings,
    ...(dest.defaulted ? { note: "Saving to your Downloads folder." } : {}),
  };
}
