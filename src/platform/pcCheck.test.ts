import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  classOf,
  readPcCheck,
  writeCutoffs,
  writePcCheck,
  type PcCheckRecord,
} from "../timeline/pcClass";
import type { StorageLike } from "../timeline/pcClass";
import {
  IDLE_BEFORE_RUN_MS,
  UNFINISHED_BACKOFF_MS,
  createPcCheckService,
  unfinishedBackoffMs,
  type PcCheckDeps,
  type PcCheckService,
  type PcCheckSignals,
  type ProbeDefinition,
} from "./pcCheck";

const START = 1_700_000_000_000;
const BUILD = "artdaddy@1.0.0";
const DAY = 86_400_000;
const MIN = 60_000;
const HOUR = 3_600_000;

/** A clock, its timers and a Map-backed storage that all move only when the test says so. */
function world(over: Partial<PcCheckDeps> = {}) {
  let t = START;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const map = new Map<string, string>();
  const calls = { set: 0 };
  const handle: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      calls.set++;
      map.set(key, String(value));
    },
    removeItem: (key) => void map.delete(key),
  };
  const deps: PcCheckDeps = {
    now: () => t,
    storage: handle,
    build: BUILD,
    cores: 8,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    probe: async () => ({ kind: "busy" }),
    files: {
      dir: async () => "C:/cache/pc-check",
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
      size: async () => null,
    },
    ...over,
  };
  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  /** Moves the clock, running every timer that falls due in its order, with the promises settled between them. A timer that
   *  keeps arming itself with no delay would never let the clock move: that is a failure here, not a hang. */
  async function advance(ms: number) {
    const target = t + ms;
    let fired = 0;
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers)
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      if (++fired > 2_000) throw new Error("a timer keeps arming itself with no delay");
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
      await flush();
    }
    t = target;
    await flush();
  }
  return {
    deps,
    advance,
    flush,
    now: () => t,
    timerCount: () => timers.size,
    store: { map, calls, bytes: () => JSON.stringify([...map.entries()]) },
  };
}
type World = ReturnType<typeof world>;

const signalsAt = (t: number, over: Partial<PcCheckSignals> = {}): PcCheckSignals => ({
  exportBusy: false,
  exportAsked: false,
  playing: false,
  lookOrSpeechJob: false,
  projectOpen: true,
  lastInputAtMs: t,
  ...over,
});

const record = (bFps = 24): PcCheckRecord => ({
  revision: 1,
  build: BUILD,
  atMs: START,
  cores: 8,
  outcome: "done",
  aFps: 120,
  bFps,
  cFps: 60,
  rHat: 30 / bFps,
  cls: classOf(30 / bFps),
});

/** A probe whose runs the test answers by hand, and that watches its own signal. */
function probeOf(w: World, id: string, over: Partial<ProbeDefinition> = {}) {
  const runs: {
    at: number;
    signal: AbortSignal;
    abortedAt: number | null;
    resolve: (answer: { record: PcCheckRecord | null; stored: boolean }) => void;
  }[] = [];
  const def: ProbeDefinition = {
    id,
    revision: 1,
    ttlMs: 30 * DAY,
    budgetMs: 20_000,
    run: ({ signal }) =>
      new Promise((resolve) => {
        const run = { at: w.now(), signal, abortedAt: null as number | null, resolve };
        signal.addEventListener("abort", () => {
          run.abortedAt = w.now();
        });
        runs.push(run);
      }),
    ...over,
  };
  return {
    def,
    runs,
    answer: (rec: PcCheckRecord | null, stored = false, which = runs.length - 1) =>
      runs[which].resolve({ record: rec, stored }),
  };
}

const identity = (w: World, revision = 1) => ({ atMs: w.now(), build: BUILD, cores: 8, revision });

/** A service with one probe registered, and the editor quiet from now. */
function quietService(
  probeOver: Partial<ProbeDefinition> = {},
  depsOver: Partial<PcCheckDeps> = {},
) {
  const w = world(depsOver);
  const service = createPcCheckService(w.deps);
  const speed = probeOf(w, "speed", probeOver);
  service.registerProbe(speed.def);
  return { w, service, speed };
}

