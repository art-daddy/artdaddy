// renderPlan.ts — the ONE resolved "look" that the exporter (render.ts) and the preview (scene.ts)
// both derive from, so a look the contract accepts can't be defined three different ways (the
// captions/transitions drift this fixes). PURE: (seconds-view timeline) -> plan; no I/O, no fs, no
// Tauri. Derive it every time; never persist it.
//
// UNITS (deliberate, per the repo's frames/seconds discipline): every time field is SECONDS and named
// `*Sec`. The exporter's `buildRenderCommand` takes a seconds-view timeline (toSecondsView has already
// converted timeline_in/out, source_in/out, transition_in.duration and keyframe `t` frames->seconds),
// so computing the plan from that view is byte-exact and needs no re-conversion. The preview derives it
// from a seconds view of its timeline.
//
// SCOPE — this models only the LOOK decisions the plan brief enumerates: transitions, per-clip
// visibility (incl. the neighbour-derived outgoing hold), and text constraints (+ caption build, C2).
// Media compositing (transform / fit / crop / flip / rotate / opacity / fade / glow / blend / colour /
// audio) is a NAMED RESIDUAL: it stays in each backend (`clipRef`), already agrees between them, and is
// therefore NOT yet structurally enforced here. Parity is guaranteed *for looks*, not claimed for
// compositing.
import type { Animatable, Clip, Timeline } from "./model";
import { canvasFps, isNum } from "./frames";
import { clipPlays, outputGate } from "./visibility";
import { parseTransitionIn, TRANSITION_KINDS, type TransitionKind } from "./transition";

/** A clip's OWN incoming transition (from `transition_in`), resolved ONCE so render.ts's private
 *  `parseTransition` and scene.ts's `parseTransitionIn` stop being two parsers of one contract field.
 *  `durSec` is the transition length in seconds; `expr` carries a `custom` kind's raw alpha expression
 *  (pass-through only — neither backend evaluates it; both render `custom` as a linear crossfade). All
 *  contract kinds are modelled AND rendered by both backends as of Commit 2a (crossfade/custom dissolve,
 *  wipe/whip mask spatially, dip flashes a colour). */
export interface ResolvedTransition {
  readonly kind: TransitionKind; // crossfade | wipe-l | wipe-r | whip | dip-to-black | dip-to-white | custom
  readonly durSec: number;
  readonly expr?: string;
}

/** When a clip is on-canvas, plus the CENTRED-transition pads. `holdSec` is the outgoing hold — how
 *  long THIS clip persists past `outSec` so the NEXT same-track clip's centred incoming transition has
 *  it underneath (0 across a gap). That neighbour decision lived only in render.ts (`holdDur`); it is
 *  centralised here so both backends agree. The per-backend lead-in (own transition straddle) is a
 *  formula each backend keeps — it is `durSec/2` but gated by which kinds that backend renders. */
export interface VisibilityWindow {
  readonly inSec: number;
  readonly outSec: number;
  readonly holdSec: number;
}

/** Text CONSTRAINTS, never final layout (owner Q2: the plan carries the box + margins + alignment +
 *  max lines + authored hard breaks; each backend does soft wrapping in its OWN glyph metrics — libass
 *  for export, Canvas2D for preview — since identical break points are unattainable across two
 *  rasterizers). `cxPx/cyPx` is the box CENTRE in canvas px; `wPx/hPx` is the wrapping box. As of
 *  Commit 2 the defaults are UNIFIED across backends (`sizePx = size ?? round(canvasH*0.06)` — the
 *  canvas resolution is the authority, not a fixed 48; `font ?? "Poppins"` — a concrete bundled family,
 *  never `sans-serif`). `rawAss` is a clip's `raw_ass` escape hatch, passed through verbatim.
 *
 *  `safeMarginXPx`/`safeMarginYPx` are per-EDGE title-safe insets (5% of each dimension): the wrap box is
 *  `wPx = canvasW - 2*safeMarginXPx` and the vertical CENTRE is clamped into `[safeMarginYPx, ch-safeMarginYPx]`,
 *  so a caption can't sit in the outer margin. The schema's open `style` extras (weight/case/spacing/outline/
 *  shadow/background) and `animation` (build/emphasis/word-highlight/phrase-chunks) are NOT resolved into
 *  this look yet — tracked in NOT_MODELED (they survive on `rawStyle`/`clipRef`). `text.maxLines` is
 *  DELIBERATELY not modelled: a line cap needs glyph metrics the plan doesn't have, so it stays in
 *  NOT_MODELED rather than be a constraint nobody enforces. Parity is guaranteed for the RESOLVED look. */
