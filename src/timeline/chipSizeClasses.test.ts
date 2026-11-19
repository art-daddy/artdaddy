// The chip test's size classes as a set (the rules that hold for every class, walked from the table itself) and the third class, "uhd60"
// (3840 by 2160 at 60 frames a second): what its test asks of the chip, what a chip that cannot do it is refused, and what a memory written
// before the class existed still means.
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { __setExportFlag } from "../api/exportFlags";
import { amd, harness, type Behaviour } from "../test/chipHarness";
import {
  CHIP_TEST_REVISION,
  FAIL_TTL_MS,
  TEST_FRAMES,
  __resetChipTests,
  chipEncodeArgs,
  chipStatusOf,
  chipTestSource,
  findChip,
  takeChipTestEvents,
} from "./chipTest";
import { SIZE_CLASSES, SIZE_CLASS_LIMITS, sizeClassOf, type SizeClass } from "./exportEncoder";

const KEY = "artdaddy.chipTest.v1";
const PREFIX = "amd|15bf|32.0.22024.4008";

beforeEach(() => {
  __resetChipTests();
  for (const flag of ["chip_amd", "chip_nvidia", "chip_intel"] as const)
    __setExportFlag(flag, true);
});

/** The 4K commands among what a scripted PC was asked to run. */
const fourK = (calls: { args: string[] }[]) =>
  calls.filter((call) => call.args.join(" ").includes("size=3840x2160"));
const keysOf = (storage: Map<string, string>): string[] =>
  Object.keys(JSON.parse(storage.get(KEY) ?? '{"results":{}}').results);