describe("when a probe starts by itself", () => {
  it("starts after 20 seconds of quiet with a project open, and not a moment before", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS - 1);
    expect(speed.runs).toHaveLength(0);
    await w.advance(1);
    expect(speed.runs).toHaveLength(1);
    expect(speed.runs[0].at - START).toBe(IDLE_BEFORE_RUN_MS);
    expect(service.status().running).toBe("speed");
  });

  it("never starts before it has been told a project is open, however long it waits", async () => {
    const { w, speed } = quietService();
    await w.advance(30 * MIN);
    expect(speed.runs).toHaveLength(0);
  });

  const busyKinds: [string, Partial<PcCheckSignals>][] = [
    ["an export is queued or running", { exportBusy: true }],
    [
      "an export is being asked its questions (the queue's own flag does not follow it)",
      { exportAsked: true },
    ],
    ["something is playing", { playing: true }],
    ["a look or a speech job runs", { lookOrSpeechJob: true }],
    ["no project is open", { projectOpen: false }],
  ];
  for (const [name, busy] of busyKinds)
    it(`does not start while ${name}, and waits a full 20 seconds after it stops`, async () => {
      const { w, service, speed } = quietService();
      service.setSignals(signalsAt(w.now(), busy));
      await w.advance(10 * MIN);
      expect(speed.runs).toHaveLength(0);
      service.setSignals(signalsAt(w.now()));
      await w.advance(IDLE_BEFORE_RUN_MS - 1);
      expect(speed.runs).toHaveLength(0);
      await w.advance(1);
      expect(speed.runs).toHaveLength(1);
    });

  it("counts from the person's last touch: typing at 15 seconds moves the start to 35", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(15_000);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS - 1);
    expect(speed.runs).toHaveLength(0);
    await w.advance(1);
    expect(speed.runs).toHaveLength(1);
    expect(speed.runs[0].at - START).toBe(15_000 + IDLE_BEFORE_RUN_MS);
  });

  it("reads a signal it was not given, or a garbled one, as busy: it can only keep a probe from starting", async () => {
    const { w, service, speed } = quietService();
    for (const junk of [
      undefined,
      null,
      "quiet",
      {},
      { projectOpen: true },
      { ...signalsAt(w.now()), exportAsked: undefined },
      { ...signalsAt(w.now()), playing: "no" },
      { ...signalsAt(w.now()), projectOpen: "yes" },
    ]) {
      service.setSignals(junk as unknown as PcCheckSignals);
      await w.advance(2 * MIN);
    }
    expect(speed.runs).toHaveLength(0);
  });

  it("does not take a last-input time from the future as proof of idleness", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now() + 10 * DAY));
    await w.advance(IDLE_BEFORE_RUN_MS - 1);
    expect(speed.runs).toHaveLength(0);
    await w.advance(1);
    expect(speed.runs).toHaveLength(1);
  });

  it("does not start a probe that has a current record", async () => {
    const { w, service, speed } = quietService();
    writePcCheck(w.deps.storage, "speed", record());
    service.setSignals(signalsAt(w.now()));
    await w.advance(DAY);
    expect(speed.runs).toHaveLength(0);
  });
});

describe("what makes a stored answer stale, so that the next idle moment measures again", () => {
  const seeded = async (
    stored: Partial<PcCheckRecord>,
    now: Partial<{ build: string; cores: number }> = {},
  ) => {
    const w = world({
      ...(now.build ? { build: now.build } : {}),
      ...(now.cores ? { cores: now.cores } : {}),
    });
    writePcCheck(w.deps.storage, "speed", { ...record(), ...stored });
    const service = createPcCheckService(w.deps);
    const speed = probeOf(w, "speed");
    service.registerProbe(speed.def);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    return { runs: speed.runs.length, service };
  };

  it("an app update (the build changes)", async () => {
    expect((await seeded({}, { build: "artdaddy@1.0.1" })).runs).toBe(1);
    expect((await seeded({})).runs).toBe(0);
  });

  it("30 days, and not before", async () => {
    expect((await seeded({ atMs: START - 29 * DAY })).runs).toBe(0);
    expect((await seeded({ atMs: START - 31 * DAY })).runs).toBe(1);
  });

  it("a different core count (a copied profile)", async () => {
    expect((await seeded({}, { cores: 16 })).runs).toBe(1);
  });

  it("a damaged store", async () => {
    const w = world();
    w.store.map.set("artdaddy.pcCheck.v1", "{not json");
    const service = createPcCheckService(w.deps);
    const speed = probeOf(w, "speed");
    service.registerProbe(speed.def);
    expect(service.pcClass()).toBe("unknown");
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(1);
  });
});

