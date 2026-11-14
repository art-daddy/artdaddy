import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SpeechJob } from "../store/speechJobs";
import { audioMovedFor, jobsFor, runReads } from "./speechJobMatch";

const PATH = "C:/proj/talk.mp4";
const job = (over: Partial<SpeechJob> = {}): SpeechJob => ({
  id: "j1",
  purpose: "look",
  label: "talk.mp4",
  work: [{ source: PATH, language: "", window: null }],
  spanS: 120,
  phase: "running",
  stop: null,
  enqueuedAt: 0,
  startedAt: 0,
  firstWordsAt: 1,
  endedAt: null,
  doneS: 10,
  rate: 0.5,
  etaS: 55,
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
const entry = (
  key: string,
  path: string | null,
  window: { start: number; end: number } | null = null,
) => ({
  key,
  path,
  window,
});

describe("which run reads a file", () => {
  it("is the run of its path, whatever the slashes, and of nothing else", () => {
    expect(runReads(job(), "C:\\proj\\talk.mp4", null)).toBe(true);
    expect(runReads(job(), "C:/proj/talk.mp4/", null)).toBe(true);
    expect(runReads(job(), "C:/proj/talk2.mp4", null)).toBe(false);
    expect(runReads(job(), "C:/proj/TALK.mp4", null), "a path is read as written").toBe(false);
  });

  it("holds a stretch when the run's stretch holds it, and a whole-file run holds any", () => {
    const part = job({ work: [{ source: PATH, language: "", window: { start: 10, end: 50 } }] });
    expect(runReads(part, PATH, { start: 20, end: 40 })).toBe(true);
    expect(runReads(part, PATH, { start: 5, end: 40 })).toBe(false);
    expect(runReads(part, PATH, null), "a part of the file is not the whole of it").toBe(false);
    expect(runReads(job(), PATH, { start: 5, end: 40 })).toBe(true);
  });

  it("reads an open end as the end of the file", () => {
    const rest = job({ work: [{ source: PATH, language: "", window: { start: 100, end: null } }] });
    expect(runReads(rest, PATH, { start: 150, end: Infinity })).toBe(true);
    expect(runReads(rest, PATH, { start: 50, end: 80 })).toBe(false);
  });

  it("holds when ANY of the files a run reads is the one: a run over several files", () => {
    const several = job({
      work: [
        { source: "C:/proj/a.mp4", language: "", window: null },
        { source: PATH, language: "", window: null },
      ],
    });
    expect(runReads(several, PATH, null)).toBe(true);
  });
});

describe("the job that stands for a file awaited", () => {
  it("is the one that has got furthest when several read it", () => {
    const jobs = [
      job({ id: "q", phase: "waiting", etaS: null, firstWordsAt: null }),
      job({ id: "s", phase: "starting", etaS: null, firstWordsAt: null }),
      job({ id: "r" }),
    ];
    expect(jobsFor([entry("a", PATH)], jobs).get("a")?.id).toBe("r");
    expect(jobsFor([entry("a", PATH)], jobs.slice(0, 2)).get("a")?.id).toBe("s");
  });

  it("is, of several running, the one that has a measured time, and then the soonest", () => {
    const unmeasured = job({ id: "u", etaS: null });
    const far = job({ id: "far", etaS: 300 });
    const near = job({ id: "near", etaS: 40 });
    expect(jobsFor([entry("a", PATH)], [unmeasured, far]).get("a")?.id).toBe("far");
    expect(jobsFor([entry("a", PATH)], [far, unmeasured]).get("a")?.id).toBe("far");
    expect(jobsFor([entry("a", PATH)], [far, near, unmeasured]).get("a")?.id).toBe("near");
  });

  it("is none for a file with no path, a file no run reads, and a run that has been stopped", () => {
    expect(jobsFor([entry("a", null)], [job()]).size).toBe(0);
    expect(jobsFor([entry("a", "C:/proj/other.mp4")], [job()]).size).toBe(0);
    expect(jobsFor([entry("a", PATH)], [job({ phase: "stopped", stop: "cancelled" })]).size).toBe(
      0,
    );
  });

  it("matches each file to its own run", () => {
    const jobs = [
      job({ id: "a", work: [{ source: "C:/proj/a.mp4", language: "", window: null }] }),
      job({ id: "b", work: [{ source: "C:/proj/b.mp4", language: "", window: null }] }),
    ];
    const found = jobsFor([entry("x", "C:/proj/b.mp4"), entry("y", "C:/proj/a.mp4")], jobs);
    expect([found.get("x")?.id, found.get("y")?.id]).toEqual(["b", "a"]);
  });

  it("never invents a job: whatever it is given, what it returns reads the file asked about", () => {
    const windows = [
      null,
      { start: 0, end: 10 },
      { start: 5, end: 20 },
      { start: 0, end: Infinity },
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            path: fc.constantFrom("C:/a", "C:/b", null),
            window: fc.constantFrom(...windows),
          }),
          { maxLength: 6 },
        ),
        fc.array(
          fc.record({
            source: fc.constantFrom("C:/a", "C:/b", "C:/c"),
            phase: fc.constantFrom<SpeechJob["phase"]>("waiting", "starting", "running", "stopped"),
            window: fc.constantFrom<{ start: number; end: number | null } | null>(
              null,
              { start: 0, end: 10 },
              { start: 0, end: null },
            ),
          }),
          { maxLength: 6 },
        ),
        (entries, jobSpecs) => {
          const jobs = jobSpecs.map((j, i) =>
            job({
              id: `j${i}`,
              phase: j.phase,
              work: [{ source: j.source, language: "", window: j.window }],
            }),
          );
          const keyed = entries.map((e, i) => ({ key: `k${i}`, ...e }));
          const found = jobsFor(keyed, jobs);
          for (const e of keyed) {
            const got = found.get(e.key);
            if (!got) continue;
            expect(e.path).not.toBeNull();
            expect(got.phase).not.toBe("stopped");
            expect(runReads(got, e.path as string, e.window)).toBe(true);
          }
        },
      ),
    );
  });
});

describe("whether audio of a file's run has moved", () => {
  it("is false while the run has started and said no word, true once it is running", () => {
    expect(
      audioMovedFor([job({ phase: "starting", etaS: null, firstWordsAt: null })], PATH, null),
    ).toBe(false);
    expect(audioMovedFor([job()], PATH, null)).toBe(true);
  });

  it("is not known when nothing reads the file, the run has not started, or the path is not known", () => {
    expect(audioMovedFor([], PATH, null)).toBeNull();
    expect(
      audioMovedFor([job({ phase: "waiting", etaS: null, firstWordsAt: null })], PATH, null),
    ).toBeNull();
    expect(audioMovedFor([job()], null, null)).toBeNull();
    expect(
      audioMovedFor([job({ work: [{ source: "C:/x", language: "", window: null }] })], PATH, null),
    ).toBeNull();
  });
});
