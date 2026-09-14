// Compositing geometry — the parity-critical core of the preview. Pure + fully
// unit-testable (no WebGL). buildScene() turns the client-owned timeline + a
// time into a z-ordered draw list whose fit math mirrors the ffmpeg render
// (contain = letterbox, cover = centre-crop). Images only for now; video-frame
// clips are wired in a later slice.
import { canvasFps, toSecondsView } from "../timeline/frames";
import { clipKind } from "../timeline/helpers";
import { fitScale } from "../timeline/magnification";
import { clipPlays, visibleTracks } from "../timeline/visibility";
import { fadeMul, hasVal, sampleAnim } from "../timeline/anim";
import type { Animatable, Clip, Timeline } from "../timeline/model";
import { assertNever, transitionProgress } from "../timeline/transition";
import {
  resolveRenderPlan,
  type BlendKind,
  type FitKind,
  type PlanClip,
  type SecondsRenderPlan,
} from "../timeline/renderPlan";

export interface AssetDims {
  w: number;
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** One image/video drawn into `dst` (canvas px) sampling the `src` sub-rect
 *  (0..1). For video, `sourceTime` is the source-space seconds to sample.
 *  `rotate` (radians, clockwise) spins the quad around `clipBox`'s centre and
 *  clips the result to `clipBox` (matching ffmpeg rotate=...:ow=iw:oh=ih). */
export interface Layer {
  source: string;
  kind: "image" | "video";
  sourceTime?: number;
  z: number;
  opacity: number;
  dst: Rect;
  src: Rect;
  rotate: number;
  clipBox: Rect;
  eq: [number, number, number, number];
  exposure: number;
  wb: [number, number, number];
  levels: [number, number, number, number];
  hs: [number, number];
  /** Flattened per-clip effect stack (blur/glow/grain/vignette/chroma/...). */
  fx: Fx;
  /** 256x1 RGBA tone-curve ramp (R/G/B per channel, A master); absent when ungraded. */
  curve?: Uint8Array;
  blend: BlendKind;
  /** Wipe/whip transition (masked by the renderer): kind + 0..1 progress. */
  transition?: { kind: string; p: number };
  /** When set, draw a solid RGB (0..1) colour quad instead of sampling a texture
   *  (the dip-to-colour transition midpoint). */
  solid?: [number, number, number];
}
export interface TextLayer {
  kind: "text";
  text: string;
  z: number;
  opacity: number;
  box: Rect;
  fontPx: number;
  color: string;
  align: "left" | "center" | "right";
  anchorV: "top" | "middle" | "bottom";
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  weight: number | null;
  letterSpacingPx: number;
  outline: { widthPx: number; color: string } | null;
  shadow: { depthPx: number; color: string } | null;
  bgBox: { color: string; opacity: number; paddingPx: number } | null;
  /** Preview karaoke sweep: colour the first `sungChars` chars of `text` in `color` (sung/highlight), the
   *  remainder in `secondaryColor` ("transparent" for reveal builds). null = not a karaoke line. */
  karaoke: { sungChars: number; secondaryColor: string } | null;
}
export interface Scene {
  width: number;
  height: number;
  layers: Layer[];
  textLayers: TextLayer[];
  /** Scene time in seconds — drives time-varying effects (grain). */
  time?: number;
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : d;
}

/** The preview shader's colour-grade uniforms — an APPROXIMATION of the ffmpeg
 *  export grade: primaries (brightness/contrast/saturation/gamma), exposure,
 *  white balance (temperature/tint), levels (blacks/whites) and highlights/
 *  shadows. Wheels / curves / LUT are export-only for now. */
export interface Grade {
  eq: [number, number, number, number];
  exposure: number;
  wb: [number, number, number];
  levels: [number, number, number, number];
  hs: [number, number];
}
const NEUTRAL_GRADE: Grade = {
  eq: [0, 1, 1, 1],
  exposure: 0,
  wb: [1, 1, 1],
  levels: [0, 1, 0, 1],
  hs: [0, 0],
};
function colorGrade(color: unknown): Grade {
  if (!color || typeof color !== "object") return NEUTRAL_GRADE;
  const c = color as Record<string, unknown>;
  const n = (k: string, d: number): number => (typeof c[k] === "number" ? (c[k] as number) : d);
  const temp = (n("temperature", 6500) - 6500) / 6500;
  const blacks = n("blacks", 0);
  const whites = n("whites", 0);
  return {
    eq: [n("brightness", 0), n("contrast", 1), n("saturation", 1), n("gamma", 1)],
    exposure: n("exposure", 0),
    wb: [1 + temp * 0.2, 1 + n("tint", 0) * 0.1, 1 - temp * 0.2],
    levels: [
      blacks < 0 ? -blacks * 0.5 : 0,
      whites > 0 ? 1 - whites * 0.5 : 1,
      blacks > 0 ? blacks * 0.5 : 0,
      whites < 0 ? 1 + whites * 0.5 : 1,
    ],
    hs: [n("highlights", 0), n("shadows", 0)],
  };
}

/** Per-clip effect stack, flattened for the shader. Mirrors render.ts::effectFilters,
 *  approximated where WebGL can't reproduce ffmpeg exactly (see effectsOf). */
export interface Fx {
  /** blur radius px, sharpen, grain 0..1, vignette 0..1 */
  a: [number, number, number, number];
  /** glow strength 0..1, glow opacity, clarity, dehaze */
  b: [number, number, number, number];
  /** motion smear px, denoise radius px, chroma similarity (<0 = off), chroma blend */
  c: [number, number, number, number];
  /** chroma key colour, 0..1 */
  key: [number, number, number];
}
export const NEUTRAL_FX: Fx = {
  a: [0, 0, 0, 0],
  b: [0, 0, 0, 0],
  c: [0, 0, -1, 0],
  key: [0, 1, 0],
};

const hexRgb = (hex: unknown): [number, number, number] => {
  const s = String(hex ?? "#00FF00").replace(/^#/, "");
  const v = parseInt(s.length === 3 ? s.replace(/(.)/g, "$1$1") : s.slice(0, 6), 16);
  return Number.isFinite(v)
    ? [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
    : [0, 1, 0];
};

/** Flatten `clip.effects` into shader numbers. `motion` (ffmpeg tmix averages N PREVIOUS
 *  frames) and `denoise` (hqdn3d) cannot be reproduced by a stateless per-draw shader, so
 *  they are APPROXIMATED as a directional smear and a small blur — preview ≠ export for
 *  those two by design. `custom` is a raw ffmpeg filter string and is not previewable. */
export function effectsOf(effects: unknown, glow?: unknown): Fx {
  const fx: Fx = { a: [0, 0, 0, 0], b: [0, 0, 0, 0], c: [0, 0, -1, 0], key: [0, 1, 0] };
  let any = false;
  // render.ts prefers the clip-level glow over an effects[] glow; mirror that here.
  if (typeof glow === "number" && glow > 0) {
    fx.b[0] = glow / 100;
    fx.b[1] = -1;
    any = true;
  } else if (glow && typeof glow === "object") {
    const g = glow as Record<string, unknown>;
    if (typeof g.amount === "number" && g.amount > 0) {
      fx.b[0] = g.amount / 100;
      fx.b[1] = typeof g.opacity === "number" ? g.opacity : -1;
      any = true;
    }
  }
  if (!Array.isArray(effects) || effects.length === 0) return any ? fx : NEUTRAL_FX;
  for (const raw of effects) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.enabled === false) continue;
    const p = (e.params ?? {}) as Record<string, unknown>;
    const n = (k: string, d: number): number => (typeof p[k] === "number" ? (p[k] as number) : d);
    switch (String(e.type)) {
      case "blur":
        fx.a[0] = n("radius", 8);
        break;
      case "sharpen":
        fx.a[1] = n("sharpness", 1);
        break;
      case "grain":
        fx.a[2] = n("grain", 15) / 100;
        break;
      case "vignette":
        fx.a[3] = n("vignette", 0.3);
        break;
      case "glow":
        if (fx.b[0] === 0) {
          fx.b[0] = n("intensity", 25) / 100;
          fx.b[1] = typeof p.opacity === "number" ? (p.opacity as number) : -1;
        }
        break;
      case "clarity":
        fx.b[2] = n("clarity", 0.3);
        fx.b[3] = n("dehaze", 0);
        break;
      case "motion":
        // tmix over N frames -> a horizontal smear whose width scales with the count.
        fx.c[0] = n("frames", 3) * 1.5;
        break;
      case "denoise":
        fx.c[1] = Math.min(4, n("strength", 4) * 0.25);
        break;
      case "chroma":
        fx.c[2] = n("similarity", 0.3);
        fx.c[3] = n("blend", 0.1);
        fx.key = hexRgb(p.color);
        break;
      default:
        break; // `custom` (raw ffmpeg) is not previewable
    }
  }
  return fx;
}

/** Sample a [[x,y]..] control-point curve at `x` (piecewise linear, clamped). */
function curveAt(points: [number, number][], x: number): number {
  if (points.length === 0) return x;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return points[points.length - 1][1];
}

function curvePoints(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const pts = v
    .filter((p): p is number[] => Array.isArray(p) && typeof p[0] === "number")
    .map((p) => [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, Number(p[1])))]) as [
    number,
    number,
  ][];
  return pts.sort((a, b) => a[0] - b[0]);
}