describe("a person or an export asks", () => {
  it("'Check this PC again' runs a probe whose record is current, at once, with no idle wait", async () => {
    const { w, service, speed } = quietService();
    writePcCheck(w.deps.storage, "speed", record());
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    expect(speed.runs).toHaveLength(1);
    expect(speed.runs[0].at).toBe(START);
  });

  it("does not repeat a current answer for a request that is not forced", async () => {
    const { w, service, speed } = quietService();
    writePcCheck(w.deps.storage, "speed", record());
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "question" });
    expect(speed.runs).toHaveLength(0);
    expect(service.status().lastOutcome).toEqual({ speed: "skipped" });
  });

  it("a heavy export's question with no class yet starts the check now", () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "question" });
    expect(speed.runs).toHaveLength(1);
  });

  it("takes the slot when it is free and is not kept for a quieter moment: while an export is busy or asked it is skipped, and nothing is left waiting", async () => {
    const { w, service, speed } = quietService();
    writePcCheck(w.deps.storage, "speed", record());
    service.setSignals(signalsAt(START, { exportAsked: true }));
    service.requestRun({ reason: "dialog", force: true });
    expect(service.status().lastOutcome).toEqual({ speed: "skipped" });
    service.setSignals(signalsAt(w.now()));
    await w.advance(DAY);
    expect(speed.runs).toHaveLength(0);
  });

  it("does not make a person wait out the pause after a check that did not finish", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    speed.answer(null);
    await w.flush();
    expect(service.pcClass()).toBe("unfinished");
    service.requestRun({ reason: "dialog" });
    expect(speed.runs).toHaveLength(2);
  });

  it("an idle or update request only makes the next idle moment take it: it never starts a run itself", async () => {
    const { w, service, speed } = quietService();
    writePcCheck(w.deps.storage, "speed", record());
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "update", force: true });
    expect(speed.runs).toHaveLength(0);
    await w.advance(IDLE_BEFORE_RUN_MS - 1);
    expect(speed.runs).toHaveLength(0);
    await w.advance(1);
    expect(speed.runs).toHaveLength(1);
  });

  it("names one probe, or an unknown one, or nonsense, without throwing", () => {
    const { w, service, speed } = quietService();
    const other = probeOf(w, "other");
    service.registerProbe(other.def);
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true, id: "other" });
    expect(other.runs).toHaveLength(1);
    expect(speed.runs).toHaveLength(0);
    for (const junk of [
      undefined,
      null,
      {},
      { reason: "later" },
      { reason: "dialog", id: "none", force: true },
    ])
      expect(() => service.requestRun(junk as never)).not.toThrow();
  });

  it("is skipped on battery for an idle run, and not for a person's request or a forced one", async () => {
    let discharging: boolean | null = true;
    const { w, service, speed } = quietService({}, { batteryDischarging: () => discharging });
    service.setSignals(signalsAt(w.now()));
    await w.advance(10 * MIN);
    expect(speed.runs).toHaveLength(0);
    expect(service.status().lastOutcome).toEqual({ speed: "skipped" });
    service.requestRun({ reason: "dialog", force: true });
    expect(speed.runs).toHaveLength(1);
    speed.answer(record());
    await w.flush();

    const second = quietService({}, { batteryDischarging: () => true });
    second.service.requestRun({ reason: "update", force: true });
    second.service.setSignals(signalsAt(second.w.now()));
    await second.w.advance(IDLE_BEFORE_RUN_MS);
    expect(second.speed.runs).toHaveLength(1);

    const unknown = quietService({}, { batteryDischarging: () => null });
    unknown.service.setSignals(signalsAt(unknown.w.now()));
    await unknown.w.advance(IDLE_BEFORE_RUN_MS);
    expect(unknown.speed.runs).toHaveLength(1);
  });

  it("tries again on battery in a later idle stretch, without a loop inside one", async () => {
    let discharging: boolean | null = true;
    const { w, service, speed } = quietService({}, { batteryDischarging: () => discharging });
    service.setSignals(signalsAt(w.now()));
    await w.advance(5 * MIN);
    expect(w.timerCount()).toBe(0);
    discharging = false;
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(1);
  });
});

describe("it never disturbs: a run it is told to stop is stopped at once and stores nothing", () => {
  const stops: [string, Partial<PcCheckSignals>][] = [
    ["an export is admitted", { exportBusy: true }],
    ["an export is being asked its questions", { exportAsked: true }],
    ["playback starts", { playing: true }],
    ["a look or a speech job starts", { lookOrSpeechJob: true }],
    ["the project closes", { projectOpen: false }],
  ];

  async function running() {
    const made = quietService();
    made.service.setSignals(signalsAt(made.w.now()));
    await made.w.advance(IDLE_BEFORE_RUN_MS);
    expect(made.speed.runs).toHaveLength(1);
    return made;
  }

  for (const [name, change] of stops)
    it(`aborts within 1.5 seconds when ${name}`, async () => {
      const { w, service, speed } = await running();
      const before = w.store.bytes();
      const writes = w.store.calls.set;
      const signalAt = w.now();
      // only this signal differs from the state the run started in: the person has not touched anything
      service.setSignals(signalsAt(START, change));
      await w.advance(1_500);
      expect(speed.runs[0].signal.aborted).toBe(true);
      expect(speed.runs[0].abortedAt! - signalAt).toBeLessThanOrEqual(1_500);
      // the probe, ending on its own account, still hands over what it measured
      speed.answer(record());
      await w.flush();
      expect(w.store.bytes()).toBe(before);
      expect(w.store.calls.set).toBe(writes);
      expect(service.status()).toEqual({ running: null, lastOutcome: { speed: "aborted" } });
      expect(service.pcClass()).toBe("unknown");
    });

  it("aborts within 1.5 seconds when the person types, for a run that started by itself", async () => {
    const { w, service, speed } = await running();
    const before = w.store.bytes();
    service.setSignals(signalsAt(START));
    expect(speed.runs[0].signal.aborted).toBe(false);
    await w.advance(1);
    const typedAt = w.now();
    service.setSignals(signalsAt(typedAt));
    expect(speed.runs[0].signal.aborted).toBe(true);
    expect(speed.runs[0].abortedAt! - typedAt).toBeLessThanOrEqual(1_500);
    speed.answer(record());
    await w.flush();
    expect(w.store.bytes()).toBe(before);
    expect(service.status().lastOutcome).toEqual({ speed: "aborted" });
  });

  it("lets a run a person asked for go on while they type, and keeps its answer", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    await w.advance(1_000);
    service.setSignals(signalsAt(w.now()));
    expect(speed.runs[0].signal.aborted).toBe(false);
    speed.answer(record());
    await w.flush();
    expect(service.status().lastOutcome).toEqual({ speed: "done" });
    expect(service.pcClass()).not.toBe("unknown");
  });

  it("stops a run that a person asked for just the same when an export is admitted", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    service.setSignals(signalsAt(w.now(), { exportBusy: true }));
    expect(speed.runs[0].signal.aborted).toBe(true);
    speed.answer(record());
    await w.flush();
    expect(w.store.map.size).toBe(0);
  });

  describe("the opposite order", () => {
    it("the signal comes while the probe's job is still being submitted: the run ends aborted and nothing is stored", async () => {
      let submitted!: () => void;
      const gate = new Promise<void>((resolve) => (submitted = resolve));
      const { w, service } = quietService({
        run: async ({ signal }) => {
          await gate;
          return { record: signal.aborted ? null : record(), stored: false };
        },
      });
      service.setSignals(signalsAt(w.now()));
      await w.advance(IDLE_BEFORE_RUN_MS);
      expect(service.status().running).toBe("speed");
      const before = w.store.bytes();
      service.setSignals(signalsAt(START, { exportBusy: true }));
      submitted();
      await w.flush();
      expect(w.store.bytes()).toBe(before);
      expect(service.status()).toEqual({ running: null, lastOutcome: { speed: "aborted" } });
    });

    it("even a probe that ignores its signal and finishes a whole record after the stop stores nothing", async () => {
      let submitted!: () => void;
      const gate = new Promise<void>((resolve) => (submitted = resolve));
      const { w, service } = quietService({
        run: async () => (await gate, { record: record(), stored: false }),
      });
      service.setSignals(signalsAt(w.now()));
      await w.advance(IDLE_BEFORE_RUN_MS);
      service.setSignals(signalsAt(START, { playing: true }));
      submitted();
      await w.flush();
      expect(w.store.map.size).toBe(0);
      expect(service.pcClass()).toBe("unknown");
    });

    it("the signal and the answer arrive in the same tick, in either order: nothing is stored", async () => {
      for (const signalFirst of [true, false]) {
        const { w, service, speed } = await running();
        const before = w.store.bytes();
        const stop = () => service.setSignals(signalsAt(START, { exportBusy: true }));
        if (signalFirst) {
          stop();
          speed.answer(record());
        } else {
          speed.answer(record());
          stop();
        }
        await w.flush();
        expect(w.store.bytes(), `signal first: ${signalFirst}`).toBe(before);
        expect(service.status().lastOutcome).toEqual({ speed: "aborted" });
      }
    });

    it("control: an answer that was committed before the signal stays", async () => {
      const { w, service, speed } = await running();
      speed.answer(record());
      await w.flush();
      service.setSignals(signalsAt(START, { exportBusy: true }));
      await w.flush();
      expect(service.status().lastOutcome).toEqual({ speed: "done" });
      expect(readPcCheck(w.deps.storage, "speed", identity(w))).not.toBeNull();
    });
  });
});

