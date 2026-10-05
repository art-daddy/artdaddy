// HEIF files for tests, written byte by byte: image ITEMS (meta/iloc), not the HEVC video track that
// `ffmpeg -f mp4` writes and names .heic. The shipped ffmpeg cannot write a HEIF image item or a tile
// grid, and the public samples are not licensed for redistribution, so without this the structure
// every iPhone photo has (a cropped tile grid, often rotated, with a thumbnail and auxiliary images
// beside it) had no test anywhere.
//
// Pure: payload bytes are supplied by the caller (heifFixtures.ts codes real HEVC for the e2e lane;
// a parser test can pass any bytes). ISO/IEC 23008-12 boxes: ftyp, meta{hdlr, pitm, iloc, iinf/infe,
// iref{dimg|thmb|auxl|cdsc}, iprp{ipco{hvcC, ispe, irot, imir, auxC}, ipma}}, mdat; `grid` item
// payloads per section 6.6.2.3.

const u8 = (n: number): Buffer => Buffer.from([n & 255]);
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
export const box = (type: string, ...payload: Buffer[]): Buffer => {
  const p = Buffer.concat(payload);
  return Buffer.concat([u32(8 + p.length), Buffer.from(type, "latin1"), p]);
};
export const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...payload: Buffer[]
): Buffer => box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...payload);

/** One coded image: its decoder configuration record and its one sample. */
export interface Coded {
  hvcC: Buffer;
  sample: Buffer;
  w: number;
  h: number;
}

/** An image item. `coded` for a coded image; `grid` (tiles = item ids, row-major) for a derived
 *  grid; `props` are extra property boxes (irot, imir, auxC) associated with it. `exif` makes it an
 *  `Exif` METADATA item instead (payload: the 4-byte offset to the TIFF header, then the TIFF
 *  block), which a `cdsc` reference ties to the image it describes, as every iPhone photo has. */
export interface Item {
  coded?: Coded;
  grid?: { rows: number; cols: number; w: number; h: number; tiles: number[] };
  props?: Buffer[];
  hidden?: boolean;
  exif?: Buffer;
}

export interface Ref {
  type: "thmb" | "auxl" | "cdsc";
  from: number;
  to: number[];
}

/** irot: rotation anticlockwise in quarter turns. */
export const irot = (quarterTurns: number): Buffer => box("irot", u8(quarterTurns & 3));
/** imir: 0 = top-bottom flip, 1 = left-right flip (HEIF 2nd edition, libheif, and the shipped ffmpeg,
 *  measured; the 2017 text read the other way round). */
export const imir = (axis: 0 | 1): Buffer => box("imir", u8(axis));
export const auxC = (urn: string): Buffer =>
  fullBox("auxC", 0, 0, Buffer.from(urn, "latin1"), u8(0));
/** A big-endian TIFF block whose IFD0 holds one entry, Orientation (0x0112) = `o` (EXIF 1-8). */
export const exifOrientation = (o: number): Buffer =>
  Buffer.concat([
    Buffer.from("MM", "latin1"),
    u16(42),
    u32(8),
    u16(1),
    u16(0x0112),
    u16(3),
    u32(1),
    u16(o),
    u16(0),
    u32(0),
  ]);
export const ALPHA_HEVC = "urn:mpeg:hevc:2015:auxid:1";
export const DEPTH_HEVC = "urn:mpeg:hevc:2015:auxid:2";
export const ALPHA_MPEGB = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha";
export const APPLE_GAIN_MAP = "urn:com:apple:photo:2020:aux:hdrgainmap";

