// One real PC's transcription times, replayed through the old and the new model of how long a
// transcription takes (S2, 5.1b). The numbers are anonymous: whisper's own audio seconds and total
// seconds of the 12 runs one PC finished on 9 and 10 Nov 2026 (graphics chip, `small` model), in the
// order they ran. They are not on one line (the start-up of that PC is about a minute, and one run
// of 33 s of audio took 463 s), which is exactly why a time shown before any audio has moved is a
// guess, and why the model may not show less than the start-up it has measured.
import { describe, expect, it } from "vitest";

import { estimateTranscribeSeconds, type PaceSample } from "./speechPace";

const W1: ReadonlyArray<readonly [audio: number, wall: number]> = [
  [45.7, 92.7],
  [40.9, 92.2],
  [83.6, 174.6],
  [32.8, 462.6],
  [120.0, 145.2],
  [134.2, 168.2],
  [118.0, 300.0],
  [45.7, 110.1],
  [40.9, 92.4],
  [83.6, 167.2],
  [120.0, 143.4],
  [120.0, 143.7],
];

/** What the app of 0.27.0 said before each of those runs, fed that PC's own earlier runs: frozen
 *  from the old formula (3 s of start-up, the median of the last eight runs' `(wall - 3) / audio`,
 *  0.35 s per audio second before any run), so the comparison below is with what shipped. */
const OLD_SAID = [19, 83, 176, 70, 257, 278, 240, 97, 90, 186, 257, 252];

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
function oldFormula(history: ReadonlyArray<readonly [number, number]>, audio: number): number {
  const kept = history.filter(([a]) => a >= 10).slice(-8);
  const rate = kept.length ? median(kept.map(([a, w]) => Math.max(0.01, (w - 3) / a))) : 0.35;
  return Math.round(3 + rate * audio);
}

/** What the model under test says before run `i`, having been told of the runs before it. */
const saysBefore = (i: number, startup?: number): number => {
  const seen: PaceSample[] = W1.slice(0, i).map(([a, w]) =>
    startup ? [a, w, "gpu", startup] : [a, w, "gpu"],
  );
  return estimateTranscribeSeconds(W1[i][0], seen, "windows", "gpu");
};
const error = (said: number, real: number): number => Math.abs(said - real);

describe("one real PC's 12 transcriptions, replayed", () => {
  it("starts from what the old model really said: the frozen numbers are the old formula's output", () => {
    expect(W1.map(([a], i) => oldFormula(W1.slice(0, i), a))).toEqual(OLD_SAID);
  });

  it("never shows a time below the start-up the backend is known to have, before any audio has moved", () => {
    // A start-up the PC itself measured (what the monitor will record) is a floor...
    for (let i = 1; i < W1.length; i++) {
      const seen: PaceSample[] = W1.slice(0, i).map(([a, w]) => [a, w, "gpu", 65]);
      expect(
        estimateTranscribeSeconds(0, seen, "windows", "gpu"),
        `run ${i + 1}`,
      ).toBeGreaterThanOrEqual(65);
      expect(saysBefore(i, 65), `run ${i + 1} of ${W1[i][0]} s`).toBeGreaterThanOrEqual(65);
    }
    // ...and with none measured it is the backend's default start-up, which is never the 3 s that
    // said "19 s" for a clip that took 93.
    const nothingYet = estimateTranscribeSeconds(0, [], "windows", "gpu");
    expect(nothingYet).toBeGreaterThan(3);
    for (let i = 0; i < W1.length; i++) {
      const seen: PaceSample[] = W1.slice(0, i).map(([a, w]) => [a, w, "gpu"]);
      expect(
        estimateTranscribeSeconds(0, seen, "windows", "gpu"),
        `run ${i + 1}`,
      ).toBeGreaterThanOrEqual(nothingYet);
    }
  });

  it("is closer to what the runs really took than the old model was: in the first run, and over the 12", () => {
    const now = W1.map((_, i) => saysBefore(i));
    expect(error(now[0], W1[0][1]), "the first clip, before any history").toBeLessThan(
      error(OLD_SAID[0], W1[0][1]),
    );
    const total = (said: number[]) => said.reduce((n, s, i) => n + error(s, W1[i][1]), 0);
    const logTotal = (said: number[]) =>
      said.reduce((n, s, i) => n + Math.abs(Math.log(s / W1[i][1])), 0);
    expect(total(now), "total seconds wrong").toBeLessThan(total(OLD_SAID));
    expect(logTotal(now), "total proportion wrong, over and under alike").toBeLessThan(
      logTotal(OLD_SAID),
    );
  });
});
