// The PC check as the app starts it, against the app's own sources: the real export queue, the real "an export is being asked" signal, the real work gate, the real editor store, the real
// window and document. Only the probe's ffmpeg and the cache folder are doubles. What matters is what a person would see: the check does not start while anything is busy, stops within a
// second and a half when anything turns busy and keeps nothing for it, does not mistake the question that offers it for an export being asked, gives way to the chip test and takes its
// turn after it, and is gone when stopped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import type { ProbeOutcome } from "../platform/host";
import { IDLE_BEFORE_RUN_MS, type PcCheckDeps } from "../platform/pcCheck";
import { EXPORT_SPEED_PROBE_ID } from "../platform/pcCheckProbe";
import { useEditor } from "../store/editor";
import { useProxyJobs } from "../store/proxyJobs";
import { amd, harness } from "../test/chipHarness";
import { ExportMemFs } from "../test/timelineKit";
import { __resetWorkGate, adoptTurn, lookWhisper } from "../tools/workGate";
import { ProjectStoreAccess } from "../tools/store";
import { __resetChipTests, findChip } from "./chipTest";
import { decideExportEncoder, type ExportEncoderDecision } from "./exportChoice";
import { __resetExportAsk, beginExportAsk, suspendExportAsk } from "./exportAsk";
import { __resetExportQueue, submitExport, whenExportsSettle } from "./exportQueue";
import { emptyTimeline } from "./model";
import { pcCheckService, setPcCheckService } from "./pcCheckHandle";
import { startPcCheck } from "./pcCheckStart";
import type { RenderWorkload } from "./renderPlan";

const exportBeacon = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport: exportBeacon }));
vi.mock("../tools/genJobs", () => ({
  openProjectJobs: async () => ({ begin: async () => "job-x", settle: async () => undefined }),
  __resetProjectJobs: () => undefined,
}));
vi.mock("../store/jobNotes", () => ({ notifyJobSettled: () => undefined }));
vi.mock("../lib/attention", () => ({ askForAttention: vi.fn(async () => undefined) }));

const T0 = 1_700_000_000_000;
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };
/** A two-minute project at 1080p30: what an export asked through the chat has to find a chip for. */
const WORKLOAD: RenderWorkload = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 120,
  visualClips: 1,
  captionClips: 0,
  audioClips: 0,
  peakVisualLayers: 1,
  peakMediaLayers: 1,
};

interface ProbeCall {
  kind: string;
  signal: AbortSignal | undefined;
}

/** The speed probe's ffmpeg: every command hangs until the check stops it, or (when told) times out at once. */
function scriptedProbe() {
  const calls: ProbeCall[] = [];
  const state = { mode: "hang" as "hang" | "timeout" };
  const probe: PcCheckDeps["probe"] = (_args, options) => {
    calls.push({ kind: options.kind, signal: options.signal });
    if (state.mode === "timeout") return Promise.resolve<ProbeOutcome>({ kind: "timeout" });
    return new Promise<ProbeOutcome>((resolve) => {
      options.signal?.addEventListener("abort", () => resolve({ kind: "stopped" }), { once: true });
    });
  };
  const checks = () => calls.filter((call) => call.kind.startsWith("pc-check"));
  return { calls, state, probe, checks };
}

const files: PcCheckDeps["files"] = {
  dir: async () => "C:/cache/pc-check",
  mkdir: async () => undefined,
  remove: async () => undefined,
  rename: async () => undefined,
  size: async () => 1_000_000, // a reference clip that is already there and sound
};

const stops: Array<() => void> = [];
const cleanups: Array<() => void | Promise<void>> = [];

function begin() {
  const probe = scriptedProbe();
  const memory = new Map<string, string>();
  stops.push(
    startPcCheck({
      service: {
        probe: probe.probe,
        files,
        storage: {
          getItem: (key) => memory.get(key) ?? null,
          setItem: (key, value) => void memory.set(key, String(value)),
          removeItem: (key) => void memory.delete(key),
        },
        cores: 8,
        build: "artdaddy@test",
      },
    }),
  );
  return { ...probe, memory, service: pcCheckService()! };
}

