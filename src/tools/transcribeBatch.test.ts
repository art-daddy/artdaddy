// Which queued clips share one run of the engine. The rules are about who must not be held up: a
// clip somebody asked for, a stretch of a file, another language and a clip of unknown length run
// alone, and a batch is sized to take about BATCH_TARGET_S on the machine's own pace.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { secondsPerAudioSecond, STARTUP_S, type PaceSample } from "./speechPace";
import {
  BATCH_MAX_FILES,
  BATCH_TARGET_S,
  batchAudioCapSeconds,
  couldShare,
  pickBatch,
  type BatchCandidate,
  type BatchFlags,
} from "./transcribeBatch";

const clip = (seconds: number | null, over: Partial<BatchCandidate> = {}): BatchCandidate => ({
  language: "",
  windowed: false,
  urgent: false,
  seconds,
  ...over,
});

describe("how much audio one batch may hold", () => {
  it("is what fits in the target after the start-up, at this machine's own pace", () => {
    // no history: the typical figure for the system
    expect(batchAudioCapSeconds([], "windows")).toBeCloseTo((BATCH_TARGET_S - STARTUP_S) / 0.35);
    expect(batchAudioCapSeconds([], "macos")).toBeCloseTo((BATCH_TARGET_S - STARTUP_S) / 0.1);
    // a fast GPU: 100 s of audio in 10 s of wall time leaves 7 s of work, 0.07 s for each
    expect(batchAudioCapSeconds([[100, 10]], "windows")).toBeCloseTo(
      (BATCH_TARGET_S - STARTUP_S) / 0.07,
    );
    // a slow CPU takes much smaller batches
    expect(batchAudioCapSeconds([[60, 40]], "windows")).toBeLessThan(
      batchAudioCapSeconds([[100, 10]], "windows") / 5,
    );
  });

  it("property: a batch of several clips is expected to take no longer than the target", () => {
    const sample = fc.tuple(fc.integer({ min: 10, max: 3600 }), fc.integer({ min: 1, max: 4000 }));
    const queue = fc.array(
      fc.integer({ min: 1, max: 120 }).map((s) => clip(s)),
      { minLength: 2, maxLength: 20 },
    );
    fc.assert(
      fc.property(fc.array(sample, { maxLength: 8 }), queue, (history, q) => {
        const samples: PaceSample[] = history.map(([audio, wall]) => [audio, wall]);
        const picked = pickBatch(q, batchAudioCapSeconds(samples, "windows"));
        if (picked.length < 2) return;
        const total = picked.reduce((n, i) => n + (q[i].seconds as number), 0);
        const expected = STARTUP_S + secondsPerAudioSecond(samples, "windows") * total;
        expect(expected).toBeLessThanOrEqual(BATCH_TARGET_S + 1e-9);
      }),
    );
  });
});

