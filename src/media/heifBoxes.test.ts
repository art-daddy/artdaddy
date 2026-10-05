// readHeifLayout: the HEIF facts ffmpeg does not report. Properties, not examples: any layout the
// writer can express round-trips; a file cut anywhere is either unknown or exactly right, never a
// different answer; hostile bytes never throw.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ALPHA_HEVC,
  ALPHA_MPEGB,
  APPLE_GAIN_MAP,
  DEPTH_HEVC,
  auxC,
  box,
  exifOrientation,
  heifFile,
  imir,
  irot,
  metaEnd,
  type Coded,
  type HeifOptions,
  type Item,
  type Ref,
} from "../test/heifWriter";
import { ALPHA_AUX_TYPES, readHeifLayout } from "./heifBoxes";

const coded = (w = 64, h = 48): Coded => ({
  hvcC: Buffer.from([1, 2, 3, 4]),
  sample: Buffer.from([0, 0, 0, 1, 0x26]),
  w,
  h,
});

const URNS = [ALPHA_HEVC, ALPHA_MPEGB, DEPTH_HEVC, APPLE_GAIN_MAP, "urn:example:other"];

describe("readHeifLayout", () => {
  it("knows exactly the two alpha auxiliary types", () => {
    expect([...ALPHA_AUX_TYPES].sort()).toEqual([ALPHA_HEVC, ALPHA_MPEGB].sort());
  });

  it("finds the primary when a thumbnail is stored first", () => {
    const f = heifFile([{ coded: coded(16, 12) }, { coded: coded() }], 2, [
      { type: "thmb", from: 1, to: [2] },
    ]);
    expect(readHeifLayout(f)).toMatchObject({ primary: 2, alpha: [] });
  });

  // Every iPhone photo also carries an Exif METADATA item tied to the primary by `cdsc`, and a
  // portrait one says Orientation 6 there while `irot` says the same turn. The Exif item is not an
  // image and its orientation is not a transform: the layout must read exactly as without it.
  it("an Exif metadata item changes nothing: not an image, not a transform, not an alpha plane", () => {
    const items: Item[] = [
      { coded: coded(), props: [irot(1)] },
      { coded: coded(), props: [auxC(ALPHA_HEVC)] },
    ];
    const refs: Ref[] = [{ type: "auxl", from: 2, to: [1] }];
    const without = readHeifLayout(heifFile(items, 1, refs));
    for (const o of [1, 3, 6, 8]) {
      const withExif = readHeifLayout(
        heifFile([...items, { exif: exifOrientation(o), hidden: true }], 1, [
          ...refs,
          { type: "cdsc", from: 3, to: [1] },
        ]),
      );
      expect(withExif, `Orientation ${o}`).toEqual(without);
    }
    expect(without).toMatchObject({ primary: 1, alpha: [2] });
    expect(without?.transforms.get(1)).toEqual(["r1"]);
  });

  it("takes an alpha auxiliary of the primary, and nothing that only looks like one", () => {
    const f = heifFile(
      [
        { coded: coded() }, // 1 primary
        { coded: coded(), props: [auxC(ALPHA_HEVC)] }, // 2 alpha of 1
        { coded: coded(), props: [auxC(DEPTH_HEVC)] }, // 3 depth of 1
        { coded: coded(), props: [auxC(APPLE_GAIN_MAP)] }, // 4 gain map of 1
        { coded: coded(16, 12) }, // 5 thumbnail of 1
        { coded: coded(16, 12), props: [auxC(ALPHA_MPEGB)] }, // 6 alpha of the THUMBNAIL
      ],
      1,
      [
        { type: "auxl", from: 2, to: [1] },
        { type: "auxl", from: 3, to: [1] },
        { type: "auxl", from: 4, to: [1] },
        { type: "thmb", from: 5, to: [1] },
        { type: "auxl", from: 6, to: [5] },
      ],
    );
    expect(readHeifLayout(f)).toMatchObject({ primary: 1, alpha: [2] });
  });

  it("reads 32-bit item ids, 15-bit property indices, and a meta box far from the start", () => {
    const items: Item[] = [
      { coded: coded(), props: [irot(1), imir(0)] },
      { coded: coded(), props: [auxC(ALPHA_MPEGB)] },
    ];
    const refs: Ref[] = [{ type: "auxl", from: 2, to: [1] }];
    for (const opt of [
      { wideIds: true },
      { wideIndices: true },
      { padBeforeMeta: 70_000 },
      { wideIds: true, wideIndices: true, padBeforeMeta: 300 },
    ] satisfies HeifOptions[]) {
      const got = readHeifLayout(heifFile(items, 1, refs, opt));
      expect(got, JSON.stringify(opt)).toMatchObject({ primary: 1, alpha: [2] });
      expect(got?.transforms.get(1), JSON.stringify(opt)).toEqual(["r1", "m0"]);
    }
  });

  it("is null for a file that is not HEIF", () => {
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    ])
      expect(readHeifLayout(bytes)).toBeNull();
  });

  const twoItems: Item[] = [
    { coded: coded(), props: [irot(3)] },
    { coded: coded(), props: [auxC(ALPHA_HEVC)] },
  ];
  const alphaRef: Ref[] = [{ type: "auxl", from: 2, to: [1] }];
  const want = { primary: 1, alpha: [2] };

  it("reads the box header forms real files use", () => {
    for (const opt of [
      { padBeforeMeta: 40, padLargeHigh: 0 }, // a 64-bit (largesize) header before meta
      { mdatToEof: true }, // the last box running to the end of the file
      { zeroAssociation: true }, // property index 0: "no property"
      { shareProps: true }, // one hvcC/ispe shared by every item
      { ipmaFirst: true }, // ipma before ipco: the spec fixes no order
      { lastChildToEnd: true }, // meta's last child sized 0: "to the end of meta"
      { emptyLastBox: true }, // an empty 8-byte box closing meta
    ] satisfies HeifOptions[]) {
      const f = heifFile(twoItems, 1, alphaRef, opt);
      expect(readHeifLayout(f), JSON.stringify(opt)).toMatchObject(want);
      expect(readHeifLayout(f)?.transforms.get(1), JSON.stringify(opt)).toEqual(["r3"]);
      // ...and from a head that stops right after meta, which is all a reader is given.
      expect(readHeifLayout(f.subarray(0, metaEnd(f))), JSON.stringify(opt)).toMatchObject(want);
    }
  });

  it("reads only the angle and axis bits of irot and imir", () => {
    // Reserved bits set by a careless writer must not turn the picture another way.
    const f = heifFile(
      [
        {
          coded: coded(),
          props: [box("irot", Buffer.from([0xfd])), box("imir", Buffer.from([0xfe]))],
        },
      ],
      1,
    );
    expect(readHeifLayout(f)?.transforms.get(1)).toEqual(["r1", "m0"]);
  });

  it("every head of a file reads as unknown until meta is complete, then exactly right", () => {
    // Exhaustive over one representative file (every cut, not a sample of them).
    const f = heifFile(twoItems, 1, alphaRef, { wideIds: true, shareProps: true });
    const want = readHeifLayout(f);
    expect(want).toMatchObject({ primary: 1, alpha: [2] });
    const end = metaEnd(f);
    for (let cut = 0; cut <= f.length; cut++) {
      const got = readHeifLayout(f.subarray(0, cut));
      if (cut >= end) expect(got, `cut ${cut}`).toEqual(want);
      else expect(got, `cut ${cut}`).toBeNull();
    }
  });

  it("has no alpha plane or transforms to report when there are no item properties", () => {
    const got = readHeifLayout(heifFile(twoItems, 1, alphaRef, { noIprp: true }));
    expect(got).toMatchObject({ primary: 1, alpha: [] });
    expect(got?.transforms.size).toBe(0);
  });

  it("is null, not a guess, when a box is malformed", () => {
    for (const opt of [
      { padBeforeMeta: 40, padLargeHigh: 1 }, // a box claiming to be past 4 GiB
      { shortPitm: true }, // pitm cut off inside its item id
      { metaTrailing: 3 }, // bytes inside meta that are not a box
    ] satisfies HeifOptions[])
      expect(readHeifLayout(heifFile(twoItems, 1, alphaRef, opt)), JSON.stringify(opt)).toBeNull();
    // A box declaring a size smaller than its own header, ahead of an otherwise perfect meta.
    const good = heifFile(twoItems, 1, alphaRef);
    const tiny = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("free"), good]);
    expect(readHeifLayout(tiny)).toBeNull();
  });

  // Any layout the writer can express: N items, any primary, auxl/thmb references between any of
  // them, any auxiliary type and transforms on any item. The parser must report the primary, the
  // primary's alpha planes exactly, and every item's transforms in order.
  const layout = fc
    .integer({ min: 1, max: 7 })
    .chain((n) =>
      fc.record({
        n: fc.constant(n),
        pitm: fc.integer({ min: 1, max: n }),
        aux: fc.array(fc.option(fc.constantFrom(...URNS), { nil: undefined }), {
          minLength: n,
          maxLength: n,
        }),
        tf: fc.array(
          fc.array(
            fc.oneof(
              fc.integer({ min: 0, max: 3 }).map((k) => `r${k}`),
              fc.constantFrom("m0", "m1"),
            ),
            { maxLength: 3 },
          ),
          {
            minLength: n,
            maxLength: n,
          },
        ),
        refs: fc.array(
          fc.record({
            type: fc.constantFrom<"auxl" | "thmb">("auxl", "thmb"),
            from: fc.integer({ min: 1, max: n }),
            to: fc.uniqueArray(fc.integer({ min: 1, max: n }), { minLength: 1, maxLength: 3 }),
          }),
          { maxLength: 6 },
        ),
        opt: fc.record({
          wideIds: fc.boolean(),
          wideIndices: fc.boolean(),
          shareProps: fc.boolean(),
          zeroAssociation: fc.boolean(),
          mdatToEof: fc.boolean(),
          ipmaFirst: fc.boolean(),
          lastChildToEnd: fc.boolean(),
          padBeforeMeta: fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
          padLargeHigh: fc.option(fc.constant(0), { nil: undefined }),
        }),
      }),
    )
    // One reference box per (type, from): the spec has a box list, not a merge rule, to test.
    .filter((l) => new Set(l.refs.map((r) => `${r.type}:${r.from}`)).size === l.refs.length);

  type Layout = typeof layout extends fc.Arbitrary<infer T> ? T : never;
  const build = (l: Layout): Buffer =>
    heifFile(
      Array.from({ length: l.n }, (_, i) => ({
        coded: coded(),
        props: [
          ...(l.aux[i] ? [auxC(l.aux[i]!)] : []),
          ...l.tf[i].map((t: string) =>
            t[0] === "r" ? irot(Number(t[1])) : imir(Number(t[1]) as 0 | 1),
          ),
        ],
      })),
      l.pitm,
      l.refs,
      l.opt,
    );

  it("round-trips any layout the writer can express", () => {
    fc.assert(
      fc.property(layout, (l) => {
        const got = readHeifLayout(build(l));
        const alpha = l.refs
          .filter(
            (r) =>
              r.type === "auxl" &&
              r.from !== l.pitm &&
              r.to.includes(l.pitm) &&
              ALPHA_AUX_TYPES.has(l.aux[r.from - 1] ?? ""),
          )
          .map((r) => r.from);
        expect(got?.primary).toBe(l.pitm);
        expect([...(got?.alpha ?? [])].sort()).toEqual(alpha.sort());
        for (let i = 0; i < l.n; i++) expect(got?.transforms.get(i + 1) ?? []).toEqual(l.tf[i]);
      }),
      { numRuns: 300 },
    );
  });

  // A reader is given the file's HEAD, so a cut file is the normal case, not an edge: once the head
  // holds all of meta the answer must be exactly the whole file's, and before that it must be
  // "unknown" (null), never a partial reading.
  it("a head that holds meta reads exactly as the whole file; a shorter one reads as unknown", () => {
    fc.assert(
      fc.property(layout, fc.double({ min: 0, max: 1, noNaN: true }), (l, at) => {
        const full = build(l);
        const cut = Math.floor(full.length * at);
        const got = readHeifLayout(full.subarray(0, cut));
        if (cut >= metaEnd(full)) expect(got).toEqual(readHeifLayout(full));
        else expect(got).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on hostile bytes, and never reports the picture as its own alpha plane", () => {
    fc.assert(
      fc.property(
        layout,
        fc.array(fc.record({ at: fc.nat(), v: fc.integer({ min: 0, max: 255 }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        (l, edits) => {
          const f = Uint8Array.from(build(l));
          for (const e of edits) f[e.at % f.length] = e.v;
          const got = readHeifLayout(f);
          if (got) {
            expect(Number.isInteger(got.primary)).toBe(true);
            expect(got.alpha.every((a) => a !== got.primary)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        readHeifLayout(bytes);
      }),
      { numRuns: 500 },
    );
  });
});
