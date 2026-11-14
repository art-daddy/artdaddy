// Properties of the class rules and the two local stores. The band is written here as plain numbers (not read from the module),
// so a wrong constant in the module cannot agree with its own test.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  PC_CHECK_KEY,
  PC_CHECK_TTL_MS,
  acceptCutoffs,
  checkedRecord,
  classOf,
  readPcCheck,
  rHatOf,
  writePcCheck,
  type PcCheckNow,
  type PcCheckRecord,
  type StorageLike,
} from "./pcClass";

const inBand = (ok: number, weak: number): boolean =>
  Number.isFinite(ok) &&
  Number.isFinite(weak) &&
  ok >= 0.5 &&
  ok <= 2 &&
  weak >= 2 &&
  weak <= 8 &&
  ok < weak;

const store = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  const handle: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
  return { map, handle, bytes: () => JSON.stringify([...map.entries()]) };
};

/** Numbers that matter to the band: ordinary ones, its edges and the steps just outside them, and the ones that are not numbers. */
const bandNumber = fc.oneof(
  fc.double({ min: -1, max: 10, noNaN: true }),
  fc.constantFrom(
    0.5,
    0.4999999999,
    2,
    2.0000000001,
    1.9999999999,
    8,
    8.0000000001,
    1,
    4,
    0,
    -0,
    Number.NaN,
    Infinity,
    -Infinity,
  ),
);
const spelled = (spelling: "wire" | "own", ok: unknown, weak: unknown) =>
  spelling === "wire" ? { ok_over: ok, weak_over: weak } : { okOver: ok, weakOver: weak };
const spelling = fc.constantFrom("wire", "own") as fc.Arbitrary<"wire" | "own">;
const nonNumber = fc.oneof(
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer()),
  fc.object(),
  fc.bigInt(),
);

