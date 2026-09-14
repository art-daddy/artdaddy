// assCaption.ts — turn the shared plan's resolved captions into a libass (.ass) subtitle file. PURE:
// (caption specs + canvas) -> ASS text; no fs, no ffmpeg. The exporter (render.ts) groups captions
// into z-bands, calls this per band, references the file as `ass=f=cap_bandN.ass:fontsdir=fonts`, and
// the render EXECUTION path writes each file into a per-render temp dir + runs ffmpeg with that dir as
// cwd (bare filenames dodge ffmpeg's filter-option `:` splitter, which a Windows drive colon breaks),
// deleting the dir in a `finally`.
//
// WHY ASS (not drawtext): libass WRAPS text to a box, ALIGNS it, and honours margins — the look the
// plan models and the preview already produces (drawtext draws one un-wrapped centred line). Verified
// empirically through the bundled binary: libass resolves fonts by FAMILY via `fontsdir` (no
// fontconfig), and MarginL/MarginR set the wrap WIDTH independently of `\pos` (which sets position).
//
// SECURITY: a caption's `text` is model/user data. ASS uses `{...}` for override tags and `\` for
// commands, so raw caption text is an override-INJECTION vector (e.g. `{\c&H0000FF&}` recolouring, or
// worse a `\clip`/transform). `assEscape` ESCAPES `{`/`}` to `\{`/`\}` (a literal brace — no override
// block can open) and guards every `\` with a zero-width space, so text can only ever be DRAWN, never
// interpreted — WITHOUT dropping characters. The `rawAss` escape hatch (a clip's explicit `raw_ass`) is
// the ONLY path that passes override tags through, and only because the author opted in.
import type { ResolvedRun } from "./renderPlan";

/** One caption resolved from the plan, plus its on-screen window. `rawAss` (a clip's `raw_ass`), when
 *  non-empty, is the Dialogue text VERBATIM — the author's full-control escape hatch — and every other
 *  field is ignored for that line. Otherwise the line is composed from the styled fields below. */
export interface CaptionSpec {
  readonly text: string;
  readonly rawAss: string;
  readonly font: string; // font family name (libass matches the ttf's internal family via fontsdir)
  readonly sizePx: number;
  readonly color: string; // CSS colour (#rgb / #rrggbb / a few names)
  readonly align: "left" | "center" | "right";
  /** Which edge of the block sits on `cyPx`. "middle" = the \an4-6 row (a second line pushes the
   *  first one up); "top" = \an7-9 (the first line stays put, extra lines grow down). */
  readonly anchorV: "top" | "middle" | "bottom";
  readonly bold: boolean; // ASS Bold field (-1) unless `weight` is set
  readonly italic: boolean; // ASS Italic field (-1)
  readonly underline: boolean; // ASS Underline field (-1)
  readonly strike: boolean; // ASS StrikeOut field (-1)
  readonly weight: number | null; // numeric weight -> ASS Bold field verbatim (overrides `bold`)
  readonly spacingPx: number; // letter spacing -> Style Spacing (0 = none)
  readonly scalePct: number; // glyph scale percent -> \fscx/\fscy (100 = normal; emphasis 'pop')
  readonly fadeInMs: number; // entrance fade ms -> \fad (0 = none)
  readonly fadeOutMs: number; // exit fade ms
  readonly entranceMotion: {
    readonly kind: "pop" | "slide-up" | "slide-left";
    readonly ms: number;
  } | null; // \t / \move
  readonly karaoke: readonly { readonly word: string; readonly durCs: number }[] | null; // \k word-highlight line
  readonly highlightColor: string; // Primary (highlighted) colour a karaoke word turns when reached
  readonly karaokeReveal: boolean; // reveal builds (word-by-word/append/typewriter): unsung words INVISIBLE (vs dim)
  /** A multi-run caption's per-run styled runs (whole-line build): the Dialogue composes each run inline
   *  (font/size/colour/marks/outline diffs from the base style + emphasis) instead of the single `text`.
   *  null = a plain single-run caption. */
  readonly runs: readonly ResolvedRun[] | null;
  /** How a hero run (`emphasis:true`) is marked (animation.emphasis): pop scales, colour/highlight
   *  recolour, box-invert flips to a coloured ring. null = no emphasis treatment. */
  readonly emphasisSpec: {
    readonly kind: "pop" | "color" | "highlight" | "box-invert";
    readonly color: string;
    readonly scalePct: number;
  } | null;
  /** Painted decorations. `box` (an opaque background) and `outline` both use libass OutlineColour under
   *  different BorderStyles, so at most ONE is set (the plan drops outline when a box is present). */
  readonly outline: { readonly widthPx: number; readonly color: string } | null;
  readonly shadow: { readonly depthPx: number; readonly color: string } | null;
  readonly box: {
    readonly color: string;
    readonly opacity: number;
    readonly paddingPx: number;
  } | null;
  readonly cxPx: number; // wrap-box CENTRE x (canvas px)
  readonly cyPx: number; // wrap-box CENTRE y
  readonly wPx: number; // wrap-box width (px) -> the margins that bound libass wrapping
  readonly startSec: number;
  readonly endSec: number;
}