export interface ResolvedText {
  readonly text: string;
  readonly font: string;
  readonly sizePx: number;
  readonly color: string;
  readonly align: "left" | "center" | "right";
  /** Which edge of the text BLOCK sits on `cyPx`, and therefore which way extra lines grow.
   *  "middle" (the default) grows both ways, so wrapping to a second line shifts the first line
   *  UP — correct for a centred title, wrong for a caption card, where it makes consecutive cards
   *  sit at different heights. "top" pins the first line and grows downward. Maps to the ASS \an
   *  row directly (7-9 / 4-6 / 1-3); the preview offsets the block by the same rule. */
  readonly anchorV: "top" | "middle" | "bottom";
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly weight: number | null; // numeric font weight 100..900 -> ASS Bold field (overrides `bold`); null = use `bold`
  readonly spacingPx: number; // letter spacing in px (0 = none)
  readonly fadeInMs: number; // entrance fade duration ms (0 = none) -> \fad / preview opacity ramp
  readonly fadeOutMs: number; // exit fade duration ms (0 = none)
  /** A motion entrance (pop grows the glyphs; slide-up/slide-left drift into place) over `ms`. null =
   *  none. Exporter -> \t / \move; preview animates scale / box offset over the window. Independent of
   *  the fade above (a caption can fade AND pop). */
  readonly entranceMotion: {
    readonly kind: "pop" | "slide-up" | "slide-left";
    readonly ms: number;
  } | null;
  /** Painted decorations (3A-2). `box` and `outline` both drive libass's OutlineColour under different
   *  BorderStyles, so a boxed caption has NO separate outline (box wins when both are set). */
  readonly outline: { readonly widthPx: number; readonly color: string } | null;
  readonly shadow: { readonly depthPx: number; readonly color: string } | null;
  readonly box: {
    readonly color: string;
    readonly opacity: number;
    readonly paddingPx: number;
  } | null;
  readonly hasPos: boolean;
  readonly cxPx: number;
  readonly cyPx: number;
  readonly wPx: number;
  readonly hPx: number;
  readonly safeMarginXPx: number;
  readonly safeMarginYPx: number;
  readonly hardBreaks: boolean; // an authored newline is present
  /** A `build:"phrase-chunks"` caption's `content[]` expanded into timed sub-phrases (CLIP-RELATIVE
   *  seconds), shown one at a time — the kinetic look. null for a plain caption. The exporter emits one
   *  timed Dialogue per chunk; the preview draws whichever chunk is active. */
  readonly chunks:
    | readonly {
        readonly text: string;
        readonly relInSec: number;
        readonly relOutSec: number;
        readonly emphasis: boolean;
      }[]
    | null;
  /** How a `emphasis:true` chunk/run is marked (animation.emphasis): `pop` scales it, any colour kind
   *  recolours it. null = no emphasis. */
  readonly emphasis: {
    readonly kind: "pop" | "color" | "highlight" | "box-invert";
    readonly color: string;
    readonly scalePct: number;
  } | null;
  /** A `build:"word-highlight"` caption's content[] as karaoke syllables (word + highlight duration in
   *  centiseconds). The exporter builds one \k line (words dim until the sweep reaches them); the preview
   *  approximates by drawing the joined line. null = not a word-highlight clip. */
  readonly karaoke: readonly { readonly word: string; readonly durCs: number }[] | null;
  /** Word-REVEAL karaoke (word-by-word / append / typewriter): unsung words are INVISIBLE until the \k
   *  sweep reaches them (secondary transparent), vs word-highlight's DIM unsung. Only meaningful when
   *  `karaoke != null`. */
  readonly karaokeReveal: boolean;
  /** A multi-run caption's content[] resolved into per-run styled runs (whole-line build): each run
   *  carries its FULL resolved style (base + per-run override) + emphasis flag. null for a single-run /
   *  plain caption (the flat `text` + base style is identical and simpler). The exporter composes one
   *  Dialogue with per-run inline overrides; the preview draws the joined base-styled line (per-run
   *  styling is export-authoritative — a NAMED residual, like curves/LUT). */
  readonly runs: readonly ResolvedRun[] | null;
  readonly rawAss: string; // a clip's raw_ass override string (verbatim escape hatch), or ""
  readonly rawStyle: Record<string, unknown>;
}

/** One clip in canonical order, with its resolved look decisions. `clipRef` is the source clip so a
 *  backend can read the media-compositing fields it still owns (the named residual above). */
export interface PlanClip {
  readonly kind: string; // video | image | audio | text
  readonly clipRef: Clip;
  readonly trackZ: number;
  /** Stable identity for a backend that iterates its OWN clips and looks the plan up (the preview,
   *  whose hidden-track filter desyncs positional order from the plan's). Prefer `clip.id` — stable
   *  under insert/remove; do NOT "simplify" to a bare index. But `clip.id` is OPTIONAL in the model, so
   *  an id-less clip (tests / legacy) falls back to a track-positional `@idx` token: safe ONLY because
   *  the plan is derived fresh and consumed in the same pass. Track-scoped so a cross-track id can't
   *  alias. */
  readonly srcTrackId: string;
  readonly srcClipId: string;
  readonly transition: ResolvedTransition | null;
  readonly visibility: VisibilityWindow;
  readonly text: ResolvedText | null;
  /** A video/image clip's composite decisions resolved into the plan so both backends read them from ONE
   *  place (never `clipRef` independently): `fit`/`blend` (CLOSED unions dispatched exhaustively), `crop`
   *  (edge fractions clamped), `flip` (strict booleans), `color` (raw grade — each backend FORMATS it),
   *  `effects` (the raw stack — each backend formats it; preview approximates what WebGL can't match),
   *  `glow` (the clip-level bloom scalar/object — render.ts prefers it over an effects[] glow),
   *  and the animatable `opacity`/`rotate` curves (the SAMPLING CONTRACT — see below). Still on `clipRef`
   *  (render-only — no cross-backend read to unify): audio; and transform (sampled via boxOf,
   *  a separate follow-up). Present for every clip kind (audio/text carry neutral values they never sample).
   *
   *  SAMPLING CONTRACT (B2): the curves here are the SECONDS-view Animatable, and the ONE declared offset
   *  is `pc.visibility.inSec` (clip start, seconds). BOTH backends sample the SAME curve at
   *  `globalTime - inSec` (renderer: `compileAnim(curve,"T"|"t",inSec)`; preview: `sampleAnim(curve,
   *  tSeconds - inSec)`), so neither can independently pick a different time-base/offset — the exact drift
   *  the fps assert also guards. Interpolation/easing is shared in anim.ts. */
  readonly media: {
    readonly fit: FitKind;
    readonly blend: BlendKind;
    readonly crop: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly bottom: number;
    };
    readonly flip: { readonly h: boolean; readonly v: boolean };
    readonly color: unknown;
    readonly effects: unknown;
    readonly glow: unknown;
    readonly opacity: Animatable | undefined;
    readonly rotate: Animatable | undefined;
  };
}

