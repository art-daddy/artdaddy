// The legacy estimate, frozen. With `estimate_v2` off the app must say exactly what 0.27.0 said, so this file holds 0.27.0's numbers over a grid of
// workloads, earlier exports, routes, sizes and qualities, captured ONCE from the untouched functions (tag v0.27.0, commit 30c35253; see the header
// of the data file) and read from disk here. If it fails, do NOT regenerate the data: find out which input moved which number. The file's hash is
// pinned below for the same reason `render.corpus.test.ts` pins its snapshot: a regenerated file cannot slip through as a green test.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ExportEncoder } from "./exportEncoder";
import {
  EXPORT_SPEED_REVISION,
  estimateExport,
  estimateForDialog,
  type ExportCalibration,
  type ExportEngine,
  type ExportMode,
  type ExportQuality,
  type ExportResolution,
} from "./exportOptions";
import type { RenderWorkload } from "./renderPlan";

const GOLDEN = "src/timeline/__fixtures__/estimateLegacy.golden.json";
const GOLDEN_SHA256 = "d492c0974907395cf29233ab001d6ad4ad3854e5417ff04a1b960f22b9619441";

type Picture = [number, number, number];

interface GoldenSample {
  workload: string | RenderWorkload;
  output: Picture;
  quality: string;
  engine: ExportEngine;
  encoder?: ExportEncoder;
  revisionRel: "current" | "older" | "newer" | "absent";
  elapsedSeconds: number;
  finalBytes: number;
  memoryBytes: number | null;
  temporaryBytes: number | null;
}

interface GoldenCase {
  id: string;
  call: "dialog" | "export";
  workload: string;
  settings: { resolution: ExportResolution; quality: ExportQuality; fps: number | null };
  route: { mode: ExportMode; chip: "amd" | "nvidia" | "intel" | null; faster: boolean };
  engine: ExportEngine;
  output: Picture;
  encoder: ExportEncoder;
  history: number[];
  expected: {
    seconds: number | null;
    guessed: boolean;
    finalBytes: number | null;
    memoryBytes: number | null;
    temporaryBytes: number | null;
  };
}

interface Golden {
  header: { speedRevision: number };
  workloads: Record<string, RenderWorkload>;
  samples: GoldenSample[];
  cases: GoldenCase[];
}

const text = readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n");
const golden = JSON.parse(text) as Golden;

/** A stored sample as an `ExportCalibration`. Revisions are stored relative to the current one, so a bump of the speed revision (a later,
 *  deliberate change) keeps the same samples matching and mismatching as they did when the numbers were captured. */
function calibrationOf(sample: GoldenSample): ExportCalibration {
  const workload =
    typeof sample.workload === "string" ? golden.workloads[sample.workload] : sample.workload;
  const revision = {
    current: EXPORT_SPEED_REVISION,
    older: EXPORT_SPEED_REVISION - 1,
    newer: EXPORT_SPEED_REVISION + 1,
    absent: undefined,
  }[sample.revisionRel];
  return {
    workload,
    output: { width: sample.output[0], height: sample.output[1], fps: sample.output[2] },
    quality: sample.quality,
    engine: sample.engine,
    ...(sample.encoder === undefined ? {} : { encoder: sample.encoder }),
    ...(revision === undefined ? {} : { revision }),
    elapsedSeconds: sample.elapsedSeconds,
    finalBytes: sample.finalBytes,
    memoryBytes: sample.memoryBytes,
    temporaryBytes: sample.temporaryBytes,
  };
}

const historyOf = (entry: GoldenCase): ExportCalibration[] =>
  entry.history.map((index) => calibrationOf(golden.samples[index]));
const outputOf = (entry: GoldenCase) => ({
  width: entry.output[0],
  height: entry.output[1],
  fps: entry.output[2],
});

describe("the legacy estimate golden (0.27.0's numbers)", () => {
  it("is the file that was captured from 0.27.0, not a regenerated one", () => {
    expect(createHash("sha256").update(text).digest("hex")).toBe(GOLDEN_SHA256);
  });

  it("covers what it claims to: every encoder, both engines, history and guesses, and no answer", () => {
    const encoders = new Set(golden.cases.map((entry) => entry.encoder));
    expect([...encoders].sort()).toEqual(
      [
        "chip-amd",
        "chip-intel",
        "chip-nvidia",
        "x264-crf",
        "x264-crf-threads2",
        "x264-fast",
        "x264-fast-threads2",
      ].sort(),
    );
    expect(new Set(golden.cases.map((entry) => entry.engine)).size).toBe(2);
    const kinds = golden.cases.map((entry) =>
      entry.expected.seconds === null
        ? "none"
        : entry.expected.guessed
          ? entry.history.length > 0
            ? "derived"
            : "guess"
          : "measured",
    );
    for (const kind of ["none", "guess", "derived", "measured"])
      expect(kinds.filter((value) => value === kind).length, kind).toBeGreaterThanOrEqual(8);
    expect(new Set(golden.samples.map((sample) => sample.revisionRel)).size).toBe(4);
    expect(golden.cases.filter((entry) => entry.call === "export").length).toBeGreaterThan(30);
    expect(golden.cases.length).toBeGreaterThan(200);
  });

  it("0.27.0's own functions still give every number in it (the legacy path stays frozen)", () => {
    const moved: string[] = [];
    for (const entry of golden.cases) {
      const workload = golden.workloads[entry.workload];
      const history = historyOf(entry);
      const result = estimateExport(
        workload,
        outputOf(entry),
        entry.settings.quality,
        entry.engine,
        history,
        entry.encoder,
      );
      const now = {
        seconds: result.seconds,
        guessed: result.secondsGuessed === true,
        finalBytes: result.finalBytes,
        memoryBytes: result.memoryBytes,
        temporaryBytes: result.temporaryBytes,
      };
      if (JSON.stringify(now) !== JSON.stringify(entry.expected)) moved.push(entry.id);
      if (entry.call === "dialog") {
        const dialog = estimateForDialog(
          workload,
          { ...entry.settings, mode: entry.route.mode },
          history,
          { chip: entry.route.chip, faster: entry.route.faster },
        );
        if (
          dialog.seconds !== entry.expected.seconds ||
          dialog.guessed !== entry.expected.guessed ||
          dialog.finalBytes !== entry.expected.finalBytes
        )
          moved.push(`${entry.id} (dialog)`);
      }
    }
    expect(moved).toEqual([]);
  });
});
