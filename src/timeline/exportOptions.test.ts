// Export delivery presets. The rules that matter are about what a preset must NEVER do:
// invent detail by upscaling, emit an odd dimension that ffmpeg refuses outright, or change
// anything at all when the user asked for the source size.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assessExport, crfFor, estimateExportFromHistory, outputFps, outputSize, type ExportCalibration, type ExportEstimates } from "./exportOptions";
import type { RenderWorkload } from "./renderPlan";

describe("export preflight assessment", () => {
  const workload: RenderWorkload = { width: 1920, height: 1080, fps: 30, durationSeconds: 60,
    visualClips: 10, captionClips: 1, audioClips: 1, peakVisualLayers: 2, peakMediaLayers: 1 };
  const resources = { total_memory_bytes: 16e9, available_memory_bytes: 8e9, scratch_free_bytes: 100e9, destination_free_bytes: 100e9,
    local_fast_candidate: false,
    budgets: { memoryBytes: 4e9, temporaryBytes: 18e9, executionSeconds: 28800 } };
  const estimates: ExportEstimates = { memoryBytes: 2e9, temporaryBytes: 1e9, finalBytes: 100e6, seconds: 60 };
  const budgets = { memoryBytes: 4e9, temporaryBytes: 18e9, executionSeconds: 28800 };

  it("uses the independent HD,4Kandheavy limits and counts captions as things", () => {
    expect(assessExport(workload, resources, estimates, budgets)).toMatchObject({ promiseLine: "hd", severity: "none" });
    const fourK = { ...workload, width: 3840, height: 2160, durationSeconds: 1800, peakVisualLayers: 4 };
    expect(assessExport(fourK, resources, estimates, budgets).promiseLine).toBe("4k");
    expect(assessExport({ ...fourK, peakVisualLayers: 5 }, resources, estimates, budgets).severity).toBe("warning");
    expect(assessExport({ ...fourK, fps: 60 }, resources, estimates, budgets).promiseLine).toBe("outside");
    expect(assessExport({ ...workload, peakVisualLayers: 8 }, resources, estimates, budgets).promiseLine).toBe("heavy_hd");
    expect(assessExport({ ...workload, peakVisualLayers: 9 }, resources, estimates, budgets).promiseLine).toBe("outside");
    expect(assessExport({ ...workload, visualClips: 1001 }, resources, estimates, budgets).promiseLine).toBe("outside");
  });

  it("shows a light notice for a known slow in-scope export but never for unknown resources", () => {
    expect(assessExport(workload, resources, { ...estimates, seconds: 150 }, budgets)).toMatchObject({ severity: "notice", reasons: ["slow"] });
    expect(assessExport(workload, resources, { ...estimates, seconds: null }, budgets)).toMatchObject({ severity: "warning", reasons: ["time_unknown"] });
    expect(assessExport(workload, { ...resources, scratch_free_bytes: null }, estimates, budgets)).toMatchObject({ severity: "warning", reasons: ["disk_unknown"] });
  });

  it("does not put missing or invalid workload values inside the promise", () => {
    for (const patch of [{ width: 0 }, { height: NaN }, { fps: 0 }, { fps: Infinity }, { durationSeconds: 0 }])
      expect(assessExport({ ...workload, ...patch }, resources, estimates, budgets)).toMatchObject({ promiseLine: "outside", severity: "warning" });
    expect(assessExport(workload, resources, { ...estimates, seconds: NaN, memoryBytes: Infinity }, budgets).reasons)
      .toEqual(["memory_unknown", "time_unknown"]);
  });

  it("checks final allocation and temporary space together without assuming separate volumes", () => {
    expect(assessExport(workload, { ...resources, destination_free_bytes: 1.05e9 }, estimates, budgets)).toMatchObject({ severity: "warning", reasons: ["disk_shortage"] });
    expect(assessExport(workload, resources, { ...estimates, memoryBytes: 5e9 }, budgets).reasons).toContain("memory_shortage");
    expect(assessExport(workload, resources, { ...estimates, temporaryBytes: 19e9 }, budgets).reasons).toContain("temporary_limit");
  });

  it("never downgrades a fit warning when available memory or storage decreases", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 8_000_000_000 }), fc.integer({ min: 0, max: 100_000_000_000 }),
      (memory, disk) => {
        const result = assessExport(workload, { ...resources, available_memory_bytes: memory, destination_free_bytes: disk }, estimates, budgets);
        if (memory < estimates.memoryBytes! || disk < estimates.temporaryBytes! + estimates.finalBytes!) expect(result.severity).toBe("warning");
      }), { numRuns: 200 });
  });
});