describe("one probe at a time", () => {
  it("starts the second probe only after the first has ended, in the order they were registered", async () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    const a = probeOf(w, "a");
    const b = probeOf(w, "b");
    service.registerProbe(a.def);
    service.registerProbe(b.def);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect([a.runs.length, b.runs.length]).toEqual([1, 0]);
    expect(service.status().running).toBe("a");
    // anything that makes the service look again while the first runs (the lane reports the same quiet editor again, a
    // minute passes) must not start another
    service.setSignals(signalsAt(START));
    await w.advance(19_000);
    expect([a.runs.length, b.runs.length]).toEqual([1, 0]);
    a.answer(record());
    await w.flush();
    await w.advance(0);
    expect([a.runs.length, b.runs.length]).toEqual([1, 1]);
    expect(service.status().running).toBe("b");
    b.answer(record());
    await w.flush();
    expect(service.status()).toEqual({ running: null, lastOutcome: { a: "done", b: "done" } });
  });

  it("registers a second probe without knowing either by name: each is stored under its own id", async () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    const first = probeOf(w, "alpha");
    const second = probeOf(w, "beta", { revision: 3 });
    service.registerProbe(first.def);
    service.registerProbe(second.def);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    first.answer(record(40));
    await w.flush();
    await w.advance(0);
    second.answer(record(5));
    await w.flush();
    expect(service.result("alpha")?.bFps).toBe(40);
    expect(service.result("beta")).toMatchObject({ bFps: 5, revision: 3 });
    expect(readPcCheck(w.deps.storage, "beta", identity(w, 3))?.bFps).toBe(5);
    expect(readPcCheck(w.deps.storage, "alpha", identity(w))?.bFps).toBe(40);
    expect(service.result("nothing")).toBeNull();
  });

  it("takes the class from the probe that says it defines it, else from the first registered", async () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    service.registerProbe(probeOf(w, "speech").def);
    service.registerProbe(probeOf(w, "speed", { definesClass: true }).def);
    writePcCheck(w.deps.storage, "speech", { ...record(), bFps: 1, rHat: 30, cls: "weak" });
    writePcCheck(w.deps.storage, "speed", { ...record(), bFps: 120, rHat: 0.25, cls: "fast" });
    expect(service.pcClass()).toBe("fast");

    const plain = world();
    const other = createPcCheckService(plain.deps);
    other.registerProbe(probeOf(plain, "first").def);
    other.registerProbe(probeOf(plain, "second").def);
    writePcCheck(plain.deps.storage, "first", { ...record(), bFps: 1, rHat: 30, cls: "weak" });
    writePcCheck(plain.deps.storage, "second", { ...record(), bFps: 120, rHat: 0.25, cls: "fast" });
    expect(other.pcClass()).toBe("weak");
  });

  it("refuses a probe that is not one, and a second one with the same id", () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    const good = probeOf(w, "speed");
    for (const junk of [
      null,
      {},
      { ...good.def, id: "" },
      { ...good.def, id: "x".repeat(65) },
      { ...good.def, revision: -1 },
      { ...good.def, revision: 1.5 },
      { ...good.def, ttlMs: 0 },
      { ...good.def, budgetMs: Number.NaN },
      { ...good.def, run: "no" },
    ])
      expect(() => service.registerProbe(junk as never)).not.toThrow();
    service.registerProbe(good.def);
    const twin = probeOf(w, "speed");
    service.registerProbe(twin.def);
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    expect(good.runs).toHaveLength(1);
    expect(twin.runs).toHaveLength(0);
  });

  it("does not know the export probe by name, and does not import it", () => {
    // The files are read from the repo's root, where the tests run: `import.meta.url` is not a file URL under every test environment.
    const source = readFileSync(resolve(process.cwd(), "src/platform/pcCheck.ts"), "utf8");
    expect(source).not.toMatch(/export-speed/);
    expect(source).not.toMatch(/pcCheckProbe/);
  });
});

