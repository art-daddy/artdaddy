import { describe, expect, it } from "vitest";

import {
  CUTOFF_BAND,
  PC_CHECK_KEY,
  PC_CHECK_TTL_MS,
  PC_CLASS_COMPILED,
  PC_CLASS_KEY,
  R_HAT_FIT,
  acceptCutoffs,
  checkedRecord,
  classOf,
  classOfRecord,
  readCutoffs,
  readPcCheck,
  rHatOf,
  unfinishedRecord,
  writeCutoffs,
  writePcCheck,
  type PcCheckNow,
  type PcCheckRecord,
  type StorageLike,
} from "./pcClass";

/** A Map-backed Storage that counts what was asked of it, so "nothing was written" is a fact and not a hope. */
function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0, remove: 0 };
  const store: StorageLike = {
    getItem: (key) => {
      calls.get++;
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      calls.set++;
      map.set(key, String(value));
    },
    removeItem: (key) => {
      calls.remove++;
      map.delete(key);
    },
  };
  return { store, map, calls, bytes: () => JSON.stringify([...map.entries()]) };
}

const brokenStore = (which: "get" | "set" | "both"): StorageLike => ({
  getItem: () => {
    if (which !== "set") throw new Error("storage is off");
    return null;
  },
  setItem: () => {
    if (which !== "get") throw new Error("storage is full");
  },
  removeItem: () => undefined,
});

const NOW: PcCheckNow = { atMs: 1_700_000_000_000, build: "artdaddy@1.2.3", cores: 8, revision: 1 };
const done = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
  revision: NOW.revision,
  build: NOW.build,
  atMs: NOW.atMs - 60_000,
  cores: NOW.cores,
  outcome: "done",
  aFps: 180.5,
  bFps: 24,
  cFps: 71.25,
  rHat: 1.25,
  cls: "ok",
  ...over,
});

describe("classOf: the class from the ratio", () => {
  it("puts exactly the cut-offs in the LOWER class: 1.0 is fast and 4.0 is OK", () => {
    expect(classOf(1)).toBe("fast");
    expect(classOf(1.0000001)).toBe("ok");
    expect(classOf(4)).toBe("ok");
    expect(classOf(4.0000001)).toBe("weak");
    expect(classOf(0)).toBe("fast");
    expect(classOf(-0)).toBe("fast");
  });

  it("says unknown for no ratio and for anything that is not a real, non-negative number", () => {
    const garbage = [null, Number.NaN, Infinity, -Infinity, -0.001, "2" as unknown as number];
    for (const value of garbage) expect(classOf(value), String(value)).toBe("unknown");
  });

  it("never produces unfinished: only the service knows a check did not finish", () => {
    const seen = new Set<string>();
    for (let r = 0; r <= 20; r += 0.05) seen.add(classOf(r));
    expect([...seen].sort()).toEqual(["fast", "ok", "weak"]);
  });

  it("uses the pair it is given when it is inside the band", () => {
    const tight = { okOver: 0.5, weakOver: 2 };
    expect(classOf(0.5, tight)).toBe("fast");
    expect(classOf(0.7, tight)).toBe("ok");
    expect(classOf(2, tight)).toBe("ok");
    expect(classOf(2.5, tight)).toBe("weak");
  });

  it("does not use a pair outside the band: the compiled pair stands", () => {
    // 1.5 is OK under the compiled pair (above 1, up to 4) and would be weak or fast under these.
    for (const bad of [
      { okOver: 0.1, weakOver: 100 },
      { okOver: 2, weakOver: 2 },
      { okOver: Number.NaN, weakOver: 4 },
      { okOver: 3, weakOver: 3.5 },
    ])
      expect(classOf(1.5, bad), JSON.stringify(bad)).toBe("ok");
  });

  it("keeps the compiled pair inside its own band, so a server that serves it restores it", () => {
    expect(acceptCutoffs({ ok_over: 1, weak_over: 4 })).toEqual(PC_CLASS_COMPILED);
  });
});