export interface HeifOptions {
  /** Major brand (default "heic"). */
  brand?: string;
  /** Write ipma with 15-bit property indices (flags bit 0). */
  wideIndices?: boolean;
  /** pitm/iloc/iref/infe version 1+ (32-bit item ids where the spec allows them). */
  wideIds?: boolean;
  /** Put a `free` box of this many payload bytes before `meta`, pushing it away from the start. */
  padBeforeMeta?: number;
  /** Write that `free` box with a 64-bit (largesize) header whose high word is this (0 = valid). */
  padLargeHigh?: number;
  /** One property box per DISTINCT property, shared by every item that has it, as real encoders do
   *  (an iPhone photo's 48 tiles share one hvcC and one ispe). */
  shareProps?: boolean;
  /** mdat with size 0: "runs to the end of the file". */
  mdatToEof?: boolean;
  /** A pitm whose declared size leaves its item id cut short. */
  shortPitm?: boolean;
  /** Add an association with property index 0 ("no property") to every item. */
  zeroAssociation?: boolean;
  /** Omit the iprp box. */
  noIprp?: boolean;
  /** Stray bytes after meta's last child (too few to be a box). */
  metaTrailing?: number;
  /** Write ipma BEFORE ipco inside iprp (legal: the spec fixes no order). */
  ipmaFirst?: boolean;
  /** Give meta's last child a size of 0 ("to the end of meta"). */
  lastChildToEnd?: boolean;
  /** End meta with an empty (8-byte) `free` box. */
  emptyLastBox?: boolean;
}

