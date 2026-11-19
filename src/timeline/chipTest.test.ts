import fc from "fast-check";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHIP_TEST_REVISION,
  FAIL_TTL_MS,
  PASS_TTL_MS,
  SSIM_FLOOR,
  SSIM_PARITY_MARGIN,
  TEST_FRAMES,
  __resetChipTests,
  chipEncodeArgs,
  chipStatusOf,
  chipTestSource,
  encodeFailure,
  findChip,
  judge,
  markChipSuspect,
  readSsim,
  referenceEncodeArgs,
  setChipTestGate,
  ssimArgs,
  takeChipTestEvents,
  type ChipDeps,
} from "./chipTest";
import {
  CHIP_MAKERS,
  SIZE_CLASS_LIMITS,
  chipVideoArgs,
  type ChipMaker,
  type SizeClass,
} from "./exportEncoder";
import { buildRenderCommand } from "./render";
import type { Timeline } from "./model";
import { __setExportFlag } from "../api/exportFlags";
import { EXPORT_TRACE_VALUES } from "../api/exportVocabulary";
import { amd, harness, intel, nvidia, ssimText, type Behaviour } from "../test/chipHarness";
import { CHIP_PREF_KEY } from "./chipPref";
import { chipAdvice } from "./chipAdvice";

beforeEach(() => {
  __resetChipTests();
  for (const flag of ["chip_amd", "chip_nvidia", "chip_intel"] as const)
    __setExportFlag(flag, true);
});

describe("what the test asks ffmpeg to do", () => {
  // The picture each class's test encodes is the largest the class admits, at the fastest frame rate it admits: no admitted
  // export is bigger or faster than what was proved (review finding 1, second pass: a 60 fps export was served by a chip
  // that had only been tried at 30).
  it("tests each size class at the largest picture the class admits, at exactly the frame rate the class admits", () => {
    for (const cls of ["hd", "uhd"] as const) {
      const [w, h] = /size=(\d+)x(\d+)/.exec(chipTestSource(cls))!.slice(1).map(Number);
      expect(Math.max(w, h), cls).toBe(SIZE_CLASS_LIMITS[cls].longSide);
      expect(w * h, cls).toBe(SIZE_CLASS_LIMITS[cls].pixels);
      const fps = Number(/rate=(\d+)/.exec(chipTestSource(cls))![1]);
      expect(fps, cls).toBe(SIZE_CLASS_LIMITS[cls].fps);
      // Every command of the test says the same rate: the chip's encode, the processor's reference and the compare's source.
      const rateOf = (args: string[]) => args[args.indexOf("-r") + 1];
      expect(rateOf(chipEncodeArgs("amd", cls, "/t.mp4")), cls).toBe(String(fps));
      expect(rateOf(referenceEncodeArgs(cls, "/r.mp4")), cls).toBe(String(fps));
      expect(ssimArgs("/t.mp4", cls).join(" "), cls).toContain(`rate=${fps}`);
    }
  });

  it("is the export's own encoder arguments, for every maker, so the test can never prove other arguments than the ones that run", () => {
    // The test builds its command from the same table; the export's command is built by the real command builder, for a
    // project at the frame rate the class is tested at.
    const oneClip = {
      canvas: { width: 1080, height: 1920, fps: SIZE_CLASS_LIMITS.hd.fps },
      tracks: [
        {
          id: "v0",
          kind: "video",
          z: 0,
          clips: [
            {
              media_ref: "/v.mp4",
              kind: "video",
              source_in: 0,
              source_out: 4,
              timeline_in: 0,
              timeline_out: 4,
            },
          ],
        },
      ],
    } as unknown as Timeline;
    const section = (args: string[]) => {
      const from = args.lastIndexOf("-c:v");
      const to = args.findIndex(
        (part, index) => index > from && (part === "-an" || part === "-c:a"),
      );
      return args.slice(from, to);
    };
    for (const maker of CHIP_MAKERS) {
      const exported = buildRenderCommand(oneClip, "/o.mp4", {
        mode: "fast",
        chip: maker,
        quality: "medium",
      });
      const tested = chipEncodeArgs(maker, "hd", "/t.mp4");
      expect(section(tested), maker).toEqual(section(exported.args));
    }
  });

  /** How many frames a test source makes: its rate times its length, read from the filter text. */
  const framesOf = (source: string): number =>
    Math.round(
      Number(/rate=(\d+)/.exec(source)![1]) * Number(/duration=([0-9.]+)/.exec(source)![1]),
    );

  it("encodes thirty frames of a textured synthetic clip at the class's size, once, to the file it is given", () => {
    for (const [cls, size] of [
      ["hd", "1080x1920"],
      ["uhd", "3840x2160"],
    ] as const) {
      expect(chipTestSource(cls)).toContain(`size=${size}`);
      expect(framesOf(chipTestSource(cls)), cls).toBe(TEST_FRAMES);
      expect(chipTestSource(cls)).toContain("noise=");
      const args = chipEncodeArgs("amd", cls, "C:/cache/chip-test/x.mp4");
      expect(args).toContain("-nostdin");
      expect(args[args.length - 1]).toBe("C:/cache/chip-test/x.mp4");
      expect(args).toContain("-y");
      expect(args).toContain("-an");
    }
  });

  it("compares against a source longer than the file and ends with the file, so the frame count it reports is the file's own", () => {
    for (const cls of ["hd", "uhd"] as const) {
      const args = ssimArgs("/t.mp4", cls);
      expect(args.join(" ")).toContain("ssim=shortest=1");
      const longer = chipTestSource(cls, TEST_FRAMES * 2);
      expect(args, cls).toContain(longer);
      expect(framesOf(longer), cls).toBe(TEST_FRAMES * 2);
      expect(framesOf(chipTestSource(cls)), cls).toBe(TEST_FRAMES); // the encode itself is thirty frames
      // The first thirty frames are the same picture whatever the length: only the duration differs.
      const length = (source: string) => /duration=([0-9.]+)/.exec(source)![1];
      expect(
        longer.replace(`duration=${length(longer)}`, `duration=${length(chipTestSource(cls))}`),
        cls,
      ).toBe(chipTestSource(cls));
    }
  });

  it("compares the chip's file with the same source, and the processor's reference at Medium", () => {
    const reference = referenceEncodeArgs("hd", "/r.mp4");
    expect(reference).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-preset", "medium", "-crf", "23"]),
    );
    const ssim = ssimArgs("/t.mp4", "hd");
    expect(ssim).toEqual(expect.arrayContaining(["-i", "/t.mp4", "-f", "lavfi"]));
    expect(ssim.join(" ")).toContain("ssim");
    expect(ssim.slice(-3)).toEqual(["-f", "null", "-"]);
    // The pixel layout every maker takes is stated by the table, not repeated here.
    for (const maker of CHIP_MAKERS)
      expect(chipEncodeArgs(maker, "hd", "/t.mp4")).toContain(
        chipVideoArgs(maker, "medium").pixFmt,
      );
  });
});