describe("acceptCutoffs: lane L2's band, both numbers or neither", () => {
  it("accepts a pair inside the band, in the wire's spelling and in the app's own", () => {
    expect(acceptCutoffs({ ok_over: 1.5, weak_over: 5 })).toEqual({ okOver: 1.5, weakOver: 5 });
    expect(acceptCutoffs({ okOver: 1.5, weakOver: 5 })).toEqual({ okOver: 1.5, weakOver: 5 });
  });

  it("includes both ends of the band", () => {
    const { okOver, weakOver } = CUTOFF_BAND;
    for (const [ok, weak] of [
      [okOver.min, weakOver.min],
      [okOver.max, weakOver.max],
      [okOver.min, weakOver.max],
      [1.9999, 2],
    ])
      expect(acceptCutoffs({ ok_over: ok, weak_over: weak }), `${ok} ${weak}`).toEqual({
        okOver: ok,
        weakOver: weak,
      });
  });

  it("refuses a pair that is one step outside the band, or not strictly ordered", () => {
    const refused: [number, number][] = [
      [0.49, 4],
      [2.01, 4],
      [1, 1.99],
      [1, 8.01],
      [2, 2],
      [1.5, 1.5],
    ];
    for (const [ok, weak] of refused)
      expect(acceptCutoffs({ ok_over: ok, weak_over: weak }), `${ok} ${weak}`).toBeNull();
  });

  it("refuses one number alone, in either spelling", () => {
    for (const told of [
      { ok_over: 1 },
      { weak_over: 4 },
      { okOver: 1 },
      { weakOver: 4 },
      { ok_over: 1, weakOver: 4 },
      { okOver: 1, weak_over: 4 },
      { ok_over: 1, weak_over: 4, okOver: 1, weakOver: 4 },
    ])
      expect(acceptCutoffs(told), JSON.stringify(told)).toBeNull();
  });

  it("refuses NaN, infinities and strings, even ones that look like numbers", () => {
    for (const [ok, weak] of [
      [Number.NaN, 4],
      [1, Number.NaN],
      [Infinity, 4],
      [1, Infinity],
      [-Infinity, 4],
      ["1", 4],
      [1, "4"],
      [null, 4],
      [1, undefined],
    ])
      expect(acceptCutoffs({ ok_over: ok, weak_over: weak }), `${ok} ${weak}`).toBeNull();
  });

  it("refuses whatever is not an object, and values that only look like the pair", () => {
    for (const told of [
      null,
      undefined,
      1,
      "1,4",
      true,
      [1, 4],
      {},
      Object.create({ ok_over: 1, weak_over: 4 }),
    ])
      expect(acceptCutoffs(told)).toBeNull();
  });

  it("never throws, even for an object whose properties throw when read", () => {
    const hostile = new Proxy(
      {},
      {
        has: () => {
          throw new Error("no");
        },
        get: () => {
          throw new Error("no");
        },
        getOwnPropertyDescriptor: () => {
          throw new Error("no");
        },
      },
    );
    expect(acceptCutoffs(hostile)).toBeNull();
  });

  it("hands back its own object and leaves the one it was given alone", () => {
    const told = Object.freeze({ ok_over: 1.5, weak_over: 5 });
    const got = acceptCutoffs(told)!;
    got.okOver = 99;
    expect(acceptCutoffs(told)).toEqual({ okOver: 1.5, weakOver: 5 });
  });
});

