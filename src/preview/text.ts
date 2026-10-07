// Rasterize a text layer to an ImageBitmap for the WebGL compositor, with simple
// word-wrap + vertical centering. Uses OffscreenCanvas 2D (works on the main
// thread and inside the preview worker). Browser-only (OffscreenCanvas is absent
// in the unit-test DOM) so it's excluded from coverage; textKey is pure.
import type { TextLayer } from "./scene";

/** Stable cache key for a rasterized text layer (text + style + box size). */
export function textKey(t: TextLayer): string {
  const marks = `${t.bold ? "b" : ""}${t.italic ? "i" : ""}${t.underline ? "u" : ""}${t.strike ? "s" : ""}${t.weight ?? ""}`;
  const kara = t.karaoke ? `k${t.karaoke.sungChars}` : "";
  return `text:${t.text}|${t.fontPx}|${t.color}|${t.align}|${t.anchorV}|${t.font}|${marks}|${kara}|${t.letterSpacingPx}|${Math.round(t.box.w)}x${Math.round(t.box.h)}`;
}

/** Top of the text BLOCK inside its box, for a vertical anchor. Mirrors the ASS \an row the
 *  exporter emits: middle centres the block on the box centre, top starts it there and grows
 *  downward, bottom ends it there. */
export function blockTop(anchorV: TextLayer["anchorV"], boxH: number, blockH: number): number {
  if (anchorV === "top") return boxH / 2;
  if (anchorV === "bottom") return boxH / 2 - blockH;
  return (boxH - blockH) / 2;
}

const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;

/** Which way a paragraph reads: its first strong letter decides, as libass decides it in the export
 *  (Encoding -1). Digits, punctuation and marks have no direction of their own and are skipped. */
export function lineDirection(text: string): "ltr" | "rtl" {
  for (const ch of text) if (/\p{L}/u.test(ch)) return RTL_LETTER.test(ch) ? "rtl" : "ltr";
  return "ltr";
}

