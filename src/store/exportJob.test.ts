import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { useExportJob } from "./exportJob";
import type { ExportCalibration } from "../timeline/exportOptions";

const sample: ExportCalibration = {
  workload: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 10,
    visualClips: 14,
    captionClips: 2,
    audioClips: 1,
    peakVisualLayers: 8,
    peakMediaLayers: 7,
  },
  output: { width: 1920, height: 1080, fps: 30 },
  quality: "medium",
  engine: "partition-pipes-v1",
  elapsedSeconds: 16,
  finalBytes: 2_400_000,
  memoryBytes: null,
  temporaryBytes: null,
};

beforeEach(() => {
  useExportJob.setState({ calibrations: [], mode: "quality" });
});

describe("local export calibration records", () => {
  it("bounds successful measurements without discarding unknown resource values", () => {
    for (let index = 0; index < 40; index++)
      useExportJob.getState().rememberCalibration({ ...sample, elapsedSeconds: index + 1 });
    expect(useExportJob.getState().calibrations).toHaveLength(24);
    expect(useExportJob.getState().calibrations[23]).toMatchObject({
      elapsedSeconds: 40,
      memoryBytes: null,
      temporaryBytes: null,
    });
  });

  it("rejects unusable observations rather than giving them zero-cost estimates", () => {
    for (const invalid of [
      { elapsedSeconds: NaN },
      { elapsedSeconds: 0 },
      { finalBytes: -1 },
      { quality: "unknown" },
    ])
      useExportJob.getState().rememberCalibration({ ...sample, ...invalid });
    useExportJob
      .getState()
      .rememberCalibration(JSON.parse(JSON.stringify({ ...sample, encoder: "unqualified" })));
    expect(useExportJob.getState().calibrations).toEqual([]);
  });

  it("keeps explicit encoder observations separate and starts in Full quality", () => {
    expect(useExportJob.getState().mode).toBe("quality");
    useExportJob.getState().setMode("fast");
    expect(useExportJob.getState().mode).toBe("fast");
    useExportJob.getState().rememberCalibration(sample);
    useExportJob.getState().rememberCalibration({ ...sample, encoder: "amf-cqp18" });
    expect(useExportJob.getState().calibrations.map((entry) => entry.encoder)).toEqual([
      "x264-crf",
      "amf-cqp18",
    ]);
  });

  it("drops private fields while preserving valid numeric measurements", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const secret = `private:${text}`;
        useExportJob.getState().rememberCalibration({
          ...sample,
          ...{ filename: secret, project_id: secret, error: secret },
          workload: { ...sample.workload, ...{ content: secret } },
        });
        const kept = useExportJob.getState().calibrations.at(-1)!;
        expect(kept.elapsedSeconds).toBe(16);
        expect(JSON.stringify(kept)).not.toContain(secret);
        expect(kept.memoryBytes).toBeNull();
      }),
      { numRuns: 40 },
    );
  });
});