describe("the cut-offs store (artdaddy.pcClass.v1)", () => {
  it("is the compiled pair until the server tells another, and keeps the accepted one", () => {
    const { store, map } = memoryStore();
    expect(readCutoffs(store)).toEqual(PC_CLASS_COMPILED);
    writeCutoffs(store, { ok_over: 0.75, weak_over: 3 });
    expect(readCutoffs(store)).toEqual({ okOver: 0.75, weakOver: 3 });
    expect([...map.keys()]).toEqual([PC_CLASS_KEY]);
  });

  it("keeps the last good pair, byte for byte, when told a bad one", () => {
    const { store, calls, bytes } = memoryStore();
    writeCutoffs(store, { ok_over: 0.75, weak_over: 3 });
    const before = bytes();
    const writes = calls.set;
    for (const bad of [
      { ok_over: 0.1, weak_over: 3 },
      { ok_over: 1 },
      { ok_over: "1", weak_over: "4" },
      null,
      undefined,
      "x",
      { ok_over: Number.NaN, weak_over: 4 },
    ])
      writeCutoffs(store, bad);
    expect(bytes()).toBe(before);
    expect(calls.set).toBe(writes);
    expect(readCutoffs(store)).toEqual({ okOver: 0.75, weakOver: 3 });
  });

  it("reads a damaged stored value as the compiled pair", () => {
    const damaged = [
      "not json",
      "null",
      "[]",
      "{}",
      '{"okOver":0.75}',
      '{"okOver":9,"weakOver":99}',
      '{"okOver":"0.75","weakOver":"3"}',
      `{"okOver":0.75,"weakOver":3,"pad":"${"x".repeat(2000)}"}`,
    ];
    expect(
      readCutoffs(memoryStore({ [PC_CLASS_KEY]: '{"okOver":0.75,"weakOver":3}' }).store),
    ).toEqual({
      okOver: 0.75,
      weakOver: 3,
    });
    for (const raw of damaged) {
      const { store } = memoryStore({ [PC_CLASS_KEY]: raw });
      expect(readCutoffs(store), raw.slice(0, 40)).toEqual(PC_CLASS_COMPILED);
    }
  });

  it("works with no storage, and with storage that throws", () => {
    expect(readCutoffs(null)).toEqual(PC_CLASS_COMPILED);
    expect(() => writeCutoffs(null, { ok_over: 1, weak_over: 4 })).not.toThrow();
    expect(readCutoffs(brokenStore("both"))).toEqual(PC_CLASS_COMPILED);
    expect(() => writeCutoffs(brokenStore("both"), { ok_over: 1, weak_over: 4 })).not.toThrow();
  });

  it("returns a copy of the compiled pair, so a caller cannot change what the next one gets", () => {
    const first = readCutoffs(null);
    first.okOver = 99;
    expect(readCutoffs(null)).toEqual(PC_CLASS_COMPILED);
  });
});

describe("rHatOf: the ratio from the probe's speed", () => {
  it("has no ratio for no usable speed", () => {
    for (const value of [null, 0, -5, Number.NaN, Infinity, -Infinity, "30" as unknown as number])
      expect(rHatOf(value), String(value)).toBeNull();
  });

  it("is the model r = k x 30 / b + c0 with the one set of coefficients, never below zero", () => {
    expect(rHatOf(30)).toBeCloseTo(Math.max(0, R_HAT_FIT.k + R_HAT_FIT.c0), 12);
    expect(rHatOf(15)).toBeCloseTo(Math.max(0, (R_HAT_FIT.k * 30) / 15 + R_HAT_FIT.c0), 12);
    expect(Number.isFinite(R_HAT_FIT.k) && R_HAT_FIT.k > 0).toBe(true);
    expect(Number.isFinite(R_HAT_FIT.c0)).toBe(true);
  });

  it("gives a slower PC a ratio that is never smaller", () => {
    const speeds = [0.5, 2, 5, 10, 24, 30, 60, 120, 500];
    const ratios = speeds.map((speed) => rHatOf(speed)!);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeLessThanOrEqual(ratios[i - 1]);
  });

  it("stays finite for absurd speeds", () => {
    for (const speed of [Number.MIN_VALUE, 1e-300, 1e300, Number.MAX_VALUE]) {
      const ratio = rHatOf(speed);
      expect(ratio !== null && Number.isFinite(ratio) && ratio >= 0, String(speed)).toBe(true);
    }
  });
});