describe("acceptCutoffs (property)", () => {
  it("accepts a pair exactly when it is inside the band: nothing outside gets in, nothing inside is dropped", () => {
    fc.assert(
      fc.property(bandNumber, bandNumber, spelling, (ok, weak, how) => {
        const got = acceptCutoffs(spelled(how, ok, weak));
        expect(got !== null).toBe(inBand(ok, weak));
        if (got) expect(got).toEqual({ okOver: ok, weakOver: weak });
      }),
      { numRuns: 1000 },
    );
  });

  it("refuses one number alone", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        fc.double({ min: 2, max: 8, noNaN: true }),
        spelling,
        (ok, weak, how) => {
          const pair = spelled(how, ok, weak) as Record<string, unknown>;
          for (const key of Object.keys(pair)) {
            const alone = { ...pair };
            delete alone[key];
            expect(acceptCutoffs(alone)).toBeNull();
          }
        },
      ),
    );
  });

  it("refuses a pair in which either number is not a number, whatever the other is", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 1.9, noNaN: true }),
        fc.double({ min: 2.1, max: 8, noNaN: true }),
        nonNumber,
        spelling,
        (ok, weak, junk, how) => {
          expect(acceptCutoffs(spelled(how, junk, weak))).toBeNull();
          expect(acceptCutoffs(spelled(how, ok, junk))).toBeNull();
        },
      ),
    );
  });

  it("never throws and only ever hands back a pair inside the band, whatever it is told", () => {
    fc.assert(
      fc.property(fc.anything(), (told) => {
        const got = acceptCutoffs(told);
        if (got) expect(inBand(got.okOver, got.weakOver)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("classOf (property)", () => {
  const rank = { fast: 0, ok: 1, weak: 2 } as const;
  const pairs = fc
    .tuple(fc.double({ min: 0.5, max: 2, noNaN: true }), fc.double({ min: 2, max: 8, noNaN: true }))
    .filter(([ok, weak]) => weak - ok > 1e-6);

  it("is fast, OK or weak for every real ratio, and never slower-to-faster as the ratio grows", () => {
    fc.assert(
      fc.property(
        pairs,
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        ([ok, weak], a, b) => {
          const cutoffs = { okOver: ok, weakOver: weak };
          const [low, high] = a <= b ? [a, b] : [b, a];
          const lowClass = classOf(low, cutoffs);
          const highClass = classOf(high, cutoffs);
          expect(lowClass in rank && highClass in rank).toBe(true);
          expect(rank[lowClass as keyof typeof rank]).toBeLessThanOrEqual(
            rank[highClass as keyof typeof rank],
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("puts each cut-off in the lower class and the next step above it in the higher", () => {
    fc.assert(
      fc.property(pairs, ([ok, weak]) => {
        const cutoffs = { okOver: ok, weakOver: weak };
        expect(classOf(ok, cutoffs)).toBe("fast");
        expect(classOf(ok + ok * 1e-9, cutoffs)).toBe("ok");
        expect(classOf(weak, cutoffs)).toBe("ok");
        expect(classOf(weak + weak * 1e-9, cutoffs)).toBe("weak");
      }),
    );
  });

  it("says unknown for anything that is not a real ratio, and never unfinished", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const got = classOf(value as number | null);
        const real = typeof value === "number" && Number.isFinite(value) && value >= 0;
        expect(got === "unknown").toBe(!real);
        expect(got).not.toBe("unfinished");
      }),
      { numRuns: 500 },
    );
  });
});

describe("rHatOf (property)", () => {
  it("is finite and never negative, and a faster PC never gets the larger ratio", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-9, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-9, max: 1e6, noNaN: true }),
        (a, b) => {
          const [slow, fast] = a <= b ? [a, b] : [b, a];
          const slowRatio = rHatOf(slow)!;
          const fastRatio = rHatOf(fast)!;
          expect(Number.isFinite(slowRatio) && slowRatio >= 0).toBe(true);
          expect(fastRatio).toBeLessThanOrEqual(slowRatio);
        },
      ),
      { numRuns: 500 },
    );
  });
});

const NOW_BUILD = "artdaddy@9.9.9";
// `+ 0` turns a generated -0 into 0: JSON has no negative zero, and a round trip is not expected to invent one.
const speed = (max: number) => fc.double({ min: 0, max, noNaN: true }).map((value) => value + 0);
const fps = fc.oneof(fc.constant(null), speed(5000));
const finished: fc.Arbitrary<PcCheckRecord> = fc.record({
  revision: fc.integer({ min: 0, max: 50 }),
  build: fc.constant(NOW_BUILD),
  atMs: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
  cores: fc.integer({ min: 1, max: 128 }),
  outcome: fc.constant("done" as const),
  aFps: fps,
  bFps: fc.double({ min: 0.01, max: 5000, noNaN: true }),
  cFps: fps,
  rHat: speed(100),
  cls: fc.constantFrom("fast" as const, "ok" as const, "weak" as const),
});
const unfinished: fc.Arbitrary<PcCheckRecord> = finished.map((record) => ({
  ...record,
  outcome: "unfinished" as const,
  bFps: null,
  rHat: null,
  cls: "unfinished" as const,
}));
const anyRecord = fc.oneof(finished, unfinished);
const nowOf = (record: PcCheckRecord, ageMs: number): PcCheckNow => ({
  atMs: record.atMs + ageMs,
  build: record.build,
  cores: record.cores,
  revision: record.revision,
});

describe("the check's store (property)", () => {
  it("gives back exactly what it was given while the record is current", () => {
    fc.assert(
      fc.property(anyRecord, fc.integer({ min: 0, max: PC_CHECK_TTL_MS }), (record, age) => {
        const { handle } = store();
        writePcCheck(handle, "speed", record);
        expect(readPcCheck(handle, "speed", nowOf(record, age))).toEqual(record);
      }),
    );
  });

  it("gives back nothing once it is stale, from another build, another revision or another core count", () => {
    fc.assert(
      fc.property(anyRecord, fc.integer({ min: 1, max: 10 * PC_CHECK_TTL_MS }), (record, extra) => {
        const { handle } = store();
        writePcCheck(handle, "speed", record);
        const now = nowOf(record, 0);
        expect(
          readPcCheck(handle, "speed", { ...now, atMs: now.atMs + PC_CHECK_TTL_MS + extra }),
        ).toBeNull();
        expect(readPcCheck(handle, "speed", { ...now, build: `${now.build}x` })).toBeNull();
        expect(readPcCheck(handle, "speed", { ...now, revision: now.revision + 1 })).toBeNull();
        expect(readPcCheck(handle, "speed", { ...now, cores: now.cores + 1 })).toBeNull();
      }),
    );
  });

  it("never throws and never returns anything but a well-formed record, whatever the store holds", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), fc.constant(null)), (raw) => {
        const { handle } = store(raw === null ? {} : { [PC_CHECK_KEY]: raw });
        const got = readPcCheck(handle, "speed", {
          atMs: 1_500_000_000_000,
          build: NOW_BUILD,
          cores: 8,
          revision: 1,
        });
        expect(got === null || checkedRecord(got) !== null).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("survives a single changed character anywhere in a valid store, still returning nothing or a well-formed record", () => {
    fc.assert(
      fc.property(
        anyRecord,
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 1 }),
        (record, at, replacement) => {
          const { handle, map } = store();
          writePcCheck(handle, "speed", record);
          const text = map.get(PC_CHECK_KEY)!;
          const i = at % text.length;
          map.set(PC_CHECK_KEY, text.slice(0, i) + replacement + text.slice(i + 1));
          const got = readPcCheck(handle, "speed", nowOf(record, 0));
          expect(got === null || checkedRecord(got) !== null).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
