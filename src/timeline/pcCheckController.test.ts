// The PC check hears of the world through one controller: it reads the six signals the service wants (an export queued or running, an export being asked, playback, a look or a background
// job, a project open, the person's last input), tells the service at once when a source says something changed and on a one-second heartbeat for the sources that have no event, and so keeps the
// check from starting while any of them is busy and stops it within a second and a half when one turns busy. The service is the real one; the world is a table the tests move.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEARTBEAT_MS, startPcCheckSignals, type SignalReaders } from "./pcCheckController";
import { createPcCheckService, IDLE_BEFORE_RUN_MS } from "../platform/pcCheck";
import type { PcCheckDeps, PcCheckService, ProbeDefinition } from "../platform/pcCheck";
import type { PcCheckRecord, StorageLike } from "./pcClass";

const T0 = 1_700_000_000_000;

const record = (over: Partial<PcCheckRecord> = {}): PcCheckRecord => ({
  revision: 1,
  build: "artdaddy@test",
  atMs: T0,
  cores: 8,
  outcome: "done",
  aFps: 90,
  bFps: 12,
  cFps: 40,
  rHat: 2.5,
  cls: "ok",
  ...over,
});

interface World {
  exportBusy: boolean;
  exportAsked: boolean;
  playing: boolean;
  lookOrSpeechJob: boolean;
  projectOpen: boolean;
  lastInputAtMs: number;
  enabled: boolean;
}

const SIGNALS = [
  "exportBusy",
  "exportAsked",
  "playing",
  "lookOrSpeechJob",
  "projectOpen",
  "lastInputAtMs",
  "enabled",
] as const;
type Signal = (typeof SIGNALS)[number];
/** The five signals that are a state: busy for as long as they say so. The sixth, the last input, is a moment; the seventh is the switch. */
const STATES = ["exportBusy", "exportAsked", "playing", "lookOrSpeechJob", "projectOpen"] as const;

/** The ONE way a signal is made busy in these tests: each has its own busy value. */
function makeBusy(w: World, signal: Signal): void {
  if (signal === "projectOpen") w.projectOpen = false;
  else if (signal === "lastInputAtMs") w.lastInputAtMs = Date.now();
  else if (signal === "enabled") w.enabled = false;
  else w[signal] = true;
}
function makeQuiet(w: World, signal: (typeof STATES)[number]): void {
  if (signal === "projectOpen") w.projectOpen = true;
  else w[signal] = false;
}

interface Run {
  signal: AbortSignal;
  finish(value: PcCheckRecord | null): void;
}

function rig(over: { readers?: Partial<SignalReaders> } = {}) {
  const w: World = {
    exportBusy: false,
    exportAsked: false,
    playing: false,
    lookOrSpeechJob: false,
    projectOpen: true,
    lastInputAtMs: T0 - 60_000,
    enabled: true,
  };
  const heard = new Set<() => void>();
  const storage = new Map<string, string>();
  const storageLike: StorageLike = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
  };
  const runs: Run[] = [];
  const probe: ProbeDefinition = {
    id: "export-speed",
    revision: 1,
    ttlMs: 30 * 86_400_000,
    budgetMs: 20_000,
    definesClass: true,
    run: ({ signal }) =>
      new Promise((resolve) => {
        runs.push({ signal, finish: (value) => resolve({ record: value, stored: false }) });
      }),
  };
  const deps: PcCheckDeps = {
    now: () => Date.now(),
    storage: storageLike,
    build: "artdaddy@test",
    cores: 8,
    flags: () => ({ pc_check: w.enabled }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    probe: async () => ({ kind: "busy" }),
    files: {
      dir: async () => "C:/cache/pc-check",
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
      size: async () => null,
    },
  };
  const service: PcCheckService = createPcCheckService(deps);
  service.registerProbe(probe);
  const readers: SignalReaders = {
    exportBusy: () => w.exportBusy,
    exportAsked: () => w.exportAsked,
    playing: () => w.playing,
    lookOrSpeechJob: () => w.lookOrSpeechJob,
    projectOpen: () => w.projectOpen,
    lastInputAtMs: () => w.lastInputAtMs,
    enabled: () => w.enabled,
    ...over.readers,
  };
  const controller = startPcCheckSignals({
    service,
    read: readers,
    listen: [
      (onChange) => {
        heard.add(onChange);
        return () => void heard.delete(onChange);
      },
    ],
    now: () => Date.now(),
    setBeat: (fn, ms) => setInterval(fn, ms),
    clearBeat: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  return {
    w,
    runs,
    service,
    controller,
    storage,
    /** A source says something changed: what an event of the queue, the ask or the work gate does. */
    changed: () => [...heard].forEach((fn) => fn()),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the check starts when the editor has been quiet, and only then", () => {
  it("starts after the editor has been quiet for the idle wait, and not a moment before", async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_RUN_MS - 1_000);
    expect(r.runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.runs).toHaveLength(1);
    expect(r.service.status().running).toBe("export-speed");
    r.controller.stop();
  });

  it.each(STATES)(
    "does not start for as long as %s says the editor is busy, and starts one idle wait after it stops",
    async (signal) => {
      const r = rig();
      makeBusy(r.w, signal);
      r.changed();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(r.runs, `${signal} busy for ten minutes`).toHaveLength(0);
      makeQuiet(r.w, signal);
      r.changed();
      await vi.advanceTimersByTimeAsync(IDLE_BEFORE_RUN_MS - 2_000);
      expect(r.runs, `${signal}: not yet`).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(r.runs, `${signal}: after the idle wait`).toHaveLength(1);
      r.controller.stop();
    },
  );

  it("waits one idle wait after the person's last input, and every new input begins the wait again", async () => {
    const r = rig();
    // typing every ten seconds for two minutes keeps it from starting, whether the input is announced or only found at a beat
    for (let i = 0; i < 12; i++) {
      r.w.lastInputAtMs = Date.now();
      if (i % 2 === 0) r.changed();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(r.runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_RUN_MS);
    expect(r.runs).toHaveLength(1);
    r.controller.stop();
  });

  it("starts nothing when the switch is off, and starts by itself when the server turns it on, with no other change to prompt it", async () => {
    const r = rig();
    r.w.enabled = false;
    r.changed();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r.runs).toHaveLength(0);
    r.w.enabled = true; // nothing else moves: the heartbeat is what notices
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + IDLE_BEFORE_RUN_MS + 1_000);
    expect(r.runs).toHaveLength(1);
    r.controller.stop();
  });
});