describe("the check's store (artdaddy.pcCheck.v1)", () => {
  it("keeps a finished check and a check that did not finish, and gives them back", () => {
    const { store } = memoryStore();
    writePcCheck(store, "speed", done());
    writePcCheck(store, "other", unfinishedRecord({ ...NOW, atMs: NOW.atMs - 5 }));
    expect(readPcCheck(store, "speed", NOW)).toEqual(done());
    expect(readPcCheck(store, "other", NOW)).toEqual(
      unfinishedRecord({ ...NOW, atMs: NOW.atMs - 5 }),
    );
  });

  it("stores the design's fields under the design's key", () => {
    const { store, map } = memoryStore();
    writePcCheck(store, "speed", done());
    expect([...map.keys()]).toEqual([PC_CHECK_KEY]);
    const stored = JSON.parse(map.get(PC_CHECK_KEY)!);
    expect(Object.keys(stored.speed).sort()).toEqual(
      [
        "a_fps",
        "at",
        "b_fps",
        "build",
        "c_fps",
        "class",
        "cores",
        "outcome",
        "r_hat",
        "revision",
      ].sort(),
    );
    expect(stored.speed.class).toBe("ok");
  });

  it("ignores a record from another build, another revision or another core count", () => {
    const { store } = memoryStore();
    writePcCheck(store, "speed", done());
    expect(readPcCheck(store, "speed", { ...NOW, build: "artdaddy@1.2.4" })).toBeNull();
    expect(readPcCheck(store, "speed", { ...NOW, revision: 2 })).toBeNull();
    expect(readPcCheck(store, "speed", { ...NOW, cores: 16 })).toBeNull();
    expect(readPcCheck(store, "speed", NOW)).not.toBeNull();
  });

  it("is stale after 30 days and not before: exactly 30 days is still current", () => {
    const { store } = memoryStore();
    writePcCheck(store, "speed", done({ atMs: NOW.atMs - PC_CHECK_TTL_MS }));
    expect(readPcCheck(store, "speed", NOW)).not.toBeNull();
    expect(readPcCheck(store, "speed", { ...NOW, atMs: NOW.atMs + 1 })).toBeNull();
    expect(PC_CHECK_TTL_MS).toBe(30 * 24 * 3_600_000);
  });

  it("takes the probe's own lifetime when it has one", () => {
    const { store } = memoryStore();
    writePcCheck(store, "speed", done({ atMs: NOW.atMs - 3_600_000 }));
    expect(readPcCheck(store, "speed", NOW, 7_200_000)).not.toBeNull();
    expect(readPcCheck(store, "speed", NOW, 1_800_000)).toBeNull();
    expect(readPcCheck(store, "speed", NOW, Number.NaN)).toBeNull();
  });

  it("does not believe a time from the future (a clock put back), but allows a few minutes of skew", () => {
    const { store } = memoryStore();
    writePcCheck(store, "speed", done({ atMs: NOW.atMs + 4 * 60_000 }));
    expect(readPcCheck(store, "speed", NOW)).not.toBeNull();
    writePcCheck(store, "speed", done({ atMs: NOW.atMs + 6 * 60_000 }));
    expect(readPcCheck(store, "speed", NOW)).toBeNull();
  });

  it("answers for its own probe id only, and a second probe leaves the first alone", () => {
    const { store } = memoryStore();
    writePcCheck(store, "speed", done());
    expect(readPcCheck(store, "speech", NOW)).toBeNull();
    writePcCheck(store, "speech", done({ bFps: 3, rHat: 10, cls: "weak" }));
    expect(readPcCheck(store, "speed", NOW)).toEqual(done());
    expect(readPcCheck(store, "speech", NOW)?.cls).toBe("weak");
  });

  describe("damage", () => {
    const store1 = (value: string) => memoryStore({ [PC_CHECK_KEY]: value }).store;
    const entry = (over: Record<string, unknown> = {}) => ({
      revision: 1,
      build: NOW.build,
      at: NOW.atMs - 1000,
      cores: 8,
      outcome: "done",
      a_fps: 100,
      b_fps: 24,
      c_fps: 70,
      r_hat: 1.25,
      class: "ok",
      ...over,
    });
    const read = (stored: unknown) =>
      readPcCheck(store1(JSON.stringify({ speed: stored })), "speed", NOW);

    it("reads the well-formed entry used below, so the damage cases mean something", () => {
      expect(read(entry())).not.toBeNull();
    });

    it("ignores a value that is not the stored object", () => {
      for (const raw of ["", "garbage", "null", "[]", "42", '"x"', "{", '{"speed":'])
        expect(readPcCheck(store1(raw), "speed", NOW), raw).toBeNull();
      for (const stored of [null, [], "x", 5, true]) expect(read(stored)).toBeNull();
    });

    it("ignores an entry with any one field of the wrong kind or out of range", () => {
      const bad: Record<string, unknown[]> = {
        revision: ["1", 1.5, -1, null, Number.NaN, 2 ** 60],
        build: [1, null, "x".repeat(300), {}],
        at: ["1", null, -5, "now"],
        cores: ["8", 0, -1, 2.5, null, 99999],
        outcome: ["finished", null, 1, "DONE"],
        a_fps: ["1", -1, 1e9, {}],
        b_fps: ["1", -1, 0, null, 1e9],
        c_fps: ["1", -1, 1e9, []],
        r_hat: ["1", -1, 1e9, null],
        class: ["quick", null, 1, "unknown", "unfinished"],
      };
      for (const [field, values] of Object.entries(bad))
        for (const value of values)
          expect(read(entry({ [field]: value })), `${field}=${String(value)}`).toBeNull();
    });

    it("ignores an entry where a field is missing, and a finished check whose parts disagree", () => {
      for (const field of [
        "revision",
        "build",
        "at",
        "cores",
        "outcome",
        "a_fps",
        "b_fps",
        "c_fps",
        "r_hat",
        "class",
      ]) {
        const partial: Record<string, unknown> = entry();
        delete partial[field];
        expect(read(partial), `missing ${field}`).toBeNull();
      }
      expect(read(entry({ outcome: "unfinished" }))).toBeNull();
      expect(
        read(entry({ outcome: "unfinished", b_fps: null, r_hat: null, class: "ok" })),
      ).toBeNull();
      expect(
        read(entry({ outcome: "unfinished", b_fps: null, r_hat: null, class: "unfinished" })),
      ).not.toBeNull();
    });

    it("ignores a huge stored string, even one that starts as valid JSON", () => {
      const valid = JSON.stringify({ speed: entry() });
      expect(readPcCheck(store1(valid), "speed", NOW)).not.toBeNull();
      expect(readPcCheck(store1(valid + " ".repeat(70_000)), "speed", NOW)).toBeNull();
    });

    it("heals: the next good write replaces a damaged value", () => {
      const { store, map } = memoryStore({ [PC_CHECK_KEY]: "garbage" });
      writePcCheck(store, "speed", done());
      expect(readPcCheck(store, "speed", NOW)).toEqual(done());
      expect(() => JSON.parse(map.get(PC_CHECK_KEY)!)).not.toThrow();
    });

    it("drops a damaged entry of another probe when it writes, and keeps its good ones", () => {
      const { store, map } = memoryStore({
        [PC_CHECK_KEY]: JSON.stringify({ broken: { revision: "x" }, good: entry() }),
      });
      writePcCheck(store, "speed", done());
      expect(Object.keys(JSON.parse(map.get(PC_CHECK_KEY)!)).sort()).toEqual(["good", "speed"]);
    });
  });

  it("does not write what is not a well-formed record, and does not throw on one", () => {
    const { store, calls } = memoryStore();
    for (const record of [
      null,
      undefined,
      {},
      done({ cls: "unfinished" }),
      done({ bFps: null }),
      done({ rHat: Number.NaN }),
      { ...done(), build: 7 },
    ])
      expect(() => writePcCheck(store, "speed", record as PcCheckRecord)).not.toThrow();
    expect(calls.set).toBe(0);
    writePcCheck(store, "", done());
    writePcCheck(store, "x".repeat(65), done());
    expect(calls.set).toBe(0);
  });

  it("is not a failure when the storage is off, full, or absent", () => {
    expect(() => writePcCheck(brokenStore("set"), "speed", done())).not.toThrow();
    expect(() => writePcCheck(brokenStore("both"), "speed", done())).not.toThrow();
    expect(() => writePcCheck(null, "speed", done())).not.toThrow();
    expect(readPcCheck(brokenStore("get"), "speed", NOW)).toBeNull();
    expect(readPcCheck(null, "speed", NOW)).toBeNull();
    expect(readPcCheck(memoryStore().store, "speed", null as unknown as PcCheckNow)).toBeNull();
  });

  it("holds at most sixteen probes, newest kept", () => {
    const { store, map } = memoryStore();
    for (let i = 0; i < 40; i++) writePcCheck(store, `probe-${i}`, done());
    expect(Object.keys(JSON.parse(map.get(PC_CHECK_KEY)!))).toHaveLength(16);
    expect(readPcCheck(store, "probe-39", NOW)).not.toBeNull();
    expect(readPcCheck(store, "probe-0", NOW)).toBeNull();
  });

  it("treats __proto__ and constructor as ordinary probe ids", () => {
    const { store } = memoryStore();
    writePcCheck(store, "__proto__", done());
    writePcCheck(store, "constructor", done({ bFps: 3, rHat: 10, cls: "weak" }));
    expect(({} as Record<string, unknown>).revision).toBeUndefined();
    expect(readPcCheck(store, "__proto__", NOW)).toEqual(done());
    expect(readPcCheck(store, "constructor", NOW)?.cls).toBe("weak");
  });
});