describe("the one slot: the chip test and the probes never overlap", () => {
  it("queues the chip test behind a running probe, and runs it as soon as the probe has ended", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    let chipStarted = false;
    let finishChip!: (value: string) => void;
    const chip = service.withSlot("chip-test", () => {
      chipStarted = true;
      return new Promise<string>((resolve) => (finishChip = resolve));
    });
    await w.flush();
    expect(chipStarted).toBe(false);
    speed.answer(record());
    await w.flush();
    expect(chipStarted).toBe(true);
    expect(service.status().running).toBe("chip-test");
    finishChip("passed");
    await expect(chip).resolves.toEqual({ ran: true, value: "passed" });
    expect(service.status().running).toBeNull();
  });

  it("starts no probe while the chip test holds the slot, and starts one when it lets go", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    let finishChip!: () => void;
    const chip = service.withSlot(
      "chip-test",
      () => new Promise<void>((resolve) => (finishChip = resolve)),
    );
    await w.flush();
    expect(service.status().running).toBe("chip-test");
    await w.advance(5 * MIN);
    expect(speed.runs).toHaveLength(0);
    service.requestRun({ reason: "dialog", force: true });
    expect(speed.runs).toHaveLength(0);
    finishChip();
    await chip;
    await w.advance(0);
    expect(speed.runs).toHaveLength(1);
  });

  it("gives the slot to waiters in the order they asked, ahead of a probe that is due", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    const order: string[] = [];
    const done: (() => void)[] = [];
    const wait = (id: string) =>
      service.withSlot(id, () => {
        order.push(id);
        return new Promise<void>((resolve) => done.push(resolve));
      });
    const results = [wait("one"), wait("two"), wait("three")];
    await w.flush();
    expect(order).toEqual(["one"]);
    for (let i = 0; i < 3; i++) {
      done[i]();
      await w.flush();
    }
    await Promise.all(results);
    expect(order).toEqual(["one", "two", "three"]);
    expect(speed.runs).toHaveLength(0);
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(1);
  });

  it("gives the slot back when the chip test fails, and passes the failure on", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await expect(
      service.withSlot("chip-test", async () => {
        throw new Error("the test blew up");
      }),
    ).rejects.toThrow("the test blew up");
    await expect(
      service.withSlot("chip-test", () => {
        throw new Error("synchronously");
      }),
    ).rejects.toThrow("synchronously");
    expect(service.status().running).toBeNull();
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(1);
  });

  it("does not run a chip test whose caller stopped waiting, and does not let a probe wait for it", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    const controller = new AbortController();
    let ran = false;
    const chip = service.withSlot(
      "chip-test",
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(chip).resolves.toEqual({ ran: false });
    speed.answer(record());
    await w.flush();
    expect(ran).toBe(false);
    const already = new AbortController();
    already.abort();
    await expect(service.withSlot("x", async () => 1, { signal: already.signal })).resolves.toEqual(
      { ran: false },
    );
  });

  it("does not run waiters after the service is gone", async () => {
    const { w, service } = quietService();
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    let ran = false;
    const chip = service.withSlot("chip-test", async () => void (ran = true));
    service.dispose();
    await expect(chip).resolves.toEqual({ ran: false });
    await expect(service.withSlot("later", async () => 1)).resolves.toEqual({ ran: false });
    expect(ran).toBe(false);
  });
});