describe("reading ffmpeg's answer", () => {
  it("reads the score and the frames of a real compare pass, and nothing from a text that is not one", () => {
    expect(readSsim(ssimText(0.870733))).toEqual({ ssim: 0.870733, frames: 30 });
    expect(readSsim("")).toEqual({ ssim: null, frames: null });
    expect(readSsim("SSIM All:abc")).toEqual({ ssim: null, frames: null });
    expect(readSsim("frame=  7 x\nframe=  30 y\n")).toEqual({ ssim: null, frames: 30 }); // the last count is the total
    fc.assert(
      fc.property(fc.string(), (text) => {
        const { ssim, frames } = readSsim(text);
        if (ssim !== null) expect(ssim >= 0 && ssim <= 1 && Number.isFinite(ssim)).toBe(true);
        if (frames !== null) expect(Number.isInteger(frames) && frames >= 0).toBe(true);
      }),
    );
  });

  it("reads back exactly what a compare pass reported, among any other lines", () => {
    const noise = fc.string().filter((line) => !/frame=|All:|SSIM/i.test(line));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }).map((milli) => milli / 1000),
        fc.integer({ min: 0, max: 99_999 }),
        noise,
        noise,
        (score, frames, before, after) => {
          const seen = readSsim(`${before}\n${ssimText(score, frames)}${after}\n`);
          expect(seen.frames).toBe(frames);
          expect(seen.ssim).toBeCloseTo(score, 6);
        },
      ),
    );
  });
});

