import { describe, expect, it } from "vitest";
import { limitThatFired, mibBand, parseNativeDiagnostics } from "./nativeDiagnostics";

const GIB = 1024 ** 3;

// The lines native prints, built exactly as src-tauri/src/jobs/stream.rs formats them.
const resident = (peak: number, limit: number) =>
  `native render resident: ${JSON.stringify({ limit, sampled_peak: peak, workers_at_peak: [{ bytes: peak, pid: 4242, role: "single" }] })}\n`;
const temporary = (peak: number) =>
  `native render temporary: ${JSON.stringify({ accounted_peak_payload_bytes: peak })}\n`;
const budget = (limit: number, peak: number) =>
  `native render budget: configured_commit=${limit}, reported_peak=${peak}; peak is accounting, not an exact physical ceiling\n`;

describe("parseNativeDiagnostics", () => {
  it("reads every fact of a finished run", () => {
    const stderr =
      "frame= 900 fps=30\n" +
      resident(2_500_000_000, 3.5 * GIB) +
      temporary(123_456) +
      budget(4 * GIB, 3_900_000_000);
    expect(parseNativeDiagnostics(stderr)).toEqual({
      residentPeakBytes: 2_500_000_000,
      residentLimitBytes: 3.5 * GIB,
      temporaryPeakBytes: 123_456,
      commitLimitBytes: 4 * GIB,
      commitPeakBytes: 3_900_000_000,
    });
  });

  it("finds the lines after ffmpeg's own output and when the previous line had no newline", () => {
    const stderr = `Conversion failed!${resident(1_000_000, 3.5 * GIB)}${budget(4 * GIB, 5)}`;
    const facts = parseNativeDiagnostics(stderr);
    expect(facts.residentPeakBytes).toBe(1_000_000);
    expect(facts.commitLimitBytes).toBe(4 * GIB);
  });

  it("keeps the last of each line when a run prints several", () => {
    const facts = parseNativeDiagnostics(resident(100, 200) + resident(300, 400));
    expect(facts).toEqual({ residentPeakBytes: 300, residentLimitBytes: 400 });
  });

  it("leaves out what is missing or malformed instead of guessing", () => {
    expect(parseNativeDiagnostics("")).toEqual({});
    expect(parseNativeDiagnostics("native render resident: {not json\n")).toEqual({});
    expect(
      parseNativeDiagnostics('native render resident: {"sampled_peak":"big","limit":-1}\n'),
    ).toEqual({});
    expect(parseNativeDiagnostics("native render budget: configured_commit=x\n")).toEqual({});
    expect(
      parseNativeDiagnostics('native render resident: {"sampled_peak":0,"limit":0}\n'),
    ).toEqual({});
  });

  it("never throws, whatever the text", () => {
    for (const text of [
      "\u0000".repeat(50),
      "native render resident: ",
      "{".repeat(10_000),
      "\n\n\n",
    ])
      expect(() => parseNativeDiagnostics(text)).not.toThrow();
  });
});

describe("mibBand", () => {
  it("rounds to steps of 128 MiB and reports nothing for nothing", () => {
    expect(mibBand(3_800_350_720)).toBe(3584);
    expect(mibBand(3.5 * GIB)).toBe(3584);
    expect(mibBand(8 * GIB)).toBe(8192);
    expect(mibBand(1)).toBe(128);
    expect(mibBand(0)).toBeUndefined();
    expect(mibBand(undefined)).toBeUndefined();
    expect(mibBand(-5)).toBeUndefined();
    for (const bytes of [1, 77_000_000, 3 * GIB + 12345, 40 * GIB])
      expect(mibBand(bytes)! % 128).toBe(0);
  });
});

describe("limitThatFired", () => {
  const none = {};

  it("names the resident limit from the watcher's own words, as the 0.21.7 field failure read", () => {
    const error =
      `native render failed: render resident memory budget exceeded: sampled=3800350720, limit=3758096384\n` +
      resident(3_800_350_720, 3_758_096_384) +
      "output write boundary refused completion: " +
      JSON.stringify({
        cleaned: true,
        limit: 17_999_838_842,
        observed: 0,
        producer_complete: false,
      });
    expect(limitThatFired(error, parseNativeDiagnostics(error))).toBe("resident");
  });

  it("names the commit cap when the job had reached it (the 1.7-second 'Cannot allocate memory' failures)", () => {
    const error =
      "[fc#0 @ 000002052b65d140] Error while filtering: Cannot allocate memory\n" +
      resident(1_300_000_000, 3.5 * GIB) +
      budget(4 * GIB, 4 * GIB - 1000);
    expect(limitThatFired(error, parseNativeDiagnostics(error))).toBe("commit");
  });

  it("blames the machine, not the cap, when the job was far below its commit cap", () => {
    const error = "Error while filtering: Cannot allocate memory\n" + budget(4 * GIB, 1 * GIB);
    expect(limitThatFired(error, parseNativeDiagnostics(error))).toBe("os");
    expect(limitThatFired("Cannot allocate memory", none)).toBe("os");
  });

  it("reads every way ffmpeg says a memory request was refused, the field's own line first", () => {
    for (const refused of [
      "x264 [error]: malloc of size 12030144 failed",
      "[libx264 @ 0000020a] Failed to allocate 12030144 bytes",
      "Could not allocate memory for the frame buffer",
      "not enough memory",
    ]) {
      const below = `${refused}\n${budget(4 * GIB, 1 * GIB)}`;
      expect(limitThatFired(below, parseNativeDiagnostics(below)), refused).toBe("os");
      const at = `${refused}\n${budget(4 * GIB, 4 * GIB - 1000)}`;
      expect(limitThatFired(at, parseNativeDiagnostics(at)), refused).toBe("commit");
      expect(limitThatFired(refused, none), refused).toBe("os");
    }
  });

  it("names the temporary-space allowance and the clock", () => {
    expect(limitThatFired("export workspace allocation budget exceeded before write", none)).toBe(
      "scratch",
    );
    expect(limitThatFired("export workspace budget exceeded before write", none)).toBe("scratch");
    expect(limitThatFired("render execution deadline expired; worker group stopped", none)).toBe(
      "clock",
    );
  });

  it("says nothing for the lines every failed run prints, which are consequences and not causes", () => {
    const error =
      "ffmpeg: Conversion failed!\n" +
      resident(900_000_000, 3.5 * GIB) +
      "output write boundary refused completion: " +
      JSON.stringify({
        cleaned: true,
        limit: 17_999_838_842,
        observed: 0,
        producer_complete: false,
      });
    expect(limitThatFired(error, parseNativeDiagnostics(error))).toBeUndefined();
    expect(limitThatFired("", none)).toBeUndefined();
    expect(limitThatFired("no such file or directory", none)).toBeUndefined();
  });

  it("names the PC's own floor when the app stopped an export to keep the PC usable", () => {
    const error =
      "native render failed: render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself\n" +
      resident(1_300_000_000, 3.5 * GIB);
    expect(limitThatFired(error, parseNativeDiagnostics(error))).toBe("pc_floor");
    // Explicit words win over a consequence printed beside them.
    expect(limitThatFired(`${error}\nCannot allocate memory`, none)).toBe("pc_floor");
  });

  it("prefers the watcher's verdict when several words appear", () => {
    const error =
      "Cannot allocate memory\nnative render failed: render resident memory budget exceeded: sampled=1, limit=0";
    expect(limitThatFired(error, none)).toBe("resident");
  });
});
