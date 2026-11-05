import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHIP_TEST_REVISION,
  FAIL_TTL_MS,
  PASS_TTL_MS,
  SSIM_FLOOR,
  SSIM_PARITY_MARGIN,
  TEST_FRAMES,
  __resetChipTests,
  chipEncodeArgs,
  chipTestSource,
  findChip,
  judge,
  markChipSuspect,
  readSsim,
  referenceEncodeArgs,
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
import { amd, harness, intel, nvidia, ssimText, type Behaviour } from "../test/chipHarness";

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