const status = () => pcCheckService()?.status();
const runningNow = () => status()?.running ?? null;
const outcome = () => status()?.lastOutcome[EXPORT_SPEED_PROBE_ID];
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** The editor quiet for the idle wait: a check starts by itself. */
async function untilRunning() {
  await advance(IDLE_BEFORE_RUN_MS + 1_000);
  expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  useEditor.setState({ projectId: "p", timeline: emptyTimeline(1920, 1080, 30) });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await whenExportsSettle();
  __resetExportQueue();
  __resetExportAsk();
  __resetWorkGate();
  __resetChipTests();
  __resetExportFlags();
  setPcCheckService(null);
  useProxyJobs.setState({ jobs: [] });
  useEditor.setState({ projectId: null, timeline: null, playhead: 0 });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** An export that is queued or running until `release` is called. */
async function heldExport() {
  const fs = new ExportMemFs();
  const store = new ProjectStoreAccess("/proj", fs);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await submitExport({
    store,
    dependencies: [],
    destPath: "/out/film.mp4",
    stagePath: "/out/film.mp4.partial",
    filename: "film.mp4",
    origin: AGENT,
    run: async () => {
      await hold;
      await fs.writeTextFile("/out/film.mp4.partial", "encoded");
      return {};
    },
  });
  cleanups.push(() => release());
  return async () => {
    release();
    await whenExportsSettle();
  };
}

interface Condition {
  name: string;
  /** Makes the editor busy in the way the app does, and returns how to end it. */
  on(): Promise<() => void | Promise<void>>;
}

const CONDITIONS: Condition[] = [
  { name: "an export is queued or running", on: heldExport },
  {
    name: "an export is being asked its questions",
    on: async () => beginExportAsk(),
  },
  {
    name: "a look's whisper runs",
    on: async () => {
      let finish!: () => void;
      void lookWhisper(() => new Promise<void>((resolve) => (finish = resolve)));
      return () => finish();
    },
  },
  {
    name: "a background job holds a turn",
    on: async () => adoptTurn("whisper"),
  },
  {
    name: "a preview copy of an imported file is being built",
    on: async () => {
      useProxyJobs.getState().begin("C:/library/clip.mov", "clip.mov", ["m1"]);
      return () => useProxyJobs.getState().finish("C:/library/clip.mov");
    },
  },
  {
    name: "the playhead is moving",
    on: async () => {
      const timer = setInterval(
        () => useEditor.setState({ playhead: useEditor.getState().playhead + 0.5 }),
        500,
      );
      return () => clearInterval(timer);
    },
  },
  {
    name: "a media element is playing",
    on: async () => {
      const video = document.createElement("video");
      document.body.appendChild(video);
      Object.defineProperty(video, "paused", { configurable: true, writable: true, value: false });
      video.dispatchEvent(new Event("play"));
      return () => {
        (video as unknown as { paused: boolean }).paused = true;
        video.dispatchEvent(new Event("pause"));
      };
    },
  },
  {
    name: "no project is open",
    on: async () => {
      useEditor.setState({ projectId: null, timeline: null });
      return () => useEditor.setState({ projectId: "p", timeline: emptyTimeline(1920, 1080, 30) });
    },
  },
];

describe("the check in the app: when it starts", () => {
  it("starts by itself once the editor has been quiet for the idle wait with a project open, and not a moment before", async () => {
    const world = begin();
    await advance(IDLE_BEFORE_RUN_MS - 2_000);
    expect(runningNow()).toBeNull();
    await advance(4_000);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
    expect(world.checks().length).toBeGreaterThan(0);
  });

  it.each(CONDITIONS)(
    "does not start for as long as $name, and starts once it has ended and the editor has been quiet",
    async (condition) => {
      const world = begin();
      const end = await condition.on();
      await advance(10 * 60_000);
      expect(runningNow(), condition.name).toBeNull();
      expect(world.checks(), condition.name).toHaveLength(0);
      await end();
      await advance(IDLE_BEFORE_RUN_MS + 10_000);
      expect(runningNow(), `${condition.name}: after it ended`).toBe(EXPORT_SPEED_PROBE_ID);
    },
  );

  it("does not start while any preview copy is still being built: one of two copies ending is not the end of the work", async () => {
    const world = begin();
    const copies = useProxyJobs.getState();
    copies.begin("C:/library/a.mov", "a.mov", ["m1"]);
    copies.begin("C:/library/b.mov", "b.mov", ["m2"]);
    copies.finish("C:/library/a.mov");
    await advance(10 * 60_000);
    expect(world.checks()).toHaveLength(0);
    copies.finish("C:/library/b.mov");
    await advance(IDLE_BEFORE_RUN_MS + 10_000);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });

  it("waits one idle wait after the person's last key, click or scroll, and each one begins the wait again", async () => {
    const world = begin();
    for (const name of ["keydown", "pointerdown", "wheel", "touchstart", "pointermove"]) {
      await advance(15_000);
      window.dispatchEvent(new Event(name));
    }
    expect(world.checks()).toHaveLength(0);
    await advance(IDLE_BEFORE_RUN_MS + 1_000);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });

  it("starts nothing with the switch off and the class unknown, and starts by itself when the server turns it on", async () => {
    const world = begin();
    __setExportFlag("pc_check", false);
    await advance(10 * 60_000);
    expect(world.checks()).toHaveLength(0);
    expect(pcCheckService()!.pcClass()).toBe("unknown");
    __setExportFlag("pc_check", true);
    // nothing else moved and the editor has long been quiet: the check starts at the next beat, and is under way (its box is twenty seconds)
    await advance(3_000);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });
});

describe("the check in the app: it stops within a second and a half", () => {
  it.each(CONDITIONS)("when $name, and keeps nothing for the run it stopped", async (condition) => {
    const world = begin();
    await untilRunning();
    const run = world.checks()[0];
    expect(run.signal?.aborted).toBe(false);
    const end = await condition.on();
    await advance(1_500);
    expect(run.signal?.aborted, condition.name).toBe(true);
    expect(runningNow(), condition.name).toBeNull();
    expect(outcome(), condition.name).toBe("aborted");
    expect(pcCheckService()!.result(EXPORT_SPEED_PROBE_ID), condition.name).toBeNull();
    expect(pcCheckService()!.pcClass()).toBe("unknown");
    expect(world.memory.size, "nothing was written").toBe(0);
    await end();
  });

  it("when the person types, for a check that started by itself, and again at every key after it", async () => {
    const world = begin();
    await untilRunning();
    window.dispatchEvent(new Event("keydown"));
    await advance(1_500);
    expect(world.checks()[0].signal?.aborted).toBe(true);
    expect(outcome()).toBe("aborted");
    expect(world.memory.size).toBe(0);
  });

  it("for a check a person asked for (the Check again link), not when they type: they are waiting for it", async () => {
    const world = begin();
    pcCheckService()!.requestRun({ reason: "dialog", force: true, id: EXPORT_SPEED_PROBE_ID });
    await advance(0);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("pointerdown"));
    await advance(5_000);
    expect(world.checks()[0].signal?.aborted).toBe(false);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });

  it("is not stopped by a quiet editor, however long the check takes within its box", async () => {
    const world = begin();
    await untilRunning();
    await advance(15_000);
    expect(world.checks()[0].signal?.aborted).toBe(false);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });
});

