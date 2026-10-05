// The HEIF facts ffmpeg does not report: which image item is the file's primary picture (`pitm`),
// which auxiliary images are its ALPHA plane (an `auxl` reference to it plus an alpha `auxC` type),
// and each item's transformative properties (`irot`, `imir`).
//
// ffmpeg exposes every image item as a stream whose id is the item id, and marks the primary with
// the `default` disposition; that much is enough to pick the picture. But an alpha plane looks
// exactly like a thumbnail, a depth map or an HDR gain map to it: no disposition, and a title that is
// whatever the writer named the item. Taking a grey non-default stream for alpha would punch holes in
// every portrait-mode iPhone photo (its depth and matte images are exactly that). Reading the boxes is
// the only way to tell them apart.
//
// Pure, and total: any input, however truncated or hostile, yields a layout or null and never
// throws. Null means "unknown", and the caller then decodes the primary without an alpha plane.
// It is given the file's HEAD, so the top level is read up to the first box the head cuts off; inside
// meta, a box that does not fit its parent means the file is malformed. ISO/IEC 23008-12 (HEIF) boxes
// read: meta{pitm, iref, iprp{ipco, ipma}}, and the properties auxC, irot, imir.

/** Auxiliary types that mean "this image is the alpha plane": MIAF/AVIF's, and HEVC's (auxid 1). */
export const ALPHA_AUX_TYPES: ReadonlySet<string> = new Set([
  "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha",
  "urn:mpeg:hevc:2015:auxid:1",
]);

export interface HeifLayout {
  /** Item id of the primary picture. */
  primary: number;
  /** Item ids of the primary's alpha planes, in reference order (the first is the one to use). */
  alpha: number[];
  /** Each item's transformative properties in association order: "r<0-3>" = irot (quarter turns
   *  anticlockwise), "m<0|1>" = imir axis. Items with none are absent. */
  transforms: ReadonlyMap<number, readonly string[]>;
}

interface Box {
  type: string;
  /** First byte of the payload (after the size/type header). */
  body: number;
  /** One past the last byte of the box. */
  end: number;
}

/** Thrown inside the parser for anything malformed; readHeifLayout turns it into null. */
class Malformed extends Error {}

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number): number =>
  b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

/** The box starting at `at`, or null when it does not fit in [at, end). `toEnd` is what a size of 0
 *  ("runs to the end of the enclosing space") means here: null when that end is unknowable. */
function boxAt(b: Uint8Array, at: number, end: number, toEnd: boolean): Box | null {
  if (at + 8 > end) return null;
  let size = u32(b, at);
  let header = 8;
  if (size === 1) {
    if (at + 16 > end) return null;
    if (u32(b, at + 8) !== 0) return null; // past 4 GiB: not something a header read can hold
    size = u32(b, at + 12);
    header = 16;
  } else if (size === 0) {
    if (!toEnd) return null;
    size = end - at;
  }
  if (size < header || at + size > end) return null;
  const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
  return { type, body: at + header, end: at + size };
}

/** The boxes filling [start, end) exactly; anything that does not fit is a malformed file. */
function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at < end;) {
    const box = boxAt(b, at, end, true);
    if (!box) throw new Malformed();
    out.push(box);
    at = box.end;
  }
  return out;
}

/** The file's top-level boxes, up to the first one the head cuts off. A size-0 box runs to the end
 *  of the FILE, which a head cannot see, so it ends the walk too. */
function topLevel(b: Uint8Array): Box[] {
  const out: Box[] = [];
  for (let at = 0; ;) {
    const box = boxAt(b, at, b.length, false);
    if (!box) return out;
    out.push(box);
    at = box.end;
  }
}

/** A cursor over one box's payload that refuses to read past it. */
class Reader {
  constructor(
    private readonly b: Uint8Array,
    public at: number,
    private readonly end: number,
  ) {}
  private take(n: number): number {
    if (this.at + n > this.end) throw new Malformed();
    const at = this.at;
    this.at += n;
    return at;
  }
  u8(): number {
    return this.b[this.take(1)];
  }
  u16(): number {
    return u16(this.b, this.take(2));
  }
  u32(): number {
    return u32(this.b, this.take(4));
  }
  /** An item id: 16 bits, or 32 when the box's version says so. */
  id(wide: boolean): number {
    return wide ? this.u32() : this.u16();
  }
  /** A NUL-terminated string (latin1 is enough for the URNs compared against). */
  cstring(): string {
    let s = "";
    for (let c = this.u8(); c !== 0; c = this.u8()) s += String.fromCharCode(c);
    return s;
  }
}