/** One resolved run of a multi-run caption: its FULL style (base overlaid with the run's per-item
 *  `style`) + whether it is a hero (`emphasis:true`). assCaption's `runOverride` diffs this against the
 *  caption's base style and emits only the inline tags that differ (+ the emphasis treatment). */
export interface ResolvedRun {
  readonly text: string;
  readonly font: string;
  readonly sizePx: number;
  readonly color: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly weight: number | null;
  readonly outline: { readonly widthPx: number; readonly color: string } | null;
  readonly emphasis: boolean;
}

export interface SecondsRenderPlan {
  readonly canvas: { readonly w: number; readonly h: number; readonly fps: number };
  readonly durationSec: number;
  /** Clips in CANONICAL order — tracks by z then id (render.ts's existing sort), clips in track order.
   *  Both backends iterate THIS, so neither re-derives order and there is no id-keying (test clips have
   *  no id). */
  readonly clips: readonly PlanClip[];
  /** Fields the EXPORTER models here but does not yet render (Commit 2 must EMPTY this). Named so
   *  "the renderer ignores a field" is explicit, not silent. */
  readonly unimplementedInExport: readonly string[];
}

/** Plan fields the exporter models but does NOT render — the preview>export asymmetry the Commit-1
 *  extraction tracked. EMPTY as of Commit 2: the exporter now burns captions via libass, so it renders
 *  every caption look the preview does — align (`\an`), wrap (per-Dialogue margins), authored hard
 *  breaks (`\N`), and the unified font/size/colour. (Unmodelled caption looks — the style/animation extras
 *  and the metric-free `maxLines` — were never a preview>export ASYMMETRY; they are tracked in NOT_MODELED,
 *  not here.) */
export const UNIMPLEMENTED_IN_EXPORT: readonly string[] = [];

/** Caption capabilities the plan TRACKS against the contract's open `style`/`animation` objects (plus the
 *  metric-free `text.maxLines`). SINGLE SOURCE OF TRUTH for the closure report's caption residual: as a
 *  Fix-#3 slice ships a capability it moves into CAPTION_CAPS_MODELED, and NOT_MODELED — the computed
 *  remainder — shrinks automatically, so a parity claim can never run ahead of what resolveText does. */
const CAPTION_CAPS_ALL = [
  "style.weight",
  "style.italic",
  "style.underline",
  "style.strike",
  "style.case",
  "style.spacing",
  "style.outline",
  "style.shadow",
  "style.box",
  "style.preset",
  "animation.fade",
  "animation.entrance-motion",
  "animation.emphasis",
  "animation.word-highlight",
  "animation.phrase-chunks",
  "text.maxLines",
] as const;
/** The subset resolveText/resolveRenderPlan actually resolve TODAY (grows per Fix #3 slice; `text.maxLines`
 *  stays out forever — it is metric-free and deliberately unenforced, hence permanently NOT_MODELED). */
const CAPTION_CAPS_MODELED: ReadonlySet<string> = new Set<string>([
  "style.weight", // numeric weight -> ASS Bold field verbatim; else the bold flag -> -1/0 (C1)
  "style.italic", // -> \i1 (3A-1)
  "style.underline", // -> Underline = -1 in the style line (C1)
  "style.strike", // -> StrikeOut = -1 in the style line (C1)
  "style.case", // upper/lower applied to the plan's text (3A-1)
  "style.spacing", // letter spacing -> \fsp (3A-1)
  "style.outline", // \bord + \3c / strokeText (3A-2)
  "style.shadow", // \shad + \4c / shadowColor+Offset (3A-2)
  "style.box", // BorderStyle=3 + \3c / fillRect behind (3A-2)
  "style.preset", // named look seeds the style defaults; explicit fields override (C5)
  "animation.phrase-chunks", // content[] -> timed sub-phrases, one at a time (3B-1)
  "animation.fade", // entrance/exit fade -> \fad / preview opacity envelope (3B-2)
  "animation.emphasis", // hero runs recoloured (\1c) or popped (\fscx/\fscy) (3B-3)
  "animation.entrance-motion", // pop/slide entrances -> \t/\move / preview scale+offset (3B-4)
  "animation.word-highlight", // \k karaoke line; preview draws the full line (3B-5)
]);
/** Exposed for the drift guard (renderPlan.test.ts). */
export const CAPTION_CAPS = {
  all: CAPTION_CAPS_ALL as readonly string[],
  modeled: CAPTION_CAPS_MODELED,
};