const NAMED_COLOURS: Record<string, string> = {
  white: "ffffff",
  black: "000000",
  red: "ff0000",
  green: "008000",
  lime: "00ff00",
  blue: "0000ff",
  yellow: "ffff00",
  cyan: "00ffff",
  aqua: "00ffff",
  magenta: "ff00ff",
  fuchsia: "ff00ff",
  gray: "808080",
  grey: "808080",
  silver: "c0c0c0",
  orange: "ffa500",
};

/** CSS colour -> an ASS inline fill colour `&HBBGGRR&` (ASS stores blue-green-red, no alpha in `\1c`).
 *  Handles `#rgb`, `#rrggbb`, and the common names; anything unparseable falls back to white so a bad
 *  colour never yields a malformed tag. */
export function assColour(css: string): string {
  let hex = (css || "").trim().toLowerCase();
  if (hex.startsWith("#")) hex = hex.slice(1);
  else if (NAMED_COLOURS[hex]) hex = NAMED_COLOURS[hex];
  if (/^[0-9a-f]{3}$/.test(hex))
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-f]{6}$/.test(hex)) hex = "ffffff";
  const rr = hex.slice(0, 2);
  const gg = hex.slice(2, 4);
  const bb = hex.slice(4, 6);
  return `&H${(bb + gg + rr).toUpperCase()}&`;
}

/** CSS colour (+ optional opacity multiplier) -> a full ASS Style-line colour `&HAABBGGRR` (alpha
 *  INVERTED: 00 = opaque). `#rrggbbaa` carries its own alpha. Unlike `assColour` (a 6-hex inline `\1c`
 *  value), a Style row's PrimaryColour/OutlineColour/BackColour need the 8-hex alpha form. */
export function assColourFull(css: string, opacity = 1): string {
  let hex = (css || "").trim().toLowerCase();
  if (hex.startsWith("#")) hex = hex.slice(1);
  else if (NAMED_COLOURS[hex]) hex = NAMED_COLOURS[hex];
  if (/^[0-9a-f]{3}$/.test(hex))
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  let a = 1;
  if (/^[0-9a-f]{8}$/.test(hex)) {
    a = parseInt(hex.slice(6, 8), 16) / 255;
    hex = hex.slice(0, 6);
  }
  if (!/^[0-9a-f]{6}$/.test(hex)) hex = "ffffff";
  const rr = hex.slice(0, 2);
  const gg = hex.slice(2, 4);
  const bb = hex.slice(4, 6);
  const aa = Math.round((1 - Math.max(0, Math.min(1, a * opacity))) * 255);
  return `&H${aa.toString(16).padStart(2, "0")}${bb}${gg}${rr}`.toUpperCase();
}

/** ASS numeric field: integers verbatim, else trimmed to 3 dp (drops the trailing `.00` a plain
 *  toFixed would leave). */
function assNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/** Port of v1 `_style_line`: a caption's STATIC look -> one `[V4+ Styles]` row BODY (the text after
 *  `Style: <name>,`), so `buildBandAss` can dedupe by body and assign a name. A box paints via
 *  BorderStyle=3 (opaque box, `Outline` = padding, `BackColour` = box fill) which libass can ONLY set in
 *  a style line (never inline); otherwise BorderStyle=1 (outline `Outline`=width + drop `Shadow`). A
 *  numeric `weight` goes to the Bold field verbatim (overrides the bold flag). Secondary starts
 *  transparent — a karaoke line sets its reveal colours inline. Alignment carries the \an anchor. */
