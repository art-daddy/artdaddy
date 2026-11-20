// The list of failed background transcriptions: what keeps one project's failures from another's, and what Retry
// reaches. Tested through the store's own doors, as the indexer and the status bar use them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSpeechFailures,
  ENGINE_FAILURE_ID,
  registerSpeechRetrier,
  retrySpeechFailures,
  useSpeechFailures,
  type SpeechFailure,
} from "./speechFailures";

const failure = (owner: string, id: string, over: Partial<SpeechFailure> = {}): SpeechFailure => ({
  id,
  owner,
  label: id,
  reason: "engine_failed",
  message: `${id} failed`,
  at: 1,
  attempts: 1,
  willRetry: true,
  ...over,
});
const ids = (): string[] => useSpeechFailures.getState().failures.map((f) => `${f.owner}/${f.id}`);

beforeEach(__resetSpeechFailures);
afterEach(__resetSpeechFailures);

describe("the list of failures", () => {
  it("holds one entry per piece of work: a second failure of it replaces the first", () => {
    const s = useSpeechFailures.getState();
    s.record(failure("p1", "a"));
    s.record(failure("p1", "b"));
    s.record(failure("p1", "a", { attempts: 2 }));
    expect(ids().sort()).toEqual(["p1/a", "p1/b"]);
    expect(useSpeechFailures.getState().failures.find((f) => f.id === "a")?.attempts).toBe(2);
  });

  it("keeps the same id of two projects apart: closing one takes away only its own", () => {
    const s = useSpeechFailures.getState();
    s.record(failure("p1", "a"));
    s.record(failure("p2", "a"));
    s.clear("p1", "a");
    expect(ids()).toEqual(["p2/a"]);
    s.record(failure("p1", "b"));
    s.clearOwner("p1");
    expect(ids()).toEqual(["p2/a"]);
  });

  it("is emptied by the cross, and clearing what is not there changes nothing", () => {
    const s = useSpeechFailures.getState();
    s.record(failure("p1", "a"));
    const before = useSpeechFailures.getState().failures;
    s.clear("p1", "missing");
    s.clearOwner("nobody");
    expect(useSpeechFailures.getState().failures).toBe(before);
    s.dismissAll();
    expect(ids()).toEqual([]);
  });
});

describe("Retry", () => {
  it("reaches each failure through the indexer that owns it, the engine first", () => {
    const order: string[] = [];
    const p1 = vi.fn((f: SpeechFailure) => order.push(`p1/${f.id}`));
    const p2 = vi.fn((f: SpeechFailure) => order.push(`p2/${f.id}`));
    registerSpeechRetrier("p1", p1);
    registerSpeechRetrier("p2", p2);
    const s = useSpeechFailures.getState();
    s.record(failure("p1", "a"));
    s.record(failure("p2", "b"));
    s.record(failure("p2", ENGINE_FAILURE_ID, { label: null, reason: "engine_unavailable" }));
    expect(retrySpeechFailures()).toBe(3);
    expect(order[0]).toBe(`p2/${ENGINE_FAILURE_ID}`);
    expect(order.sort()).toEqual(["p1/a", "p2/b", `p2/${ENGINE_FAILURE_ID}`].sort());
  });

  it("leaves alone a failure whose indexer is gone: nothing can retry it, and it is not counted", () => {
    useSpeechFailures.getState().record(failure("closed", "a"));
    expect(retrySpeechFailures()).toBe(0);
    expect(ids()).toEqual(["closed/a"]);
  });

  it("is not undone by the old registration of a project withdrawing after a new one took its place", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerSpeechRetrier("p1", first);
    registerSpeechRetrier("p1", second);
    offFirst();
    useSpeechFailures.getState().record(failure("p1", "a"));
    expect(retrySpeechFailures()).toBe(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