describe("checkedRecord and classOfRecord", () => {
  it("accepts what the module writes and nothing else", () => {
    expect(checkedRecord(done())).toEqual(done());
    expect(checkedRecord({ ...done(), extra: 1 })).toEqual(done());
    expect(checkedRecord(null)).toBeNull();
    expect(checkedRecord([])).toBeNull();
    expect(checkedRecord(done({ aFps: null, cFps: null }))).not.toBeNull();
  });

  it("is unknown without a record, unfinished for a check that did not finish, and the class otherwise", () => {
    const { store } = memoryStore();
    expect(classOfRecord(null, store)).toBe("unknown");
    expect(classOfRecord(unfinishedRecord(NOW), store)).toBe("unfinished");
    expect(classOfRecord(done({ rHat: 0.6, cls: "fast" }), store)).toBe("fast");
    expect(classOfRecord(done({ rHat: 2.5, cls: "ok" }), store)).toBe("ok");
    expect(classOfRecord(done({ rHat: 7, cls: "weak" }), store)).toBe("weak");
  });

  it("applies a pair the server moves to a PC that was measured earlier, without measuring again", () => {
    const { store } = memoryStore();
    const measured = done({ rHat: 2.5, cls: "ok" });
    expect(classOfRecord(measured, store)).toBe("ok");
    writeCutoffs(store, { ok_over: 0.5, weak_over: 2 });
    expect(classOfRecord(measured, store)).toBe("weak");
    writeCutoffs(store, { ok_over: 0.1, weak_over: 99 });
    expect(classOfRecord(measured, store)).toBe("weak");
    writeCutoffs(store, { ok_over: 1, weak_over: 4 });
    expect(classOfRecord(measured, store)).toBe("ok");
  });
});