/** Bake master + per-channel tone curves into a 256x1 RGBA ramp (R/G/B = per-channel,
 *  A = master) so the shader can apply them with a texture lookup. Undefined when the
 *  grade has no curves, so the common path uploads nothing. */
export function bakeCurves(color: unknown): Uint8Array | undefined {
  if (!color || typeof color !== "object") return undefined;
  const c = color as Record<string, unknown>;
  const master = curvePoints(c.masterCurve);
  const red = curvePoints(c.redCurve);
  const green = curvePoints(c.greenCurve);
  const blue = curvePoints(c.blueCurve);
  if (!master.length && !red.length && !green.length && !blue.length) return undefined;
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    out[i * 4 + 0] = Math.round(255 * Math.min(1, Math.max(0, red.length ? curveAt(red, x) : x)));
    out[i * 4 + 1] = Math.round(
      255 * Math.min(1, Math.max(0, green.length ? curveAt(green, x) : x)),
    );
    out[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, blue.length ? curveAt(blue, x) : x)));
    out[i * 4 + 3] = Math.round(
      255 * Math.min(1, Math.max(0, master.length ? curveAt(master, x) : x)),
    );
  }
  return out;
}

/** A clip's transform box, normalised to the canvas: centre + size (1 = full canvas) plus its
 *  rotation in RADIANS clockwise about that centre.
 *
 *  THE one owner. The compositor turns this into pixels (`boxOf`) and the stage overlay outlines
 *  it (`stageGeometry.normBoxOf`); neither re-derives it. There used to be two implementations
 *  with a comment on one saying it "must agree" with the other — which is how the overlay's
 *  parity test ended up comparing two copies of the same wrong quantity and agreeing perfectly
 *  while the handles sat a quarter of the canvas away from the clip. */