/** Contract caption capabilities the plan does NOT resolve yet — COMPUTED as (all MINUS modelled), so
 *  shipping a Fix-#3 capability is a one-line move into CAPTION_CAPS_MODELED and this list updates itself.
 *  The drift guard verifies consistency (modelled ⊆ all; NOT_MODELED and modelled are disjoint and cover
 *  all). Transition-kind coverage is a SEPARATE guard (every schema `transition.kind` ∈ TRANSITION_KINDS). */
export const NOT_MODELED: readonly string[] = CAPTION_CAPS_ALL.filter(
  (c) => !CAPTION_CAPS_MODELED.has(c),
);

const EPS = 1e-4;

/** Read a text clip's string content (text, or a content string/array). Mirrors render.ts. */
function textContent(clip: Clip): string {
  if (typeof clip.text === "string") return clip.text;
  if (typeof clip.content === "string") return clip.content;
  if (Array.isArray(clip.content)) {
    return clip.content
      .map((c) =>
        c && typeof c === "object" ? String((c as Record<string, unknown>).text ?? "") : "",
      )
      .join(" ");
  }
  return "";
}

/** Parse `transition_in` -> {kind, durSec}, or null. Delegates to transition.ts's `parseTransitionIn`
 *  — the ONE parser (validate.ts uses it too), so the plan can't drift from validation. Its `duration`
 *  is in the CALLER's view unit: SECONDS here, because resolveRenderPlan runs on the seconds view (the
 *  exporter passes its seconds-view timeline; the preview passes `toSecondsView(timeline)`). */
function resolveTransition(clip: Clip): ResolvedTransition | null {
  const ti = parseTransitionIn(clip);
  if (!ti) return null;
  // The plan's kind is the CLOSED TransitionKind union so both backends can dispatch it exhaustively
  // (default: assertNever). parseTransitionIn returns a raw string, so an unrecognised kind coerces to
  // "crossfade" — the exact linear dissolve both backends already fall back to for an unknown kind —
  // never a value outside the union.
  const kind: TransitionKind = (TRANSITION_KINDS as readonly string[]).includes(ti.kind)
    ? (ti.kind as TransitionKind)
    : "crossfade";
  return ti.expr ? { kind, durSec: ti.duration, expr: ti.expr } : { kind, durSec: ti.duration };
}

/** CLOSED media-composite unions the plan resolves so both backends dispatch them exhaustively
 *  (`default: assertNever`). Mirrors resolveTransition: a value outside the contract enum coerces to the
 *  exact neutral both backends ALREADY fall back to for an unknown value — fit→"contain" (the
 *  non-"cover" branch in render.ts::boxOf and scene.ts::clipRects), blend→"normal" (parseBlend returns
 *  null, i.e. no blend chain) — so the resolved value is byte-identical to today for every in-contract
 *  input and can never be out of union. Source of truth: timeline.schema.json fit/blend enums. */
export const FIT_KINDS = ["contain", "cover"] as const;
export type FitKind = (typeof FIT_KINDS)[number];
export const BLEND_KINDS = ["normal", "multiply", "screen", "overlay", "add"] as const;
export type BlendKind = (typeof BLEND_KINDS)[number];

export function resolveFit(v: unknown): FitKind {
  return v === "cover" ? "cover" : "contain";
}
function resolveBlend(v: unknown): BlendKind {
  return (BLEND_KINDS as readonly string[]).includes(v as string) ? (v as BlendKind) : "normal";
}

/** Edge crop fractions clamped to (0,1) ONCE here so BOTH backends read the same clamped values
 *  (render.ts builds the ffmpeg `crop=` expr, scene.ts the texture sub-rect) — an unclamped raw read in
 *  either would diverge. Out-of-range/absent -> 0 (no crop on that edge). */
function frac(v: unknown): number {
  return typeof v === "number" && v > 0 && v < 1 ? v : 0;
}
function resolveCrop(v: unknown): { left: number; right: number; top: number; bottom: number } {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { left: frac(o.left), right: frac(o.right), top: frac(o.top), bottom: frac(o.bottom) };
}
/** Flip flags coerced to strict booleans ONCE (both backends used `=== true`). */
function resolveFlip(val: unknown): { h: boolean; v: boolean } {
  const o = (val && typeof val === "object" ? val : {}) as Record<string, unknown>;
  return { h: o.h === true, v: o.v === true };
}

/** The outgoing hold for a clip at track index `idx`: the FIRST following non-audio/non-text clip's
 *  transition, half its duration past the cut, zero across a gap. Byte-for-byte render.ts `holdDur`. */
function resolveHoldSec(tclips: readonly Clip[], idx: number, outSec: number): number {
  for (let k = idx + 1; k < tclips.length; k++) {
    const nx = tclips[k];
    if (nx.kind === "audio" || nx.kind === "text") continue;
    const ntr = resolveTransition(nx);
    if (ntr) {
      const nxTin = Number(nx.timeline_in) || 0;
      return nxTin - outSec > EPS ? 0 : Math.max(0, nxTin + ntr.durSec / 2 - outSec);
    }
    return 0;
  }
  return 0;
}

/** A painted outline `{color,width}` -> `{widthPx,color}` (default colour black), or null when absent/zero. */
function parseOutline(v: unknown): { widthPx: number; color: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const width = isNum(o.width) ? (o.width as number) : 0;
  return width > 0
    ? { widthPx: width, color: typeof o.color === "string" ? o.color : "black" }
    : null;
}