describe("the question that offers the check", () => {
  it("does not stop the check it offers nor keep it from starting, while an export that is asked without one does both", async () => {
    const world = begin();
    const service = pcCheckService()!;
    // an export is asked: a check that is asked for in the middle of it does not run
    const endRequest = beginExportAsk();
    service.requestRun({ reason: "question", force: true, id: EXPORT_SPEED_PROBE_ID });
    await advance(0);
    expect(runningNow()).toBeNull();
    expect(outcome()).toBe("skipped");
    // the check-first question is what the request is waiting on: it does not count
    const endQuestion = suspendExportAsk();
    service.requestRun({ reason: "question", force: true, id: EXPORT_SPEED_PROBE_ID });
    await advance(0);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
    await advance(10_000);
    expect(world.checks()[0].signal?.aborted, "a pending question is not an export asked").toBe(
      false,
    );
    // the question is answered and the request goes on to be asked, which does count
    endQuestion();
    await advance(1_500);
    expect(world.checks()[0].signal?.aborted).toBe(true);
    endRequest();
  });

  it("is over with the request: a question that was never ended makes no later request not count", async () => {
    const world = begin();
    const endRequest = beginExportAsk();
    suspendExportAsk(); // never ended
    endRequest();
    await untilRunning();
    const later = beginExportAsk();
    await advance(1_500);
    expect(world.checks()[0].signal?.aborted).toBe(true);
    later();
  });
});

describe("a check that cannot finish", () => {
  it("is stored as not finished at once, is tried again after ten minutes and then thirty, and never makes the class wait", async () => {
    const world = begin();
    world.state.mode = "timeout";
    const attempts = () => world.calls.filter((call) => call.kind === "pc-check-b").length;
    await advance(IDLE_BEFORE_RUN_MS + 1_000);
    expect(attempts()).toBe(1);
    // the class is read at once, whatever the check is doing
    expect(pcCheckService()!.pcClass()).toBe("unfinished");
    expect(pcCheckService()!.result(EXPORT_SPEED_PROBE_ID)).toMatchObject({
      outcome: "unfinished",
    });
    await advance(9 * 60_000);
    expect(attempts()).toBe(1);
    await advance(61_000);
    expect(attempts()).toBe(2);
    await advance(29 * 60_000);
    expect(attempts()).toBe(2);
    await advance(61_000);
    expect(attempts()).toBe(3);
    expect(pcCheckService()!.pcClass()).toBe("unfinished");
  });
});