export interface NormBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Radians, clockwise, about (cx, cy). 0 = upright. */
  rotate: number;
}

export function normBox(clip: Clip, atFrame: number): NormBox {
  const rotate = (sampleAnim(clip.rotate, atFrame, 0) * Math.PI) / 180;
  const t = clip.transform;
  if (!t || !(t.position || hasVal(t.scale) || hasVal(t.scale_x) || hasVal(t.scale_y)))
    return { cx: 0.5, cy: 0.5, w: 1, h: 1, rotate };
  const cx = hasVal(t.position?.x) ? sampleAnim(t.position!.x, atFrame) : 0.5;
  const cy = hasVal(t.position?.y) ? sampleAnim(t.position!.y, atFrame) : 0.5;
  const s = hasVal(t.scale) ? sampleAnim(t.scale as Animatable, atFrame) : 1;
  const w = hasVal(t.scale_x) ? sampleAnim(t.scale_x as Animatable, atFrame) : s;
  const h = hasVal(t.scale_y) ? sampleAnim(t.scale_y as Animatable, atFrame) : s;
  return { cx, cy, w, h, rotate };
}

function boxOf(clip: Clip, cw: number, ch: number, atFrame: number): Rect {
  const b = normBox(clip, atFrame);
  const w = Math.max(1, b.w * cw);
  const h = Math.max(1, b.h * ch);
  return { x: Math.round(b.cx * cw - w / 2), y: Math.round(b.cy * ch - h / 2), w, h };
}

