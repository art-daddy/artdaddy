// Read the few tables of a TrueType/OpenType font that text layout needs. Pure: bytes in, numbers out.
// Used to GENERATE fontMetrics.data.ts and to check that file against the fonts the app ships; the app
// itself never parses a font at run time.

export interface ParsedFont {
  /** The family a renderer resolves the face by (typographic family, name ID 16, else ID 1). */
  readonly family: string;
  readonly upm: number;
  /** OS/2 usWinAscent / usWinDescent: libass sizes a face so these two add up to the ASS Fontsize. */
  readonly winAscent: number;
  readonly winDescent: number;
  /** Advance width in font units for every Basic Multilingual Plane character the font maps. */
  readonly advances: ReadonlyMap<number, number>;
}

export function parseFont(bytes: Uint8Array): ParsedFont {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  const numTables = dv.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    let tag = "";
    for (let k = 0; k < 4; k++) tag += String.fromCharCode(dv.getUint8(o + k));
    tables.set(tag, dv.getUint32(o + 8));
  }
  const at = (tag: string): number => {
    const o = tables.get(tag);
    if (o === undefined) throw new Error(`font has no '${tag}' table`);
    return o;
  };

  const upm = dv.getUint16(at("head") + 18);
  const numberOfHMetrics = dv.getUint16(at("hhea") + 34);
  const hmtx = at("hmtx");
  const advanceOf = (gid: number): number =>
    dv.getUint16(hmtx + 4 * Math.min(gid, numberOfHMetrics - 1));
  const os2 = at("OS/2");

  const advances = new Map<number, number>();
  for (const [cp, gid] of cmapOf(dv, at("cmap")))
    if (cp <= 0xffff && gid !== 0) advances.set(cp, advanceOf(gid));

  return {
    family: familyOf(dv, at("name")),
    upm,
    winAscent: dv.getUint16(os2 + 74),
    winDescent: dv.getUint16(os2 + 76),
    advances,
  };
}

/** Code point -> glyph id, from the best Unicode subtable: format 12 (full repertoire) when the font
 *  has one, else format 4 (BMP). */
function cmapOf(dv: DataView, cmap: number): Map<number, number> {
  const n = dv.getUint16(cmap + 2);
  let best: { off: number; format: number } | null = null;
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = dv.getUint16(rec);
    const encoding = dv.getUint16(rec + 2);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const off = cmap + dv.getUint32(rec + 4);
    const format = dv.getUint16(off);
    if (format === 12 && best?.format !== 12) best = { off, format };
    else if (format === 4 && !best) best = { off, format };
  }
  if (!best) throw new Error("font has no Unicode cmap (format 4 or 12)");
  const map = new Map<number, number>();
  const { off } = best;
  if (best.format === 12) {
    const groups = dv.getUint32(off + 12);
    for (let g = 0; g < groups; g++) {
      const o = off + 16 + g * 12;
      const start = dv.getUint32(o);
      const end = dv.getUint32(o + 4);
      const glyph = dv.getUint32(o + 8);
      for (let cp = start; cp <= end && cp <= 0xffff; cp++) map.set(cp, glyph + (cp - start));
    }
    return map;
  }
  const segX2 = dv.getUint16(off + 6);
  const ends = off + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = dv.getUint16(ends + 2 * s);
    const start = dv.getUint16(starts + 2 * s);
    const delta = dv.getInt16(deltas + 2 * s);
    const ro = dv.getUint16(rangeOffsets + 2 * s);
    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let gid: number;
      if (ro === 0) gid = (cp + delta) & 0xffff;
      else {
        const g = dv.getUint16(rangeOffsets + 2 * s + ro + 2 * (cp - start));
        gid = g === 0 ? 0 : (g + delta) & 0xffff;
      }
      if (gid) map.set(cp, gid);
    }
  }
  return map;
}

/** The family name renderers match: Windows-platform English typographic family (16), else family (1). */
function familyOf(dv: DataView, name: number): string {
  const count = dv.getUint16(name + 2);
  const strings = name + dv.getUint16(name + 4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = name + 6 + i * 12;
    const platform = dv.getUint16(r);
    const language = dv.getUint16(r + 4);
    const id = dv.getUint16(r + 6);
    if (platform !== 3 || language !== 0x409 || (id !== 1 && id !== 16)) continue;
    const len = dv.getUint16(r + 8);
    const at = strings + dv.getUint16(r + 10);
    let s = "";
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(at + k));
    found.set(id, s);
  }
  const family = found.get(16) ?? found.get(1);
  if (!family) throw new Error("font has no Windows English family name");
  return family;
}