export function rasterizeText(t: TextLayer): ImageBitmap | null {
  const w = Math.max(1, Math.round(t.box.w));
  const h = Math.max(1, Math.round(t.box.h));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  // Weight + slant go in the shorthand `font`; a numeric weight is honoured verbatim, else bold/normal.
  // libass synthesises faux-bold/italic from the single-weight families, and the browser does the same,
  // so the exporter and preview stay visually paired.
  const weightStr = t.weight != null ? `${t.weight} ` : t.bold ? "bold " : "";
  ctx.font = `${t.italic ? "italic " : ""}${weightStr}${t.fontPx}px ${t.font}`;
  // letterSpacing must be set BEFORE measureText/wrap so the width accounts for it (Chromium-only; the
  // Tauri webview + the worker both have it). Guard for the older lib typing.
  if ("letterSpacing" in ctx)
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${t.letterSpacingPx}px`;
  ctx.textBaseline = "middle";
  ctx.textAlign = t.align;
  const lines = wrapLines(ctx, t.text, w);
  const lineH = t.fontPx * 1.25;
  const blockH = lines.length * lineH;
  const top = blockTop(t.anchorV, h, blockH);
  const x = t.align === "left" ? 0 : t.align === "right" ? w : w / 2;
  // Background box behind the whole block (mirrors the exporter's BorderStyle=3 fill + padding).
  if (t.bgBox) {
    const blockW = lines.reduce((m, ln) => Math.max(m, ctx.measureText(ln.text).width), 0);
    const bx = t.align === "left" ? 0 : t.align === "right" ? w - blockW : (w - blockW) / 2;
    const pad = t.bgBox.paddingPx;
    ctx.save();
    ctx.globalAlpha = t.bgBox.opacity;
    ctx.fillStyle = t.bgBox.color;
    ctx.fillRect(bx - pad, top - pad, blockW + 2 * pad, blockH + 2 * pad);
    ctx.restore();
  }
  ctx.fillStyle = t.color;
  let y = top + lineH / 2;
  let karaokeOffset = 0; // running char index at each line's start (for the karaoke sweep)
  for (const { text: ln, dir } of lines) {
    // Set before drawing: an Arabic line's closing punctuation belongs at its LEFT end.
    ctx.direction = dir;
    // Shadow sits behind the glyph. The outline (if any) is drawn UNDER the fill and casts the shadow;
    // the fill then goes on top without re-casting it (mirrors ASS: border, then primary fill).
    if (t.shadow) {
      ctx.shadowColor = t.shadow.color;
      ctx.shadowOffsetX = t.shadow.depthPx;
      ctx.shadowOffsetY = t.shadow.depthPx;
      ctx.shadowBlur = 0;
    }
    if (t.outline) {
      ctx.lineWidth = t.outline.widthPx * 2; // ASS \bord is a radius; Canvas lineWidth is the full stroke
      ctx.strokeStyle = t.outline.color;
      ctx.strokeText(ln, x, y);
      ctx.shadowColor = "transparent"; // don't let the fill re-cast the shadow over the outline
    }
    if (t.karaoke) {
      drawKaraokeLine(ctx, ln, x, y, t, karaokeOffset, dir);
      karaokeOffset += ln.length + 1; // +1 for the wrap-collapsed inter-line space
      ctx.fillStyle = t.color;
    } else {
      ctx.fillText(ln, x, y);
    }
    ctx.shadowColor = "transparent"; // reset before the next line
    // Underline / strike: Canvas2D has no glyph decoration, so draw the rules ourselves (mirrors the
    // ASS Underline/StrikeOut style fields). Baseline is "middle", so strike sits at y and underline
    // just below the glyph bottom.
    if (t.underline || t.strike) {
      const lw = ctx.measureText(ln).width;
      const lx = t.align === "left" ? x : t.align === "right" ? x - lw : x - lw / 2;
      ctx.strokeStyle = t.color;
      ctx.lineWidth = Math.max(1, t.fontPx * 0.06);
      if (t.underline) {
        ctx.beginPath();
        ctx.moveTo(lx, y + t.fontPx * 0.38);
        ctx.lineTo(lx + lw, y + t.fontPx * 0.38);
        ctx.stroke();
      }
      if (t.strike) {
        ctx.beginPath();
        ctx.moveTo(lx, y);
        ctx.lineTo(lx + lw, y);
        ctx.stroke();
      }
    }
    y += lineH;
  }
  return cv.transferToImageBitmap();
}

/** Draw one wrapped line's karaoke sweep: the chars sung so far (global `sungChars` minus this line's
 *  `offset`) in the primary colour (`t.color`), the remainder in `secondaryColor` (skipped when
 *  "transparent" — a reveal build). The sung part starts where the line starts reading: its left edge,
 *  or its right edge in a right-to-left line. Exact for the common single line. */
function drawKaraokeLine(
  ctx: OffscreenCanvasRenderingContext2D,
  line: string,
  cx: number,
  y: number,
  t: TextLayer,
  offset: number,
  dir: "ltr" | "rtl",
): void {
  const k = t.karaoke!;
  const sungLocal = Math.max(0, Math.min(line.length, k.sungChars - offset));
  const sung = line.slice(0, sungLocal);
  const unsung = line.slice(sungLocal);
  const totalW = ctx.measureText(line).width;
  const left = t.align === "left" ? cx : t.align === "right" ? cx - totalW : cx - totalW / 2;
  const start = dir === "rtl" ? left + totalW : left;
  const along = dir === "rtl" ? -1 : 1;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = dir === "rtl" ? "right" : "left";
  ctx.fillStyle = t.color; // sung (primary)
  ctx.fillText(sung, start, y);
  if (k.secondaryColor !== "transparent") {
    ctx.fillStyle = k.secondaryColor; // unsung (secondary)
    ctx.fillText(unsung, start + along * ctx.measureText(sung).width, y);
  }
  ctx.textAlign = prevAlign;
}

/** Lines to draw, each with its paragraph's direction (a paragraph is one authored line). */
function wrapLines(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  maxW: number,
): Array<{ text: string; dir: "ltr" | "rtl" }> {
  const lines: Array<{ text: string; dir: "ltr" | "rtl" }> = [];
  for (const para of text.split("\n")) {
    const dir = lineDirection(para);
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) {
        lines.push({ text: line, dir });
        line = word;
      } else {
        line = test;
      }
    }
    lines.push({ text: line, dir });
  }
  return lines;
}