describe("what a result means", () => {
  const ok = { code: 0, frames: TEST_FRAMES, ssim: 0.87, reference: 0.79 };
  it("is passed for a sound file that is as good as the processor's, and says why otherwise", () => {
    expect(judge(ok)).toBe("passed");
    expect(judge({ ...ok, reference: null })).toBe("passed"); // the 4K class does not run the reference
    expect(judge({ ...ok, ssim: SSIM_FLOOR, reference: null })).toBe("passed"); // the floor itself is allowed
    expect(judge({ ...ok, ssim: SSIM_FLOOR - 0.01, reference: null })).toBe("garbled");
    expect(judge({ ...ok, ssim: 0.2 })).toBe("garbled");
    expect(judge({ ...ok, ssim: null })).toBe("garbled");
    expect(judge({ ...ok, frames: TEST_FRAMES - 1 })).toBe("wrong_frames");
    expect(judge({ ...ok, frames: null })).toBe("wrong_frames");
    expect(judge({ ...ok, code: 1 })).toBe("garbled"); // the compare pass could not read the file
    // Parity: no worse than the processor by more than the margin.
    expect(judge({ ...ok, ssim: 0.79 - SSIM_PARITY_MARGIN, reference: 0.79 })).toBe("passed");
    expect(judge({ ...ok, ssim: 0.79 - SSIM_PARITY_MARGIN - 0.01, reference: 0.79 })).toBe(
      "below_x264",
    );
  });

  it("never passes a file that is the wrong length, unreadable or scored under the floor, whatever else is true", () => {
    // Weighted towards the valid shape, so most runs reach the rules that follow the cheap ones.
    const codes = fc.oneof(
      { weight: 4, arbitrary: fc.constant(0) },
      fc.integer({ min: -1, max: 3 }),
    );
    const counts = fc.oneof(
      { weight: 4, arbitrary: fc.constant<number | null>(TEST_FRAMES) },
      fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
    );
    // Scores on the real line (thousandths): fc.double is uniform over bit patterns and almost never lands near 0.6 to 1.
    const scores = fc.option(
      fc.integer({ min: 0, max: 1000 }).map((milli) => milli / 1000),
      { nil: null },
    );
    fc.assert(
      fc.property(codes, counts, scores, scores, (code, frames, ssim, reference) => {
        const result = judge({ code, frames, ssim, reference });
        if (result === "passed") {
          expect(code).toBe(0);
          expect(frames).toBe(TEST_FRAMES);
          expect(ssim).not.toBeNull();
          expect(ssim!).toBeGreaterThanOrEqual(SSIM_FLOOR);
          if (reference !== null)
            expect(ssim!).toBeGreaterThanOrEqual(reference - SSIM_PARITY_MARGIN);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("passes every sound file that is as good as the processor's, whatever the numbers (nothing legitimate is refused)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Math.round(SSIM_FLOOR * 1000), max: 1000 }).map((milli) => milli / 1000),
        fc.option(
          fc.integer({ min: 0, max: 1000 }).map((milli) => milli / 1000),
          { nil: null },
        ),
        (ssim, reference) => {
          fc.pre(reference === null || ssim >= reference - SSIM_PARITY_MARGIN);
          expect(judge({ code: 0, frames: TEST_FRAMES, ssim, reference })).toBe("passed");
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("finding a graphics chip that can be trusted", () => {
  it("tests the chip once, says it passed, and then answers from what it remembers without running anything", async () => {
    const h = harness([amd]);
    const first = await findChip("hd", { allowRun: true }, h.deps);
    expect(first.chip).toMatchObject({ maker: "amd", sizeClass: "hd", ok: true, result: "passed" });
    expect(first.events).toEqual([expect.objectContaining({ maker: "amd", result: "passed" })]);
    const callsAfterFirst = h.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const again = await findChip("hd", { allowRun: true }, h.deps);
    expect(again.chip).toMatchObject({ maker: "amd", ok: true });
    expect(again.events).toEqual([expect.objectContaining({ result: "cached_pass" })]);
    expect(h.calls.length).toBe(callsAfterFirst);
  });

  it("runs the chip's encode and compare, and the processor's reference at the 1080p class only", async () => {
    const hd = harness([amd]);
    await findChip("hd", { allowRun: true }, hd.deps);
    expect(hd.calls.map((call) => call.kind)).toEqual([
      "chip-test-encode",
      "chip-test-compare",
      "chip-test-encode-ref",
      "chip-test-compare-ref",
    ]);
    const uhd = harness([amd]);
    await findChip("uhd", { allowRun: true }, uhd.deps);
    // The 4K class needs the 1080p class's parity proof first, then runs its own encode and compare only.
    expect(uhd.calls.map((call) => call.kind)).toEqual([
      "chip-test-encode",
      "chip-test-compare",
      "chip-test-encode-ref",
      "chip-test-compare-ref",
      "chip-test-encode",
      "chip-test-compare",
    ]);
  });

  it("removes the files it made, whether the chip passed or not", async () => {
    for (const behaviour of [{}, { chip: "fail" }, { chipSsim: 0.1 }] as Behaviour[]) {
      const h = harness([amd], behaviour);
      await findChip("hd", { allowRun: true }, h.deps);
      expect(h.removed.length).toBeGreaterThan(0);
      expect(h.removed.every((path) => path.startsWith("C:/cache/chip-test"))).toBe(true);
    }
  });

  it("is no chip, and runs nothing, on a PC that reported none", async () => {
    const h = harness([]);
    const found = await findChip("hd", { allowRun: true }, h.deps);
    expect(found).toEqual({ chip: null, events: [] });
    expect(h.calls).toEqual([]);
  });

  it("only uses what is already known when it is told not to run a test", async () => {
    const h = harness([amd]);
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip).toBeNull();
    expect(h.calls).toEqual([]);
    await findChip("hd", { allowRun: true }, h.deps);
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip).toMatchObject({
      maker: "amd",
    });
  });

  it.each([
    ["the encode fails", { chip: "fail" }, "encode_failed"],
    ["the encode says there is no device", { chip: "no_device" }, "no_device"],
    ["the encode does not finish", { chip: "slow" }, "timed_out"],
    ["the file cannot be read back", { decodeFails: true }, "garbled"],
    ["the picture is garbage", { chipSsim: 0.15 }, "garbled"],
    ["the file has the wrong number of frames", { chipFrames: 29 }, "wrong_frames"],
    [
      "the picture is worse than the processor's",
      { chipSsim: 0.6, referenceSsim: 0.85 },
      "below_x264",
    ],
  ] as const)(
    "is no chip when %s, and remembers that for a day",
    async (_name, behaviour, result) => {
      const h = harness([amd], behaviour);
      const first = await findChip("hd", { allowRun: true }, h.deps);
      expect(first.chip).toBeNull();
      expect(first.events).toEqual([expect.objectContaining({ maker: "amd", result })]);
      const calls = h.calls.length;
      const again = await findChip("hd", { allowRun: true }, h.deps);
      expect(again.chip).toBeNull();
      expect(again.events).toEqual([expect.objectContaining({ result: "cached_fail" })]);
      expect(h.calls.length).toBe(calls); // not tested again within the day
      h.now.t += FAIL_TTL_MS + 1;
      await findChip("hd", { allowRun: true }, h.deps);
      expect(h.calls.length).toBeGreaterThan(calls); // a new day, a new test
    },
  );

  it("does not remember that it could not test (an export was running, or it was stopped), and tests again later", async () => {
    for (const mode of ["busy", "stopped"] as const) {
      const h = harness([amd], { chip: mode });
      const first = await findChip("hd", { allowRun: true }, h.deps);
      expect(first.chip).toBeNull();
      const calls = h.calls.length;
      await findChip("hd", { allowRun: true }, h.deps);
      expect(h.calls.length, mode).toBeGreaterThan(calls);
    }
    const busy = harness([amd], { chip: "busy" });
    expect((await findChip("hd", { allowRun: true }, busy.deps)).events).toEqual([
      expect.objectContaining({ result: "skipped_busy" }),
    ]);
  });

  it("remembers a pass for a month, and tests again after a driver update, a new app version or a new test", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    const calls = h.calls.length;
    h.now.t += PASS_TTL_MS - 1000;
    await findChip("hd", { allowRun: true }, h.deps);
    expect(h.calls.length).toBe(calls);
    h.now.t += 2000;
    await findChip("hd", { allowRun: true }, h.deps);
    expect(h.calls.length).toBeGreaterThan(calls);
    // A new driver, and a new app build, are other keys.
    const more = h.calls.length;
    const updated = { ...h.deps, adapters: async () => [{ ...amd, driver: "32.0.99999.1" }] };
    await findChip("hd", { allowRun: true }, updated);
    expect(h.calls.length).toBeGreaterThan(more);
    const afterDriver = h.calls.length;
    await findChip("hd", { allowRun: true }, { ...h.deps, release: "artdaddy@9.9.9" });
    expect(h.calls.length).toBeGreaterThan(afterDriver);
    expect(CHIP_TEST_REVISION).toBeGreaterThanOrEqual(1);
  });

  it("does not trust a result that an older revision of the test made", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    const calls = h.calls.length;
    const memory = JSON.parse(h.storage.get("artdaddy.chipTest.v1")!) as {
      results: Record<string, unknown>;
    };
    // The same results, as if they had been made one revision ago (the revision is the last part of the key).
    const older = Object.fromEntries(
      Object.entries(memory.results).map(([key, value]) => [
        key.replace(/\|\d+$/, `|${CHIP_TEST_REVISION - 1}`),
        value,
      ]),
    );
    h.storage.set("artdaddy.chipTest.v1", JSON.stringify({ ...memory, results: older }));
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    expect(h.calls.length).toBeGreaterThan(calls);
  });

  it("tries the makers in order of preference and uses the first that passes, falling through one that fails", async () => {
    const h = harness([intel, amd, nvidia], {});
    const seen: string[] = [];
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) => {
        if (options.kind === "chip-test-encode") seen.push(args[args.indexOf("-c:v") + 1]);
        // NVIDIA's encode fails; AMD's passes.
        if (options.kind === "chip-test-encode" && args.includes("h264_nvenc"))
          return { kind: "ran", code: 1, stdout: "", stderr: "failed", ms: 3 };
        return h.deps.probe(args, options);
      },
    };
    const found = await findChip("hd", { allowRun: true }, deps);
    expect(found.chip?.maker).toBe("amd");
    expect(seen).toEqual(["h264_nvenc", "h264_amf"]); // Intel was never tried: AMD passed before it
    expect(found.events.map((event) => [event.maker, event.result])).toEqual([
      ["nvidia", "encode_failed"],
      ["amd", "passed"],
    ]);
  });

  it("never tests a maker whose switch the server turned off, and never offers its chip from the cache either", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    __setExportFlag("chip_amd", false);
    const calls = h.calls.length;
    expect(await findChip("hd", { allowRun: true }, h.deps)).toEqual({ chip: null, events: [] });
    expect(h.calls.length).toBe(calls);
    __setExportFlag("chip_amd", true);
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
  });

  it("does not offer a chip under suspicion for a day (it failed in a real export), and does again after", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    markChipSuspect(amd, h.deps);
    const calls = h.calls.length;
    const suspect = await findChip("hd", { allowRun: true }, h.deps);
    expect(suspect.chip).toBeNull();
    expect(h.calls.length).toBe(calls);
    h.now.t += 24 * 3_600_000 + 1;
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
  });

  // Found by the second review: the 1080p class admits 60 frames a second and its test ran at 30, so a chip that could not
  // keep up at 60 was handed a 1080p60 export on the strength of a 30 fps pass.
  it("does not hand the 1080p class to a chip that only managed a slower frame rate than the class admits", async () => {
    const slow = harness([amd], { failsAboveFps: 30 });
    const found = await findChip("hd", { allowRun: true }, slow.deps);
    expect(found.chip).toBeNull();
    expect(found.events).toEqual([
      expect.objectContaining({ maker: "amd", result: "encode_failed" }),
    ]);
    const encode = slow.calls.find((call) => call.kind === "chip-test-encode")!;
    expect(encode.args[encode.args.indexOf("-r") + 1]).toBe(String(SIZE_CLASS_LIMITS.hd.fps));
    // A chip that manages the class's own rate passes, and so does one that manages more.
    for (const limit of [SIZE_CLASS_LIMITS.hd.fps, 120]) {
      const fine = harness([amd], { failsAboveFps: limit });
      expect((await findChip("hd", { allowRun: true }, fine.deps)).chip?.maker).toBe("amd");
    }
    // The 4K class is tested at its own rate: a chip that cannot do 4K at that rate is refused there, and only there.
    const uhdLimit = harness([amd], { failsAboveFps: SIZE_CLASS_LIMITS.uhd.fps - 1 });
    expect((await findChip("uhd", { allowRun: true }, uhdLimit.deps)).chip).toBeNull();
  });

  // Found by the second review: the test changed meaning (the rate, and how the frames are counted) while its revision
  // stood at 1, so a pass remembered by the weaker test would have been believed by a build with the same version number.
  it("is a later revision than the first test, and a pass the first test remembered is tested again", async () => {
    expect(CHIP_TEST_REVISION).toBeGreaterThan(1);
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    const calls = h.calls.length;
    const memory = JSON.parse(h.storage.get("artdaddy.chipTest.v1")!) as {
      results: Record<string, unknown>;
    };
    const first = Object.fromEntries(
      Object.entries(memory.results).map(([key, value]) => [key.replace(/\|\d+$/, "|1"), value]),
    );
    h.storage.set("artdaddy.chipTest.v1", JSON.stringify({ ...memory, results: first }));
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    expect(h.calls.length).toBeGreaterThan(calls);
  });

  it("gives the 4K class only to a chip that was good enough for the 1080p class", async () => {
    const bad = harness([amd], { chipSsim: 0.6, referenceSsim: 0.85 }); // fails parity at 1080p
    const found = await findChip("uhd", { allowRun: true }, bad.deps);
    expect(found.chip).toBeNull();
    expect(bad.calls.every((call) => !call.args.join(" ").includes("3840x2160"))).toBe(true); // 4K was never tried
    const good = harness([amd]);
    expect((await findChip("uhd", { allowRun: true }, good.deps)).chip).toMatchObject({
      maker: "amd",
      sizeClass: "uhd",
    });
  });

  it("runs one test however many callers ask at once", async () => {
    const h = harness([amd]);
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map(() => findChip("hd", { allowRun: true }, h.deps)),
    );
    expect([a.chip?.maker, b.chip?.maker, c.chip?.maker]).toEqual(["amd", "amd", "amd"]);
    expect(h.calls.filter((call) => call.kind === "chip-test-encode")).toHaveLength(1);
  });

  // Found by review: the comparison with the processor's own encode is what keeps a chip that is worse than x264 out. When that
  // comparison cannot be made, the chip is not proven; it must not pass because the reference said nothing.
  it.each([
    ["exits with an error", "fails"],
    ["says nothing readable", "unreadable"],
    ["reports the wrong number of frames", "short"],
  ] as const)(
    "does not pass a chip when the comparison with the processor's encode %s, and remembers that for a day",
    async (_name, referenceCompare) => {
      const h = harness([amd], { referenceCompare });
      const found = await findChip("hd", { allowRun: true }, h.deps);
      expect(found.chip).toBeNull();
      expect(found.events).toEqual([
        expect.objectContaining({ maker: "amd", result: "timed_out" }),
      ]);
      const calls = h.calls.length;
      expect((await findChip("hd", { allowRun: true }, h.deps)).events).toEqual([
        expect.objectContaining({ result: "cached_fail" }),
      ]);
      expect(h.calls.length).toBe(calls);
    },
  );

  it("does not need a reference at the 4K class: it passes the chip that has already passed at 1080p", async () => {
    // The reference is only made at 1080p, so a broken one there must not be a way round it, and 4K needs none of its own.
    const good = harness([amd]);
    expect((await findChip("uhd", { allowRun: true }, good.deps)).chip?.sizeClass).toBe("uhd");
  });

  // Found by review: a remembered answer that is the right shape but not true to the rules must be tested again, never believed.
  describe("a damaged memory", () => {
    const KEY = "artdaddy.chipTest.v1";
    /** The memory after one real test, edited by `change` the way a damaged or tampered file would be. */
    async function damaged(change: (memory: Record<string, any>, key: string) => void) {
      const h = harness([amd]);
      await findChip("hd", { allowRun: true }, h.deps);
      const memory = JSON.parse(h.storage.get(KEY)!);
      const [key] = Object.keys(memory.results);
      change(memory, key);
      h.storage.set(KEY, JSON.stringify(memory));
      const before = h.calls.length;
      const found = await findChip("hd", { allowRun: true }, h.deps);
      return { found, h, tested: h.calls.length > before };
    }

    it.each([
      ["an ok that is not a boolean", (m: any, k: string) => (m.results[k].ok = "yes")],
      [
        "an ok that disagrees with the result",
        (m: any, k: string) => (m.results[k].result = "garbled"),
      ],
      ["a result nobody knows", (m: any, k: string) => (m.results[k].result = "great")],
      ["a time that is not a number", (m: any, k: string) => (m.results[k].at = "now")],
      ["a time from the future", (m: any, k: string) => (m.results[k].at += 3_600_000)],
      ["a score that is not a number", (m: any, k: string) => (m.results[k].ssimMilli = null)],
      ["a score out of range", (m: any, k: string) => (m.results[k].ssimMilli = 5000)],
      ["an entry that is not an object", (m: any, k: string) => (m.results[k] = "passed")],
    ])("is tested again, not believed: %s", async (_name, change) => {
      const { tested, found } = await damaged(change);
      expect(tested).toBe(true);
      expect(found.chip?.maker).toBe("amd"); // the retest is a real one, and passed
    });

    it("does not let a suspect time far in the future keep a good chip away for ever", async () => {
      const h = harness([amd]);
      await findChip("hd", { allowRun: true }, h.deps);
      const memory = JSON.parse(h.storage.get(KEY)!);
      memory.suspect = { "amd|15bf|32.0.22024.4008": h.now.t + 365 * 86_400_000 };
      h.storage.set(KEY, JSON.stringify(memory));
      expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    });

    it("keeps a genuine suspicion, and a genuine pass, exactly as they were", async () => {
      const h = harness([amd]);
      await findChip("hd", { allowRun: true }, h.deps);
      markChipSuspect(amd, h.deps);
      expect((await findChip("hd", { allowRun: true }, h.deps)).chip).toBeNull();
      h.now.t += 24 * 3_600_000 + 1000;
      expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    });
  });

  // Found by review: where the remembered answer cannot be written (storage off or full) a chip that failed an export must
  // still be set aside for this run of the app, or the same broken chip is offered again at once.
  it("keeps a chip set aside for this run of the app even when the suspicion cannot be written down", async () => {
    const h = harness([amd]);
    const broken: ChipDeps = {
      ...h.deps,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    };
    expect((await findChip("hd", { allowRun: true }, broken)).chip?.maker).toBe("amd");
    markChipSuspect(amd, broken);
    expect((await findChip("hd", { allowRun: true }, broken)).chip).toBeNull();
    expect((await findChip("hd", { allowRun: false }, broken)).chip).toBeNull();
  });

  // Found by the second review: the in-memory list reads the clock directly, so a chip set aside while the clock was far ahead
  // stayed set aside for years once the clock was put right (the written memory already refuses a time that far ahead).
  it("does not keep a chip set aside for years because the clock was ahead when it was set aside", async () => {
    const h = harness([amd], {}, { t: Date.UTC(2030, 0, 1) });
    markChipSuspect(amd, h.deps);
    h.now.t = Date.UTC(2026, 10, 7); // the clock is put right, and the app has not been restarted
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip?.maker).toBe("amd");
    // A suspicion set now, on a right clock, still holds, whether or not the memory can be written.
    const right = harness([amd], {}, { t: Date.UTC(2026, 10, 7) });
    const broken: ChipDeps = {
      ...right.deps,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    };
    markChipSuspect({ ...amd, device: "other" }, broken);
    expect(
      (
        await findChip(
          "hd",
          { allowRun: true },
          { ...broken, adapters: async () => [{ ...amd, device: "other" }] },
        )
      ).chip,
    ).toBeNull();
  });

  it("keeps the result of every test one dialog can run, for the export that follows: two classes for each of eight chips", async () => {
    const chips = Array.from({ length: 8 }, (_, i) => ({ ...amd, device: `15b${i}` }));
    const h = harness(chips);
    // Every chip passes at 1080p and fails at 4K: sixteen results, the most one look can make.
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) =>
        options.kind === "chip-test-encode" && args.join(" ").includes("3840x2160")
          ? { kind: "ran", code: 1, stdout: "", stderr: "Error while opening encoder", ms: 3 }
          : h.deps.probe(args, options),
    };
    expect((await findChip("uhd", { allowRun: true }, deps)).chip).toBeNull();
    const told = takeChipTestEvents();
    expect(told).toHaveLength(16);
    expect(told.filter((event) => event.result === "passed")).toHaveLength(8);
  });

  it("lets a caller stop waiting without stopping the test: it finishes, is remembered, and the next caller has it", async () => {
    const h = harness([amd]);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const slow: ChipDeps = {
      ...h.deps,
      probe: async (args, options) => {
        if (options.kind === "chip-test-encode") await gate;
        return h.deps.probe(args, options);
      },
    };
    const stopWaiting = new AbortController();
    const waiting = findChip("hd", { allowRun: true, signal: stopWaiting.signal }, slow);
    await Promise.resolve();
    stopWaiting.abort();
    expect(await waiting).toEqual({ chip: null, events: [] }); // it did not wait for the test
    // A second caller (the export, after the dialog was closed) joins the same test and gets the answer.
    const joined = findChip("hd", { allowRun: true }, slow);
    open();
    expect((await joined).chip?.maker).toBe("amd");
    expect(h.calls.filter((call) => call.kind === "chip-test-encode")).toHaveLength(1);
    // And it is remembered: nothing runs for a caller that only reads.
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip?.maker).toBe("amd");
  });

  it("does not go on to the next chip once the caller has stopped waiting", async () => {
    const h = harness([nvidia, amd], { chip: "fail" });
    const stopWaiting = new AbortController();
    const probes: string[] = [];
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) => {
        if (options.kind === "chip-test-encode") {
          probes.push(args[args.indexOf("-c:v") + 1]);
          stopWaiting.abort(); // the caller gives up while the first chip is being tested
        }
        return h.deps.probe(args, options);
      },
    };
    const found = await findChip("hd", { allowRun: true, signal: stopWaiting.signal }, deps);
    expect(found.chip).toBeNull();
    expect(probes).toEqual(["h264_nvenc"]); // AMD was not tried for a caller who had left
  });

  it("hands the results of the tests that really ran to whoever asks next, once, and never a remembered answer", async () => {
    const h = harness([amd]);
    expect(takeChipTestEvents()).toEqual([]);
    await findChip("hd", { allowRun: true }, h.deps); // ran (as the Export dialog opens)
    await findChip("hd", { allowRun: true }, h.deps); // remembered
    expect(takeChipTestEvents()).toEqual([
      expect.objectContaining({ maker: "amd", sizeClass: "hd", result: "passed" }),
    ]);
    expect(takeChipTestEvents()).toEqual([]); // told once
  });

  it("keeps only a bounded number of untold results (the most one look can make), the newest", async () => {
    for (let round = 0; round < 40; round++) {
      const h = harness([amd], { chip: "fail" });
      await findChip("hd", { allowRun: true }, h.deps);
    }
    expect(takeChipTestEvents()).toHaveLength(16);
  });

  it("copes with a damaged memory, and with storage that throws", async () => {
    const h = harness([amd]);
    h.storage.set("artdaddy.chipTest.v1", "not json {");
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip?.maker).toBe("amd");
    const broken: ChipDeps = {
      ...h.deps,
      storage: {
        getItem: () => {
          throw new Error("no storage");
        },
        setItem: () => {
          throw new Error("no storage");
        },
      },
    };
    expect((await findChip("hd", { allowRun: true }, broken)).chip?.maker).toBe("amd");
  });

  it("never throws, whatever the PC or ffmpeg does", async () => {
    const h = harness([amd]);
    const boom: ChipDeps = {
      ...h.deps,
      adapters: async () => {
        throw new Error("the app process is gone");
      },
    };
    expect(await findChip("hd", { allowRun: true }, boom)).toEqual({ chip: null, events: [] });
    const explode: ChipDeps = {
      ...h.deps,
      probe: async () => {
        throw new Error("supervisor exploded");
      },
    };
    const found = await findChip("hd", { allowRun: true }, explode);
    expect(found.chip).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (await findChip("hd", { allowRun: true, signal: aborted.signal }, h.deps)).chip,
    ).toBeNull();
  });

  it("only ever reports a maker it knows and a size class it knows", async () => {
    const h = harness([amd, nvidia, intel], { chip: "fail" });
    const found = await findChip("hd", { allowRun: true }, h.deps);
    for (const event of found.events) {
      expect(CHIP_MAKERS as readonly string[]).toContain(event.maker);
      expect(["hd", "uhd"] as SizeClass[]).toContain(event.sizeClass);
      expect(Number.isFinite(event.ms) && event.ms >= 0).toBe(true);
    }
    vi.restoreAllMocks();
    const _maker: ChipMaker = "amd";
    expect(_maker).toBe("amd");
  });
});