/** A drop shadow `{color,depth}` -> `{depthPx,color}` (default colour black), or null when absent/zero. */
function parseShadow(v: unknown): { depthPx: number; color: string } | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const depth = isNum(s.depth) ? (s.depth as number) : 0;
  return depth > 0
    ? { depthPx: depth, color: typeof s.color === "string" ? s.color : "black" }
    : null;
}

/** A background box `{color,opacity,padding}` -> resolved, or null when absent / colourless. Padding
 *  defaults to 20% of the font size so a box always has breathing room. */
function parseBox(
  v: unknown,
  sizePx: number,
): { color: string; opacity: number; paddingPx: number } | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (typeof b.color !== "string") return null; // a box must have a colour to paint
  const opacity = isNum(b.opacity) ? Math.max(0, Math.min(1, b.opacity as number)) : 1;
  const paddingPx = isNum(b.padding) ? (b.padding as number) : Math.round(sizePx * 0.2);
  return { color: b.color, opacity, paddingPx };
}

/** Named style presets (v1 STYLE_PRESETS): a `style.preset` seeds these defaults, then explicit style
 *  fields override them. `boxed` sets outline width 0 so the box (BorderStyle=3) isn't doubled with an
 *  outline ring. */
const STYLE_PRESETS: Record<string, Record<string, unknown>> = {
  "clean-white": {
    font: "Poppins",
    size: 92,
    color: "#ffffff",
    bold: true,
    outline: { color: "#000000", width: 6 },
  },
  boxed: {
    font: "Poppins",
    size: 84,
    color: "#ffffff",
    bold: true,
    box: { color: "#000000", opacity: 0.75, padding: 16 },
    outline: { color: "#000000", width: 0 },
  },
  punchy: {
    font: "Anton",
    size: 110,
    color: "#ffffff",
    case: "upper",
    outline: { color: "#000000", width: 8 },
    shadow: { color: "#000000", depth: 3 },
  },
  headline: {
    font: "Bebas Neue",
    size: 120,
    color: "#ffffff",
    case: "upper",
    outline: { color: "#000000", width: 6 },
  },
  editorial: {
    font: "Playfair Display",
    size: 96,
    color: "#ffffff",
    italic: true,
    shadow: { color: "#000000", depth: 3 },
  },
  minimal: { font: "Oswald", size: 80, color: "#ffffff", shadow: { color: "#000000", depth: 2 } },
};
/** Merge a raw style dict over its `preset` seed (explicit fields win), so downstream resolution reads a
 *  single flattened style. Applied at BOTH clip and run level (a run may carry its own preset). */
function mergeStyle(raw: unknown): Record<string, unknown> {
  const st = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const preset = typeof st.preset === "string" ? STYLE_PRESETS[st.preset] : undefined;
  return preset ? { ...preset, ...st } : st;
}

/** Named type sizes, as a fraction of CANVAS HEIGHT. A raw px size means the same thing on every
 *  canvas only by accident; these keep their proportion, which is what "make it bigger" means. */
const SIZE_TIERS: Record<string, number> = { s: 0.04, m: 0.06, l: 0.09, xl: 0.13 };

/** The type size in px, from a raw number or a named tier. `fallback` is the inherited size (the
 *  clip's, for a run) or the canvas default. */
export function resolveSizePx(
  style: Record<string, unknown>,
  ch: number,
  fallback: number,
): number {
  if (isNum(style.fontsize)) return style.fontsize as number;
  const s = style.size;
  if (isNum(s)) return s as number;
  if (typeof s === "string") {
    const tier = SIZE_TIERS[s.trim().toLowerCase()];
    if (tier) return ch * tier;
  }
  return fallback;
}

/** Named caption motions. Each seeds the animation fields it implies; anything the caller states
 *  explicitly still wins, exactly as a style preset works.
 *
 *  These exist because `build` / `entrance` / `timing` / `emphasis` are four separate enums whose
 *  combinations are not all meaningful — asking for "karaoke" as one word is both cheaper for the
 *  model and harder to get subtly wrong than asking it to agree with itself four times. */
const ANIMATION_PRESETS: Record<string, Record<string, unknown>> = {
  "pop-in": { build: "whole-line", entrance: "pop", entrance_ms: 180 },
  "slide-up": { build: "whole-line", entrance: "slide-up", entrance_ms: 220 },
  typewriter: { build: "typewriter", timing: "transcript" },
  "word-reveal": { build: "word-by-word", timing: "transcript" },
  "word-highlight": { build: "word-highlight", timing: "transcript" },
  karaoke: {
    build: "word-highlight",
    timing: "transcript",
    emphasis: { kind: "highlight", color: "#ffd400" },
  },
  "phrase-chunks": { build: "phrase-chunks", timing: "transcript" },
};

/** Merge a raw animation dict over its `preset` seed (explicit fields win). Mirrors mergeStyle so
 *  there is ONE merge rule for "a preset seeds, the caller overrides", not two. */
export function mergeAnimation(raw: unknown): Record<string, unknown> {
  const an = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const preset = typeof an.preset === "string" ? ANIMATION_PRESETS[an.preset] : undefined;
  return preset ? { ...preset, ...an } : an;
}

/** The bundled libass families (resources/fonts) — the ONLY names that resolve at export; an unbundled
 *  name (e.g. "Impact") leaves plan.fonts empty and libass falls back to a SYSTEM font, so exports would
 *  differ per machine. resolveText clamps a requested font to one of these (case/space-insensitive),
 *  defaulting to Poppins. */
