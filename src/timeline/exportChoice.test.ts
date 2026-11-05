import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { __setExportFlag, type ExportFlagName } from "../api/exportFlags";
import type { GraphicsAdapter } from "../platform/host";
import {
  __resetChipTests,
  findChip,
  type ChipLookup,
  type ChipTestEvent,
  type ChipVerdict,
} from "./chipTest";
import { amd as amdAdapter, harness } from "../test/chipHarness";
import { CHIP_WAIT_MS, decideExportEncoder, type ChoiceInput } from "./exportChoice";
import { CHIP_MAKERS, sizeClassOf, type ChipMaker, type SizeClass } from "./exportEncoder";
import {
  EXPORT_SPEED_REVISION,
  deliveredPicture,
  promiseLineOf,
  promiseMultipleOf,
  type ExportCalibration,
  type ExportEncoder,
} from "./exportOptions";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";
import type { RenderWorkload } from "./renderPlan";

const workload = (over: Partial<RenderWorkload> = {}): RenderWorkload => ({
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 600,
  visualClips: 1,
  captionClips: 0,
  audioClips: 1,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
  ...over,
});

const verdict = (maker: ChipMaker = "amd", sizeClass: SizeClass = "hd"): ChipVerdict => {
  const adapter: GraphicsAdapter = { maker, device: "15bf", driver: "32.0.1" };
  return { maker, adapter, sizeClass, ok: true, result: "passed", ssimMilli: 870, ms: 1800 };
};

/** A lookup that answers with `chip` and remembers what it was asked. */
function lookupWith(chip: ChipVerdict | null, events: ChipTestEvent[] = []) {
  const asked: { sizeClass: SizeClass; allowRun: boolean }[] = [];
  const lookup = async (
    sizeClass: SizeClass,
    options: { allowRun: boolean; signal?: AbortSignal },
  ): Promise<ChipLookup> => {
    asked.push({ sizeClass, allowRun: options.allowRun });
    return { chip, events };
  };
  return { lookup, asked };
}

const input = (over: Partial<ChoiceInput> = {}): ChoiceInput => ({
  request: "auto",
  workload: workload(),
  settings: {},
  history: [],
  ...over,
});

const sample = (
  encoder: ExportEncoder,
  elapsedSeconds: number,
  w: RenderWorkload = workload(),
): ExportCalibration => ({
  workload: w,
  output: { width: w.width, height: w.height, fps: w.fps },
  quality: "medium",
  engine: "file-sequence-v1",
  encoder,
  revision: EXPORT_SPEED_REVISION,
  elapsedSeconds,
  finalBytes: 50_000_000,
  memoryBytes: 1_000_000_000,
  temporaryBytes: 0,
});

const FLAGS: ExportFlagName[] = [
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "faster_x264",
];
beforeEach(() => {
  __resetChipTests();
  for (const flag of FLAGS) __setExportFlag(flag, true);
});