describe("the chip test and the check take turns", () => {
  it("a chip test that an export asks for while the check is under way by itself stops that check and runs at once: the export is not late, and the check goes on afterwards", async () => {
    const world = begin();
    await untilRunning();
    const run = world.checks()[0];
    const chip = harness([amd]);
    // What `encoderOptions` does for an export asked through the chat or MCP, before the queue has been told of it: look for the chip, and wait for it
    // no longer than CHIP_WAIT_MS (20 s).
    let decision: ExportEncoderDecision | undefined;
    void decideExportEncoder(
      { request: "auto", workload: WORKLOAD, settings: {}, history: [] },
      (size, options) => findChip(size, options, chip.deps),
    ).then((decided) => (decision = decided));
    await advance(1_500);
    expect(decision?.facts.chip, "the export has the chip: it did not wait for the check").toBe(
      "amd",
    );
    expect(chip.calls.length, "the chip was tested").toBeGreaterThan(0);
    expect(run.signal?.aborted, "the check was told to stop").toBe(true);
    expect(outcome()).toBe("aborted");
    expect(world.memory.size, "the check that was stopped kept nothing").toBe(0);
    // Nothing is busy yet (the export has not reached the queue): the check goes on where it left off, and the export's admission stops it again.
    await advance(3_000);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });

  it("a check a person asked for (Check again) is not stopped by a chip test: the chip test waits for it, and an export being asked still stops it", async () => {
    const world = begin();
    pcCheckService()!.requestRun({ reason: "dialog", force: true, id: EXPORT_SPEED_PROBE_ID });
    await advance(0);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
    const run = world.checks()[0];
    const chip = harness([amd]);
    const lookup = findChip("hd", { allowRun: true }, chip.deps);
    await advance(5_000);
    expect(run.signal?.aborted).toBe(false);
    expect(chip.calls, "the chip test waits for the check the person is waiting for").toEqual([]);
    const ask = beginExportAsk();
    await advance(1_500);
    const found = await lookup;
    expect(run.signal?.aborted).toBe(true);
    expect(found.chip).toMatchObject({ maker: "amd", ok: true });
    ask();
  });

  it("a chip test under way holds the check back until it ends, and the check then starts by itself", async () => {
    const world = begin();
    const chip = harness([amd]);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...chip.deps,
      probe: async (...args: Parameters<typeof chip.deps.probe>) => {
        await hold;
        return chip.deps.probe(...args);
      },
    };
    const lookup = findChip("hd", { allowRun: true }, slow);
    await advance(10 * 60_000);
    expect(world.checks(), "the check waits for the chip test").toHaveLength(0);
    expect(runningNow()).toBe("chip-test");
    release();
    const found = await lookup;
    expect(found.chip).toMatchObject({ maker: "amd" });
    // the editor has long been quiet: the check takes the slot the chip test gave back, and is under way
    await advance(3_000);
    expect(runningNow()).toBe(EXPORT_SPEED_PROBE_ID);
  });

  it("without the app's check (never started, or stopped) the chip test runs as it always did", async () => {
    const chip = harness([amd]);
    expect((await findChip("hd", { allowRun: true }, chip.deps)).chip).toMatchObject({
      maker: "amd",
    });
    const calls = chip.calls.length;
    expect(calls).toBeGreaterThan(0);
    begin();
    const stop = stops.pop()!;
    stop();
    __resetChipTests();
    const again = harness([amd]);
    expect((await findChip("hd", { allowRun: true }, again.deps)).chip).toMatchObject({
      maker: "amd",
    });
    expect(again.calls.length).toBe(calls);
  });
});

describe("starting and stopping", () => {
  it("makes the service known to the rest of the app and takes it back when stopped, stopping a check under way with it", async () => {
    expect(pcCheckService()).toBeNull();
    const world = begin();
    expect(pcCheckService()).not.toBeNull();
    await untilRunning();
    stops.pop()!();
    expect(pcCheckService()).toBeNull();
    await advance(0);
    expect(world.checks()[0].signal?.aborted).toBe(true);
    // nothing is left running that would start it again
    await advance(10 * 60_000);
    expect(world.checks()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the speed check, and only that: the one command it makes first is the speed check's own", async () => {
    const world = begin();
    await untilRunning();
    expect(new Set(world.checks().map((call) => call.kind))).toEqual(new Set(["pc-check-b"]));
  });

  it("survives a page without the app's file layer: the check cannot make its clip, is stored as not finished, and nothing throws", async () => {
    const probe = scriptedProbe();
    const stop = startPcCheck({
      service: {
        probe: probe.probe,
        files: {
          dir: async () => {
            throw new Error("no app cache");
          },
          mkdir: async () => undefined,
          remove: async () => undefined,
          rename: async () => undefined,
          size: async () => null,
        },
        cores: 8,
      },
    });
    stops.push(stop);
    await advance(IDLE_BEFORE_RUN_MS + 1_000);
    expect(pcCheckService()!.pcClass()).toBe("unfinished");
    expect(probe.calls).toHaveLength(0);
  });
});