/** A HEIF file holding `items` (item id = index + 1), primary `pitm`, and references `refs`. */
export function heifFile(
  items: Item[],
  pitm: number,
  refs: Ref[] = [],
  opt: HeifOptions = {},
): Buffer {
  const itemType = (it: Item): string => (it.exif ? "Exif" : it.grid ? "grid" : "hvc1");
  const ids = items.map((_, i) => i + 1);
  const id = (n: number): Buffer => (opt.wideIds ? u32(n) : u16(n));
  const payload = (it: Item): Buffer =>
    it.exif
      ? Buffer.concat([u32(0), it.exif])
      : it.coded
        ? it.coded.sample
        : Buffer.concat([
            u8(0),
            u8(0),
            u8(it.grid!.rows - 1),
            u8(it.grid!.cols - 1),
            u16(it.grid!.w),
            u16(it.grid!.h),
          ]);
  const payloads = items.map(payload);
  const props: Buffer[] = [];
  /** 1-based index of `p`, reusing an identical box when sharing. */
  const prop = (p: Buffer): number => {
    if (opt.shareProps) {
      const at = props.findIndex((q) => q.equals(p));
      if (at >= 0) return at + 1;
    }
    props.push(p);
    return props.length;
  };
  const assoc = items.map((it) => {
    const a: number[] = [];
    if (it.exif) return a; // a metadata item has no image properties
    if (it.coded) a.push(0x8000 | prop(box("hvcC", it.coded.hvcC)));
    const [w, h] = it.coded ? [it.coded.w, it.coded.h] : [it.grid!.w, it.grid!.h];
    a.push(prop(fullBox("ispe", 0, 0, u32(w), u32(h))));
    for (const p of it.props ?? []) a.push(0x8000 | prop(p));
    if (opt.zeroAssociation) a.push(0);
    return a;
  });
  const assocBytes = (a: number): Buffer =>
    opt.wideIndices ? u16(a) : u8(((a & 0x8000) >> 8) | (a & 0x7f));
  // A grid names its tiles with a `dimg` reference (grid -> tiles); every other relation is the
  // caller's (`thmb`/`auxl`/`cdsc`: the thumbnail/auxiliary/metadata item -> the image it serves).
  const refBoxes = [
    ...items.flatMap((it, i) =>
      it.grid ? [box("dimg", id(i + 1), u16(it.grid.tiles.length), ...it.grid.tiles.map(id))] : [],
    ),
    ...refs.map((r) => box(r.type, id(r.from), u16(r.to.length), ...r.to.map(id))),
  ];
  const v = opt.wideIds ? 1 : 0;
  const pitmBox = opt.shortPitm
    ? // A pitm box whose declared size ends one byte into its item id.
      Buffer.concat([u32(13), Buffer.from("pitm"), u8(v), u8(0), u8(0), u8(0), u8(pitm >> 8)])
    : fullBox("pitm", v, 0, id(pitm));
  const ipco = box("ipco", ...props);
  const ipma = (): Buffer =>
    fullBox(
      "ipma",
      v,
      opt.wideIndices ? 1 : 0,
      u32(ids.length),
      ...ids.map((n, i) =>
        Buffer.concat([id(n), u8(assoc[i].length), ...assoc[i].map(assocBytes)]),
      ),
    );
  const iprp = (): Buffer => box("iprp", ...(opt.ipmaFirst ? [ipma(), ipco] : [ipco, ipma()]));
  /** `b` re-headed with size 0 ("to the end of the enclosing box"). */
  const toEnd = (b: Buffer): Buffer => Buffer.concat([u32(0), b.subarray(4)]);
  const meta = (offsets: number[]): Buffer => {
    const kids = [
      fullBox("hdlr", 0, 0, u32(0), Buffer.from("pict"), u32(0), u32(0), u32(0), u8(0)),
      pitmBox,
      opt.wideIds
        ? fullBox(
            "iloc",
            2,
            0,
            u8(0x44),
            u8(0x00),
            u32(ids.length),
            ...ids.map((n, i) =>
              Buffer.concat([
                u32(n),
                u16(0),
                u16(0),
                u16(1),
                u32(offsets[i]),
                u32(payloads[i].length),
              ]),
            ),
          )
        : fullBox(
            "iloc",
            0,
            0,
            u8(0x44),
            u8(0x00),
            u16(ids.length),
            ...ids.map((n, i) =>
              Buffer.concat([u16(n), u16(0), u16(1), u32(offsets[i]), u32(payloads[i].length)]),
            ),
          ),
      fullBox(
        "iinf",
        0,
        0,
        u16(ids.length),
        ...items.map((it, i) =>
          opt.wideIds
            ? fullBox(
                "infe",
                3,
                it.hidden ? 1 : 0,
                u32(i + 1),
                u16(0),
                Buffer.from(itemType(it)),
                u8(0),
              )
            : fullBox(
                "infe",
                2,
                it.hidden ? 1 : 0,
                u16(i + 1),
                u16(0),
                Buffer.from(itemType(it)),
                u8(0),
              ),
        ),
      ),
      ...(refBoxes.length ? [fullBox("iref", v, 0, ...refBoxes)] : []),
      ...(opt.noIprp ? [] : [iprp()]),
      ...(opt.emptyLastBox ? [box("free")] : []),
    ];
    if (opt.lastChildToEnd) kids[kids.length - 1] = toEnd(kids[kids.length - 1]);
    return fullBox("meta", 0, 0, ...kids, Buffer.alloc(opt.metaTrailing ?? 0));
  };
  const brand = opt.brand ?? "heic";
  const ftyp = box("ftyp", Buffer.from(brand), u32(0), Buffer.from("mif1"), Buffer.from(brand));
  const padBytes = Buffer.alloc(opt.padBeforeMeta ?? 0);
  const pad =
    opt.padBeforeMeta === undefined
      ? Buffer.alloc(0)
      : opt.padLargeHigh !== undefined
        ? Buffer.concat([
            u32(1),
            Buffer.from("free"),
            u32(opt.padLargeHigh),
            u32(16 + padBytes.length),
            padBytes,
          ])
        : box("free", padBytes);
  const mdat = (...p: Buffer[]): Buffer =>
    opt.mdatToEof ? Buffer.concat([u32(0), Buffer.from("mdat"), ...p]) : box("mdat", ...p);
  let at = ftyp.length + pad.length + meta(ids.map(() => 0)).length + 8;
  const offsets = payloads.map((p) => {
    const o = at;
    at += p.length;
    return o;
  });
  return Buffer.concat([ftyp, pad, meta(offsets), mdat(...payloads)]);
}

/** Where the meta box ends in a file `heifFile` wrote (the head a reader must have). */
export function metaEnd(file: Uint8Array): number {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let at = 0; at + 8 <= file.length;) {
    let size = dv.getUint32(at);
    if (size === 1) size = dv.getUint32(at + 12);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    if (type === "meta") return at + size;
    at += size;
  }
  throw new Error("no meta box");
}