/** Destination rect (canvas px) + source sub-rect (0..1) for a fit mode. */
export function fitRects(box: Rect, img: AssetDims, fit: FitKind): { dst: Rect; src: Rect } {
  const scale = fitScale(box, img, fit);
  switch (fit) {
    case "cover": {
      const visW = box.w / scale;
      const visH = box.h / scale;
      return {
        dst: { ...box },
        src: {
          x: (img.w - visW) / 2 / img.w,
          y: (img.h - visH) / 2 / img.h,
          w: visW / img.w,
          h: visH / img.h,
        },
      };
    }
    case "contain": {
      // contain (default): fit inside the box, centred, preserving aspect.
      const dw = img.w * scale;
      const dh = img.h * scale;
      return {
        dst: { x: box.x + (box.w - dw) / 2, y: box.y + (box.h - dh) / 2, w: dw, h: dh },
        src: { x: 0, y: 0, w: 1, h: 1 },
      };
    }
    default:
      return assertNever(fit);
  }
}

function frac(v: unknown): number {
  return typeof v === "number" && v > 0 && v < 1 ? v : 0;
}

/** dst rect + source sub-rect combining source crop, fit, and flip. A negative
 *  src width/height mirrors sampling (flip), matching ffmpeg hflip/vflip. */
export function clipRects(
  box: Rect,
  img: AssetDims,
  fit: FitKind,
  crop: { left?: number; top?: number; right?: number; bottom?: number } | undefined,
  flipH: boolean,
  flipV: boolean,
): { dst: Rect; src: Rect } {
  const cl = frac(crop?.left);
  const ct = frac(crop?.top);
  const cr = frac(crop?.right);
  const cb = frac(crop?.bottom);
  const cropW = Math.max(0.01, 1 - cl - cr);
  const cropH = Math.max(0.01, 1 - ct - cb);
  // Fit the CROPPED image into the box (ffmpeg crops the source before scaling).
  const cropped = { w: img.w * cropW, h: img.h * cropH };
  const { dst, src: f } = fitRects(box, cropped, fit);
  // Compose the crop window with the fit sub-rect (both normalised 0..1).
  let sx = cl + f.x * cropW;
  let sy = ct + f.y * cropH;
  let sw = f.w * cropW;
  let sh = f.h * cropH;
  if (flipH) {
    sx += sw;
    sw = -sw;
  }
  if (flipV) {
    sy += sh;
    sh = -sh;
  }
  return { dst, src: { x: sx, y: sy, w: sw, h: sh } };
}

// The look plan is STATIC per timeline; buildScene runs per preview frame, so memoise it by the
// timeline object. Timelines are treated as immutable (an edit yields a NEW object), so a change
// misses this cache and recomputes; the consume-time fps assert catches the one staleness this can't
// see. Resolved from the SECONDS view so it's the SAME resolution the exporter reads.
const planCache = new WeakMap<Timeline, SecondsRenderPlan>();
function planFor(timeline: Timeline): SecondsRenderPlan {
  let plan = planCache.get(timeline);
  if (!plan) {
    plan = resolveRenderPlan(toSecondsView(timeline));
    planCache.set(timeline, plan);
  }
  return plan;
}

/** The composited scene (draw list) at `tSeconds`. Origin is top-left, canvas
 *  pixels — the renderer maps it into GL clip space. Image clips only. */