const oneClip = {
  canvas: { width: 1080, height: 1920, fps: 30 },
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

describe("the encoder an export gets", () => {
  it("is the graphics chip, with the reason, for a long export on a PC whose chip has proven itself", async () => {
    const { lookup, asked } = lookupWith(verdict("amd"));
    const decision = await decideExportEncoder(input(), lookup);
    expect(decision).toMatchObject({
      mode: "fast",
      chip: "amd",
      reason: "over_minute",
      showRow: true,
      defaultMode: "fast",
    });
    expect(decision.faster).toBeUndefined();
    expect(asked).toEqual([{ sizeClass: "hd", allowRun: true }]);
    expect(decision.facts).toMatchObject({ encoder: "amd", chip: "amd", reason: "over_minute" });
    expect(decision.fullSeconds).toBeGreaterThan(60);
    expect(decision.fastSeconds!).toBeLessThan(decision.fullSeconds!);
  });

  it("stays Full quality for a short export, and still offers the row", async () => {
    const { lookup } = lookupWith(verdict("amd"));
    const decision = await decideExportEncoder(
      input({ workload: workload({ durationSeconds: 10 }) }),
      lookup,
    );
    expect(decision).toMatchObject({
      mode: "quality",
      reason: "none",
      showRow: true,
      defaultMode: "quality",
    });
    expect(decision.chip).toBeUndefined();
    expect(decision.facts).toMatchObject({ encoder: "x264", chip: "amd", reason: "none" });
  });

  it("never changes what the person picked: Full is the processor, and no chip is even tested for it", async () => {
    const { lookup, asked } = lookupWith(verdict("amd"));
    const decision = await decideExportEncoder(input({ request: "full" }), lookup);
    expect(decision).toMatchObject({ mode: "quality", reason: "person" });
    expect(decision.chip).toBeUndefined();
    expect(decision.faster).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("gives Fast to the person who picked it, and the processor when no chip can serve", async () => {
    const withChip = await decideExportEncoder(
      input({ request: "fast" }),
      lookupWith(verdict("nvidia")).lookup,
    );
    expect(withChip).toMatchObject({ mode: "fast", chip: "nvidia", reason: "person" });
    const without = await decideExportEncoder(input({ request: "fast" }), lookupWith(null).lookup);
    expect(without).toMatchObject({ mode: "quality", reason: "none" });
    expect(without.chip).toBeUndefined();
  });

  it("asks about the picture that is delivered: a resolution below the project's changes the size class", async () => {
    const { lookup, asked } = lookupWith(verdict("amd", "hd"));
    await decideExportEncoder(
      input({
        workload: workload({ width: 3840, height: 2160 }),
        settings: { resolution: "1080p" },
      }),
      lookup,
    );
    expect(asked).toEqual([{ sizeClass: "hd", allowRun: true }]);
    const uhd = lookupWith(verdict("amd", "uhd"));
    await decideExportEncoder(
      input({ workload: workload({ width: 3840, height: 2160 }) }),
      uhd.lookup,
    );
    expect(uhd.asked).toEqual([{ sizeClass: "uhd", allowRun: true }]);
  });

  it("uses no chip, and tests none, for a picture or frame rate no chip is tested at (8K, 4K at 60)", async () => {
    const { lookup, asked } = lookupWith(verdict("amd"));
    for (const shape of [
      { width: 7680, height: 4320 },
      { width: 3840, height: 2160, fps: 60 },
      { width: 4000, height: 500 },
      { width: 1920, height: 1080, fps: 120 },
    ]) {
      const decision = await decideExportEncoder(input({ workload: workload(shape) }), lookup);
      expect(decision.chip, JSON.stringify(shape)).toBeUndefined();
      expect(decision.showRow, JSON.stringify(shape)).toBe(false);
    }
    expect(asked).toEqual([]);
    // The same project at a frame rate every class was tested at is served.
    const ok = await decideExportEncoder(
      input({ workload: workload({ width: 1920, height: 1080, fps: 60 }) }),
      lookup,
    );
    expect(ok.chip).toBe("amd");
  });

  it("uses no chip, and tests none, for a picture no chip is tested at (8K)", async () => {
    const { lookup, asked } = lookupWith(verdict("amd"));
    const decision = await decideExportEncoder(
      input({ workload: workload({ width: 7680, height: 4320 }) }),
      lookup,
    );
    expect(decision.chip).toBeUndefined();
    expect(decision.showRow).toBe(false);
    expect(asked).toEqual([]);
  });

  it("does not offer Fast where this PC's own history says it would not save a quarter of the time", async () => {
    const history = [sample("x264-crf", 600), sample("chip-amd", 560)];
    const { lookup } = lookupWith(verdict("amd"));
    const decision = await decideExportEncoder(input({ history }), lookup);
    expect(decision).toMatchObject({ showRow: false, mode: "quality", reason: "none" });
    const quick = await decideExportEncoder(
      input({ history: [sample("x264-crf", 600), sample("chip-amd", 200)] }),
      lookup,
    );
    expect(quick).toMatchObject({
      showRow: true,
      mode: "fast",
      chip: "amd",
      reason: "over_minute",
    });
    expect(quick.fastSeconds).toBe(200);
    expect(quick.fullGuessed).toBe(false);
  });

  it("estimates Fast from what the processor measured while the chip has not run here: a measured ten minutes is never seconds on the chip", async () => {
    const { lookup } = lookupWith(verdict("amd"));
    const decision = await decideExportEncoder(
      input({ history: [sample("x264-crf", 600)] }),
      lookup,
    );
    expect(decision).toMatchObject({ fullSeconds: 600, fullGuessed: false, showRow: true });
    expect(decision.fastSeconds).toBe(400); // 600 over the cautious 1.5, not a fresh guess for the project's size
  });

  it("gives a measured export that is over the promise the processor's faster setting, when no chip can be used", async () => {
    const w = workload({ durationSeconds: 100 });
    const line = promiseMultipleOf(promiseLineOf(w));
    const measured = await decideExportEncoder(
      input({ workload: w, history: [sample("x264-crf", 100 * line + 60, w)] }),
      lookupWith(null).lookup,
    );
    expect(measured).toMatchObject({ mode: "quality", faster: true, reason: "promise_line" });
    expect(measured.facts.encoder).toBe("x264_fast");
    // A guess that is not far over the line is not a reason to lower the quality.
    const guessed = await decideExportEncoder(input({ workload: w }), lookupWith(null).lookup);
    expect(guessed.faster).toBeUndefined();
    // Never for a person who picked Full.
    const full = await decideExportEncoder(
      input({ workload: w, request: "full", history: [sample("x264-crf", 100 * line + 60, w)] }),
      lookupWith(null).lookup,
    );
    expect(full.faster).toBeUndefined();
  });

  it("follows the server's switches: a maker off is never used, no default keeps the row but not the selection, no faster setting", async () => {
    __setExportFlag("chip_default", false);
    const noDefault = await decideExportEncoder(input(), lookupWith(verdict("amd")).lookup);
    expect(noDefault).toMatchObject({
      mode: "quality",
      showRow: true,
      defaultMode: "quality",
      reason: "none",
    });
    expect(
      await decideExportEncoder(input({ request: "fast" }), lookupWith(verdict("amd")).lookup),
    ).toMatchObject({ mode: "fast", chip: "amd", reason: "person" });

    __setExportFlag("faster_x264", false);
    const w = workload({ durationSeconds: 100 });
    const line = promiseMultipleOf(promiseLineOf(w));
    const noFaster = await decideExportEncoder(
      input({ workload: w, history: [sample("x264-crf", 100 * line + 60, w)] }),
      lookupWith(null).lookup,
    );
    expect(noFaster.faster).toBeUndefined();
  });

  it("goes on with the processor, and does not wait for ever, when the chip's test is slow: the test finishes for the next export", async () => {
    let answer: (lookup: ChipLookup) => void = () => undefined;
    const slow = new Promise<ChipLookup>((resolve) => (answer = resolve));
    const started = Date.now();
    const decision = await decideExportEncoder(input({ waitMs: 30 }), async () => slow);
    expect(Date.now() - started).toBeLessThan(CHIP_WAIT_MS);
    expect(decision).toMatchObject({ mode: "quality", reason: "none" });
    expect(decision.chip).toBeUndefined();
    answer({ chip: verdict("amd"), events: [] }); // nothing is waiting for it, and nothing breaks
    await slow;
  });

  it("goes on at once when the export is stopped", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const never = new Promise<ChipLookup>(() => undefined);
    const decision = await decideExportEncoder(
      input({ signal: stopped.signal }),
      async () => never,
    );
    expect(decision.mode).toBe("quality");
  });

  it("never lets a failing lookup fail the export", async () => {
    const decision = await decideExportEncoder(input(), async () => {
      throw new Error("the supervisor is gone");
    });
    expect(decision).toMatchObject({ mode: "quality", reason: "none" });
  });

  it("reports the chip's tests once: the real runs made since the last export, else what it remembers", async () => {
    const remembered: ChipTestEvent[] = [
      { maker: "amd", sizeClass: "hd", result: "cached_pass", ms: 0, ssimMilli: 870 },
    ];
    const { lookup } = lookupWith(verdict("amd"), remembered);
    const first = await decideExportEncoder(input(), lookup);
    expect(first.tests).toEqual(remembered);
    expect(first.facts.tests).toEqual(remembered);
  });

  it("journey: the chip is tested as the Export dialog opens; the export that follows uses it without running anything, and reports that test once", async () => {
    const h = harness([amdAdapter]);
    const real = (cls: SizeClass, options: { allowRun: boolean; signal?: AbortSignal }) =>
      findChip(cls, options, h.deps);
    // The dialog opens: it looks, and the Mode row appears once the chip has passed. A look takes nothing for a report.
    const dialog = await decideExportEncoder(input({ preview: true, waitMs: Infinity }), real);
    expect(dialog).toMatchObject({ showRow: true, defaultMode: "fast" });
    const callsAfterDialog = h.calls.length;
    expect(callsAfterDialog).toBeGreaterThan(0);
    // The export starts: the chip is used with no new test, and the test's result is told with this export.
    const started = await decideExportEncoder(input(), real);
    expect(started).toMatchObject({ mode: "fast", chip: "amd", reason: "over_minute" });
    expect(h.calls.length).toBe(callsAfterDialog);
    expect(started.tests).toEqual([
      expect.objectContaining({ maker: "amd", sizeClass: "hd", result: "passed" }),
    ]);
    // The next export has nothing new to tell: the answer is remembered.
    const next = await decideExportEncoder(input(), real);
    expect(next.tests).toEqual([expect.objectContaining({ result: "cached_pass" })]);
  });

  it("journey: a chip that fails its test is never used, and the failure is told with the export that ran on the processor", async () => {
    const h = harness([amdAdapter], { chip: "fail" });
    const real = (cls: SizeClass, options: { allowRun: boolean; signal?: AbortSignal }) =>
      findChip(cls, options, h.deps);
    const started = await decideExportEncoder(input(), real);
    expect(started).toMatchObject({ mode: "quality", reason: "none", showRow: false });
    expect(started.chip).toBeUndefined();
    expect(started.tests).toEqual([
      expect.objectContaining({ maker: "amd", result: "encode_failed" }),
    ]);
    expect(started.facts.encoder).toBe("x264");
  });
});

describe("what the decision does to the command that runs", () => {
  const argsFor = async (over: Partial<ChoiceInput>, chip: ChipVerdict | null) => {
    const decision = await decideExportEncoder(input(over), lookupWith(chip).lookup);
    const plan = buildRenderCommand(oneClip, "/o.mp4", {
      mode: decision.mode,
      chip: decision.chip,
      faster: decision.faster,
      quality: "medium",
    });
    return { decision, args: plan.args, encoder: plan.encoder };
  };

  it("is the chip's encode when the chip was chosen, and today's libx264 otherwise, down to the last argument", async () => {
    const chip = await argsFor({}, verdict("amd"));
    expect(chip.args).toContain("h264_amf");
    expect(chip.args).not.toContain("libx264");
    expect(chip.encoder).toBe("chip-amd");

    const plain = await argsFor({ request: "full" }, verdict("amd"));
    const today = buildRenderCommand(oneClip, "/o.mp4", { quality: "medium" });
    expect(plain.args).toEqual(today.args);
    expect(plain.encoder).toBe(today.encoder);

    const w = workload({ durationSeconds: 100 });
    const line = promiseMultipleOf(promiseLineOf(w));
    const faster = await argsFor(
      { workload: w, history: [sample("x264-crf", 100 * line + 60, w)] },
      null,
    );
    expect(faster.decision.faster).toBe(true);
    expect(faster.args).toContain("veryfast");
    expect(faster.encoder).toBe("x264-fast");
  });
});

describe("the rules, over every shape of PC, project and request", () => {
  it("never uses a chip nobody proved or the person refused, never lowers a chosen Full, and is today's with every switch off", async () => {
    const sizes = [
      [640, 360],
      [1080, 1920],
      [1920, 1080],
      [3840, 2160],
      [4096, 2160],
      [7680, 4320],
    ] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("auto", "full", "fast" as const),
        fc.option(fc.constantFrom(...CHIP_MAKERS), { nil: null }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 7200 }),
        fc.constantFrom(...sizes),
        fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
        fc.constantFrom(24, 30, 60, 120),
        async (
          request,
          maker,
          chipDefault,
          fasterOn,
          makerOn,
          duration,
          [width, height],
          measured,
          fps,
        ) => {
          for (const flag of FLAGS) __setExportFlag(flag, true);
          __setExportFlag("chip_default", chipDefault);
          __setExportFlag("faster_x264", fasterOn);
          const w = workload({ width, height, fps, durationSeconds: duration });
          const picture = deliveredPicture(w, {});
          const cls = sizeClassOf(picture.width, picture.height, picture.fps);
          // The real lookup refuses a maker whose switch is off; the stub does the same.
          const offered = maker !== null && makerOn && cls !== null ? verdict(maker, cls) : null;
          const { lookup, asked } = lookupWith(offered);
          const history = measured === null ? [] : [sample("x264-crf", measured, w)];
          const decision = await decideExportEncoder(
            input({ request, workload: w, history }),
            lookup,
          );

          if (decision.chip !== undefined) {
            expect(offered).not.toBeNull();
            expect(decision.chip).toBe(offered!.maker);
            expect(request).not.toBe("full");
            expect(decision.mode).toBe("fast");
            expect(decision.faster).toBeUndefined();
          } else expect(decision.mode).toBe("quality");
          if (request === "full") {
            expect(decision.faster).toBeUndefined();
            expect(asked).toEqual([]);
            expect(decision.reason).toBe("person");
          }
          if (decision.faster) {
            expect(request).toBe("auto");
            expect(offered).toBeNull();
            expect(fasterOn).toBe(true);
          }
          if (cls === null) {
            expect(decision.chip).toBeUndefined();
            expect(asked).toEqual([]);
          }
          if (decision.showRow) expect(offered).not.toBeNull();
          if (decision.reason === "over_minute") {
            expect(request).toBe("auto");
            expect(decision.chip).toBeDefined();
            expect(chipDefault).toBe(true);
          }
          if (decision.reason === "promise_line") expect(decision.faster).toBe(true);
          expect(decision.facts.encoder).toBe(
            decision.chip ?? (decision.faster ? "x264_fast" : "x264"),
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});