// The PC check and the chip test each run ffmpeg on the processor: one at a time. The app registers the check's one slot, and a test that must really run takes a
// turn in it; everything the test decides, remembers and reports is unchanged, and with no slot registered it runs as it always did.
describe("the chip test takes its turn", () => {
  type Turn = { ran: true; value: never } | { ran: false };
  /** A slot that is held by someone until `open()`: the test asked for its turn waits behind it. */
  function slot(mode: "granted" | "never" | "broken" = "granted") {
    const asked: string[] = [];
    let open!: () => void;
    const held = new Promise<void>((resolve) => (open = resolve));
    const gate = async (fn: () => Promise<unknown>): Promise<Turn> => {
      asked.push("asked");
      if (mode === "broken") throw new Error("the slot is gone");
      await held;
      if (mode === "never") return { ran: false };
      return { ran: true, value: (await fn()) as never };
    };
    return { gate, asked, open: () => open() };
  }

  it("runs nothing until its turn is given, and then runs exactly as it would have", async () => {
    const h = harness([amd]);
    const turn = slot();
    setChipTestGate(turn.gate);
    const lookup = findChip("hd", { allowRun: true }, h.deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turn.asked).toEqual(["asked"]);
    expect(h.calls).toEqual([]);
    turn.open();
    const found = await lookup;
    expect(found.chip).toMatchObject({ maker: "amd", sizeClass: "hd", ok: true, result: "passed" });
    expect(h.calls.map((call) => call.kind)).toEqual([
      "chip-test-encode",
      "chip-test-compare",
      "chip-test-encode-ref",
      "chip-test-compare-ref",
    ]);
  });

  it("asks for one turn however many ask for the same test, and none for an answer it remembers or when it may not run", async () => {
    const h = harness([amd]);
    const turn = slot();
    turn.open();
    setChipTestGate(turn.gate);
    await findChip("hd", { allowRun: false }, h.deps);
    expect(turn.asked).toEqual([]);
    await Promise.all([
      findChip("hd", { allowRun: true }, h.deps),
      findChip("hd", { allowRun: true }, h.deps),
    ]);
    expect(turn.asked).toEqual(["asked"]);
    await findChip("hd", { allowRun: true }, h.deps); // remembered now
    expect(turn.asked).toEqual(["asked"]);
  });

  it("lets a caller stop waiting for the turn without cancelling the shared test: it runs when its turn comes and its answer is kept", async () => {
    const h = harness([amd]);
    const turn = slot();
    setChipTestGate(turn.gate);
    const stop = new AbortController();
    const lookup = findChip("hd", { allowRun: true, signal: stop.signal }, h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    expect((await lookup).chip).toBeNull();
    // the test is shared and goes on once the turn comes, and its answer is kept for the next caller
    turn.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip).toMatchObject({
      maker: "amd",
    });
  });

  it.each(["never", "broken"] as const)(
    "runs as it would have without a slot when the slot cannot be had (%s)",
    async (mode) => {
      const h = harness([amd]);
      const turn = slot(mode);
      turn.open();
      setChipTestGate(turn.gate);
      const found = await findChip("hd", { allowRun: true }, h.deps);
      expect(found.chip).toMatchObject({ maker: "amd", ok: true });
      expect(h.calls.length).toBeGreaterThan(0);
    },
  );

  it("lets the test's own failure through as it did, and gives no chip", async () => {
    const h = harness([amd]);
    const gate = async (fn: () => Promise<unknown>): Promise<Turn> => ({
      ran: true,
      value: (await fn()) as never,
    });
    setChipTestGate(gate);
    const explode: ChipDeps = {
      ...h.deps,
      files: {
        ...h.deps.files,
        dir: async () => {
          throw new Error("no cache folder");
        },
      },
    };
    expect((await findChip("hd", { allowRun: true }, explode)).chip).toBeNull();
  });

  it("is not changed by a slot being registered: the same verdicts for every scripted behaviour (property)", async () => {
    const modes = ["ok", "fail", "no_device", "slow", "busy"] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...modes),
        fc.constantFrom<SizeClass>("hd", "uhd"),
        async (chip, sizeClass) => {
          __resetChipTests();
          const plain = harness([amd], { chip });
          const without = await findChip(sizeClass, { allowRun: true }, plain.deps);
          __resetChipTests();
          setChipTestGate(async (fn) => ({ ran: true, value: (await fn()) as never }));
          const gated = harness([amd], { chip });
          const through = await findChip(sizeClass, { allowRun: true }, gated.deps);
          setChipTestGate(null);
          expect(through).toEqual(without);
          expect(gated.calls.map((call) => call.kind)).toEqual(
            plain.calls.map((call) => call.kind),
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

// The person's own Off (artdaddy.chipPref.v1) is theirs, so it holds whatever the server's switch for Quick export says. (An earlier rule read it only while the switch was
// on: an operator who turned the switch off to hide the new row also gave the chip back to a person who had turned it off, and the row that could undo it was hidden.)
describe("the person's Off and the server's switch for Quick export", () => {
  afterEach(() => __setExportFlag("quick_export", true));

  const OFF = (h: ReturnType<typeof harness>) => h.storage.set(CHIP_PREF_KEY, "off");

  it.each([true, false])(
    "with Quick export %s, Off is never tested, offered or used",
    async (quickExport) => {
      __setExportFlag("quick_export", quickExport);
      const h = harness([amd]);
      OFF(h);
      for (const allowRun of [true, false])
        expect(await findChip("hd", { allowRun }, h.deps), `run ${allowRun}`).toEqual({
          chip: null,
          events: [],
        });
      expect(h.calls).toEqual([]);
    },
  );

  it("does not hand back a chip that was remembered as passing: Off wins over a remembered pass, with the switch on or off, and Auto brings the pass back without a new test", async () => {
    const h = harness([amd]);
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip).toMatchObject({ ok: true });
    const tested = h.calls.length;
    OFF(h);
    for (const quickExport of [true, false]) {
      __setExportFlag("quick_export", quickExport);
      for (const allowRun of [true, false])
        expect(
          await findChip("hd", { allowRun }, h.deps),
          `quick ${quickExport} run ${allowRun}`,
        ).toEqual({ chip: null, events: [] });
    }
    expect(h.calls.length).toBe(tested);
    h.storage.delete(CHIP_PREF_KEY);
    expect((await findChip("hd", { allowRun: false }, h.deps)).chip).toMatchObject({
      maker: "amd",
    });
    expect(h.calls.length).toBe(tested);
  });

  it("leaves the stored choice as it was, whatever the switch says, so the row that undoes it still finds it", async () => {
    const h = harness([amd]);
    OFF(h);
    for (const quickExport of [false, true, false]) {
      __setExportFlag("quick_export", quickExport);
      await findChip("hd", { allowRun: true }, h.deps);
      expect(h.storage.get(CHIP_PREF_KEY)).toBe("off");
      expect((await chipStatusOf("hd", h.deps)).pref).toBe("off");
    }
  });

  it("holds for every maker, both size classes and every scripted behaviour, with the switch on or off: a stored Off gives no chip and runs nothing (rule over the class)", async () => {
    const behaviours: Behaviour[] = [{}, { chip: "fail" }, { chip: "no_device" }, { chip: "busy" }];
    for (const maker of [amd, nvidia, intel])
      for (const sizeClass of ["hd", "uhd"] as const)
        for (const behaviour of behaviours)
          for (const allowRun of [true, false])
            for (const quickExport of [true, false]) {
              const label = `${maker.maker} ${sizeClass} ${JSON.stringify(behaviour)} run ${allowRun} quick ${quickExport}`;
              __setExportFlag("quick_export", quickExport);
              __resetChipTests();
              const chosen = harness([maker], behaviour);
              OFF(chosen);
              expect(await findChip(sizeClass, { allowRun }, chosen.deps), label).toEqual({
                chip: null,
                events: [],
              });
              expect(chosen.calls, label).toEqual([]);
            }
  });
});

// Off is the person's switch, and a click can come at any moment of a test: while it runs, and while it waits for its turn in the PC check's one slot.
describe("the person turns the chip off while it is being tested", () => {
  const OFF = (h: ReturnType<typeof harness>) => h.storage.set(CHIP_PREF_KEY, "off");
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A scripted PC whose ffmpeg does not answer until `open()`: the test is under way when the person acts. */
  function held(adapters: Parameters<typeof harness>[0], behaviour: Behaviour = {}) {
    const h = harness(adapters, behaviour);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) => {
        await gate;
        return h.deps.probe(args, options);
      },
    };
    return { h, deps, open: () => open() };
  }

  it("drops a test that finishes after the click: nothing is remembered or reported for the next export, and the row's answer stays unknown", async () => {
    const { h, deps, open } = held([amd]);
    const lookup = findChip("hd", { allowRun: true }, deps);
    await later(10);
    OFF(h);
    open();
    expect(await lookup).toEqual({ chip: null, events: [] });
    expect(takeChipTestEvents()).toEqual([]);
    expect(await chipStatusOf("hd", h.deps)).toMatchObject({ pref: "off", verdict: "unknown" });
    // Auto again: the test is made afresh, and this time its answer is kept
    h.storage.delete(CHIP_PREF_KEY);
    expect((await findChip("hd", { allowRun: true }, h.deps)).chip).toMatchObject({ ok: true });
    expect((await chipStatusOf("hd", h.deps)).verdict).toBe("passed");
  });

  it("does not go on to test another chip after the click", async () => {
    const { h, deps, open } = held([amd, nvidia], { chip: "fail" });
    const lookup = findChip("hd", { allowRun: true }, deps);
    await later(10);
    OFF(h);
    open();
    expect(await lookup).toEqual({ chip: null, events: [] });
    const chipsTested = new Set(
      h.calls
        .filter((call) => call.kind === "chip-test-encode")
        .map((call) => call.args[call.args.indexOf("-c:v") + 1]),
    );
    expect(
      chipsTested.size,
      "the test under way ran to its end; the next chip was never started",
    ).toBe(1);
  });

  it("never starts a test that is still waiting for its turn in the PC check's slot when the click comes", async () => {
    type Turn = { ran: true; value: never } | { ran: false };
    const h = harness([amd]);
    let open!: () => void;
    const turnGiven = new Promise<void>((resolve) => (open = resolve));
    setChipTestGate(async (fn: () => Promise<unknown>): Promise<Turn> => {
      await turnGiven;
      return { ran: true, value: (await fn()) as never };
    });
    const lookup = findChip("hd", { allowRun: true }, h.deps);
    await later(10);
    OFF(h);
    open();
    expect(await lookup).toEqual({ chip: null, events: [] });
    expect(h.calls).toEqual([]);
    expect(takeChipTestEvents()).toEqual([]);
  });
});

// WHY a test failed: the maker's own refusal of the driver. The two sentences are the NVENC loader's, word for word, as the pinned
// ffmpeg prints them (master snapshot N-127021); the lines around them are what ffmpeg prints after an encoder that could not open.
const DRIVER_SENTENCES = [
  "Driver does not support the required nvenc API version. Required: 13.1 Found: 12.1",
  "The minimum required Nvidia driver for nvenc is 610.00 or newer",
] as const;
const NVENC_LOADER = "[h264_nvenc @ 000001e3b9d6c0c0]";
const AFTER_AN_OPEN_THAT_FAILED = [
  "[vost#0:0/h264_nvenc @ 000001e3b9d5f100] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.",
  "[vf#0:0 @ 000001e3b9d5f400] Error sending frames to consumers: Function not implemented",
  "[vost#0:0/h264_nvenc @ 000001e3b9d5f100] Could not open encoder before EOF",
  "[out#0/mp4 @ 000001e3b9d4cc80] Nothing was written into output file, because at least one of its streams received no packets.",
  "Conversion failed!",
] as const;
/** ffmpeg's report of an NVENC open that was refused: the loader's sentences, then the lines every failed open ends with. */
const stderrOf = (...sentences: readonly string[]): string =>
  [
    ...sentences.map((sentence) => `${NVENC_LOADER} ${sentence}`),
    ...AFTER_AN_OPEN_THAT_FAILED,
  ].join("\n") + "\n";
const DRIVER_STDERR = stderrOf(...DRIVER_SENTENCES);
const NO_DEVICE_STDERR = stderrOf("Cannot load nvcuda.dll", "No capable devices found");
/** One sentence for each way the pattern for a missing device can be met. */
const NO_DEVICE_SENTENCES = [
  "[h264_nvenc @ 0000] Cannot load nvcuda.dll",
  "[h264_nvenc @ 0000] No capable devices found",
  "[h264_amf @ 0000] No AMF capable device",
  "[h264_qsv @ 0000] No device available for encoding",
  "Device not found",
  "[h264_amf @ 0000] Component AMFVideoEncoderVCE_AVC not found",
  "[h264_nvenc @ 0000] OpenEncodeSessionEx failed: unsupported device (2)",
] as const;
const UNRELATED_FAILURES = [
  "Error while opening encoder",
  "",
  "Conversion failed!",
  stderrOf("OpenEncodeSessionEx failed: out of memory (10)"),
  "[h264_nvenc @ 0000] Nvidia driver reported an error",
] as const;
const ADAPTER: Record<ChipMaker, typeof amd> = { amd, nvidia, intel };
const MEMORY_KEY = "artdaddy.chipTest.v1";

describe("why a chip's test failed: the maker's own refusal of the driver", () => {
  /** What one look at one size class finds on a PC whose chip's encode exits with an error and says exactly `stderr`. */
  async function lookAt(maker: ChipMaker, stderr: string, sizeClass: SizeClass = "hd") {
    const h = harness([ADAPTER[maker]], { chipStderr: stderr });
    const found = await findChip(sizeClass, { allowRun: true }, h.deps);
    return { h, found, results: found.events.map((event) => event.result) };
  }

  it.each(["hd", "uhd"] as const)(
    "files the driver's refusal under its own word when the %s look is made, and the event says the maker and nothing about the driver",
    async (sizeClass) => {
      const { h, found } = await lookAt("nvidia", DRIVER_STDERR, sizeClass);
      expect(found.chip).toBeNull();
      // The 4K class is only asked of a chip that passed the HD test, so a refused driver ends the look at the HD test.
      expect(found.events).toEqual([
        { maker: "nvidia", sizeClass: "hd", result: "driver_too_old", ms: 0, ssimMilli: 0 },
      ]);
      expect(h.calls.every((call) => !call.args.join(" ").includes("3840x2160"))).toBe(true);
      // What the next export's report is told is the same event, once.
      expect(takeChipTestEvents()).toEqual(found.events);
      expect(takeChipTestEvents()).toEqual([]);
    },
  );

  it("files it under its own word at the 4K class too, when that is where the maker said it", async () => {
    const h = harness([nvidia]);
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) =>
        options.kind === "chip-test-encode" && args.join(" ").includes("3840x2160")
          ? { kind: "ran", code: 1, stdout: "", stderr: DRIVER_STDERR, ms: 4 }
          : h.deps.probe(args, options),
    };
    const found = await findChip("uhd", { allowRun: true }, deps);
    expect(found.chip).toBeNull();
    expect(found.events.map((event) => [event.sizeClass, event.result])).toEqual([
      ["hd", "passed"],
      ["uhd", "driver_too_old"],
    ]);
  });

  it.each(DRIVER_SENTENCES)(
    "recognises the sentence %j on its own, in any letter case",
    async (sentence) => {
      for (const text of [sentence, sentence.toLowerCase(), sentence.toUpperCase()])
        expect((await lookAt("nvidia", stderrOf(text))).results, text).toEqual(["driver_too_old"]);
    },
  );

  it("says driver_too_old for a stderr that also says there is no device, in either order, and no_device when only that is said", async () => {
    for (const stderr of [
      stderrOf("No capable devices found", ...DRIVER_SENTENCES),
      stderrOf(...DRIVER_SENTENCES, "Cannot load nvcuda.dll"),
    ])
      expect((await lookAt("nvidia", stderr)).results).toEqual(["driver_too_old"]);
    expect((await lookAt("nvidia", NO_DEVICE_STDERR)).results).toEqual(["no_device"]);
  });

  it.each(CHIP_MAKERS)(
    "still files every 'no device' sentence as no_device, and every unrelated failure as encode_failed, for %s",
    async (maker) => {
      for (const sentence of NO_DEVICE_SENTENCES)
        expect((await lookAt(maker, sentence)).results, sentence).toEqual(["no_device"]);
      for (const stderr of UNRELATED_FAILURES)
        expect((await lookAt(maker, stderr)).results, stderr).toEqual(["encode_failed"]);
    },
  );

  it.each(["amd", "intel"] as const)(
    "does not call the same sentences a driver refusal when %s's chip says them: only NVIDIA's loader says it",
    async (maker) => {
      expect((await lookAt(maker, DRIVER_STDERR)).results).toEqual(["encode_failed"]);
      expect(
        (await lookAt(maker, stderrOf(...DRIVER_SENTENCES, "No capable devices found"))).results,
      ).toEqual(["no_device"]);
    },
  );

  it("does not read a warning of a chip that encoded as a refusal: with exit 0 the test goes on to the picture and passes", async () => {
    const h = harness([nvidia]);
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) =>
        options.kind === "chip-test-encode"
          ? { kind: "ran", code: 0, stdout: "", stderr: DRIVER_STDERR, ms: 4 }
          : h.deps.probe(args, options),
    };
    expect((await findChip("hd", { allowRun: true }, deps)).chip).toMatchObject({
      maker: "nvidia",
      result: "passed",
    });
  });

  it("stays on the catch-all when ffmpeg's text cannot even be read", async () => {
    const h = harness([nvidia]);
    const hostile = {
      toString() {
        throw new Error("not a text");
      },
    } as unknown as string;
    const deps: ChipDeps = {
      ...h.deps,
      probe: async (args, options) =>
        options.kind === "chip-test-encode"
          ? { kind: "ran", code: 1, stdout: "", stderr: hostile, ms: 1 }
          : h.deps.probe(args, options),
    };
    expect((await findChip("hd", { allowRun: true }, deps)).events).toEqual([
      expect.objectContaining({ result: "encode_failed" }),
    ]);
  });

  it("is driver_too_old exactly when the maker is NVIDIA and a driver sentence is there, else no_device exactly when a no-device sentence is there, else encode_failed (property)", () => {
    type Part = { readonly text: string; readonly kind: "driver" | "no_device" | "noise" };
    const parts: Part[] = [
      ...DRIVER_SENTENCES.flatMap((sentence) =>
        [sentence, sentence.toLowerCase(), sentence.toUpperCase()].map((text) => ({
          text: `${NVENC_LOADER} ${text}`,
          kind: "driver" as const,
        })),
      ),
      ...NO_DEVICE_SENTENCES.map((text) => ({ text, kind: "no_device" as const })),
      ...AFTER_AN_OPEN_THAT_FAILED.map((text) => ({ text, kind: "noise" as const })),
      { text: "", kind: "noise" },
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...CHIP_MAKERS),
        fc.array(fc.constantFrom(...parts), { maxLength: 8 }),
        (maker, said) => {
          const has = (kind: Part["kind"]) => said.some((part) => part.kind === kind);
          const expected =
            maker === "nvidia" && has("driver")
              ? "driver_too_old"
              : has("no_device")
                ? "no_device"
                : "encode_failed";
          expect(encodeFailure(maker, said.map((part) => part.text).join("\n"))).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("a refused driver is remembered like any failure", () => {
  it("is remembered for a day: the next look says cached_fail and runs nothing; a new day tests again, and so does a new driver", async () => {
    const behaviour: Behaviour = { chipStderr: DRIVER_STDERR };
    const h = harness([nvidia], behaviour);
    const first = await findChip("hd", { allowRun: true }, h.deps);
    expect(first.events).toEqual([expect.objectContaining({ result: "driver_too_old" })]);
    const calls = h.calls.length;
    const again = await findChip("hd", { allowRun: true }, h.deps);
    expect(again.chip).toBeNull();
    expect(again.events).toEqual([expect.objectContaining({ result: "cached_fail" })]);
    expect(h.calls.length).toBe(calls);
    // What the chip row reads is the word itself, not the cache's.
    expect((await chipStatusOf("hd", h.deps)).adapters[0].result).toBe("driver_too_old");
    // A day later the same driver is asked again, and says the same.
    h.now.t += FAIL_TTL_MS + 1;
    const later = await findChip("hd", { allowRun: true }, h.deps);
    expect(h.calls.length).toBeGreaterThan(calls);
    expect(later.events).toEqual([expect.objectContaining({ result: "driver_too_old" })]);
    // The person updates the driver: another key, a fresh test, and now the chip is accepted.
    delete behaviour.chipStderr;
    const updated: ChipDeps = {
      ...h.deps,
      adapters: async () => [{ ...nvidia, driver: "32.0.16.1012" }],
    };
    expect((await findChip("hd", { allowRun: true }, updated)).chip).toMatchObject({
      maker: "nvidia",
    });
  });

  it("still reads back a failure that the build before this one wrote, and refuses a damaged entry that carries the new word", async () => {
    const h = harness([nvidia], { chip: "fail" });
    await findChip("hd", { allowRun: true }, h.deps);
    const memory = JSON.parse(h.storage.get(MEMORY_KEY)!);
    const [key] = Object.keys(memory.results);
    // The shape the old build wrote for the catch-all: nothing about it changed.
    expect(memory.results[key]).toMatchObject({ ok: false, result: "encode_failed" });
    const calls = h.calls.length;
    expect((await findChip("hd", { allowRun: true }, h.deps)).events).toEqual([
      expect.objectContaining({ result: "cached_fail" }),
    ]);
    expect(h.calls.length).toBe(calls);
    expect((await chipStatusOf("hd", h.deps)).adapters[0].result).toBe("encode_failed");
    // The new word with ok true is not something this module could have written: tested again, never believed.
    memory.results[key] = { ...memory.results[key], ok: true, result: "driver_too_old" };
    h.storage.set(MEMORY_KEY, JSON.stringify(memory));
    const found = await findChip("hd", { allowRun: true }, h.deps);
    expect(h.calls.length).toBeGreaterThan(calls);
    expect(found.events).toEqual([expect.objectContaining({ result: "encode_failed" })]);
  });
});

describe("what the person is told for a refused driver", () => {
  it("is the NVIDIA driver line, built from what the test itself remembered, for a driver under 610 (and not for a newer one)", async () => {
    const hint = async (driver: string) => {
      const h = harness([{ ...nvidia, driver }], { chipStderr: DRIVER_STDERR });
      await findChip("hd", { allowRun: true }, h.deps);
      const status = await chipStatusOf("hd", h.deps);
      expect(status.verdict).toBe("not_passed");
      return chipAdvice({
        adapters: status.adapters.map(({ adapter, result }) => ({
          maker: adapter.maker,
          driver: adapter.driver,
          result,
        })),
        processor: null,
      });
    };
    expect((await hint("31.0.15.5123"))?.text).toContain("Your NVIDIA graphics driver is 551.23.");
    expect(await hint("32.0.16.1012")).toBeNull();
  });
});

describe("the words a chip test can say are words a report may carry, and words the memory can keep", () => {
  const source = readFileSync("src/timeline/chipTest.ts", "utf8").replace(/\r\n/g, "\n");
  const union = /export type ChipTestResult\s*=((?:\s*\|\s*"[a-z_0-9]+")+);/.exec(source);
  const words = union ? [...union[1].matchAll(/"([a-z_0-9]+)"/g)].map((found) => found[1]) : [];
  // Made when the memory is read, or nothing was learned: never stored.
  const NEVER_STORED = ["cached_pass", "cached_fail", "skipped_busy"];

  it("reads the type it guards (a parse that found nothing would pass everything below)", () => {
    expect(words.length).toBeGreaterThanOrEqual(11);
    expect(new Set(words).size).toBe(words.length);
    expect(words).toContain("passed");
  });

  it("has every member of ChipTestResult in the list a report is cleaned against", () => {
    for (const word of words)
      expect(EXPORT_TRACE_VALUES as readonly string[], word).toContain(word);
  });

  it("keeps every result a test can end in, and reads it back as the same word; the words that are never stored are refused", async () => {
    const h = harness([amd]);
    await findChip("hd", { allowRun: true }, h.deps);
    const memory = JSON.parse(h.storage.get(MEMORY_KEY)!);
    const [key] = Object.keys(memory.results);
    const readBack = async (word: string): Promise<string | null> => {
      memory.results = {
        [key]: { ...memory.results[key], ok: word === "passed", result: word },
      };
      h.storage.set(MEMORY_KEY, JSON.stringify(memory));
      return (await chipStatusOf("hd", h.deps)).adapters[0].result;
    };
    for (const word of words.filter((w) => !NEVER_STORED.includes(w)))
      expect(await readBack(word), word).toBe(word);
    for (const word of NEVER_STORED) expect(await readBack(word), word).toBeNull();
  });
});