describe("the size classes, as a set", () => {
  it("has a limit and a test picture for exactly the listed classes, the picture of exactly the class's pixels and long side at exactly its rate", () => {
    expect(Object.keys(SIZE_CLASS_LIMITS).sort()).toEqual([...SIZE_CLASSES].sort());
    for (const cls of SIZE_CLASSES) {
      const [w, h, rate] = /size=(\d+)x(\d+):rate=(\d+)/
        .exec(chipTestSource(cls))!
        .slice(1)
        .map(Number);
      expect(w * h, cls).toBe(SIZE_CLASS_LIMITS[cls].pixels);
      expect(Math.max(w, h), cls).toBe(SIZE_CLASS_LIMITS[cls].longSide);
      expect(rate, cls).toBe(SIZE_CLASS_LIMITS[cls].fps);
    }
    // The same, written out: a class whose picture or rate drifted from what it stands for cannot hide behind a table read twice.
    expect(chipTestSource("hd")).toContain("size=1080x1920:rate=60");
    expect(chipTestSource("uhd")).toContain("size=3840x2160:rate=30");
    expect(chipTestSource("uhd60")).toContain("size=3840x2160:rate=60");
  });

  it("is listed smallest first: the picture never shrinks along the list, and between two classes of one picture size the later has the higher rate", () => {
    for (let i = 1; i < SIZE_CLASSES.length; i++) {
      const before = SIZE_CLASS_LIMITS[SIZE_CLASSES[i - 1]];
      const after = SIZE_CLASS_LIMITS[SIZE_CLASSES[i]];
      expect(after.pixels).toBeGreaterThanOrEqual(before.pixels);
      expect(after.longSide).toBeGreaterThanOrEqual(before.longSide);
      if (after.pixels === before.pixels && after.longSide === before.longSide)
        expect(after.fps).toBeGreaterThan(before.fps);
    }
  });

  // An oracle that does not use the list's order: of the classes whose three limits hold the picture, the one with the smallest picture, then the lowest rate.
  const oracle = (width: number, height: number, fps: number): SizeClass | null => {
    const holding = (Object.keys(SIZE_CLASS_LIMITS) as SizeClass[]).filter((cls) => {
      const limit = SIZE_CLASS_LIMITS[cls];
      return (
        Math.max(width, height) <= limit.longSide &&
        width * height <= limit.pixels &&
        fps <= limit.fps
      );
    });
    holding.sort((a, b) => {
      const [x, y] = [SIZE_CLASS_LIMITS[a], SIZE_CLASS_LIMITS[b]];
      return x.pixels - y.pixels || x.longSide - y.longSide || x.fps - y.fps;
    });
    return holding[0] ?? null;
  };

  it("gives a picture the smallest class that holds it, and no class exactly when none does, over the whole space and at every limit (property)", () => {
    const side = fc.oneof(
      fc.integer({ min: 1, max: 9000 }),
      fc.constantFrom(1080, 1081, 1920, 1921, 2160, 2161, 2560, 1440, 3839, 3840, 3841, 4320, 7680),
    );
    const rate = fc.oneof(
      fc.integer({ min: 1, max: 130 }),
      fc.constantFrom(24, 29, 30, 31, 59, 60, 61),
    );
    fc.assert(
      fc.property(side, side, rate, (width, height, fps) => {
        expect(sizeClassOf(width, height, fps)).toBe(oracle(width, height, fps));
      }),
      { numRuns: 3000 },
    );
  });

  it("serves a picture in a class only when every limit of that class holds it (what the class's test proved is all a chip was asked about)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9000 }),
        fc.integer({ min: 1, max: 9000 }),
        fc.integer({ min: 1, max: 130 }),
        (width, height, fps) => {
          const cls = sizeClassOf(width, height, fps);
          if (cls === null) return;
          expect(Math.max(width, height)).toBeLessThanOrEqual(SIZE_CLASS_LIMITS[cls].longSide);
          expect(width * height).toBeLessThanOrEqual(SIZE_CLASS_LIMITS[cls].pixels);
          expect(fps).toBeLessThanOrEqual(SIZE_CLASS_LIMITS[cls].fps);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("the third class, uhd60", () => {
  it("asks the chip to encode 3840 by 2160 at 60 frames a second, thirty frames of it, with the chip's own arguments", () => {
    const args = chipEncodeArgs("amd", "uhd60", "/t.mp4");
    expect(args).toContain(chipTestSource("uhd60"));
    expect(args[args.indexOf("-r") + 1]).toBe("60");
    expect(chipTestSource("uhd60")).toContain(`duration=${TEST_FRAMES / 60}`);
    expect(args).toContain("h264_amf");
  });

  it("gives it to a chip that passed the 1080p test and its own, runs no test of the 4K class at 30, and tells both tests in order", async () => {
    const h = harness([amd]);
    const found = await findChip("uhd60", { allowRun: true }, h.deps);
    expect(found.chip).toMatchObject({ maker: "amd", sizeClass: "uhd60", ok: true });
    expect(found.events.map((event) => [event.sizeClass, event.result])).toEqual([
      ["hd", "passed"],
      ["uhd60", "passed"],
    ]);
    expect(
      fourK(h.calls).every((call) => call.args.join(" ").includes("rate=60")),
      "every 4K command ran at 60",
    ).toBe(true);
    expect(takeChipTestEvents().map((event) => event.sizeClass)).toEqual(["hd", "uhd60"]);
  });

  it("refuses a chip that cannot do 4K at 60 at that class and only there: 1080p and 4K at 30 stay its classes", async () => {
    // 4K at 30 is 249 million pixels a second and 4K at 60 is 498 million: this chip stops between them.
    const h = harness([amd], { failsAbovePixelRate: 300_000_000 });
    const refused = await findChip("uhd60", { allowRun: true }, h.deps);
    expect(refused.chip).toBeNull();
    expect(refused.events.map((event) => [event.sizeClass, event.result])).toEqual([
      ["hd", "passed"],
      ["uhd60", "encode_failed"],
    ]);
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip).toMatchObject({
      sizeClass: "hd",
    });
    expect((await findChip("uhd", { allowRun: true }, h.deps)).chip).toMatchObject({
      sizeClass: "uhd",
    });
    expect(await chipStatusOf("uhd60", h.deps)).toMatchObject({ verdict: "not_passed" });
    expect(await chipStatusOf("uhd", h.deps)).toMatchObject({ verdict: "passed" });
    expect(await chipStatusOf("hd", h.deps)).toMatchObject({ verdict: "passed" });
  });

  it("remembers that failure for a day without running ffmpeg, and tests only its own class again after the day", async () => {
    const h = harness([amd], { failsAbovePixelRate: 300_000_000 });
    await findChip("uhd60", { allowRun: true }, h.deps);
    const calls = h.calls.length;
    const again = await findChip("uhd60", { allowRun: true }, h.deps);
    expect(again.chip).toBeNull();
    expect(again.events.map((event) => [event.sizeClass, event.result])).toEqual([
      ["hd", "cached_pass"],
      ["uhd60", "cached_fail"],
    ]);
    expect(h.calls.length).toBe(calls);
    h.now.t += FAIL_TTL_MS + 1;
    await findChip("uhd60", { allowRun: true }, h.deps);
    const rerun = h.calls.slice(calls);
    expect(rerun.length).toBeGreaterThan(0);
    // The 1080p pass is good for a month, so only the 4K 60 test runs again: no 1080p picture, and no reference encode.
    expect(rerun.every((call) => call.args.join(" ").includes("size=3840x2160:rate=60"))).toBe(
      true,
    );
  });

  it.each(["uhd", "uhd60"] as const)(
    "offers %s only to a chip that passed 1080p: a remembered pass of the 4K class does not outweigh a failure at 1080p, in the lookup or in the row",
    async (sizeClass) => {
      const h = harness([amd]);
      expect((await findChip(sizeClass, { allowRun: true }, h.deps)).chip).not.toBeNull();
      // The 1080p answer is now a failure (the chip was found worse than the processor there); the 4K pass is still remembered.
      const memory = JSON.parse(h.storage.get(KEY)!) as {
        results: Record<string, { ok: boolean; result: string }>;
      };
      const hdKey = Object.keys(memory.results).find((key) => key.includes("|hd|"))!;
      memory.results[hdKey] = { ...memory.results[hdKey], ok: false, result: "below_x264" };
      h.storage.set(KEY, JSON.stringify(memory));
      const calls = h.calls.length;
      expect((await findChip(sizeClass, { allowRun: false }, h.deps)).chip).toBeNull();
      const status = await chipStatusOf(sizeClass, h.deps);
      expect(status.verdict).toBe("not_passed");
      expect(status.adapters[0].result).toBe("below_x264");
      expect(h.calls.length).toBe(calls);
    },
  );

  it("runs no 4K command for a chip that failed 1080p, and none for one not yet tested when it may not run a test", async () => {
    const bad = harness([amd], { chipSsim: 0.6, referenceSsim: 0.85 }); // worse than the processor at 1080p
    const found = await findChip("uhd60", { allowRun: true }, bad.deps);
    expect(found.chip).toBeNull();
    expect(found.events.map((event) => [event.sizeClass, event.result])).toEqual([
      ["hd", "below_x264"],
    ]);
    expect(fourK(bad.calls)).toEqual([]);

    const fresh = harness([amd]);
    expect(await findChip("uhd60", { allowRun: false }, fresh.deps)).toEqual({
      chip: null,
      events: [],
    });
    expect(fresh.calls).toEqual([]);
  });

  it("keeps the keys of the classes that were there: a pass remembered for 1080p or 4K at 30 is the same entry as before, and the new class has its own", async () => {
    const h = harness([amd]);
    await findChip("uhd60", { allowRun: true }, h.deps);
    await findChip("uhd", { allowRun: true }, h.deps);
    // maker, device, driver, class, release, revision: written out, so that a bumped revision or a moved part is a failure here.
    expect(new Set(keysOf(h.storage))).toEqual(
      new Set([
        `${PREFIX}|hd|artdaddy@0.0.0-test|2`,
        `${PREFIX}|uhd|artdaddy@0.0.0-test|2`,
        `${PREFIX}|uhd60|artdaddy@0.0.0-test|2`,
      ]),
    );
    expect(CHIP_TEST_REVISION).toBe(2);
  });

  it("believes a memory written before the class existed: 1080p and 4K at 30 read back the same, 4K at 60 says nothing and is tested on its own", async () => {
    const h = harness([amd]);
    await findChip("uhd", { allowRun: true }, h.deps); // the memory an older build wrote: entries for hd and uhd only
    const before = JSON.parse(h.storage.get(KEY)!) as { results: Record<string, unknown> };
    expect(Object.keys(before.results)).toHaveLength(2);
    h.calls.length = 0;

    expect((await chipStatusOf("hd", h.deps)).verdict).toBe("passed");
    expect((await chipStatusOf("uhd", h.deps)).verdict).toBe("passed");
    expect(await chipStatusOf("uhd60", h.deps)).toMatchObject({
      verdict: "unknown",
      adapters: [{ adapter: amd, result: null }],
    });
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip?.sizeClass).toBe("hd");
    expect((await findChip("uhd", { allowRun: false }, h.deps)).chip?.sizeClass).toBe("uhd");
    expect((await findChip("uhd60", { allowRun: false }, h.deps)).chip).toBeNull();
    expect(h.calls).toEqual([]);

    // Asked to test it, only the 4K 60 test runs (the 1080p proof is remembered): an encode and a compare, nothing else.
    expect((await findChip("uhd60", { allowRun: true }, h.deps)).chip?.sizeClass).toBe("uhd60");
    expect(h.calls.map((call) => call.kind)).toEqual(["chip-test-encode", "chip-test-compare"]);
    const after = JSON.parse(h.storage.get(KEY)!) as { results: Record<string, unknown> };
    for (const [key, entry] of Object.entries(before.results))
      expect(after.results[key], key).toEqual(entry);
    expect(Object.keys(after.results)).toHaveLength(3);
  });

  it("tests two classes asked at once as two tests that share the 1080p one", async () => {
    const h = harness([amd]);
    const [large, fast] = await Promise.all([
      findChip("uhd", { allowRun: true }, h.deps),
      findChip("uhd60", { allowRun: true }, h.deps),
    ]);
    expect(large.chip?.sizeClass).toBe("uhd");
    expect(fast.chip?.sizeClass).toBe("uhd60");
    const encodes = h.calls.filter((call) => call.kind === "chip-test-encode");
    const at = (fragment: string) =>
      encodes.filter((call) => call.args.join(" ").includes(fragment)).length;
    expect(at("size=1080x1920")).toBe(1);
    expect(at("size=3840x2160:rate=30")).toBe(1);
    expect(at("size=3840x2160:rate=60")).toBe(1);
  });

  it("looks at no class but 1080p and the one asked, whatever the chip does (property over the classes and what the chip does)", async () => {
    const behaviours: Behaviour[] = [
      {},
      { chip: "fail" },
      { chip: "no_device" },
      { chip: "busy" },
      { chipSsim: 0.2 },
      { failsAbovePixelRate: 300_000_000 },
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<SizeClass>(...SIZE_CLASSES),
        fc.constantFrom(...behaviours),
        async (sizeClass, behaviour) => {
          __resetChipTests();
          const h = harness([amd], behaviour);
          const found = await findChip(sizeClass, { allowRun: true }, h.deps);
          for (const event of found.events)
            expect(["hd", sizeClass], JSON.stringify(found.events)).toContain(event.sizeClass);
          if (found.chip) expect(found.chip.sizeClass).toBe(sizeClass);
          // A class above 1080p that was tested made its 1080p test first.
          const classes = found.events.map((event) => event.sizeClass);
          if (classes.includes(sizeClass) && sizeClass !== "hd") expect(classes[0]).toBe("hd");
        },
      ),
      { numRuns: 40 },
    );
  });
});