describe("the time box", () => {
  it("ends a probe that never answers when its 20 seconds are over: stored as not finished, the slot free", async () => {
    const { w, service } = quietService({ run: () => new Promise(() => undefined) });
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    const startedAt = w.now();
    await w.advance(19_999);
    expect(service.status().running).toBe("speed");
    // the class never waits: with the probe running it is a plain value, in the same tick
    const during = service.pcClass();
    expect(during).toBe("unknown");
    expect(during).not.toBeInstanceOf(Promise);
    await w.advance(1);
    expect(w.now() - startedAt).toBe(20_000);
    expect(service.status()).toEqual({ running: null, lastOutcome: { speed: "unfinished" } });
    expect(readPcCheck(w.deps.storage, "speed", identity(w))).toMatchObject({
      outcome: "unfinished",
      cls: "unfinished",
      bFps: null,
      rHat: null,
    });
    expect(service.pcClass()).toBe("unfinished");
  });

  it("hands the hung probe an aborted signal, so it can take its job and its files with it", async () => {
    let seen: AbortSignal | undefined;
    const { w, service } = quietService({
      run: ({ signal }) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    });
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(seen!.aborted).toBe(false);
    await w.advance(20_000);
    expect(seen!.aborted).toBe(true);
  });

  it("frees the slot for the next probe and for the chip test", async () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    const hung = probeOf(w, "hung", { run: () => new Promise(() => undefined) });
    const next = probeOf(w, "next");
    service.registerProbe(hung.def);
    service.registerProbe(next.def);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    const chip = service.withSlot("chip-test", async () => "ok");
    await w.advance(20_000);
    await expect(chip).resolves.toEqual({ ran: true, value: "ok" });
    await w.advance(0);
    expect(next.runs).toHaveLength(1);
  });

  it("uses the probe's own budget", async () => {
    const { w, service } = quietService({
      budgetMs: 5_000,
      run: () => new Promise(() => undefined),
    });
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS + 4_999);
    expect(service.status().running).toBe("speed");
    await w.advance(1);
    expect(service.status().lastOutcome).toEqual({ speed: "unfinished" });
  });

  it("throws away an answer that arrives after the box ended the run", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS + 20_000);
    expect(service.pcClass()).toBe("unfinished");
    speed.answer(record());
    await w.flush();
    expect(service.pcClass()).toBe("unfinished");
    expect(service.result("speed")?.outcome).toBe("unfinished");
  });

  it("counts a probe that says it could not finish, or fails, as not finished", async () => {
    for (const run of [
      async () => ({ record: null, stored: false }),
      async () => {
        throw new Error("ffmpeg is gone");
      },
      () => {
        throw new Error("synchronously");
      },
      async () => undefined,
      async () => ({ record: { ...record(), bFps: null }, stored: false }),
      async () => ({
        record: {
          ...record(),
          outcome: "unfinished" as const,
          bFps: null,
          rHat: null,
          cls: "unfinished" as const,
        },
        stored: false,
      }),
    ]) {
      const { w, service } = quietService({ run: run as unknown as ProbeDefinition["run"] });
      service.setSignals(signalsAt(w.now()));
      await w.advance(IDLE_BEFORE_RUN_MS);
      await w.flush();
      expect(service.status().lastOutcome).toEqual({ speed: "unfinished" });
      expect(service.pcClass()).toBe("unfinished");
    }
  });

  it("refuses to start a run it cannot time-box", async () => {
    let failing = false;
    const { w, service, speed } = quietService(
      {},
      {
        setTimer: (fn, ms) => {
          if (failing) throw new Error("no timers");
          return setTimeout(fn, ms);
        },
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    );
    failing = true;
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    expect(speed.runs).toHaveLength(0);
    expect(service.status()).toEqual({ running: null, lastOutcome: { speed: "skipped" } });
  });
});

describe("the wait after a check that did not finish", () => {
  it("is 10 minutes, 30 minutes, 6 hours, a day, and a day after that", () => {
    expect([1, 2, 3, 4, 5, 6, 100].map(unfinishedBackoffMs)).toEqual([
      10 * MIN,
      30 * MIN,
      6 * HOUR,
      DAY,
      DAY,
      DAY,
      DAY,
    ]);
    expect(UNFINISHED_BACKOFF_MS).toEqual([10 * MIN, 30 * MIN, 6 * HOUR, DAY]);
  });

  it("is none before the first failure, and a day for a count that is not a number", () => {
    for (const none of [0, -1, -Infinity, 0.5])
      expect(unfinishedBackoffMs(none), String(none)).toBe(0);
    for (const odd of [Number.NaN, "3" as unknown as number, undefined as unknown as number])
      expect(unfinishedBackoffMs(odd), String(odd)).toBe(DAY);
    expect(unfinishedBackoffMs(Infinity)).toBe(DAY);
    expect(unfinishedBackoffMs(2.9)).toBe(30 * MIN);
  });

  it("never gets shorter as the failures pile up (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(unfinishedBackoffMs(low)).toBeLessThanOrEqual(unfinishedBackoffMs(high));
        expect(unfinishedBackoffMs(high)).toBeLessThanOrEqual(DAY);
      }),
    );
  });

  it("holds the next automatic try back by that long, again and again, and a finished check ends the streak", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    let runs = 0;
    for (const wait of [10 * MIN, 30 * MIN, 6 * HOUR, DAY, DAY]) {
      expect(speed.runs).toHaveLength(++runs);
      speed.answer(null);
      await w.flush();
      const endedAt = w.now();
      // typing keeps the editor "active" only at the moment it happens; the stretch is long past, so the wait is the backoff
      await w.advance(wait - 1);
      expect(speed.runs, `${wait} ms after failure ${runs}: not yet`).toHaveLength(runs);
      await w.advance(1);
      expect(speed.runs, `${wait} ms after failure ${runs}: now`).toHaveLength(runs + 1);
      expect(speed.runs[runs].at - endedAt).toBe(wait);
    }
    speed.answer(record());
    await w.flush();
    expect(service.pcClass()).not.toBe("unfinished");
    // the answer goes stale after 30 days; the next time the editor is quiet after that it is measured again, and the failures
    // before the success are forgotten: the first wait is 10 minutes again, not a day
    await w.advance(31 * DAY);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(runs + 2);
    speed.answer(null);
    await w.flush();
    const endedAt = w.now();
    await w.advance(10 * MIN);
    expect(speed.runs).toHaveLength(runs + 3);
    expect(speed.runs[runs + 2].at - endedAt).toBe(10 * MIN);
  });

  it("keeps counting across a restart: a stored 'not finished' is the first failure", async () => {
    const first = quietService();
    first.service.setSignals(signalsAt(first.w.now()));
    await first.w.advance(IDLE_BEFORE_RUN_MS);
    first.speed.answer(null);
    await first.w.flush();
    first.service.dispose();
    // a new service over the same storage, 5 minutes later: the 10 minutes are counted from the failure, not from the restart
    await first.w.advance(5 * MIN);
    const second = createPcCheckService(first.w.deps);
    const probe = probeOf(first.w, "speed");
    second.registerProbe(probe.def);
    second.setSignals(signalsAt(first.w.now()));
    await first.w.advance(5 * MIN - 1);
    expect(probe.runs).toHaveLength(0);
    await first.w.advance(1);
    expect(probe.runs).toHaveLength(1);
    // and that was the second failure in a row: the next wait is 30 minutes
    probe.answer(null);
    await first.w.flush();
    const endedAt = first.w.now();
    await first.w.advance(30 * MIN);
    expect(probe.runs).toHaveLength(2);
    expect(probe.runs[1].at - endedAt).toBe(30 * MIN);
  });

  it("does not block the person's own 'Check again' and a forced idle run", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    speed.answer(null);
    await w.flush();
    service.requestRun({ reason: "update", force: true });
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(2);
  });
});