describe("local measured export estimates", () => {
  const workload: RenderWorkload = { width: 1920, height: 1080, fps: 30, durationSeconds: 10,
    visualClips: 14, captionClips: 2, audioClips: 1, peakVisualLayers: 8, peakMediaLayers: 7 };
  const output = { width: 1920, height: 1080, fps: 30 };
  const sample: ExportCalibration = { workload, output, quality: "medium", engine: "partition-pipes-v1",
    elapsedSeconds: 16, finalBytes: 2_400_000, memoryBytes: 1_000_000_000, temporaryBytes: null };
  const estimate = (target = workload, history: readonly ExportCalibration[] = [sample]) =>
    estimateExportFromHistory(target, output, "medium", "partition-pipes-v1", history);

  it("does not invent observations for absent or incompatible history", () => {
    const unknown = { seconds: null, memoryBytes: null, temporaryBytes: null, finalBytes: null };
    expect(estimate(workload, [])).toEqual(unknown);
    expect(estimate({ ...workload, peakMediaLayers: 1 })).toEqual(unknown);
    expect(estimateExportFromHistory(workload, output, "high", "partition-pipes-v1", [sample])).toEqual(unknown);
    expect(estimateExportFromHistory(workload, { ...output, fps: 60 }, "medium", "partition-pipes-v1", [sample])).toEqual(unknown);
  });

  it("uses successful measurements without replacing missing observations by zero", () => {
    expect(estimate()).toEqual({ seconds: 16, finalBytes: 2_400_000, memoryBytes: 1_000_000_000, temporaryBytes: null });
    expect(estimate(workload, [{ ...sample, elapsedSeconds: NaN }]).seconds).toBeNull();
    expect(estimate(workload, [sample, { ...sample, elapsedSeconds: 20 }]).seconds).toBe(20);
  });

  it("cannot use old or late encoder-policy measurements for a different policy", () => {
    const profiles = (["x264-crf", "x264-crf-threads2", "amf-cqp18"] as const)
      .map((encoder, index) => ({ ...sample, encoder, elapsedSeconds: (index + 1) * 10 }));
    for (const profile of profiles) {
      const foreign = profiles.filter((entry) => entry.encoder !== profile.encoder);
      expect(estimateExportFromHistory(workload, output, "medium", "partition-pipes-v1", foreign, profile.encoder).seconds).toBeNull();
      for (const history of [[profile, ...foreign], [...foreign, profile]])
        expect(estimateExportFromHistory(workload, output, "medium", "partition-pipes-v1", history, profile.encoder).seconds)
          .toBe(profile.elapsedSeconds);
    }
  });

  it("never estimates Fast from software history or software from Fast history", () => {
    const fast = { ...sample, encoder: "amf-cqp18" as const, elapsedSeconds: 9, finalBytes: 10_000_000 };
    expect(estimateExportFromHistory(workload, output, "medium", "partition-pipes-v1", [sample], "amf-cqp18").seconds).toBeNull();
    expect(estimate(workload, [fast]).seconds).toBeNull();
    expect(estimateExportFromHistory(workload, output, "medium", "partition-pipes-v1", [sample, fast], "amf-cqp18"))
      .toMatchObject({ seconds: 9, finalBytes: 10_000_000 });
    expect(estimate(workload, [sample, fast])).toMatchObject({ seconds: 16, finalBytes: 2_400_000 });
  });

  it("does not shorten an estimate when duration or clip count increases", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }), (seconds, clips) => {
      const first = estimate({ ...workload, durationSeconds: seconds, visualClips: clips });
      const more = estimate({ ...workload, durationSeconds: seconds + 1, visualClips: clips + 1 });
      expect(more.seconds!).toBeGreaterThanOrEqual(first.seconds!);
      expect(more.finalBytes!).toBeGreaterThanOrEqual(first.finalBytes!);
    }), { numRuns: 100 });
  });
});