const BUNDLED_FONTS = ["Anton", "Bebas Neue", "Oswald", "Playfair Display", "Poppins"] as const;
const FONT_ALIASES: Record<string, string> = Object.fromEntries(
  BUNDLED_FONTS.flatMap((f) => [
    [f.toLowerCase(), f],
    [f.toLowerCase().replace(/\s+/g, ""), f],
  ]),
);
export function clampFont(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) return "Poppins";
  const key = name.trim();
  if ((BUNDLED_FONTS as readonly string[]).includes(key)) return key;
  return (
    FONT_ALIASES[key.toLowerCase()] ??
    FONT_ALIASES[key.toLowerCase().replace(/\s+/g, "")] ??
    "Poppins"
  );
}

/** Expand a `build:"phrase-chunks"` caption's `content[]` into timed sub-phrases (CLIP-RELATIVE seconds),
 *  one shown at a time — the kinetic caption look. `timing:"explicit"|"transcript"` uses each item's
 *  t_in/t_out (a missing t_out runs to the next chunk's start, or the clip end); otherwise the clip's
 *  duration is split evenly. null when the clip isn't a phrase-chunk sequence. */
function resolveChunks(
  clip: Clip,
  caseMode: "upper" | "lower" | "none",
  durSec: number,
): ResolvedText["chunks"] {
  const anim = mergeAnimation(clip.animation);
  if (anim.build !== "phrase-chunks") return null;
  const content = clip.content;
  if (!Array.isArray(content) || content.length < 2) return null;
  const explicit = anim.timing === "explicit" || anim.timing === "transcript";
  const n = content.length;
  return content.map((rawItem, i) => {
    const it = (rawItem ?? {}) as Record<string, unknown>;
    const t = typeof it.text === "string" ? it.text : "";
    const text =
      caseMode === "upper" ? t.toUpperCase() : caseMode === "lower" ? t.toLowerCase() : t;
    let relInSec: number;
    let relOutSec: number;
    if (explicit && isNum(it.t_in)) {
      relInSec = it.t_in as number;
      const nextIn =
        i + 1 < n ? ((content[i + 1] ?? {}) as Record<string, unknown>).t_in : undefined;
      relOutSec = isNum(it.t_out)
        ? (it.t_out as number)
        : isNum(nextIn)
          ? (nextIn as number)
          : durSec;
    } else {
      relInSec = (durSec * i) / n;
      relOutSec = (durSec * (i + 1)) / n;
    }
    return { text, relInSec, relOutSec, emphasis: it.emphasis === true };
  });
}

/** Resolve `animation.emphasis` (how HERO words are marked) into a compact style: kind + colour + a pop
 *  scale percent. null when absent or kind is 'none'. Each backend applies it to a chunk (or run) flagged
 *  `emphasis:true`: `pop` scales the glyphs; every colour kind (color/highlight/box-invert) recolours the
 *  hero to `emphasis.color` (highlight/box-invert are approximated as a recolour — no separate marker box). */
function resolveEmphasis(anim: Record<string, unknown>): ResolvedText["emphasis"] {
  const e = anim.emphasis;
  if (!e || typeof e !== "object") return null;
  const em = e as Record<string, unknown>;
  const kind = em.kind;
  if (kind !== "pop" && kind !== "color" && kind !== "highlight" && kind !== "box-invert")
    return null;
  return {
    kind,
    color: typeof em.color === "string" ? em.color : "",
    scalePct: isNum(em.scale) ? Math.round((em.scale as number) * 100) : 120,
  };
}

/** Expand a KARAOKE-style caption's content[] into karaoke syllables {word, durCs}. Four builds render
 *  as one \k line: `word-highlight` (unsung DIM), and the reveal trio `word-by-word`/`append`/`typewriter`
 *  (unsung INVISIBLE until reached). The exporter builds one \k line; the preview approximates by drawing
 *  the joined line (a NAMED residual). null when the build isn't a karaoke build. */
function resolveKaraoke(
  clip: Clip,
  caseMode: "upper" | "lower" | "none",
  durSec: number,
): ResolvedText["karaoke"] {
  const anim = mergeAnimation(clip.animation);
  if (
    anim.build !== "word-highlight" &&
    anim.build !== "word-by-word" &&
    anim.build !== "append" &&
    anim.build !== "typewriter"
  )
    return null;
  const content = clip.content;
  if (!Array.isArray(content) || content.length < 1) return null;
  const explicit = anim.timing === "explicit" || anim.timing === "transcript";
  const n = content.length;
  return content.map((rawItem, i) => {
    const it = (rawItem ?? {}) as Record<string, unknown>;
    const t = typeof it.text === "string" ? it.text : "";
    const word =
      caseMode === "upper" ? t.toUpperCase() : caseMode === "lower" ? t.toLowerCase() : t;
    let durCs: number;
    if (explicit && isNum(it.t_in)) {
      const start = it.t_in as number;
      const nextIn =
        i + 1 < n ? ((content[i + 1] ?? {}) as Record<string, unknown>).t_in : undefined;
      const end = isNum(it.t_out)
        ? (it.t_out as number)
        : isNum(nextIn)
          ? (nextIn as number)
          : durSec;
      durCs = Math.max(1, Math.round((end - start) * 100));
    } else {
      durCs = Math.max(1, Math.round((durSec / n) * 100));
    }
    return { word, durCs };
  });
}

