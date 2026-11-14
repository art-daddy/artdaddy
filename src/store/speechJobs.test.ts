// The store of speech jobs is the contract between the engine that runs them and the chip that shows
// them, so what is pinned here is what each side may rely on: one job is one id, Cancel reaches that job
// and no other, a stopped job is shown for a while and then goes, and the chip shows what is going before
// what has stopped before what is waiting.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSpeechJobs,
  cancelSpeechJob,
  chipJob,
  registerCanceller,
  STOPPED_SHOWN_MS,
  useSpeechJobs,
  waitingBesides,
  type SpeechJob,
} from "./speechJobs";

const FACTS = {
  backend: null,
  gpuHeld: false,
  noGpu: false,
  cores: 4,
  threads: 2,
  exportsBusy: false,
};
function job(id: string, over: Partial<SpeechJob> = {}): SpeechJob {
  return {
    id,
    purpose: "index",
    label: `${id}.mp4`,
    spanS: 1200,
    phase: "waiting",
    stop: null,
    enqueuedAt: 1_000,
    startedAt: null,
    firstWordsAt: null,
    endedAt: null,
    doneS: 0,
    rate: null,
    etaS: null,
    facts: { ...FACTS },
    ...over,
  };
}
const state = () => useSpeechJobs.getState();

beforeEach(() => __resetSpeechJobs());

describe("the list of jobs", () => {
  it("holds one job per id: adding it again replaces it", () => {
    state().add(job("a"));
    state().add(job("a", { doneS: 30 }));
    expect(state().jobs).toHaveLength(1);
    expect(state().jobs[0].doneS).toBe(30);
  });

  it("merges a patch into one job, its facts field by field, and leaves a job that is not there alone", () => {
    state().add(job("a"));
    state().add(job("b"));
    state().patch("a", { phase: "running", doneS: 60, facts: { backend: "cpu", noGpu: true } });
    state().patch("zzz", { doneS: 1 });
    const [a, b] = state().jobs;
    expect(a).toMatchObject({ phase: "running", doneS: 60 });
    expect(a.facts).toEqual({ ...FACTS, backend: "cpu", noGpu: true });
    expect(b).toEqual(job("b"));
    expect(state().jobs).toHaveLength(2);
  });

  it("drops a finished or failed run, and keeps a stopped one as stopped with no time left", () => {
    for (const id of ["done", "failed", "cancelled", "slow"])
      state().add(job(id, { phase: "running", etaS: 90 }));
    state().end("done", "done", 5_000);
    state().end("failed", "failed", 5_000);
    state().end("cancelled", "cancelled", 5_000);
    state().end("slow", "too_slow", 6_000);
    expect(state().jobs.map((j) => j.id)).toEqual(["cancelled", "slow"]);
    expect(state().jobs[0]).toMatchObject({
      phase: "stopped",
      stop: "cancelled",
      endedAt: 5_000,
      etaS: null,
    });
    expect(state().jobs[1]).toMatchObject({ phase: "stopped", stop: "too_slow", endedAt: 6_000 });
  });

  it("removes a stopped job after it has been shown for a while, never one that is still going", () => {
    state().add(job("run", { phase: "running" }));
    state().add(job("stop", { phase: "running" }));
    state().end("stop", "cancelled", 10_000);
    state().prune(10_000 + STOPPED_SHOWN_MS - 1);
    expect(state().jobs.map((j) => j.id)).toEqual(["run", "stop"]);
    state().prune(10_000 + STOPPED_SHOWN_MS);
    expect(state().jobs.map((j) => j.id)).toEqual(["run"]);
    state().prune(10 ** 12);
    expect(state().jobs.map((j) => j.id)).toEqual(["run"]);
  });
});

describe("Cancel", () => {
  it("reaches the job it was registered for and no other", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerCanceller("a", a);
    registerCanceller("b", b);
    expect(cancelSpeechJob("a")).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("finds nothing to stop once the run has withdrawn it, or for a job that never started", () => {
    const a = vi.fn();
    const withdraw = registerCanceller("a", a);
    withdraw();
    expect(cancelSpeechJob("a")).toBe(false);
    expect(cancelSpeechJob("never")).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("a run that registered again under the same id keeps its own canceller when the first one is withdrawn late", () => {
    const first = vi.fn();
    const second = vi.fn();
    const withdrawFirst = registerCanceller("a", first);
    registerCanceller("a", second);
    withdrawFirst();
    expect(cancelSpeechJob("a")).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("what the chip shows", () => {
  it("is what is going first, the one started first; then what just stopped; then what is waiting", () => {
    const waiting = job("w", { enqueuedAt: 1 });
    const stopped = job("s", { phase: "stopped", stop: "cancelled", endedAt: 50 });
    const later = job("s2", { phase: "stopped", stop: "cancelled", endedAt: 90 });
    const running = job("r", { phase: "running", startedAt: 20 });
    const starting = job("t", { phase: "starting", startedAt: 10 });
    expect(chipJob([waiting])?.id).toBe("w");
    expect(chipJob([waiting, stopped, later])?.id).toBe("s2");
    expect(chipJob([waiting, stopped, running, starting])?.id).toBe("t");
    expect(chipJob([])).toBeNull();
  });

  it("counts the others waiting, not the one it shows", () => {
    const jobs = [
      job("a", { phase: "running" }),
      job("b"),
      job("c"),
      job("d", { phase: "stopped" }),
    ];
    expect(waitingBesides(jobs, jobs[0])).toBe(2);
    expect(waitingBesides(jobs, jobs[1])).toBe(1);
    expect(waitingBesides([], null)).toBe(0);
  });
});
