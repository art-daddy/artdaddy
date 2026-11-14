import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SpeechJob } from "../store/speechJobs";
import type { Entry } from "../store/speechWake";
import type { WakeChatView } from "../store/speechWakeHost";
import { cardInputOf } from "./speechCardInput";
import { cardView } from "./speechTimeLine";

const pathOf = (n: number): string => `C:/proj/f${n}.mp4`;
const entry = (n: number, audioS: number | null = 30): Entry => ({
  key: `k${n}`,
  source: `m_${n}`,
  ref: `m_${n}`,
  audioS,
  window: null,
  path: pathOf(n),
  state: "pending",
  failure: null,
});
const view = (pending: Entry[], over: Partial<WakeChatView> = {}): WakeChatView => ({
  total: pending.length,
  done: 0,
  pending,
  ready: null,
  notes: [],
  ...over,
});
const job = (n: number, over: Partial<SpeechJob> = {}): SpeechJob => ({
  id: `j${n}`,
  purpose: "look",
  label: `f${n}.mp4`,
  work: [{ source: pathOf(n), language: "", window: null }],
  spanS: 30,
  phase: "starting",
  stop: null,
  enqueuedAt: 0,
  startedAt: 0,
  firstWordsAt: null,
  endedAt: null,
  doneS: 0,
  rate: null,
  etaS: null,
  facts: {
    backend: null,
    gpuHeld: false,
    noGpu: false,
    cores: null,
    threads: null,
    exportsBusy: false,
  },
  ...over,
});
const projectedS = (audioS: number): number => 10 + audioS * 0.5;
const input = (wake: WakeChatView, jobs: SpeechJob[]) =>
  cardInputOf({ wake, jobs, download: null, projectedS });
const lines = (wake: WakeChatView, jobs: SpeechJob[]): readonly string[] =>
  cardView(input(wake, jobs))?.lines ?? [];

describe("what the card is told of the work", () => {
  it("says nothing of a time for files no job is found for: the count only", () => {
    const wake = view([entry(1), entry(2), entry(3)], { total: 8, done: 5 });
    expect(input(wake, [])).toMatchObject({
      phase: null,
      runningEtaS: null,
      queuedS: 10 + 15 + 10 + 15 + 10 + 15,
    });
    expect(lines(wake, [])).toEqual(["Transcribing 5 of 8 files"]);
  });

  it("says it is starting, with no time, while the run has said no word", () => {
    const wake = view([entry(1), entry(2)]);
    expect(lines(wake, [job(1)])).toEqual(["Transcribing 0 of 2 files · starting…"]);
  });

  it("says the time once audio has moved: the run's, and the files that are still to start", () => {
    const wake = view([entry(1), entry(2)]);
    const running = job(1, { phase: "running", firstWordsAt: 1, rate: 0.5, etaS: 100 });
    expect(input(wake, [running])).toMatchObject({
      phase: "running",
      runningEtaS: 100,
      queuedS: projectedS(30), // the second file has not started
      slow: false,
    });
    expect(lines(wake, [running])).toEqual(["Transcribing 0 of 2 files · about 2 minutes"]);
  });

  it("says this PC is slow when a run is slower than the audio it reads", () => {
    const wake = view([entry(1)]);
    const slow = job(1, { phase: "running", firstWordsAt: 1, rate: 2.5, etaS: 600 });
    expect(lines(wake, [slow])[0]).toContain("this PC is slow at this");
  });

  it("says it waits for an export when that is what the runs wait for", () => {
    const wake = view([entry(1)]);
    const facts = {
      backend: null,
      gpuHeld: false,
      noGpu: false,
      cores: null,
      threads: null,
      exportsBusy: true,
    };
    expect(lines(wake, [job(1, { phase: "waiting", startedAt: null, facts })])[0]).toContain(
      "waiting for the export",
    );
  });

  it("takes the run of each file from the job that reads it, not from any job there is", () => {
    const wake = view([entry(1)]);
    const other = job(9, { phase: "running", firstWordsAt: 1, rate: 0.5, etaS: 100 });
    expect(input(wake, [other])).toMatchObject({ phase: null, runningEtaS: null });
  });

  it("carries the download, the words ready and the notes through as they are", () => {
    const ready = { files: 2, held: "typing" as const };
    const notes = [{ id: "n1", kind: "engine_failed" as const, count: 1 }];
    const got = cardInputOf({
      wake: view([], { ready, notes }),
      jobs: [],
      download: { pct: 40, etaS: 90 },
      projectedS,
    });
    expect(got).toMatchObject({ ready, notes, download: { pct: 40, etaS: 90 } });
  });
});

// The rule the person is promised: no time before audio has moved. Whatever the jobs and the files, the card shows a
// time only when a run found for one of its files is running and has a time of its own.
describe("whatever the files and the runs are", () => {
  it("never shows a time before audio has moved", () => {
    const timeIn = (s: string): boolean => /about \d+ (minute|hour)|less than a minute/.test(s);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
        fc.array(
          fc.record({
            n: fc.integer({ min: 1, max: 5 }),
            phase: fc.constantFrom<SpeechJob["phase"]>("waiting", "starting", "running"),
            etaS: fc.constantFrom<number | null>(null, 0, 30, 400),
          }),
          { maxLength: 5 },
        ),
        (files, specs) => {
          const wake = view(files.map((n) => entry(n)));
          const jobs = specs.map((s, i) =>
            job(s.n, {
              id: `j${i}`,
              phase: s.phase,
              etaS: s.etaS,
              firstWordsAt: s.phase === "running" ? 1 : null,
            }),
          );
          const got = lines(wake, jobs).join(" ");
          const reads = (j: SpeechJob): boolean =>
            files.some((n) => j.work[0].source === pathOf(n));
          // The rule: a time needs a run of one of the files that has started AND measured itself.
          const measured = jobs.some((j) => reads(j) && j.phase === "running" && j.etaS !== null);
          if (!measured) expect(timeIn(got), got).toBe(false);
        },
      ),
    );
  });
});