describe("pcClass: at once, from what is stored", () => {
  it("is unknown with no record, and the class of the stored record otherwise", () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    service.registerProbe(probeOf(w, "speed").def);
    expect(service.pcClass()).toBe("unknown");
    for (const [bFps, expected] of [
      [120, "fast"],
      [30, "fast"],
      [24, "ok"],
      [7.5, "ok"],
      [7, "weak"],
    ] as const) {
      writePcCheck(w.deps.storage, "speed", { ...record(bFps) });
      expect(service.pcClass(), String(bFps)).toBe(expected);
    }
  });

  it("is unknown with nothing registered, and never throws", () => {
    const service = createPcCheckService(world().deps);
    expect(service.pcClass()).toBe("unknown");
    expect(service.result("speed")).toBeNull();
    expect(service.status()).toEqual({ running: null, lastOutcome: {} });
  });

  it("reads a damaged or foreign store as unknown", () => {
    for (const raw of [
      "",
      "garbage",
      "[]",
      "null",
      '{"speed":{"revision":1}}',
      "x".repeat(100_000),
    ]) {
      const w = world();
      w.store.map.set("artdaddy.pcCheck.v1", raw);
      const service = createPcCheckService(w.deps);
      service.registerProbe(probeOf(w, "speed").def);
      expect(service.pcClass(), raw.slice(0, 20)).toBe("unknown");
    }
    const broken = world({
      storage: {
        getItem: () => {
          throw new Error("storage is off");
        },
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    const service = createPcCheckService(broken.deps);
    service.registerProbe(probeOf(broken, "speed").def);
    expect(service.pcClass()).toBe("unknown");
  });

  it("does not use a record of another build, revision or core count", () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    service.registerProbe(probeOf(w, "speed", { revision: 2 }).def);
    writePcCheck(w.deps.storage, "speed", record());
    expect(service.pcClass()).toBe("unknown");
    writePcCheck(w.deps.storage, "speed", { ...record(), revision: 2 });
    expect(service.pcClass()).toBe("ok");
    writePcCheck(w.deps.storage, "speed", { ...record(), revision: 2, build: "other" });
    expect(service.pcClass()).toBe("unknown");
    writePcCheck(w.deps.storage, "speed", { ...record(), revision: 2, cores: 4 });
    expect(service.pcClass()).toBe("unknown");
  });

  it("says unfinished for a check that did not finish, and applies a cut-off the server moved without measuring again", () => {
    const w = world();
    const service = createPcCheckService(w.deps);
    service.registerProbe(probeOf(w, "speed").def);
    writePcCheck(w.deps.storage, "speed", record(12));
    expect(service.pcClass()).toBe("ok");
    writeCutoffs(w.deps.storage, { ok_over: 0.5, weak_over: 2 });
    expect(service.pcClass()).toBe("weak");
    writeCutoffs(w.deps.storage, { ok_over: 0.1, weak_over: 99 });
    expect(service.pcClass()).toBe("weak");
    writePcCheck(w.deps.storage, "speed", {
      ...record(),
      outcome: "unfinished",
      aFps: null,
      bFps: null,
      cFps: null,
      rHat: null,
      cls: "unfinished",
    });
    expect(service.pcClass()).toBe("unfinished");
  });

  it("is removed altogether by the pc_check switch: no class, no run, and the class is read again when it comes back", async () => {
    let on = true;
    const w = world({ flags: () => ({ pc_check: on }) });
    const service = createPcCheckService(w.deps);
    const speed = probeOf(w, "speed");
    service.registerProbe(speed.def);
    writePcCheck(w.deps.storage, "speed", record());
    expect(service.pcClass()).toBe("ok");
    on = false;
    expect(service.pcClass()).toBe("unknown");

    const bare = world({ flags: () => ({ pc_check: on }) });
    const quiet = createPcCheckService(bare.deps);
    const idle = probeOf(bare, "speed");
    quiet.registerProbe(idle.def);
    quiet.setSignals(signalsAt(bare.now()));
    quiet.requestRun({ reason: "dialog", force: true });
    await bare.advance(10 * MIN);
    expect(idle.runs).toHaveLength(0);
    on = true;
    quiet.setSignals(signalsAt(bare.now()));
    await bare.advance(IDLE_BEFORE_RUN_MS);
    expect(idle.runs).toHaveLength(1);
    expect(service.pcClass()).toBe("ok");
  });

  it("treats a switch reader that fails as the compiled default, on", () => {
    const w = world({
      flags: () => {
        throw new Error("no flags");
      },
    });
    const service = createPcCheckService(w.deps);
    service.registerProbe(probeOf(w, "speed").def);
    writePcCheck(w.deps.storage, "speed", record());
    expect(service.pcClass()).toBe("ok");
  });
});

describe("what it stores", () => {
  it("keeps a finished check under the probe's id with the service's own build, core count and time", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    // a probe that stamped another build, core count and time on its record
    speed.answer({ ...record(30), build: "someone else", cores: 64, atMs: 5 });
    await w.flush();
    expect(readPcCheck(w.deps.storage, "speed", identity(w))).toMatchObject({
      outcome: "done",
      build: BUILD,
      cores: 8,
      atMs: w.now(),
      bFps: 30,
    });
    expect(service.pcClass()).toBe("fast");
    await w.advance(DAY);
    expect(speed.runs).toHaveLength(1);
  });

  it("writes nothing for a probe that keeps its own answer, and does not call that a failure", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    speed.answer(null, true);
    await w.flush();
    expect(w.store.map.size).toBe(0);
    expect(service.status().lastOutcome).toEqual({ speed: "done" });
  });

  it("is not a failure when the storage cannot be written: the answer holds for this run and is not measured again and again", async () => {
    const w = world();
    const failing: StorageLike = {
      getItem: (key) => w.store.map.get(key) ?? null,
      setItem: () => {
        throw new Error("storage is full");
      },
      removeItem: () => undefined,
    };
    const { service, speed } = (() => {
      const made = createPcCheckService({ ...w.deps, storage: failing });
      const probe = probeOf(w, "speed");
      made.registerProbe(probe.def);
      return { service: made, speed: probe };
    })();
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    speed.answer(record(30));
    await w.flush();
    expect(service.status().lastOutcome).toEqual({ speed: "done" });
    expect(service.pcClass()).toBe("fast");
    await w.advance(7 * DAY);
    expect(speed.runs).toHaveLength(1);
  });

  it("clamps a core count that is not a count, so a record can still be matched", async () => {
    const w = world({ cores: 0 });
    const service = createPcCheckService(w.deps);
    const speed = probeOf(w, "speed");
    service.registerProbe(speed.def);
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    speed.answer(record(30));
    await w.flush();
    expect(service.pcClass()).toBe("fast");
  });
});

