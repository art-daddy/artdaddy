// The coordinate grid an inspect frame carries, so the agent can name a position ("the title sits
// at y 0.82") instead of guessing one. It is Palmier's grid exactly (InspectFrameOverlay.swift, owner
// decision 2026-10-03): lines every 0.05, stronger at 0 / 0.5 / 1, each a dark stroke under a light
// one, and labels every 0.1 along the bottom and right edges on dark chips. Drawn by libass, the
// renderer every caption already depends on, so a platform that can export captions can draw this.
// The one deliberate difference is the face: Poppins (bundled) where Palmier uses Helvetica Bold.

/** What the result says about the grid, in Palmier's words. */
export const GRID_NOTE = "0-1, origin top-left";

/** Bump when the overlay's look changes, so a cached frame drawn with the old one is not reused. */
export const OVERLAY_REV = 1;

/** The bundled font file the overlay's text needs staged next to it. */
export const OVERLAY_FONT_FILE = "Poppins-Regular.ttf";
const FACE = "Poppins";

/** ASS colour (BGR) + alpha, where ASS alpha is TRANSPARENCY: 0 = opaque. */
const ink = (gray: 0 | 1, alpha: number): string => {
  const c = gray ? "FFFFFF" : "000000";
  const a = Math.round((1 - alpha) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
  return `\\1c&H${c}&\\1a&H${a}&`;
};

/** Drawing units: \p3 divides coordinates by 4, so a 2.5 px stroke is exact in integers. */
const Q = 4;
const q = (px: number): number => Math.round(px * Q);

/** One stroke style's lines as ONE drawing, so crossings are filled once (like a stroked path)
 *  instead of doubling their alpha where two lines meet. */
function strokes(w: number, h: number, ticks: number[], width: number, colour: string): string {
  const half = width / 2;
  const rects: string[] = [];
  for (const t of ticks) {
    const x = Math.min(Math.max(0.5, t * w), w - 0.5);
    rects.push(
      `m ${q(x - half)} 0 l ${q(x + half)} 0 ${q(x + half)} ${q(h)} ${q(x - half)} ${q(h)}`,
    );
    const y = Math.min(Math.max(0.5, t * h), h - 0.5);
    rects.push(
      `m 0 ${q(y - half)} l ${q(w)} ${q(y - half)} ${q(w)} ${q(y + half)} 0 ${q(y + half)}`,
    );
  }
  return `{\\an7\\pos(0,0)\\bord0\\shad0${colour}\\p3}${rects.join(" ")}{\\p0}`;
}

/** Palmier's label text: "0" and "1" bare, the rest to one decimal (i / 10 prints that way). */
const tickLabel = (t: number): string => String(t);

/** A whole .ass file that draws the grid (and an optional top-left caption chip, e.g. "f120")
 *  over a `w` x `h` image. The image is a single frame at t=0, so every event spans an hour. */
export function gridAss(w: number, h: number, caption?: string): string {
  const fs = Math.min(11, Math.max(8, Math.min(w, h) / 42));
  const twentieths = Array.from({ length: 21 }, (_, i) => i / 20);
  const minor = twentieths.filter((_, i) => i % 10 !== 0);
  const major = twentieths.filter((_, i) => i % 10 === 0);
  const ev = (layer: number, style: string, text: string): string =>
    `Dialogue: ${layer},0:00:00.00,1:00:00.00,${style},,0,0,0,,${text}`;
  const events = [
    ev(0, "Line", strokes(w, h, minor, 2, ink(0, 0.55))),
    ev(1, "Line", strokes(w, h, minor, 1, ink(1, 0.75))),
    ev(2, "Line", strokes(w, h, major, 2.5, ink(0, 0.65))),
    ev(3, "Line", strokes(w, h, major, 1.5, ink(1, 0.95))),
  ];
  // Labels every 0.1: along the bottom (all but 1, whose corner the right edge already names) and
  // down the right edge. Edge labels are anchored so they stay inside the frame, as Palmier clamps.
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const label = tickLabel(t);
    if (i < 10) {
      const an = i === 0 ? 1 : 2;
      const x = i === 0 ? 4 : t * w;
      events.push(ev(4, "Chip", `{\\an${an}\\pos(${x.toFixed(1)},${(h - 4).toFixed(1)})}${label}`));
    }
    const an = i === 0 ? 9 : i === 10 ? 3 : 6;
    const y = i === 0 ? 4 : i === 10 ? h - 4 : t * h;
    events.push(ev(4, "Chip", `{\\an${an}\\pos(${(w - 4).toFixed(1)},${y.toFixed(1)})}${label}`));
  }
  if (caption) events.push(ev(5, "Caption", `{\\an7\\pos(5,3)}${escapeAss(caption)}`));
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Line,${FACE},${fs.toFixed(1)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    // BorderStyle 3 = an opaque box behind the text: Palmier's chip, black at 65%.
    `Style: Chip,${FACE},${fs.toFixed(1)},&H00FFFFFF,&H00FFFFFF,&H59000000,&H59000000,-1,0,0,0,100,100,0,0,3,2,0,5,0,0,0,1`,
    `Style: Caption,${FACE},12,&H00FFFFFF,&H00FFFFFF,&H59000000,&H59000000,-1,0,0,0,100,100,0,0,3,3,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** A caption is ours (a frame number, a time), but never let a brace or backslash become a tag. */
function escapeAss(s: string): string {
  return s.replace(/[{}\\]/g, "");
}

/** The size ffmpeg gives `scale=edge:edge:force_original_aspect_ratio=decrease` for a w x h input
 *  (libavfilter scale_eval: av_rescale rounds to nearest), so the grid is drawn for the exact
 *  pixels it lands on rather than scaled onto them. */
export function fitDims(w: number, h: number, edge: number): { w: number; h: number } {
  const tmpW = Math.round((edge * w) / h);
  const tmpH = Math.round((edge * h) / w);
  return { w: Math.min(tmpW, edge), h: Math.min(tmpH, edge) };
}

/** The ffmpeg filter that draws the grid file `assName` over the frame it is given (sized with
 *  {@link fitDims} beforehand). The file is staged next to the run by withAssScratch. */
export function gridFilter(assName: string): string {
  return `ass=f=${assName}:fontsdir=fonts`;
}