/** Parse a multi-run caption's content[] into per-run styled runs (whole-line build only — phrase-chunks
 *  and word-highlight own their timed paths). Each run's style resolves the item's `style` ON TOP of the
 *  clip base (unset fields inherit base). Returns null unless a per-run style/emphasis is actually
 *  present, so a plain content array still uses the simpler joined-text path. */
function resolveRuns(
  clip: Clip,
  base: {
    font: string;
    sizePx: number;
    color: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    weight: number | null;
    outline: { widthPx: number; color: string } | null;
  },
  caseMode: "upper" | "lower" | "none",
  ch: number,
): ResolvedText["runs"] {
  const anim = mergeAnimation(clip.animation);
  if (anim.build === "phrase-chunks" || anim.build === "word-highlight") return null;
  const content = clip.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const hasOverride = content.some(
    (it) =>
      it != null &&
      typeof it === "object" &&
      ("style" in (it as object) || (it as Record<string, unknown>).emphasis === true),
  );
  if (!hasOverride) return null;
  const applyCase = (t: string) =>
    caseMode === "upper" ? t.toUpperCase() : caseMode === "lower" ? t.toLowerCase() : t;
  return content.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const st = mergeStyle(it.style);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(st, k);
    return {
      text: applyCase(typeof it.text === "string" ? it.text : ""),
      font: typeof st.font === "string" && st.font ? clampFont(st.font) : base.font,
      sizePx: Math.round(resolveSizePx(st, ch, base.sizePx)),
      color: typeof st.color === "string" ? st.color : base.color,
      bold: has("bold") ? st.bold === true : base.bold,
      italic: has("italic") ? st.italic === true : base.italic,
      underline: has("underline") ? st.underline === true : base.underline,
      strike: has("strike") ? st.strike === true : base.strike,
      weight:
        isNum(st.weight) && (st.weight as number) >= 100 && (st.weight as number) <= 900
          ? Math.round(st.weight as number)
          : base.weight,
      outline: has("outline") ? parseOutline(st.outline) : base.outline,
      emphasis: it.emphasis === true,
    };
  });
}

/** Resolve a text clip's CONSTRAINTS + unified style defaults (Commit 2): `size ?? round(ch*0.06)`
 *  (resolution-relative, not a fixed 48), `font ?? "Poppins"` (a concrete bundled family — never
 *  `sans-serif`, which libass can't resolve without fontconfig), `color ?? white`. Box + align +
 *  per-edge safe margins + hardBreaks are the target constraints each backend lays out within. */
function resolveText(clip: Clip, cw: number, ch: number, durSec: number): ResolvedText {
  const style = mergeStyle(clip.style);
  // transform.scale multiplies the TYPE SIZE (a text clip has no pixel box to scale — it scales glyphs).
  const tScale = isNum(clip.transform?.scale) ? Math.max(0, clip.transform!.scale as number) : 1;
  const sizePx = Math.round(resolveSizePx(style, ch, ch * 0.06) * tScale);
  const color =
    typeof style.color === "string"
      ? style.color
      : typeof style.fontcolor === "string"
        ? style.fontcolor
        : "white";
  // Clamp to a BUNDLED family (default Poppins): an unbundled name would leave plan.fonts empty and
  // libass would fall back to a per-machine system font.
  const font = clampFont(style.font);
  const align =
    style.align === "left" || style.align === "right"
      ? (style.align as "left" | "right")
      : "center";
  const anchorV =
    style.anchor_v === "top" || style.anchor_v === "bottom"
      ? (style.anchor_v as "top" | "bottom")
      : "middle";
  // Static marks (3A-1 + C1): a numeric `weight` (100..900) goes to the ASS Bold field verbatim (v1
  // _style_line) and OVERRIDES the `bold` flag; italic/underline/strike are style-line booleans; letter
  // spacing -> \fsp; the `case` transform is applied to the TEXT here so both backends draw the identical
  // cased string.
  const weight =
    isNum(style.weight) && (style.weight as number) >= 100 && (style.weight as number) <= 900
      ? Math.round(style.weight as number)
      : null;
  const bold = style.bold === true;
  const italic = style.italic === true;
  const underline = style.underline === true;
  const strike = style.strike === true;
  const spacingPx = isNum(style.spacing) ? (style.spacing as number) : 0;
  const caseMode = style.case === "upper" || style.case === "lower" ? style.case : "none";
  // Painted decorations: box wins over outline (both drive OutlineColour under different BorderStyles).
  const box = parseBox(style.box, sizePx);
  const outline = box ? null : parseOutline(style.outline);
  const shadow = parseShadow(style.shadow);
  // Entrance/exit FADE (3B-2): \fad(inMs,outMs) per Dialogue; the preview ramps opacity over the window.
  // A default 300ms applies when the mode is 'fade' without an explicit duration. (pop/slide entrances
  // are NOT modelled yet — see NOT_MODELED animation.entrance-exit.)
  const anim = mergeAnimation(clip.animation);
  const fadeInMs =
    anim.entrance === "fade"
      ? isNum(anim.entrance_ms)
        ? Math.max(0, anim.entrance_ms as number)
        : 300
      : 0;
  const fadeOutMs =
    anim.exit === "fade" ? (isNum(anim.exit_ms) ? Math.max(0, anim.exit_ms as number) : 300) : 0;
  const emphasis = resolveEmphasis(anim);
  const entranceMotion =
    anim.entrance === "pop" || anim.entrance === "slide-up" || anim.entrance === "slide-left"
      ? {
          kind: anim.entrance as "pop" | "slide-up" | "slide-left",
          ms: isNum(anim.entrance_ms) ? Math.max(0, anim.entrance_ms as number) : 300,
        }
      : null;
  // Per-EDGE title-safe inset (5% of EACH dimension — a landscape frame's side margin must be 5% of the
  // WIDTH, not of the smaller height, or a wide caption still touches the vertical edges).
  const safeMarginXPx = Math.round(cw * 0.05);
  const safeMarginYPx = Math.round(ch * 0.05);
  const pos = clip.transform?.position;
  const hasPos = pos != null && isNum(pos.x) && isNum(pos.y);
  const cxPx = hasPos ? Math.round((pos!.x as number) * cw) : Math.round(cw / 2);
  // Clamp the vertical CENTRE into the safe band so a positioned caption can't sit in the outer margin.
  const cyRaw = hasPos ? Math.round((pos!.y as number) * ch) : Math.round(ch / 2);
  const cyPx = Math.max(safeMarginYPx, Math.min(ch - safeMarginYPx, cyRaw));
  const raw = textContent(clip);
  const text =
    caseMode === "upper" ? raw.toUpperCase() : caseMode === "lower" ? raw.toLowerCase() : raw;
  const chunks = resolveChunks(clip, caseMode, durSec);
  const karaoke = resolveKaraoke(clip, caseMode, durSec);
  // Reveal builds (word-by-word/append/typewriter) hide unsung words; word-highlight only dims them.
  const karaokeReveal = karaoke != null && anim.build !== "word-highlight";
  const runs = resolveRuns(
    clip,
    { font, sizePx, color, bold, italic, underline, strike, weight, outline },
    caseMode,
    ch,
  );
  const rawAss =
    typeof (clip as Record<string, unknown>).raw_ass === "string"
      ? ((clip as Record<string, unknown>).raw_ass as string)
      : "";
  return {
    text,
    font,
    sizePx,
    color,
    align,
    anchorV,
    bold,
    italic,
    underline,
    strike,
    weight,
    spacingPx,
    fadeInMs,
    fadeOutMs,
    entranceMotion,
    outline,
    shadow,
    box,
    hasPos,
    cxPx,
    cyPx,
    wPx: Math.max(1, cw - 2 * safeMarginXPx), // wrap box inset by the horizontal safe margin on BOTH sides
    hPx: ch,
    safeMarginXPx,
    safeMarginYPx,
    hardBreaks: /[\r\n]/.test(text),
    chunks,
    emphasis,
    karaoke,
    karaokeReveal,
    runs,
    rawAss,
    rawStyle: style,
  };
}

