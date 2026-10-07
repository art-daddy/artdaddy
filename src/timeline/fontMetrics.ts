// How text in the app's fonts measures, and how the export must size it. Pure; reads the metrics of the
// fonts the app ships (fontMetrics.data.ts, generated from the font files).
//
// Two renderers draw every text clip, and they disagreed about what a font size IS. The preview (a
// canvas, as in CSS) makes it the em. libass, which burns text into the export, follows VSFilter and
// makes it the drawing face's Windows ascent + descent: 1.76 em in Poppins, so the same size drew text
// 57% as big in the export as in the preview (57% to 77% across the bundled fonts, UJ-032). A size is
// the em here, as in every editor, and the export converts it with `exportCell`.
import { BUNDLED_FACES } from "./fontMetrics.data";

export interface FaceData {
  readonly file: string;
  readonly upm: number;
  readonly winAscent: number;
  readonly winDescent: number;
  /** Runs of consecutive code points and their advance widths, in font units. */
  readonly ranges: ReadonlyArray<readonly [number, readonly number[]]>;
}

interface Face {
  readonly upm: number;
  /** (winAscent + winDescent) / upm: what libass multiplies an em by to get its font size. */
  readonly cell: number;
  readonly advance: ReadonlyMap<number, number>;
}

const faces = new Map<string, Face | null>();
function face(family: string): Face | null {
  if (!faces.has(family)) {
    const d = BUNDLED_FACES[family];
    const advance = new Map<number, number>();
    if (d) for (const [start, advs] of d.ranges) advs.forEach((a, i) => advance.set(start + i, a));
    faces.set(
      family,
      d ? { upm: d.upm, cell: (d.winAscent + d.winDescent) / d.upm, advance } : null,
    );
  }
  return faces.get(family) ?? null;
}

/** For a character no bundled font draws: the face libass falls back to on Windows (read from its own
 *  font-selection log, 2026-10-07) and that script's average advance in em, measured in both engines
 *  (the webview and the bundled libass, the wider kept). Chinese went to Yu Gothic UI (1.287) or
 *  Microsoft JhengHei UI (1.330) depending on the characters; Japanese to Yu Gothic UI. */
const FALLBACKS: ReadonlyArray<{
  readonly script: RegExp;
  readonly cell: number;
  readonly em: number;
}> = [
  {
    script:
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\u30a0-\u30ff\uff00-\uffef]/u,
    cell: 1.3,
    em: 1,
  },
  { script: /\p{Script=Hangul}/u, cell: 1.33, em: 0.9 }, // Malgun Gothic
  { script: /\p{Script=Arabic}/u, cell: 1.117, em: 0.34 }, // Arial
  { script: /\p{Script=Hebrew}/u, cell: 1.117, em: 0.42 }, // Arial
  { script: /[\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Latin}]/u, cell: 1.117, em: 0.51 }, // Arial
  { script: /\p{Script=Thai}/u, cell: 1.33, em: 0.58 }, // Leelawadee UI
];
/** Devanagari (in a font other than Poppins), the other Indic scripts and anything else: Nirmala UI. */
const OTHER_FALLBACK = { cell: 1.33, em: 0.63 } as const;
/** Marks drawn on another character take no room of their own; spacing marks (most Indic vowel signs)
 *  do. */
const MARK = /[\p{Mn}\p{Me}]/u;
const LETTER = /[\p{L}\p{N}]/u;

function fallbackFor(ch: string): { readonly cell: number; readonly em: number } {
  for (const f of FALLBACKS) if (f.script.test(ch)) return f;
  return OTHER_FALLBACK;
}

/** Width of `text` drawn on one line at an em of `sizePx`: each character's advance from the font
 *  itself, or for one the font lacks, that script's average in the face that fills in (one em for
 *  Chinese and Japanese, nothing for a mark drawn on another character). Kerning is ignored, which can
 *  only over-state a line slightly. */
export function lineWidthPx(text: string, family: string, sizePx: number, spacingPx = 0): number {
  const f = face(family);
  let em = 0;
  let chars = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") continue;
    chars++;
    const adv = f?.advance.get(ch.codePointAt(0)!);
    if (adv !== undefined) em += adv / f!.upm;
    else if (!MARK.test(ch)) em += fallbackFor(ch).em;
  }
  return em * sizePx + chars * spacingPx;
}

/** What libass's font size must be per em to draw `text` at the preview's size: the cell of the face
 *  that draws most of its letters (the bundled font, or the fallback for a script it lacks). One size
 *  covers a whole line, so a minority script on a mixed line is off by the ratio of the two faces. */
export function exportCell(text: string, family: string): number {
  const f = face(family);
  const letters = new Map<number, number>();
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    const cell = f?.advance.has(ch.codePointAt(0)!) ? f.cell : fallbackFor(ch).cell;
    letters.set(cell, (letters.get(cell) ?? 0) + 1);
  }
  let best = f?.cell ?? 1;
  let most = 0;
  for (const [cell, n] of letters)
    if (n > most || (n === most && cell === f?.cell)) {
      best = cell;
      most = n;
    }
  return best;
}