describe("the check stops within a second and a half when the editor turns busy", () => {
  const BUDGET_MS = 1_500;
  /** A check that is under way: the world has been quiet for the idle wait and the probe is running. */
  async function running(over?: Parameters<typeof rig>[0]) {
    const r = rig(over);
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_RUN_MS + 1_000);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0].signal.aborted).toBe(false);
    return r;
  }

  it.each(SIGNALS.filter((signal) => signal !== "enabled"))(
    "stops when %s turns busy, however the source tells (an event, or only the heartbeat), and stores nothing",
    async (signal) => {
      for (const how of ["event", "heartbeat"] as const) {
        const r = await running();
        makeBusy(r.w, signal);
        if (how === "event") r.changed();
        await vi.advanceTimersByTimeAsync(how === "event" ? 0 : BUDGET_MS);
        expect(r.runs[0].signal.aborted, `${signal} by ${how}`).toBe(true);
        // a probe that finishes after it was stopped has nothing stored for it
        r.runs[0].finish(record({ atMs: Date.now() }));
        await vi.advanceTimersByTimeAsync(0);
        expect(r.service.result("export-speed"), `${signal} by ${how}`).toBeNull();
        expect(r.service.pcClass()).toBe("unknown");
        expect(r.service.status().lastOutcome["export-speed"]).toBe("aborted");
        expect(r.storage.size).toBe(0);
        r.controller.stop();
        r.service.dispose();
      }
    },
  );

  it("stops when the switch is turned off, within the same time, and the class is unknown at once", async () => {
    const r = await running();
    r.w.enabled = false;
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(r.runs[0].signal.aborted).toBe(true);
    expect(r.service.pcClass()).toBe("unknown");
    r.controller.stop();
  });

  it("is not stopped by a world that stays quiet, and its answer is kept", async () => {
    const r = await running();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.runs[0].signal.aborted).toBe(false);
    r.runs[0].finish(record({ atMs: Date.now(), rHat: 2.5, cls: "ok" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.service.pcClass()).toBe("ok");
    expect(r.service.result("export-speed")).toMatchObject({ outcome: "done" });
    r.controller.stop();
  });
});

describe("a signal that cannot be read counts as busy", () => {
  it.each(["exportBusy", "exportAsked", "playing", "lookOrSpeechJob"] as const)(
    "never starts while %s cannot be read, and never throws for it",
    async (signal) => {
      const r = rig({
        readers: {
          [signal]: () => {
            throw new Error("a source that fails");
          },
        },
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(r.runs).toHaveLength(0);
      r.controller.stop();
    },
  );

  it("never starts while it cannot be told whether a project is open", async () => {
    const r = rig({
      readers: {
        projectOpen: () => {
          throw new Error("no editor");
        },
      },
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.runs).toHaveLength(0);
    r.controller.stop();
  });

  it("reads a signal that is not a plain boolean as busy: only a reader that says so lets a check start", async () => {
    const r = rig({ readers: { playing: (() => undefined) as unknown as () => boolean } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r.runs).toHaveLength(0);
    r.controller.stop();
  });
});

describe("the controller itself", () => {
  it("tells the service nothing while nothing has changed, however many beats go by", async () => {
    const r = rig();
    const set = vi.spyOn(r.service, "setSignals");
    r.controller.stop();
    const again = startPcCheckSignals({
      service: r.service,
      read: {
        exportBusy: () => false,
        exportAsked: () => false,
        playing: () => false,
        lookOrSpeechJob: () => false,
        projectOpen: () => true,
        lastInputAtMs: () => T0 - 60_000,
        enabled: () => true,
      },
      listen: [],
      now: () => Date.now(),
      setBeat: (fn, ms) => setInterval(fn, ms),
      clearBeat: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    expect(set).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * HEARTBEAT_MS);
    expect(set).toHaveBeenCalledTimes(1);
    again.stop();
  });

  it("stops listening and beating when it is stopped: a world that turns busy afterwards is nothing it tells", async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_RUN_MS + 1_000);
    expect(r.runs).toHaveLength(1);
    r.controller.stop();
    r.w.exportBusy = true;
    r.changed();
    await vi.advanceTimersByTimeAsync(10 * HEARTBEAT_MS);
    expect(r.runs[0].signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it("survives a source whose listening fails, and a service that throws", async () => {
    const r = rig();
    r.controller.stop();
    const service = {
      setSignals: () => {
        throw new Error("the service is gone");
      },
    };
    const handle = startPcCheckSignals({
      service,
      read: {
        exportBusy: () => false,
        exportAsked: () => false,
        playing: () => false,
        lookOrSpeechJob: () => false,
        projectOpen: () => true,
        lastInputAtMs: () => T0,
        enabled: () => true,
      },
      listen: [
        () => {
          throw new Error("cannot listen");
        },
      ],
      now: () => Date.now(),
      setBeat: (fn, ms) => setInterval(fn, ms),
      clearBeat: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
    });
    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_MS);
    expect(() => handle.stop()).not.toThrow();
  });
});