/** Resolve the shared look plan from a SECONDS-view timeline. Pure; ordering + duration + transition +
 *  hold mirror render.ts exactly so the exporter can consume this byte-for-byte. */
export function resolveRenderPlan(timeline: Timeline): SecondsRenderPlan {
  const w = Math.trunc(Number(timeline.canvas?.width));
  const h = Math.trunc(Number(timeline.canvas?.height));
  // NOT truncated: the preview inverts durSec -> frames with `Math.round(durSec * fps)`, which only
  // recovers the authored frame count when this is the exact fps the durations were resolved at
  // (buildScene asserts plan.canvas.fps === its own canvas fps). Truncating would drift at 29.97 etc.
  const fps = canvasFps(timeline);

  let durationSec = 0;
  for (const t of timeline.tracks ?? []) {
    for (const c of t.clips ?? []) {
      const to = Number(c.timeline_out);
      if (!Number.isNaN(to)) durationSec = Math.max(durationSec, to);
    }
  }

  // ONE plan feeds BOTH picture and sound, so the admission rule is chosen per clip KIND: gating
  // everything with `visibleTracks` made audio inherit `hidden` and ignore `mute` (S9).
  const gate = outputGate(timeline);

  const clips: PlanClip[] = [];
  for (const track of gate.tracks) {
    const trackZ = Number(track.z) || 0;
    const tclips = track.clips ?? [];
    tclips.forEach((clip, idx) => {
      // A disabled clip keeps its place in the document but reaches neither backend. Filtered here
      // rather than in each backend, so the preview and the export cannot disagree about it.
      if (!clipPlays(clip)) return;
      if (!gate.admits(track, String(clip.kind ?? "video"))) return;
      const inSec = Number(clip.timeline_in) || 0;
      const outSec = Number(clip.timeline_out) || 0;
      clips.push({
        kind: String(clip.kind ?? "video"),
        clipRef: clip,
        trackZ,
        srcTrackId: String(track.id ?? ""),
        srcClipId: clip.id ?? `@${idx}`,
        transition: resolveTransition(clip),
        visibility: { inSec, outSec, holdSec: resolveHoldSec(tclips, idx, outSec) },
        text: clip.kind === "text" ? resolveText(clip, w, h, Math.max(0, outSec - inSec)) : null,
        media: {
          fit: resolveFit(clip.fit),
          blend: resolveBlend(clip.blend),
          crop: resolveCrop(clip.crop),
          flip: resolveFlip(clip.flip),
          color: clip.color,
          effects: (clip as unknown as { effects?: unknown }).effects,
          glow: (clip as unknown as { glow?: unknown }).glow,
          opacity: clip.opacity,
          rotate: clip.rotate,
        },
      });
    });
  }

  return {
    canvas: { w, h, fps },
    durationSec,
    clips,
    unimplementedInExport: UNIMPLEMENTED_IN_EXPORT,
  };
}