describe("which clips are worth measuring", () => {
  const flags = (over: Partial<BatchFlags> = {}): BatchFlags => ({
    language: "",
    windowed: false,
    urgent: false,
    ...over,
  });

  it("every clip behind a first clip that runs alone is not worth measuring, however ordinary it is", () => {
    for (const head of [flags({ urgent: true }), flags({ windowed: true })]) {
      for (const c of [flags(), flags({ language: "es" }), head])
        expect(couldShare(head, c)).toBe(false);
    }
  });

  it("behind an ordinary first clip only another ordinary one in the same language is", () => {
    const head = flags({ language: "es" });
    expect(couldShare(head, head)).toBe(true);
    expect(couldShare(head, flags({ language: "es" }))).toBe(true);
    expect(couldShare(head, flags({ language: "" }))).toBe(false);
    expect(couldShare(head, flags({ language: "es", urgent: true }))).toBe(false);
    expect(couldShare(head, flags({ language: "es", windowed: true }))).toBe(false);
  });

  // The rule that ties it to the pick: measuring only what could share gives the same batch as measuring
  // everything, so skipping the rest can never change which clips run together.
  it("property: leaving the others unmeasured never changes the batch", () => {
    const candidate = fc.record({
      language: fc.constantFrom("", "es"),
      windowed: fc.boolean(),
      urgent: fc.boolean(),
      seconds: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 40 })),
    });
    fc.assert(
      fc.property(
        fc.array(candidate, { minLength: 1, maxLength: 16 }),
        fc.integer({ min: 0, max: 60 }),
        (queue, cap) => {
          const skipped = queue.map((c) => (couldShare(queue[0], c) ? c : { ...c, seconds: null }));
          expect(pickBatch(skipped, cap)).toEqual(pickBatch(queue, cap));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("which clips are taken together", () => {
  it("nothing for an empty queue", () => {
    expect(pickBatch([], 100)).toEqual([]);
  });

  it("takes clips in the order they are queued, up to the limit", () => {
    const queue = Array.from({ length: 12 }, () => clip(5));
    expect(pickBatch(queue, 1000)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(BATCH_MAX_FILES).toBe(8);
  });

  it("stops at what the machine can do in the target time", () => {
    // 10 s clips against a cap of 25 s: two fit
    expect(pickBatch([clip(10), clip(10), clip(10), clip(10)], 25)).toEqual([0, 1]);
  });

  it("passes over a clip that does not fit and takes a shorter one behind it", () => {
    expect(pickBatch([clip(10), clip(30), clip(5), clip(5)], 25)).toEqual([0, 2, 3]);
  });

  it("a clip that is too long for any batch runs alone, and nothing joins it", () => {
    expect(pickBatch([clip(90), clip(5), clip(5)], 25)).toEqual([0]);
  });

  it.each([
    ["somebody is waiting on it", clip(5, { urgent: true })],
    ["it is a stretch of a file", clip(5, { windowed: true })],
    ["its length is not known", clip(null)],
    ["its length is zero", clip(0)],
  ])("a first clip runs alone when %s", (_why, first) => {
    expect(pickBatch([first, clip(5), clip(5)], 100)).toEqual([0]);
  });

  it.each([
    ["somebody is waiting on it", clip(5, { urgent: true })],
    ["it is a stretch of a file", clip(5, { windowed: true })],
    ["its length is not known", clip(null)],
    ["it is in another language", clip(5, { language: "es" })],
  ])("a later clip stays out when %s, and the ones behind it still join", (_why, odd) => {
    expect(pickBatch([clip(5), odd, clip(5)], 100)).toEqual([0, 2]);
  });

  it("clips asking for the same named language share a run, and a different one does not", () => {
    const es = (s: number) => clip(s, { language: "es" });
    expect(pickBatch([es(5), clip(5), es(5)], 100)).toEqual([0, 2]);
  });

  it("takes a clip that brings the total to exactly the limit, and not one that goes past it", () => {
    expect(pickBatch([clip(10), clip(15)], 25)).toEqual([0, 1]);
    expect(pickBatch([clip(10), clip(16)], 25)).toEqual([0]);
    // a first clip of exactly the limit fits by itself, and leaves no room for another
    expect(pickBatch([clip(25), clip(1)], 25)).toEqual([0]);
  });

  /** The rules every pick obeys, whatever the queue and the limit: the first clip is always taken, a
   *  batch holds one kind of clip within the limits, and nothing that could still have joined it was
   *  left behind. */
  function rulesHold(queue: readonly BatchCandidate[], cap: number): void {
    const picked = pickBatch(queue, cap);
    if (queue.length === 0) {
      expect(picked).toEqual([]);
      return;
    }
    const head = queue[0];
    // the first clip is always among them, in order, none twice, none outside the queue
    expect(picked[0]).toBe(0);
    expect(picked).toEqual([...new Set(picked)].sort((a, b) => a - b));
    expect(picked.every((i) => i >= 0 && i < queue.length)).toBe(true);
    expect(picked.length).toBeLessThanOrEqual(BATCH_MAX_FILES);
    const headBatches = !head.windowed && !head.urgent && !!head.seconds && head.seconds <= cap;
    if (!headBatches) {
      expect(picked).toEqual([0]);
      return;
    }
    // everything with the head is the same kind of clip, and together they fit the target
    let total = 0;
    for (const i of picked) {
      const c = queue[i];
      expect(c.language).toBe(head.language);
      expect(!c.windowed && !c.urgent && !!c.seconds).toBe(true);
      total += c.seconds as number;
    }
    expect(total).toBeLessThanOrEqual(cap);
    // nothing that could have joined was left behind
    if (picked.length < BATCH_MAX_FILES)
      queue.forEach((c, i) => {
        if (picked.includes(i)) return;
        const fits =
          !c.windowed &&
          !c.urgent &&
          !!c.seconds &&
          c.language === head.language &&
          total + c.seconds <= cap;
        expect(fits).toBe(false);
      });
  }

  it("property: the first clip is always taken and the rest never break a rule", () => {
    const candidate = fc.record({
      language: fc.constantFrom("", "en", "es"),
      windowed: fc.boolean(),
      urgent: fc.boolean(),
      seconds: fc.oneof(fc.constant(null), fc.constant(0), fc.integer({ min: 1, max: 300 })),
    });
    fc.assert(
      fc.property(
        fc.array(candidate, { maxLength: 24 }),
        fc.integer({ min: 0, max: 300 }),
        rulesHold,
      ),
      { numRuns: 500 },
    );
  });

  // The same rules on a coarse grid of lengths, where clips add up to EXACTLY the limit far more often
  // than random lengths do: that is where an off-by-one in "fits" would hide.
  it("property: the same rules where clips often add up to exactly the limit", () => {
    const candidate = fc.record({
      language: fc.constantFrom("", "es"),
      windowed: fc.constant(false),
      urgent: fc.constantFrom(false, false, false, false, false, false, false, false, false, true),
      seconds: fc.constantFrom(null, 0, 5, 10, 15, 20, 25),
    });
    fc.assert(
      fc.property(fc.array(candidate, { maxLength: 12 }), fc.constantFrom(25, 30, 50), rulesHold),
      { numRuns: 500 },
    );
  });
});