export function buildScene(
  timeline: Timeline,
  tSeconds: number,
  assetDims: Map<string, AssetDims>,
): Scene {
  const canvas = timeline.canvas;
  const cw = Math.trunc(num(canvas.width, 1));
  const ch = Math.trunc(num(canvas.height, 1));
  const fps = canvasFps(timeline);
  const tFrame = Math.round(tSeconds * fps);

  const tracks = visibleTracks(timeline);

  // The shared look plan (transitions + hold), resolved from the SECONDS view = the SAME resolution the
  // exporter reads. Assert it was resolved at THIS canvas fps: the preview inverts durSec->frames, which
  // only recovers the authored frame count when the fps matches — a stale/mis-resolved plan must fail
  // loudly, not silently mis-time a transition. Look up per clip by (track id, clip id), never an index.
  const plan = planFor(timeline);
  if (plan.canvas.fps !== fps)
    throw new Error(`renderPlan fps ${plan.canvas.fps} !== canvas fps ${fps} (stale plan)`);
  const planByClip = new Map<string, PlanClip>();
  for (const p of plan.clips) planByClip.set(`${p.srcTrackId}#${p.srcClipId}`, p);

  const layers: Layer[] = [];
  const textLayers: TextLayer[] = [];
  for (const track of tracks) {
    const tcs = track.clips ?? [];
    let cidx = -1;
    for (const clip of tcs) {
      cidx++;
      if (clip.kind === "audio" || !clipPlays(clip)) continue;
      const tin = num(clip.timeline_in);
      const tout = num(clip.timeline_out);
      // Centered crossfade (Premiere-style): this clip's incoming dissolve
      // straddles the cut, so it's visible from tin-leadF (a frozen lead-in over
      // the FIRST half) and the previous clip holds its last frame to tin+leadF.
      // Transition + outgoing hold come from the SHARED plan (the SAME resolution the exporter reads),
      // converted to frames at the preview's edge. Math.round(durSec*fps) RECOVERS the exact authored
      // frame count (the fps assert above guarantees the fps), so leadF is byte-identical; holdF is
      // genuinely fractional (dur/2) so it is NOT rounded. Keyed by clip id (track-positional fallback
      // for an id-less clip), matching resolveRenderPlan's key exactly; never a bare index.
      const pc = planByClip.get(`${track.id ?? ""}#${clip.id ?? `@${cidx}`}`);
      // B2 sampling contract: the plan's ONE declared offset (clip start, seconds) + clip-relative
      // seconds, so opacity/rotate sample the SAME curve at the SAME base the exporter uses — neither
      // backend independently picks a time-base/offset (the drift the fps assert also guards).
      const inSec = pc?.visibility.inSec ?? tin / fps;
      const relSec = tFrame / fps - inSec;
      // The transform sample (boxOf) uses the SAME plan-declared offset as opacity/rotate, expressed in
      // frames (== tin). So every animatable field of a clip shares ONE offset the exporter also uses.
      const offFrames = Math.round(inSec * fps);
      const selfTr =
        clip.kind !== "text" && pc?.transition
          ? {
              kind: pc.transition.kind,
              duration: Math.round(pc.transition.durSec * fps),
              ...(pc.transition.expr ? { expr: pc.transition.expr } : {}),
            }
          : null;
      const leadF = selfTr ? selfTr.duration / 2 : 0;
      const holdF = clip.kind !== "text" ? (pc?.visibility.holdSec ?? 0) * fps : 0;
      if (!(tin - leadF <= tFrame && tFrame < tout + holdF)) continue;
      if (clip.kind === "text") {
        // Caption LOOK comes from the SHARED plan (pc.text) — the same resolved style + unified defaults
        // the exporter's libass burn-in uses (size = fontsize ?? size ?? canvasH*0.06, font ?? "Poppins",
        // colour, align). The preview only owns LAYOUT: the animated box (boxOf) it wraps + centres within.
        const rt = pc?.text;
        if (!rt) continue;
        // phrase-chunks: draw ONLY the sub-phrase active at this frame (clip-relative seconds), so the
        // preview shows the same kinetic sequence the exporter times per Dialogue; a plain caption draws
        // rt.text throughout its window.
        const capInSec = pc?.visibility.inSec ?? 0;
        let drawText = rt.text;
        let drawColor = rt.color;
        let drawSizePx = rt.sizePx;
        let drawBgBox = rt.box;
        let karaokeSweep: TextLayer["karaoke"] = null;
        let winStart = capInSec;
        let winEnd = pc?.visibility.outSec ?? 0;
        if (rt.chunks && rt.chunks.length) {
          const rel = tFrame / fps - capInSec;
          const active = rt.chunks.find((c) => c.relInSec <= rel && rel < c.relOutSec);
          if (!active) continue;
          drawText = active.text;
          winStart = capInSec + active.relInSec;
          winEnd = capInSec + active.relOutSec;
          // Hero chunk emphasis (mirrors the exporter): pop scales, color recolours, highlight puts a
          // coloured box behind the text, box-invert boxes it AND inverts the text to black.
          if (active.emphasis && rt.emphasis) {
            const e = rt.emphasis;
            if (e.kind === "pop") drawSizePx = Math.round((rt.sizePx * e.scalePct) / 100);
            else if (e.kind === "color") {
              if (e.color) drawColor = e.color;
            } else if (e.kind === "highlight")
              drawBgBox = {
                color: e.color || "#ffd400",
                opacity: 1,
                paddingPx: Math.round(rt.sizePx * 0.12),
              };
            else if (e.kind === "box-invert") {
              drawBgBox = {
                color: e.color || "#ffd400",
                opacity: 1,
                paddingPx: Math.round(rt.sizePx * 0.12),
              };
              drawColor = "#000000";
            }
          }
        } else if (rt.karaoke && rt.karaoke.length) {
          // Preview karaoke SWEEP: colour the sung prefix (words whose karaoke window has started) in the
          // highlight colour and the unsung remainder in the secondary — the same per-word data the
          // exporter burns as a karaoke line. The boundary advances with time (no new plan fields).
          const relCs = Math.max(0, (tFrame / fps - capInSec) * 100);
          const sungWords: string[] = [];
          let startCs = 0;
          for (const w of rt.karaoke) {
            if (relCs >= startCs) sungWords.push(w.word);
            else break;
            startCs += w.durCs;
          }
          drawText = rt.karaoke.map((w) => w.word).join(" ");
          drawColor = rt.emphasis?.color || rt.color; // sung (primary) colour
          karaokeSweep = {
            sungChars: sungWords.join(" ").length,
            secondaryColor: rt.karaokeReveal ? "transparent" : rt.color,
          };
        }
        if (!drawText) continue;
        // Entrance/exit FADE: ramp opacity in over the first fadeInMs and out over the last fadeOutMs of
        // the active window (mirrors ASS \fad on each Dialogue), on top of the clip's own opacity anim.
        const intoWin = tFrame / fps - winStart;
        const winDur = Math.max(1e-6, winEnd - winStart);
        let fadeMul = 1;
        if (rt.fadeInMs > 0) fadeMul = Math.min(fadeMul, intoWin / (rt.fadeInMs / 1000));
        if (rt.fadeOutMs > 0)
          fadeMul = Math.min(fadeMul, (winDur - intoWin) / (rt.fadeOutMs / 1000));
        const textOpacity = Math.max(
          0,
          Math.min(1, sampleAnim(pc?.media.opacity, relSec, 1) * fadeMul),
        );
        // Motion entrance: pop grows the glyphs 60%->100% over `ms`; slide-up/left drifts the box into
        // place from an offset. Both settle after the window (mirrors the exporter's \t / \move).
        const em = rt.entranceMotion;
        let motionSizePx = drawSizePx;
        let boxDx = 0;
        let boxDy = 0;
        if (em && em.ms > 0 && intoWin < em.ms / 1000) {
          const prog = Math.max(0, Math.min(1, intoWin / (em.ms / 1000)));
          if (em.kind === "pop") motionSizePx = Math.round(drawSizePx * (0.6 + 0.4 * prog));
          else if (em.kind === "slide-left") boxDx = Math.round(rt.wPx * 0.25 * (1 - prog));
          else if (em.kind === "slide-up") boxDy = Math.round(rt.sizePx * 1.2 * (1 - prog));
        }
        // Box comes from the SHARED plan so the preview wraps at the SAME safe-margin-inset width the
        // exporter's libass margins use, centred at the same point (+ any slide offset).
        const box = {
          x: rt.cxPx - Math.round(rt.wPx / 2) + boxDx,
          y: rt.cyPx - Math.round(rt.hPx / 2) + boxDy,
          w: rt.wPx,
          h: rt.hPx,
        };
        textLayers.push({
          kind: "text",
          text: drawText,
          z: num(track.z),
          opacity: textOpacity,
          box,
          fontPx: motionSizePx,
          color: drawColor,
          align: rt.align,
          anchorV: rt.anchorV,
          font: rt.font,
          bold: rt.bold,
          italic: rt.italic,
          underline: rt.underline,
          strike: rt.strike,
          weight: rt.weight,
          letterSpacingPx: rt.spacingPx,
          outline: rt.outline,
          shadow: rt.shadow,
          bgBox: drawBgBox,
          karaoke: karaokeSweep,
        });
        continue;
      }
      const source = String(clip.media_ref ?? "");
      const kind = clipKind(clip);
      if (kind !== "image" && kind !== "video") continue; // lottie/other deferred
      const box = boxOf(clip, cw, ch, tFrame - offFrames);
      const img = assetDims.get(source) ?? { w: box.w, h: box.h };
      const fit = pc?.media.fit ?? "contain";
      const { dst, src } = clipRects(
        box,
        img,
        fit,
        pc?.media.crop,
        pc?.media.flip.h ?? false,
        pc?.media.flip.v ?? false,
      );
      // Opacity is animatable (constant or keyframed); sample at the clip-local frame,
      // then apply the fade envelope (visual fade in/out) — the same `fade` field as audio.
      const vfade = (clip.fade ?? {}) as { in?: number; out?: number };
      const opacity =
        Math.max(0, Math.min(1, sampleAnim(pc?.media.opacity, relSec, 1))) *
        fadeMul(tFrame - tin, tout - tin, num(vfade.in), num(vfade.out));
      // Rotate is animatable (constant or keyframed); sample degrees -> radians.
      const rotate = (sampleAnim(pc?.media.rotate, relSec, 0) * Math.PI) / 180;
      const layer: Layer = {
        source,
        kind: kind === "video" ? "video" : "image",
        z: num(track.z),
        opacity,
        dst,
        src,
        rotate,
        clipBox: box,
        ...colorGrade(pc?.media.color),
        fx: effectsOf(pc?.media.effects, pc?.media.glow),
        ...(bakeCurves(pc?.media.color) ? { curve: bakeCurves(pc?.media.color) } : {}),
        blend: pc?.media.blend ?? "normal",
      };
      if (kind === "video") {
        const speed = Number(clip.speed ?? 1) || 1;
        // Freeze the FIRST frame during the centered lead-in ([tin-leadF, tin])
        // and the LAST frame during the cross-cut hold ([tout, tout+holdF]).
        const rel = tFrame < tin ? 0 : tFrame < tout ? tFrame - tin : Math.max(0, tout - tin - 1);
        layer.sourceTime = (num(clip.source_in) + rel * speed) / fps;
      }
      // Inbound transition blend against the clip beneath (they overlap here).
      // Centered on the cut: the progress window is [tin-leadF, tin+leadF].
      const tr = selfTr;
      const tp = tr ? transitionProgress(tr, tFrame - tin + leadF) : null;
      if (tr && tp !== null) {
        switch (tr.kind) {
          case "wipe-l":
          case "wipe-r":
          case "whip":
            layer.transition = { kind: tr.kind, p: tp }; // masked by the renderer
            break;
          case "dip-to-black":
          case "dip-to-white": {
            // Dip THROUGH a colour: the clip beneath fades to the colour over the first
            // half, this clip fades in over the second. A full-canvas colour quad
            // (opacity clamp(2p,0,1)) sits between them; this clip uses clamp(2p-1,0,1).
            layers.push({
              source: "",
              kind: "image",
              fx: NEUTRAL_FX,
              z: num(track.z),
              opacity: Math.max(0, Math.min(1, 2 * tp)),
              dst: { x: 0, y: 0, w: cw, h: ch },
              src: { x: 0, y: 0, w: 1, h: 1 },
              rotate: 0,
              clipBox: { x: 0, y: 0, w: cw, h: ch },
              ...NEUTRAL_GRADE,
              blend: "normal",
              solid: tr.kind === "dip-to-white" ? [1, 1, 1] : [0, 0, 0],
            });
            layer.opacity *= Math.max(0, Math.min(1, 2 * tp - 1));
            break;
          }
          case "crossfade":
          case "custom":
            layer.opacity *= tp; // linear cross-dissolve
            break;
          default:
            assertNever(tr.kind); // a new TransitionKind must add a branch above (won't compile otherwise)
        }
      }
      layers.push(layer);
    }
  }
  return { width: cw, height: ch, layers, textLayers, time: tSeconds };
}

/** Turn a text layer into an image draw layer (its rasterized bitmap uploaded
 *  under `key`) so the compositor draws it like any other image. Pure. */
export function textLayerToImageLayer(t: TextLayer, key: string): Layer {
  return {
    source: key,
    kind: "image",
    fx: NEUTRAL_FX,
    z: t.z,
    opacity: t.opacity,
    dst: { ...t.box },
    src: { x: 0, y: 0, w: 1, h: 1 },
    rotate: 0,
    clipBox: { ...t.box },
    ...NEUTRAL_GRADE,
    blend: "normal",
  };
}