function styleRow(c: CaptionSpec): string {
  const an = anForAlign(c.align, c.anchorV);
  const primary = assColourFull(c.color, 1);
  const secondary = assColourFull(c.color, 0);
  let borderStyle: number;
  let outlineW: number;
  let outlineC: string;
  let back: string;
  if (c.box) {
    // BorderStyle=3 opaque box: the BUNDLED libass fills the box with the OUTLINE colour (`\3c`), sized
    // by the Outline field (padding) — verified empirically through the bundled binary (BackColour does
    // NOT paint the box on this build, so v1's _style_line mapping would render nothing here).
    borderStyle = 3;
    outlineW = c.box.paddingPx;
    outlineC = assColourFull(c.box.color, c.box.opacity);
    back = "&H00000000";
  } else {
    borderStyle = 1;
    outlineW = c.outline ? c.outline.widthPx : 0;
    outlineC = c.outline ? assColourFull(c.outline.color, 1) : "&H00000000";
    back = c.shadow ? assColourFull(c.shadow.color, 1) : "&H00000000";
  }
  const shadowDepth = c.shadow ? c.shadow.depthPx : 0;
  const boldField = c.weight != null ? String(c.weight) : c.bold ? "-1" : "0";
  return [
    c.font,
    assNum(c.sizePx),
    primary,
    secondary,
    outlineC,
    back,
    boldField,
    c.italic ? "-1" : "0",
    c.underline ? "-1" : "0",
    c.strike ? "-1" : "0",
    "100",
    "100",
    assNum(c.spacingPx),
    "0",
    String(borderStyle),
    assNum(outlineW),
    assNum(shadowDepth),
    String(an),
    "0",
    "0",
    "0",
    "1",
  ].join(",");
}

/** Seconds -> ASS timestamp `H:MM:SS.cc` (centisecond precision).
 *
 *  TRUNCATES rather than rounds. A centisecond is coarser than a frame at every sane fps, so a
 *  boundary that rounded UP landed after the frame it belongs to: two cards butted at frame 416
 *  (13.8667s) both became 13.87, leaving frame 416 showing the OUTGOING card and the incoming one
 *  a frame late. Truncating can only place a boundary at or before its own frame time, so the
 *  frame belongs to the card that owns it — and both sides move together, so butted cards stay
 *  butted. The cost is at most 10ms, under a third of a frame at 30fps. */