describe("outputSize", () => {
  it("reads the preset off the SHORTER side, so it means the same thing in both orientations", () => {
    expect(outputSize(1920, 1080, "720p")).toEqual({ w: 1280, h: 720 });
    expect(outputSize(1080, 1920, "720p")).toEqual({ w: 720, h: 1280 });
  });

  it("emits nothing when the canvas already matches", () => {
    expect(outputSize(1920, 1080, "1080p")).toBeNull();
    expect(outputSize(1080, 1920, "1080p")).toBeNull();
  });

  it("emits nothing for 'source' or no preset at all", () => {
    expect(outputSize(1920, 1080, "source")).toBeNull();
    expect(outputSize(1920, 1080, undefined)).toBeNull();
  });

  it("never UPSCALES — asking 2160p of a 720p project invents detail and costs a fortune", () => {
    expect(outputSize(1280, 720, "2160p")).toBeNull();
    expect(outputSize(1280, 720, "1080p")).toBeNull();
  });

  it("keeps the aspect ratio it was given", () => {
    const r = outputSize(2560, 1080, "480p"); // an ultrawide
    expect(r).not.toBeNull();
    expect(r!.w / r!.h).toBeCloseTo(2560 / 1080, 1);
  });

  it("refuses to produce an odd dimension, which ffmpeg cannot encode to yuv420p", () => {
    // The failure this guards is not cosmetic: libx264 + yuv420p aborts with "width not
    // divisible by 2", so an odd result means the export simply fails.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.constantFrom("2160p", "1440p", "1080p", "720p", "480p" as const),
        (w, h, preset) => {
          const r = outputSize(w, h, preset);
          if (!r) return;
          expect(r.w % 2).toBe(0);
          expect(r.h % 2).toBe(0);
          expect(r.w).toBeGreaterThanOrEqual(2);
          expect(r.h).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never returns a size LARGER than the canvas, for any input (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8000 }),
        fc.integer({ min: 2, max: 8000 }),
        fc.constantFrom("2160p", "1440p", "1080p", "720p", "480p" as const),
        (w, h, preset) => {
          const r = outputSize(w, h, preset);
          if (!r) return;
          expect(r.w).toBeLessThanOrEqual(w + 1); // +1 for the even-rounding step
          expect(r.h).toBeLessThanOrEqual(h + 1);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("shrugs off a degenerate canvas instead of emitting a broken filter", () => {
    expect(outputSize(0, 1080, "720p")).toBeNull();
    expect(outputSize(1920, 0, "720p")).toBeNull();
  });
});

describe("crfFor", () => {
  it("leaves libx264 on its own default when no quality was chosen", () => {
    // Load-bearing: this is what keeps a default export byte-identical to what it was before
    // presets existed.
    expect(crfFor(undefined)).toBeNull();
  });

  it("gets better as the label gets better", () => {
    expect(crfFor("high")).toBeLessThan(crfFor("medium")!);
    expect(crfFor("medium")).toBeLessThan(crfFor("low")!);
  });
});

describe("outputFps", () => {
  it("uses the canvas rate when nothing was asked for", () => {
    expect(outputFps(30, undefined)).toBe(30);
  });

  it("uses the requested rate when it is usable", () => {
    expect(outputFps(30, 60)).toBe(60);
    expect(outputFps(30, 24)).toBe(24);
  });

  it("falls back to the canvas rate rather than emitting nonsense", () => {
    for (const bad of [0, -1, 121, NaN, Infinity]) expect(outputFps(30, bad)).toBe(30);
  });

  it("always returns a rate ffmpeg will accept (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 120 }),
        fc.double({ min: -1000, max: 1000, noNaN: false }),
        (canvas, requested) => {
          const r = outputFps(canvas, requested);
          expect(Number.isInteger(r)).toBe(true);
          expect(r).toBeGreaterThanOrEqual(1);
          expect(r).toBeLessThanOrEqual(120);
        },
      ),
      { numRuns: 300 },
    );
  });
});