/** Version and flags of a FullBox, and a reader positioned after them. */
function fullBox(b: Uint8Array, box: Box): { version: number; flags: number; r: Reader } {
  const r = new Reader(b, box.body, box.end);
  const version = r.u8();
  const flags = (r.u8() << 16) | (r.u8() << 8) | r.u8();
  return { version, flags, r };
}

/** The layout of a HEIF file from its leading bytes (which must contain the whole `meta` box), or
 *  null when there is no readable HEIF meta in them. */
export function readHeifLayout(bytes: Uint8Array): HeifLayout | null {
  try {
    return parse(bytes);
  } catch {
    return null; // malformed: unknown, never a crash
  }
}

function parse(b: Uint8Array): HeifLayout | null {
  const meta = topLevel(b).find((x) => x.type === "meta");
  if (!meta) return null; // not HEIF, or its meta is not in the head
  const kids = children(b, fullBox(b, meta).r.at, meta.end);
  const pitmBox = kids.find((k) => k.type === "pitm");
  if (!pitmBox) return null;
  const pitm = fullBox(b, pitmBox);
  const primary = pitm.r.id(pitm.version !== 0);

  // iref: auxl references, from an auxiliary image to the image(s) it serves.
  const auxlOf = new Map<number, number[]>();
  for (const irefBox of kids.filter((k) => k.type === "iref")) {
    const iref = fullBox(b, irefBox);
    for (const ref of children(b, iref.r.at, irefBox.end)) {
      const r = new Reader(b, ref.body, ref.end);
      const from = r.id(iref.version !== 0);
      const n = r.u16();
      const to: number[] = [];
      for (let i = 0; i < n; i++) to.push(r.id(iref.version !== 0));
      if (ref.type === "auxl") auxlOf.set(from, [...(auxlOf.get(from) ?? []), ...to]);
    }
  }

  // iprp: the property boxes (ipco, 1-based) and which item has which (ipma).
  const auxType = new Map<number, string>();
  const transforms = new Map<number, string[]>();
  for (const iprp of kids.filter((k) => k.type === "iprp")) {
    const parts = children(b, iprp.body, iprp.end);
    const ipco = parts.find((p) => p.type === "ipco");
    const props = ipco ? children(b, ipco.body, ipco.end) : [];
    for (const ipmaBox of parts.filter((p) => p.type === "ipma")) {
      const ipma = fullBox(b, ipmaBox);
      const entries = ipma.r.u32();
      for (let e = 0; e < entries; e++) {
        const item = ipma.r.id(ipma.version >= 1);
        const count = ipma.r.u8();
        for (let a = 0; a < count; a++) {
          const index = ipma.flags & 1 ? ipma.r.u16() & 0x7fff : ipma.r.u8() & 0x7f;
          const prop = props[index - 1]; // index 0 means "no property"
          if (prop?.type === "auxC") auxType.set(item, fullBox(b, prop).r.cstring());
          const turn = prop?.type === "irot" ? "r" : prop?.type === "imir" ? "m" : null;
          if (turn) {
            const v = new Reader(b, prop!.body, prop!.end).u8() & (turn === "r" ? 3 : 1);
            transforms.set(item, [...(transforms.get(item) ?? []), `${turn}${v}`]);
          }
        }
      }
    }
  }

  // An image cannot be its own alpha plane; a file that says so is malformed, and merging the
  // picture into itself would make it transparent where it is dark.
  const alpha = [...auxlOf.entries()]
    .filter(([item, to]) => {
      const type = auxType.get(item);
      return (
        item !== primary && to.includes(primary) && type !== undefined && ALPHA_AUX_TYPES.has(type)
      );
    })
    .map(([item]) => item);
  return { primary, alpha, transforms };
}