export function assTime(sec: number): string {
  let cs = Math.max(0, Math.floor(sec * 100));
  const h = Math.floor(cs / 360000);
  cs -= h * 360000;
  const m = Math.floor(cs / 6000);
  cs -= m * 6000;
  const s = Math.floor(cs / 100);
  cs -= s * 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Neutralise caption text so libass can only DRAW it — WITHOUT dropping characters (braces and
 *  backslashes are common in captions, e.g. tech-news). `{`/`}` become their escaped literals `\{`/`\}`
 *  (libass renders a literal brace, and no override block can open — the injection defence); every other
 *  backslash is guarded with a zero-width space so it can't form a `\N`/`\n`/`\h`/`\{`/`\}` command out of
 *  the next char (a `C:\new` path renders intact); authored newlines become the ASS hard break `\N`.
 *  Order matters: user backslashes are escaped FIRST, so the `\` this function then adds for `{`/`}`/`\N`
 *  are fresh and not double-escaped. Verified against the bundled libass build. */
/** Regional-indicator letters (U+1F1E6..U+1F1FF), the pair that forms a flag emoji.
 *
 *  No bundled face has a flag glyph and Windows ships none, so libass falls back and draws the
 *  LETTERS the pair is built from: `🇮🇳Fouji🇮🇳` exported as "IN Fouji IN". Every other unsupported
 *  emoji fails visibly, as a missing-glyph box; this one fails as plausible wrong text, which
 *  nobody re-reads their own video to catch. Dropped here — at the one boundary every caption and
 *  text run passes through — so no caller can forget. */
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/gu;

/** The flag characters in `text`, for a warning. Empty when there are none. */
export function unrenderableFlags(text: string): string[] {
  return [...(text || "").matchAll(REGIONAL_INDICATOR)].map((m) => m[0]);
}

export function assEscape(text: string): string {
  return (text || "")
    .replace(REGIONAL_INDICATOR, "") // would otherwise render as its underlying letters
    .replace(/\\/g, "\\\u200B") // literal backslash: ZWSP stops it forming a command from the following char
    .replace(/\{/g, "\\{") // literal '{' — no override block can open (injection defence)
    .replace(/\}/g, "\\}") // literal '}'
    .replace(/\r\n|\r|\n/g, "\\N"); // authored hard break -> ASS line break (added last; not ZWSP-touched)
}

/** \an numbering: the ROW comes from the vertical anchor (top 7-9, middle 4-6, bottom 1-3) and the
 *  COLUMN from the horizontal alignment (left 1, centre 2, right 3). The anchor also justifies each
 *  wrapped line, so this doubles as text alignment. */
function anForAlign(align: CaptionSpec["align"], anchorV: CaptionSpec["anchorV"]): number {
  const col = align === "left" ? 1 : align === "right" ? 3 : 2;
  const row = anchorV === "top" ? 6 : anchorV === "bottom" ? 0 : 3;
  return row + col;
}

/** The `\pos` X for a wrap box CENTRED at `cxPx` with width `wPx`, given the alignment anchor: centre
 *  anchors at the box centre; left/right anchor at the box's left/right EDGE (so `\an4/\an6` justify
 *  within the box rather than sliding it off-centre). */
function posXForAlign(align: CaptionSpec["align"], cxPx: number, wPx: number): number {
  if (align === "left") return Math.round(cxPx - wPx / 2);
  if (align === "right") return Math.round(cxPx + wPx / 2);
  return Math.round(cxPx);
}

/** Port of v1 `_run_override`: the inline tags for one run's style DIFF from the caption base + its
 *  emphasis treatment (no \k / timing here). Any field matching the base emits nothing; a hero run adds
 *  the emphasis look — colour/highlight recolour (\1c), pop scales (\fscx/\fscy), box-invert flips to
 *  black text on an emph-colour ring (\1c black + \3c emph; ASS has no per-run box). */
function runOverride(
  run: ResolvedRun,
  base: CaptionSpec,
  emph: CaptionSpec["emphasisSpec"],
): string {
  const tags: string[] = [];
  if (run.font !== base.font) tags.push(`\\fn${run.font}`);
  if (run.color !== base.color) tags.push(`\\1c${assColour(run.color)}`);
  if (run.sizePx !== base.sizePx) {
    const sc = base.sizePx ? (run.sizePx / base.sizePx) * 100 : 100;
    tags.push(`\\fscx${assNum(sc)}\\fscy${assNum(sc)}`);
  }
  if (run.weight != null && run.weight !== base.weight) tags.push(`\\b${run.weight}`);
  else if (run.bold !== base.bold) tags.push(run.bold ? "\\b1" : "\\b0");
  if (run.italic !== base.italic) tags.push(run.italic ? "\\i1" : "\\i0");
  if (run.underline !== base.underline) tags.push(run.underline ? "\\u1" : "\\u0");
  if (run.strike !== base.strike) tags.push(run.strike ? "\\s1" : "\\s0");
  // Outline diffs matter only without a box (BorderStyle=3 owns the ring at the style level).
  if (!base.box) {
    const rw = run.outline ? run.outline.widthPx : 0;
    const bw = base.outline ? base.outline.widthPx : 0;
    if (rw !== bw) tags.push(`\\bord${assNum(rw)}`);
    const rc = run.outline ? run.outline.color : "";
    const bc = base.outline ? base.outline.color : "";
    if (rc && rc !== bc) tags.push(`\\3c${assColour(rc)}`);
  }
  if (run.emphasis && emph) {
    if (emph.kind === "pop")
      tags.push(`\\fscx${Math.round(emph.scalePct)}\\fscy${Math.round(emph.scalePct)}`);
    else if (emph.kind === "color" || emph.kind === "highlight") {
      if (emph.color) tags.push(`\\1c${assColour(emph.color)}`);
    } else if (emph.kind === "box-invert")
      tags.push(`\\1c${assColour("#000000")}\\3c${assColour(emph.color || "#ffd400")}`);
  }
  return tags.join("");
}

/** One caption's Dialogue line(s). The STATIC look (font/size/colour/bold/italic/underline/strike/
 *  spacing/outline/shadow/box) lives in the referenced named Style; the inline override carries only what
 *  a style can't: position (`\pos`/`\an`), wrap margins, entrance motion (`\move`/`\t`), fade (`\fad`),
 *  emphasis scale, and a karaoke line's per-word reveal colours. Wrap width = PlayResX - MarginL -
 *  MarginR. Returns MANY lines only for a reveal build, which needs one per revealed word. */
function dialogue(c: CaptionSpec, playResX: number, styleName: string): string[] {
  const start = assTime(c.startSec);
  const end = assTime(Math.max(c.startSec, c.endSec));
  if (c.rawAss.trim()) {
    // Author opted into full ASS control: pass the override string through verbatim, still timed.
    return [`Dialogue: 0,${start},${end},${styleName},,0,0,0,,${c.rawAss}`];
  }
  const margin = Math.max(0, Math.round((playResX - c.wPx) / 2));
  const an = anForAlign(c.align, c.anchorV);
  const x = posXForAlign(c.align, c.cxPx, c.wPx);
  const y = Math.round(c.cyPx);
  // Motion entrance: a slide animates position via \move (replacing \pos); a pop grows the glyphs via
  // \t. Both settle at the normal position/scale after `ms`.
  const em = c.entranceMotion;
  let posTag: string;
  if (em && (em.kind === "slide-up" || em.kind === "slide-left")) {
    const dx = em.kind === "slide-left" ? Math.round(c.wPx * 0.25) : 0;
    const dy = em.kind === "slide-up" ? Math.round(c.sizePx * 1.2) : 0;
    posTag = `\\move(${x + dx},${y + dy},${x},${y},0,${Math.round(em.ms)})`;
  } else {
    posTag = `\\pos(${x},${y})`;
  }
  const popTag =
    em && em.kind === "pop"
      ? `\\fscx60\\fscy60\\t(0,${Math.round(em.ms)},\\fscx${Math.round(c.scalePct)}\\fscy${Math.round(c.scalePct)})`
      : "";
  // Emphasis 'pop' scales the glyphs; all the static marks/border/shadow/font/size/colour now live in
  // the STYLE line, so the inline override is position + fade + emphasis/entrance scale only.
  const emphScale =
    c.scalePct !== 100 ? `\\fscx${Math.round(c.scalePct)}\\fscy${Math.round(c.scalePct)}` : "";
  const fad =
    c.fadeInMs || c.fadeOutMs ? `\\fad(${Math.round(c.fadeInMs)},${Math.round(c.fadeOutMs)})` : "";
  if (c.runs && c.runs.length) {
    // Multi-run whole-line: the base look lives in the style; each run adds its inline diff, then {\r}
    // resets to the style. Position/motion/fade lead once. (Per-run styling is export-authoritative; the
    // preview draws the joined base-styled line — a NAMED residual.)
    const parts: string[] = [`{\\an${an}${posTag}${emphScale}${popTag}${fad}}`];
    for (const run of c.runs) {
      const ov = runOverride(run, c, c.emphasisSpec);
      if (ov) parts.push(`{${ov}}`);
      parts.push(assEscape(run.text));
      if (ov) parts.push("{\\r}");
      parts.push(" ");
    }
    return [
      `Dialogue: 0,${start},${end},${styleName},,${margin},${margin},0,,${parts.join("").trimEnd()}`,
    ];
  }
  if (c.karaoke && c.karaoke.length) {
    const words = c.karaoke;
    if (c.karaokeReveal) {
      // A reveal build (word-by-word / append / typewriter) needs each word ABSENT until its moment.
      // `\k` cannot do it: it only swaps the FILL between Secondary and Primary, so an unsung word keeps
      // its outline and shadow and stays plainly readable — the opposite of a reveal, and invisible to
      // any test whose style has neither. So emit one Dialogue per step instead, and hide the not-yet
      // words with `\alpha`, which covers fill + outline + shadow at once. They stay IN the line so the
      // text keeps its final width and does not reflow as it grows.
      const lo = c.startSec;
      const hi = Math.max(c.startSec, c.endSec);
      const clamp = (s: number): number => Math.min(hi, Math.max(lo, s));
      let acc = 0;
      const bounds = words.map((w) => {
        const at = clamp(lo + acc / 100);
        acc += Math.max(0, w.durCs);
        return at;
      });
      const last = words.length - 1;
      const out: string[] = [];
      for (let i = 0; i <= last; i++) {
        const from = bounds[i];
        const to = i === last ? hi : bounds[i + 1];
        if (to <= from) continue; // a zero-length step would render nothing
        // Motion and fade belong to the CAPTION, not to each step: sliding or popping on every word
        // would re-trigger the entrance N times, and a per-step \fad would strobe.
        const first = out.length === 0;
        const stepPos = first ? posTag : `\\pos(${x},${y})`;
        const stepPop = first ? popTag : "";
        const fin = first ? Math.round(c.fadeInMs) : 0;
        const fout = i === last ? Math.round(c.fadeOutMs) : 0;
        const stepFad = fin || fout ? `\\fad(${fin},${fout})` : "";
        const shown = words
          .slice(0, i + 1)
          .map((w) => assEscape(w.word))
          .join(" ");
        const hidden = words
          .slice(i + 1)
          .map((w) => assEscape(w.word))
          .join(" ");
        const tail = hidden ? ` {\\alpha&HFF&}${hidden}` : "";
        const ovr = `{\\an${an}${stepPos}\\1c${assColour(c.highlightColor)}\\1a&H00&${emphScale}${stepPop}${stepFad}}`;
        out.push(
          `Dialogue: 0,${assTime(from)},${assTime(to)},${styleName},,${margin},${margin},0,,${ovr}${shown}${tail}`,
        );
      }
      if (out.length) return out;
      // Every step was zero-length (all durations 0): show the whole line rather than nothing.
      const all = words.map((w) => assEscape(w.word)).join(" ");
      const ovr = `{\\an${an}${posTag}\\1c${assColour(c.highlightColor)}\\1a&H00&${emphScale}${popTag}${fad}}`;
      return [`Dialogue: 0,${start},${end},${styleName},,${margin},${margin},0,,${ovr}${all}`];
    }
    // Word-highlight karaoke: each word starts DIM (Secondary = base colour @50% alpha) and turns full
    // highlight (Primary = highlightColor) as the \k sweep reaches it (durations in centiseconds). The
    // reveal colours are inline (they differ from the style's static Primary); the style supplies
    // font/size/border/shadow.
    const sweep = words.map((k) => `{\\k${Math.round(k.durCs)}}${assEscape(k.word)}`).join(" ");
    const ovr = `{\\an${an}${posTag}\\1c${assColour(c.highlightColor)}\\1a&H00&\\2c${assColour(c.color)}\\2a&H80&${emphScale}${popTag}${fad}}`;
    return [`Dialogue: 0,${start},${end},${styleName},,${margin},${margin},0,,${ovr}${sweep}`];
  }
  const override = `{\\an${an}${posTag}${emphScale}${popTag}${fad}}`;
  return [
    `Dialogue: 0,${start},${end},${styleName},,${margin},${margin},0,,${override}${assEscape(c.text)}`,
  ];
}

/** Build ONE z-band's `.ass` file: a header + one `[V4+ Styles]` Style per DISTINCT caption look
 *  (deduped) + a Dialogue per caption referencing its style. `fontsdir` + the font FAMILY (not a file
 *  path) resolve the glyphs at render time; PlayResX/Y = the canvas so `\pos`, margins, outline and
 *  shadow are all in canvas pixels. WrapStyle 0 = balanced wrapping; ScaledBorderAndShadow keeps borders
 *  sized in PlayRes px across output resolutions. */
export function buildBandAss(
  captions: readonly CaptionSpec[],
  canvas: { w: number; h: number },
): string {
  // One Style per distinct look: BorderStyle (box=3 vs outline=1) is a style-line-only field, and a
  // proper base style is what per-run overrides diff against (C2). Dedupe by row body so a band of
  // same-look captions emits a single style.
  const styleNames = new Map<string, string>();
  const styleLines: string[] = [];
  const nameFor = (c: CaptionSpec): string => {
    const body = styleRow(c);
    let name = styleNames.get(body);
    if (name === undefined) {
      name = `S${styleNames.size}`;
      styleNames.set(body, name);
      styleLines.push(`Style: ${name},${body}`);
    }
    return name;
  };
  // Build the dialogues FIRST (populates styleLines via nameFor), then assemble the document.
  const dialogues = captions.flatMap((c) => dialogue(c, canvas.w, nameFor(c)));
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.w}`,
    `PlayResY: ${canvas.h}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogues,
  ];
  return lines.join("\n") + "\n";
}