describe("it is tidy", () => {
  it("tells its subscribers when a run starts and ends, and stops when they unsubscribe or one of them throws", async () => {
    const { w, service, speed } = quietService();
    const heard: (string | null)[] = [];
    const stop = service.subscribe(() => heard.push(service.status().running));
    service.subscribe(() => {
      throw new Error("a bad listener");
    });
    service.setSignals(signalsAt(w.now()));
    await w.advance(IDLE_BEFORE_RUN_MS);
    speed.answer(record());
    await w.flush();
    expect(heard).toEqual(["speed", null]);
    stop();
    stop();
    service.requestRun({ reason: "dialog", force: true });
    expect(heard).toEqual(["speed", null]);
  });

  it("leaves no timer behind when it is disposed: not the idle wait, not the time box", async () => {
    const { w, service, speed } = quietService();
    service.setSignals(signalsAt(w.now()));
    expect(w.timerCount()).toBe(1);
    await w.advance(IDLE_BEFORE_RUN_MS);
    expect(speed.runs).toHaveLength(1);
    expect(w.timerCount()).toBe(1);
    const before = w.store.bytes();
    service.dispose();
    expect(w.timerCount()).toBe(0);
    expect(speed.runs[0].signal.aborted).toBe(true);
    speed.answer(record());
    await w.flush();
    await w.advance(DAY);
    expect(w.timerCount()).toBe(0);
    expect(w.store.bytes()).toBe(before);
    expect(service.status().running).toBeNull();
  });

  it("is deaf and dumb after it is disposed, and disposing twice is fine", async () => {
    const { w, service, speed } = quietService();
    service.dispose();
    service.dispose();
    service.setSignals(signalsAt(w.now()));
    service.requestRun({ reason: "dialog", force: true });
    service.registerProbe(probeOf(w, "later").def);
    const heard: number[] = [];
    service.subscribe(() => heard.push(1))();
    await w.advance(DAY);
    expect(speed.runs).toHaveLength(0);
    expect(w.timerCount()).toBe(0);
    expect(heard).toEqual([]);
  });

  it("leaves no timer behind when nothing is due", async () => {
    const { w, service } = quietService();
    writePcCheck(w.deps.storage, "speed", record());
    service.setSignals(signalsAt(w.now()));
    expect(w.timerCount()).toBe(0);
  });

  it("offers exactly the calls of its contract: nothing that could carry a speed, a thread count, a preset or an encoder", () => {
    const service: PcCheckService = createPcCheckService(world().deps);
    expect(Object.keys(service).sort()).toEqual(
      [
        "dispose",
        "pcClass",
        "registerProbe",
        "requestRun",
        "result",
        "setSignals",
        "status",
        "subscribe",
        "withSlot",
      ].sort(),
    );
    // and what it answers is only ever a class, a stored record or a status
    expect(["fast", "ok", "weak", "unfinished", "unknown"]).toContain(service.pcClass());
  });
});
