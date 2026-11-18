// What a Fast pick of the Export dialog does to the command the app process is handed and to the export's record, and what it leaves alone.
// Everything goes through the real `export` tool, plan, queue and record on an in-memory project, with the app process played by FakeJobs: a test reads what the process
// was handed (`submitted[i].args` and `meta.plan.output`), the export's record, the assistant's list rows and the report the queue sends the server. The dialog is not
// built: its choice is the slot `ctx.exportRoute`, which each test fills the way the dialog will. Every expected number is written out from the owner's table below
// (never computed with the code under test), so a wrong rule cannot agree with itself. Nothing runs ffmpeg, reaches a vendor or uses the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag, __setHeldOffByBuild } from "../api/exportFlags";
import * as host from "../platform/host";
import { useAuth } from "../store/auth";
import { useExportJob } from "../store/exportJob";
import {
  amdChip,
  DRIVER_ERROR,
  flush,
  MEMORY_SHORT,
  settleTick,
  setupExport,
  type Any,
} from "../test/chipExportKit";
import { amd, harness } from "../test/chipHarness";
import { resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import { _resetAppCaches } from "../tools/appCache";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { registerLibraryClip } from "../tools/import";
import { __resetJobSupervisor, type JobSpec } from "../tools/jobSupervisor";
import { __resetWorkGate } from "../tools/workGate";
import { CHIP_PREF_KEY } from "./chipPref";
import { findChip, markChipSuspect } from "./chipTest";
import { exportTool } from "./exportItems";
import type { ExportEngine } from "./exportOptions";
import {
  __resetExportQueue,
  cancelExport,
  listExportOutcomes,
  listExportRecords,
  restartDecisions,
  retryExport,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
} from "./exportQueue";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";

// What the queue sends the server for each settled export is kept, so a test can read its fields; it is never sent.
const reported = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../api/exportEvents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/exportEvents")>()),
  reportExport: async (event: Record<string, unknown>) => {
    reported.push(event);
  },
}));
// The graphics chip's lookup is the test's to answer: no chip unless a test says so.
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: vi.fn(async () => ({ chip: null, events: [] })),
    markChipSuspect: vi.fn(),
  };
});
// No brand asset is fetched: the exports here are the unbranded ones.
vi.mock("./brandRecovery", () => ({ recoverBrandAsset: async () => null }));

type Canvas = { w: number; h: number; fps: number };
const UHD60: Canvas = { w: 3840, h: 2160, fps: 60 };
const QHD50: Canvas = { w: 2560, h: 1440, fps: 50 };
const HD30: Canvas = { w: 1920, h: 1080, fps: 30 };
const VERTICAL30: Canvas = { w: 1080, h: 1920, fps: 30 };
const WXGA30: Canvas = { w: 1366, h: 768, fps: 30 };
const SD24: Canvas = { w: 854, h: 480, fps: 24 };
const ENGINES: readonly ExportEngine[] = ["file-sequence-v1", "partition-pipes-v1"];
const pic = (width: number, height: number, fps: number) => ({ width, height, fps });
/** What Fast makes of the 4K project at 60 (nothing set), and what Quality makes of it (the project's own picture). */
const FAST_PICTURE = pic(1920, 1080, 30);
const OWN_PICTURE = pic(3840, 2160, 60);

// The owner's table: canvas, then the short side of the picture Fast makes of it and its frame rate, nothing set (the size one rung below on 2160, 1080, 720, 480
// by the short side, none at 480 or less; the rate halved down to 30 at most, so 60 gives 30, 50 gives 25, 48 gives 24; quality Medium).
const TABLE: [number, number, number, number, number][] = [
  [3840, 2160, 60, 1080, 30],
  [2560, 1440, 50, 1080, 25],
  [1920, 1080, 30, 720, 30],
  [1080, 1920, 30, 720, 30],
  [1366, 768, 30, 720, 30],
  [1280, 720, 60, 480, 30],
  [854, 480, 24, 480, 24],
  [640, 480, 30, 480, 30],
  [3840, 2160, 48, 1080, 24],
  [7680, 4320, 30, 2160, 30],
];

type Explicit = { size: boolean; fps: boolean; quality?: boolean };
// The slots are frozen: a tool that wrote into the dialog's slot would throw.
const NOTHING_SET: Explicit = Object.freeze({ size: false, fps: false, quality: false });
/** The dialog's slot for a Fast pick; `explicit` says which of the size, the rate and the quality the person set. */
const fastSlot = (explicit?: Explicit) =>
  Object.freeze({ route: "quick" as const, ...(explicit ? { explicit } : {}) });
const FAST = fastSlot(NOTHING_SET);
const STANDARD = Object.freeze({ route: "standard" });
/** Which of the size (s), the rate (f) and the quality (q) the person set, as the dialog says it. */
const setOf = (code: string): Explicit => ({
  size: code.includes("s"),
  fps: code.includes("f"),
  quality: code.includes("q"),
});

// The world: a project on a fake disk, the app process, the chip lookup, and the tool called the way the dialog calls it.
let current: { jobs: Awaited<ReturnType<typeof setupExport>>["jobs"] } | null = null;

/** Ends every job a world started and leaves nothing behind for the next one. */
async function finish(t: NonNullable<typeof current>): Promise<void> {
  for (const spec of t.jobs.submitted) cancelExport(spec.id);
  await Promise.all(t.jobs.submitted.map((spec) => whenExportEnds(spec.id)));
  await whenExportsSettle();
  await whenExportTelemetrySettles();
  await resetTestDocuments();
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  _resetAppCaches();
  __resetWorkGate();
  // What an export measured is this PC's history for the next one: each case starts on a PC that has measured nothing.
  useExportJob.setState({ calibrations: [] });
  if (current === t) current = null;
}

beforeEach(() => {
  reported.length = 0;
  __resetExportFlags();
  __setHeldOffByBuild(false);
  __setExportFlag("quick_route", true);
  useAuth.setState({ profile: null });
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useExportJob.getState().setEngine("file-sequence-v1");
  vi.mocked(findChip).mockReset();
  vi.mocked(findChip).mockResolvedValue({ chip: null, events: [] });
  vi.mocked(markChipSuspect).mockReset();
});
afterEach(async () => {
  if (current) await finish(current);
  __resetExportFlags();
  __setHeldOffByBuild(null);
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useExportJob.getState().setEngine("auto");
});

async function until(done: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 1000 && !done(); tick++) await settleTick();
  if (!done()) throw new Error(`never happened: ${what}`);
}

async function world(canvas: Canvas, options: { chip?: boolean; engine?: ExportEngine } = {}) {
  if (current) await finish(current);
  const t = await setupExport();
  current = t;
  const base: ClientToolContext = { store: t.store, runner: t.nextPage().runner };
  const set = await setCanvasTool({ width: canvas.w, height: canvas.h, fps: canvas.fps }, base);
  if (set.ok === false) throw new Error(`the canvas was not set: ${JSON.stringify(set)}`);
  vi.mocked(findChip).mockResolvedValue({ chip: options.chip ? amdChip() : null, events: [] });
  useExportJob.getState().setEngine(options.engine ?? "file-sequence-v1");
  /** One call of the `export` tool as the dialog makes it. The slot goes in before the context is made, as the host does, so a Try again (which runs on the
   *  detached context) carries it. */
  const call = async (
    args: Record<string, unknown>,
    slot?: unknown,
    extra: Partial<ClientToolContext> = {},
  ): Promise<Any> => {
    const route = slot as ClientToolContext["exportRoute"];
    const ctx = agentToolContext(
      { ...base, ...extra, ...(slot === undefined ? {} : { exportRoute: route }) },
      new AbortController().signal,
    );
    const reply = (await exportTool(args, ctx)) as Any;
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    return reply;
  };
  const handedOver = async (id: string): Promise<JobSpec> => {
    await until(() => t.jobs.submitted.some((spec) => spec.id === id), `job ${id} handed over`);
    return t.jobs.submitted.find((spec) => spec.id === id)!;
  };
  /** The job the app process was handed at position `n`. */
  const nth = async (n: number): Promise<JobSpec> => {
    await until(() => t.jobs.submitted.length > n, `job ${n} handed over`);
    return t.jobs.submitted[n];
  };
  const failWith = (id: string, stderr: string) => {
    t.jobs.exit(id, -1, stderr);
    return whenExportEnds(id);
  };
  return { ...t, base, call, handedOver, nth, failWith };
}

type Cmd = { args: string[]; steps: string[][] };
/** The same text for two exports of one project: only the staging file's random name and the job's id differ between them. */
function scrub<T>(value: T, ids: readonly string[] = []): T {
  return JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === "string"
      ? ids
          .reduce((text, id) => text.split(id).join("JOB"), item)
          .replace(/\.[a-z0-9]{6}\.partial/g, ".X.partial")
      : item,
  ) as T;
}
const commandOf = (spec: JobSpec): Cmd =>
  scrub({ args: spec.args, steps: spec.steps ?? [] }, [spec.id]);
const textOf = (cmd: Cmd): string => [cmd.args, ...cmd.steps].flat().join(" ");
const outputOf = (spec: JobSpec) => (spec.meta.plan as { output: ReturnType<typeof pic> }).output;
/** The value after `flag` in the command's last part: the one encode that makes the delivered file (a streamed export's first parts only make the pieces). */
const after = (cmd: Cmd, flag: string): string | undefined => {
  const last = [cmd.args, ...cmd.steps].at(-1)!;
  const at = last.lastIndexOf(flag);
  return at < 0 ? undefined : last[at + 1];
};
/** The command with the faster setting's pair `-preset veryfast` taken out of every part of it. */
const withoutPreset = (cmd: Cmd): Cmd => {
  const strip = (list: string[]) => {
    const at = list.indexOf("-preset");
    return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 2)];
  };
  return { args: strip(cmd.args), steps: cmd.steps.map(strip) };
};
const codecOf = (spec: JobSpec) => after(commandOf(spec), "-c:v");
const shortOf = (output: ReturnType<typeof pic>) => Math.min(output.width, output.height);
const keysOf = (value: object): string[] => Object.keys(value).sort();
const recordOf = (id: string) => listExportRecords().find((r) => r.job_id === id)!;

interface Run {
  canvas: Canvas;
  args?: Record<string, unknown>;
  slot?: unknown;
  /** The dialog's own pick of the encoder (`ctx.exportMode`): how an export typed by hand asks for its encoder. */
  mode?: "fast" | "quality";
  chip?: boolean;
  engine?: ExportEngine;
  /** The switch `quick_route`: as a shipped build has it (the hold on for the other names, the Fast choice not held), off on the server, or on with the hold lifted (the unit suite's state). */
  switch?: "shipped" | "off" | "on";
}

/** One export of a fresh project, from the call to its end: what the app process was handed, the reply, the record while it ran and after, the assistant's list row and
 *  the report sent when it settled. */
async function observe(run: Run) {
  __setHeldOffByBuild(run.switch === "shipped");
  __setExportFlag("quick_route", run.switch !== "off");
  reported.length = 0;
  const t = await world(run.canvas, run);
  const reply = await t.call(run.args ?? {}, run.slot, run.mode ? { exportMode: run.mode } : {});
  const spec = await t.handedOver(reply.job_id);
  const command = commandOf(spec);
  const seen = {
    reply: scrub(reply, [reply.job_id]),
    command,
    output: outputOf(spec),
    codec: after(command, "-c:v"),
    running: { ...recordOf(reply.job_id) },
    row: { ...listExportOutcomes().find((r) => r.job_id === reply.job_id)! },
  };
  t.jobs.exit(reply.job_id, 0);
  expect((await whenExportEnds(reply.job_id))?.state).toBe("done");
  await whenExportsSettle();
  await whenExportTelemetrySettles();
  const done = { ...recordOf(reply.job_id) };
  const out = { ...seen, done, report: reported.at(-1)! };
  await finish(t);
  return out;
}

describe("1. the picture Fast makes of a canvas (the real tool, no chip)", () => {
  it.each(TABLE)("%ix%i@%i, nothing set: %ip at %i fps", async (w, h, fps, short, rate) => {
    for (const engine of ENGINES) {
      const seen = await observe({ canvas: { w, h, fps }, slot: FAST, engine });
      expect(shortOf(seen.output), engine).toBe(short);
      expect(seen.output.fps, engine).toBe(rate);
      // The picture keeps its shape, and the command itself says what the plan says.
      expect(Math.abs(seen.output.width / seen.output.height - w / h), engine).toBeLessThan(0.01);
      expect(after(seen.command, "-r"), engine).toBe(String(rate));
      if (short < Math.min(w, h))
        expect(textOf(seen.command), engine).toContain(
          `scale=${seen.output.width}:${seen.output.height}`,
        );
      expect(seen.running.route, engine).toBe("quick");
    }
  });

  // What the person set stays and only the rest is composed (crf: high 18, medium 23, low 28). A size the call asked for that is smaller than Fast's own is never enlarged.
  const ALL3 = { resolution: "1440p", fps: 24, quality: "high" };
  type SetRow = [string, Canvas, Record<string, unknown>, string, number, number, string];
  const SET: SetRow[] = [
    ["a size set: 1440p on 2160p at 60", UHD60, { resolution: "1440p" }, "s", 1440, 30, "23"],
    ["a rate set: 24", UHD60, { fps: 24 }, "f", 1080, 24, "23"],
    ["a rate set above the cap: 60", UHD60, { fps: 60 }, "f", 1080, 60, "23"],
    ["a quality set: high", UHD60, { quality: "high" }, "q", 1080, 30, "18"],
    ["a quality set: low", UHD60, { quality: "low" }, "q", 1080, 30, "28"],
    ["all three set: nothing composed", UHD60, ALL3, "sfq", 1440, 24, "18"],
    ["same as the project, picked", UHD60, { resolution: "source" }, "s", 2160, 30, "23"],
    ["never enlarged: 720p on 2160p", UHD60, { resolution: "720p" }, "", 720, 30, "23"],
    ["never enlarged: 720p on 1440p at 50", QHD50, { resolution: "720p" }, "", 720, 25, "23"],
    ["never enlarged: 480p on 1080p", HD30, { resolution: "480p" }, "", 480, 30, "23"],
  ];
  it.each(SET)("%s", async (_name, canvas, args, set, short, rate, crf) => {
    for (const engine of ENGINES) {
      const seen = await observe({ canvas, args, slot: fastSlot(setOf(set)), engine });
      expect(shortOf(seen.output), engine).toBe(short);
      expect(seen.output.fps, engine).toBe(rate);
      expect(after(seen.command, "-crf"), engine).toBe(crf);
    }
  });
});

// For each canvas, from the table: the preset that names Fast's own size for it, with that short side and Fast's rate (nothing set); then a size (and the short side it gives),
// a rate and a quality a person may set; then the project's own short side (what "same as the project" keeps).
type Twin = [string, Canvas, [string, number, number], [string, number], number, string, number];
const TWINS: Twin[] = [
  ["3840x2160@60", UHD60, ["1080p", 1080, 30], ["1440p", 1440], 24, "high", 2160],
  ["1920x1080@30", HD30, ["720p", 720, 30], ["1080p", 1080], 60, "low", 1080],
  ["1080x1920@30", VERTICAL30, ["720p", 720, 30], ["1080p", 1080], 24, "high", 1080],
  ["1366x768@30", WXGA30, ["720p", 720, 30], ["1080p", 768], 24, "low", 768],
  ["854x480@24", SD24, ["source", 480, 24], ["480p", 480], 60, "high", 480],
];
const CRF: Record<string, string> = { high: "18", medium: "23", low: "28" };

describe.each(TWINS)("2. Fast is the export typed by hand: %s", (_label, canvas, ...spec) => {
  const [[preset, short, rate], [size, sizeShort], fps, quality, own] = spec;
  // What the person sets, which of the size (s), the rate (f) and the quality (q) that is, and the short side and the rate that result.
  const rows: [string, Record<string, unknown>, string, number, number][] = [
    ["nothing set", {}, "", short, rate],
    ["size set", { resolution: size }, "s", sizeShort, rate],
    ["rate set", { fps }, "f", short, fps],
    ["quality set", { quality }, "q", short, rate],
    ["all three set", { resolution: size, fps, quality }, "sfq", sizeShort, fps],
    ["same as the project", { resolution: "source" }, "s", own, rate],
  ];
  it.each(rows)("%s", async (_name, args, set, wantShort, wantRate) => {
    // The same settings typed: Fast's own size and rate and Medium where the person set nothing, and what the person set where they did.
    const typed = { resolution: preset, fps: rate, quality: "medium", ...args };
    for (const chip of [true, false])
      for (const engine of ENGINES) {
        const where = `${chip ? "chip" : "processor"}, ${engine}`;
        const mode = chip ? "fast" : "quality";
        // The two artifacts: the command Fast handed the app process, and the one the same tool hands it with no slot, the settings typed and the matching encoder door
        // (the chip: the dialog's Fast mode; the processor: the dialog's Quality mode, plain libx264, to which Fast adds the faster setting's `-preset veryfast`).
        const fast = await observe({ canvas, args, slot: fastSlot(setOf(set)), chip, engine });
        const byHand = await observe({ canvas, args: typed, mode, chip, engine });
        expect(fast.output, where).toEqual(byHand.output);
        expect([shortOf(fast.output), fast.output.fps], where).toEqual([wantShort, wantRate]);
        if (chip) {
          expect(fast.command, where).toEqual(byHand.command);
          expect([fast.codec, byHand.codec], where).toEqual(["h264_amf", "h264_amf"]);
        } else {
          expect(withoutPreset(fast.command), where).toEqual(byHand.command);
          expect(after(fast.command, "-preset"), where).toBe("veryfast");
          expect(after(byHand.command, "-preset"), where).toBeUndefined();
          expect([fast.codec, byHand.codec], where).toEqual(["libx264", "libx264"]);
          expect(after(fast.command, "-crf"), where).toBe(CRF[String(typed.quality)]);
        }
        // Equal is no proof if both are empty: the command names the picture, the rate and the quality.
        expect(fast.command.args.length, where).toBeGreaterThan(10);
        expect(after(fast.command, "-r"), where).toBe(String(wantRate));
      }
  });
});

describe("2b. the faster setting's own switch", () => {
  it("with it off, Fast without a chip is plain libx264, the command typed by hand; a chip is still used", async () => {
    __setExportFlag("faster_x264", false);
    const typed = { resolution: "720p", fps: 30, quality: "medium" };
    for (const engine of ENGINES) {
      const fast = await observe({ canvas: HD30, slot: FAST, engine });
      const byHand = await observe({ canvas: HD30, args: typed, mode: "quality", engine });
      expect(fast.command, engine).toEqual(byHand.command);
      expect(after(fast.command, "-preset"), engine).toBeUndefined();
      expect([fast.codec, fast.output], engine).toEqual(["libx264", pic(1280, 720, 30)]);
    }
    expect((await observe({ canvas: HD30, slot: FAST, chip: true })).codec).toBe("h264_amf");
  });
});

describe("3. with the switch off a Fast pick is Quality in every byte", () => {
  const OFF = [{ name: "switched off on the server", off: "off" as const }];
  it.each(OFF)("$name: three canvases, with and without a chip", async ({ off }) => {
    for (const canvas of [UHD60, HD30, SD24])
      for (const chip of [false, true]) {
        const where = `${canvas.w}x${canvas.h}@${canvas.fps}, ${chip ? "chip" : "processor"}`;
        // The two artifacts: what the app process was handed for the ignored Fast pick and for no pick at all; and the reply and the record's keys of each.
        const ignored = await observe({ canvas, slot: FAST, chip, switch: off });
        const none = await observe({ canvas, chip, switch: off });
        expect(ignored.command, where).toEqual(none.command);
        expect(ignored.reply, where).toEqual(none.reply);
        expect(keysOf(ignored.running), where).toEqual(keysOf(none.running));
        expect(keysOf(ignored.done), where).toEqual(keysOf(none.done));
        expect(ignored.running, where).not.toHaveProperty("route");
        expect(ignored.done, where).not.toHaveProperty("route");
        // It is the project's own picture (so the two are not both empty), and the same pick with the switch on is not ignored.
        expect(ignored.output, where).toEqual(pic(canvas.w, canvas.h, canvas.fps));
        const on = await observe({ canvas, slot: FAST, chip });
        expect(on.command, where).not.toEqual(none.command);
      }
  });

  it('with the switch on, a slot of route: "standard" is Quality in every byte too', async () => {
    for (const canvas of [UHD60, HD30, SD24])
      for (const chip of [false, true]) {
        const where = `${canvas.w}x${canvas.h}@${canvas.fps}, ${chip ? "chip" : "processor"}`;
        const standard = await observe({ canvas, slot: STANDARD, chip });
        const none = await observe({ canvas, chip });
        expect(standard.command, where).toEqual(none.command);
        expect(standard.reply, where).toEqual(none.reply);
        expect(keysOf(standard.running), where).toEqual(keysOf(none.running));
        expect(standard.running, where).not.toHaveProperty("route");
        expect(standard.output, where).toEqual(pic(canvas.w, canvas.h, canvas.fps));
      }
  });
});

describe("3b. the build's hold on the other switches does not reach the Fast choice (as shipped)", () => {
  it("with the hold on for the estimate and the speed check, a Fast pick is Fast, in the bytes it has with the hold lifted", async () => {
    for (const canvas of [UHD60, HD30, SD24])
      for (const chip of [false, true]) {
        const where = `${canvas.w}x${canvas.h}@${canvas.fps}, ${chip ? "chip" : "processor"}`;
        // The two artifacts: what the app process was handed with the build's hold on and with it lifted, and the record of each.
        const lifted = await observe({ canvas, slot: FAST, chip, switch: "on" });
        const shipped = await observe({ canvas, slot: FAST, chip, switch: "shipped" });
        expect(shipped.command, where).toEqual(lifted.command);
        expect(shipped.reply, where).toEqual(lifted.reply);
        expect(shipped.output, where).toEqual(lifted.output);
        expect([shipped.running.route, shipped.done.route], where).toEqual(["quick", "quick"]);
        // And it is Fast, not the project's own picture, where Fast has something to change.
        if (canvas !== SD24)
          expect(shipped.output, where).not.toEqual(pic(canvas.w, canvas.h, canvas.fps));
        // The way back is still the server's: the same pick with the switch off is Quality in every byte.
        const off = await observe({ canvas, slot: FAST, chip, switch: "off" });
        const none = await observe({ canvas, chip, switch: "off" });
        expect(off.command, where).toEqual(none.command);
      }
  });
});

describe("4. what Fast leaves on the record, in the assistant's list and in the report", () => {
  it('the record says route: "quick" for a Fast export and has no route key for anything else', async () => {
    for (const chip of [false, true]) {
      const fast = await observe({ canvas: UHD60, slot: FAST, chip });
      expect([fast.running.route, fast.done.route]).toEqual(["quick", "quick"]);
      const others: [string, Run][] = [
        ["no slot", { canvas: UHD60, chip }],
        ["a standard slot", { canvas: UHD60, slot: STANDARD, chip }],
        ["the switch off", { canvas: UHD60, slot: FAST, chip, switch: "off" }],
        ["the dialog's Fast mode typed by hand", { canvas: UHD60, mode: "fast", chip }],
      ];
      for (const [name, run] of others) {
        const seen = await observe(run);
        expect(seen.running, name).not.toHaveProperty("route");
        expect(seen.done, name).not.toHaveProperty("route");
      }
    }
  });

  it("a Fast row of the assistant's list has the keys of a Quality row and only the existing `encoder` besides", async () => {
    const typed = { resolution: "1080p", fps: 30, quality: "medium" };
    for (const chip of [false, true]) {
      const fast = await observe({ canvas: UHD60, slot: FAST, chip });
      const quality = await observe({ canvas: UHD60, chip });
      // `encoder` is what any row says of an export that runs on a chip or on the faster setting, whoever asked for it (0.28.0's field).
      expect(Object.keys(fast.row).filter((key) => !(key in quality.row))).toEqual(["encoder"]);
      expect(Object.keys(quality.row).filter((key) => !(key in fast.row))).toEqual([]);
      expect(fast.row.encoder).toBe(chip ? "graphics_chip" : "faster_setting");
      for (const word of ["route", "quick", "quick_offer", "mode", "setting"])
        expect(fast.row, word).not.toHaveProperty(word);
      if (chip) {
        const byHand = await observe({ canvas: UHD60, args: typed, mode: "fast", chip });
        expect(keysOf(fast.row)).toEqual(keysOf(byHand.row));
      }
    }
  });

  it("the report sent for a Fast export has the fields of a Quality export's and no event the others cannot have", async () => {
    // On 1920x1080 at 30 a chip serves Quality's picture as well as Fast's, so both reports name the chip.
    const typed = { resolution: "720p", fps: 30, quality: "medium" };
    const events = (report: Record<string, unknown>) =>
      (report.trace as { e: string }[]).map((event) => event.e);
    for (const chip of [false, true]) {
      const fast = await observe({ canvas: HD30, slot: FAST, chip });
      const quality = await observe({ canvas: HD30, chip });
      expect(keysOf(fast.report)).toEqual(keysOf(quality.report));
      const picked = await observe({ canvas: HD30, chip, mode: "quality" });
      const byHand = await observe({ canvas: HD30, args: typed, chip, mode: "fast" });
      const known = new Set([quality, picked, byHand].flatMap((seen) => events(seen.report)));
      for (const name of events(fast.report)) expect(known.has(name), name).toBe(true);
      for (const event of fast.report.trace as object[])
        expect(keysOf(event).every((key) => ["e", "t", "v", "n", "m"].includes(key))).toBe(true);
    }
  });
});

const GRAPH_REFUSED = "native render failed: ffmpeg: Error initializing filters\n";

describe("5. Try again keeps the route (the real tool and the queue's retry)", () => {
  const WHERE = [
    { name: "on the processor", chip: false, codec: "libx264" },
    { name: "on a graphics chip", chip: true, codec: "h264_amf" },
  ];
  it.each(WHERE)("(a) a failed Fast export is tried again as Fast, $name", async (leg) => {
    const t = await world(UHD60, { chip: leg.chip });
    const first = await t.call({}, FAST);
    const before = commandOf(await t.handedOver(first.job_id));
    expect(await t.failWith(first.job_id, GRAPH_REFUSED)).toMatchObject({
      state: "failed",
      canRetry: true,
      route: "quick",
    });
    await retryExport(first.job_id);
    const two = await t.nth(1);
    // A failure that says nothing about how the work was done keeps the rung, so the whole command is the first's but for the staging name.
    expect(commandOf(two)).toEqual(before);
    expect(outputOf(two)).toEqual(FAST_PICTURE);
    expect(codecOf(two)).toBe(leg.codec);
    expect(recordOf(two.id)).toMatchObject({ state: "running", route: "quick" });
  });

  it.each([
    { name: "no slot", slot: undefined },
    { name: 'a slot of route: "standard"', slot: STANDARD },
  ])("(b) a Quality export tried again stays Quality, the switch on: $name", async ({ slot }) => {
    const t = await world(UHD60);
    const first = await t.call({}, slot);
    const before = commandOf(await t.handedOver(first.job_id));
    await t.failWith(first.job_id, GRAPH_REFUSED);
    await retryExport(first.job_id);
    const two = await t.nth(1);
    expect(commandOf(two)).toEqual(before);
    expect(outputOf(two)).toEqual(OWN_PICTURE);
    expect(recordOf(two.id)).not.toHaveProperty("route");
  });

  type Kept = [string, Record<string, unknown>, string, ReturnType<typeof pic>];
  const KEPT: Kept[] = [
    ["a size set: 1440p", { resolution: "1440p" }, "s", pic(2560, 1440, 30)],
    ["same as the project, picked", { resolution: "source" }, "s", pic(3840, 2160, 30)],
    ["a rate set above the cap: 60", { fps: 60 }, "f", pic(1920, 1080, 60)],
    ["a quality set: high", { quality: "high" }, "q", FAST_PICTURE],
  ];
  it.each(KEPT)("(c) what was set survives Try again: %s", async (_n, args, set, picture) => {
    const t = await world(UHD60);
    const first = await t.call(args, fastSlot(setOf(set)));
    const one = await t.handedOver(first.job_id);
    await t.failWith(first.job_id, GRAPH_REFUSED);
    await retryExport(first.job_id);
    const two = await t.nth(1);
    expect([outputOf(one), outputOf(two)]).toEqual([picture, picture]);
    expect(after(commandOf(two), "-crf")).toBe(after(commandOf(one), "-crf"));
    expect(recordOf(two.id)).toMatchObject({ route: "quick" });
  });

  it("(d, e) the app's own restart after a chip failure keeps Fast's picture and the processor's own encoder, and happens once; the person's Try again after it is still Fast", async () => {
    // The switches as shipped (chip_restart on). The PC has room, so a later memory stop is one the app would restart too, if it were allowed a second restart.
    vi.spyOn(host, "resolveExportResources").mockResolvedValue({
      total_memory_bytes: 16 * 1024 ** 3,
      available_memory_bytes: 8 * 1024 ** 3,
      scratch_free_bytes: 100e9,
      destination_free_bytes: 100e9,
      local_fast_candidate: false,
      budgets: { memoryBytes: 3.5 * 1024 ** 3, temporaryBytes: 18e9, executionSeconds: 28800 },
    });
    const t = await world(UHD60, { chip: true });
    // The lookup answers as the real one does: a chip that failed an export is set aside.
    vi.mocked(findChip).mockImplementation(async () => ({
      chip: vi.mocked(markChipSuspect).mock.calls.length > 0 ? null : amdChip(),
      events: [],
    }));
    const first = await t.call({}, FAST);
    const one = await t.handedOver(first.job_id);
    expect([codecOf(one), outputOf(one)]).toEqual(["h264_amf", FAST_PICTURE]);

    t.jobs.exit(first.job_id, -1, DRIVER_ERROR);
    const two = await t.nth(1);
    await flush(40);
    expect(t.jobs.submitted, "one successor, not two").toHaveLength(2);
    expect([codecOf(two), outputOf(two)]).toEqual(["libx264", FAST_PICTURE]);
    expect(textOf(commandOf(two)), "the processor's own encoder").not.toContain("veryfast");
    expect(after(commandOf(two), "-crf")).toBe("23");
    expect(listExportRecords()).toHaveLength(1);
    expect(recordOf(two.id)).toMatchObject({
      state: "running",
      route: "quick",
      attempt: 2,
      restarted: "processor",
    });
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible"]);

    // The successor's own failure is final even though it is one the app would restart: exactly one restart.
    const failed = await t.failWith(two.id, MEMORY_SHORT);
    expect(failed).toMatchObject({ state: "failed", route: "quick" });
    await flush(40);
    expect(t.jobs.submitted, "no third attempt by itself").toHaveLength(2);
    expect(restartDecisions().map((d) => d.record)).toEqual(["eligible", "second"]);

    // (e) The person's Try again after that is still Fast's picture, with the chip set aside.
    await retryExport(first.job_id);
    const three = await t.nth(2);
    expect([codecOf(three), outputOf(three)]).toEqual(["libx264", FAST_PICTURE]);
    expect(recordOf(three.id)).toMatchObject({ state: "running", route: "quick" });
  });

  it("(f) the route survives Try again however the context was put together: a slot added after the agent context was made", async () => {
    const t = await world(UHD60);
    // The dialog's slot reaches the tool through the host, which puts it in before the context is made; a caller that adds it afterwards must not lose it at Try again.
    const ctx: ClientToolContext = {
      ...agentToolContext({ ...t.base }, new AbortController().signal),
      exportRoute: FAST,
    };
    const first = (await exportTool({}, ctx)) as Any;
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const one = await t.handedOver(first.job_id);
    await t.failWith(first.job_id, GRAPH_REFUSED);
    await retryExport(first.job_id);
    const two = await t.nth(1);
    expect([outputOf(one), outputOf(two)]).toEqual([FAST_PICTURE, FAST_PICTURE]);
    expect(commandOf(two)).toEqual(commandOf(one));
    expect(recordOf(two.id)).toMatchObject({ state: "running", route: "quick" });
  });
});

describe("6. a clip export and a library copy ignore a Fast slot (clip_ids and media_refs)", () => {
  async function clipExport(slot: unknown) {
    const t = await world(UHD60);
    const entries = [{ media_ref: "b.mp4", timeline_in: 60, timeline_out: 120 }];
    const placed = (await addClipsTool({ entries }, t.base)) as Any;
    const clipId = String(placed.created[0].clip_id);
    const reply = await t.call({ clip_ids: [clipId], output_dir: "clips" }, slot);
    const id = String(reply.exports[0].job_id);
    const spec = await t.handedOver(id);
    return {
      reply: scrub(reply, [id, clipId]),
      command: commandOf(spec),
      output: outputOf(spec),
      record: { ...recordOf(id) },
    };
  }

  it("a clip made with a Fast slot is the clip of Quality: the clip's own picture, the same command, no route", async () => {
    const fast = await clipExport(FAST);
    const none = await clipExport(undefined);
    expect(fast.command).toEqual(none.command);
    expect(fast.reply).toEqual(none.reply);
    expect(fast.output).toEqual(OWN_PICTURE);
    expect(fast.record).not.toHaveProperty("route");
    expect(keysOf(fast.record)).toEqual(keysOf(none.record));
  });

  it("a library file copied with a Fast slot is the copy of Quality, with no route and no render", async () => {
    const copy = async (slot: unknown) => {
      const t = await world(UHD60);
      // The app process plays the copy as well: the delivery's copy runs as one of its jobs.
      const delivery = t.jobs.delivery!;
      const prepare = delivery.prepare.bind(delivery);
      delivery.prepare = async (...args) => {
        const prepared = await prepare(...args);
        if (prepared.source?.kind === "copy") t.jobs.queueCopy(prepared);
        return prepared;
      };
      const run = delivery.copy.bind(delivery);
      delivery.copy = (id) => t.jobs.runCopy(id, () => run(id));
      const source = "C:/source/copied.mp4";
      await t.fs.writeTextFile(source, "complete copied video");
      const bytes = await t.store.readBytes(source);
      const from = { kind: "import" };
      const entry = await registerLibraryClip(t.store, bytes, "copied.mp4", "video", from, source);
      const reply = await t.call({ media_refs: [entry.id], output_dir: "copies" }, slot);
      const id = String(reply.exports[0].job_id);
      return {
        reply: scrub(reply, [id, entry.id]),
        record: { ...recordOf(id) },
        rendered: t.jobs.submitted.length,
      };
    };
    const fast = await copy(FAST);
    const none = await copy(undefined);
    expect(fast.reply).toEqual(none.reply);
    expect(fast.record).not.toHaveProperty("route");
    expect(keysOf(fast.record)).toEqual(keysOf(none.record));
    expect([fast.rendered, none.rendered]).toEqual([0, 0]);
  });
});

describe("7. a bad slot is no slot", () => {
  const unreadable = Object.defineProperty({}, "route", {
    get() {
      throw new Error("the slot cannot be read");
    },
  });
  it.each<[string, unknown]>([
    ['route: "fast"', { route: "fast" }],
    ['route: "QUICK"', { route: "QUICK" }],
    ["route: null", { route: null }],
    ["route: {}", { route: {} }],
    ["route: a number", { route: 1 }],
    ["no route at all", { explicit: { size: true, fps: true, quality: true } }],
    ["a slot that is an array", [{ route: "quick" }]],
    ["a slot that is a string", "quick"],
    ["a slot that is a number", 7],
    ["a slot that is null", null],
    ["a slot whose route cannot be read", unreadable],
  ])("%s gives exactly Quality", async (_name, slot) => {
    for (const chip of [false, true]) {
      const bad = await observe({ canvas: UHD60, slot, chip });
      const none = await observe({ canvas: UHD60, chip });
      expect(bad.command).toEqual(none.command);
      expect(bad.reply).toEqual(none.reply);
      expect(keysOf(bad.running)).toEqual(keysOf(none.running));
      expect(bad.running).not.toHaveProperty("route");
      expect(bad.output).toEqual(OWN_PICTURE);
    }
  });

  // The call's own arguments say what was set: a 1440p above Fast's own size and a rate of 60 above its cap stay; a call that sets nothing is composed in full.
  it.each<[string, unknown]>([
    ["strings for the flags", { size: "yes", fps: "no" }],
    ["nulls for the flags", { size: null, fps: null }],
    ["numbers for the flags", { size: 1, fps: 0 }],
    ["no size", { fps: false }],
    ["no rate", { size: false }],
    ["a string", "everything"],
    ["an array", [true, true]],
    ["null", null],
  ])("explicit as %s falls back to the call's arguments", async (_name, explicit) => {
    const slot = { route: "quick", explicit };
    const set = await observe({ canvas: UHD60, args: { resolution: "1440p", fps: 60 }, slot });
    expect([set.output, after(set.command, "-crf")]).toEqual([pic(2560, 1440, 60), "23"]);
    const nothing = await observe({ canvas: UHD60, slot });
    expect([nothing.output, after(nothing.command, "-crf")]).toEqual([FAST_PICTURE, "23"]);
    expect(nothing.running.route).toBe("quick");
  });

  it("an `explicit` that has the size and the rate but not the quality leaves the quality alone (nothing is taken from the person)", async () => {
    const seen = await observe({ canvas: UHD60, slot: fastSlot({ size: false, fps: false }) });
    expect([seen.output, after(seen.command, "-crf")]).toEqual([FAST_PICTURE, undefined]);
  });
});

describe("8. two exports started together from one context keep their own route", () => {
  it.each([
    { name: "Fast first", fastFirst: true },
    { name: "Quality first", fastFirst: false },
  ])("$name", async ({ fastFirst }) => {
    const t = await world(UHD60);
    const asks = [
      () => t.call({ name: "fast one" }, FAST),
      () => t.call({ name: "quality one" }, STANDARD),
    ];
    const [fast, quality] = fastFirst
      ? await Promise.all([asks[0](), asks[1]()])
      : (await Promise.all([asks[1](), asks[0]()])).reverse();
    expect(outputOf(await t.handedOver(fast.job_id))).toEqual(FAST_PICTURE);
    expect(outputOf(await t.handedOver(quality.job_id))).toEqual(OWN_PICTURE);
    expect(recordOf(fast.job_id)).toMatchObject({ route: "quick" });
    expect(recordOf(quality.job_id)).not.toHaveProperty("route");
  });
});

describe("9. the person's Graphics chip Off wins in Fast (the real chip lookup, on a scripted PC whose chip passes its test)", () => {
  // The lookup that runs is the real one, its Off check included: only the PC under it is scripted (an AMD chip that passes the test, and the storage that holds the person's switch).
  async function fastWith(pc: ReturnType<typeof harness>, pref: "auto" | "off") {
    if (pref === "off") pc.storage.set(CHIP_PREF_KEY, "off");
    else pc.storage.delete(CHIP_PREF_KEY);
    const real = await vi.importActual<typeof import("./chipTest")>("./chipTest");
    const t = await world(HD30);
    vi.mocked(findChip).mockImplementation(async (sizeClass, options) =>
      real.findChip(sizeClass, options, pc.deps),
    );
    const reply = await t.call({}, FAST);
    const spec = await t.handedOver(reply.job_id);
    const command = commandOf(spec);
    return {
      command,
      codec: after(command, "-c:v"),
      preset: after(command, "-preset"),
      output: outputOf(spec),
      record: recordOf(reply.job_id),
    };
  }

  it("with the chip Auto Fast runs on the chip that passed; with it Off Fast runs on the processor with the faster compression, and the chip is never tested", async () => {
    const auto = harness([amd]);
    const onChip = await fastWith(auto, "auto");
    expect([onChip.codec, onChip.preset, onChip.output]).toEqual([
      "h264_amf",
      undefined,
      pic(1280, 720, 30),
    ]);
    expect(auto.calls.length, "the chip was tested").toBeGreaterThan(0);

    const off = harness([amd]);
    const offChip = await fastWith(off, "off");
    expect([offChip.codec, offChip.preset, offChip.output]).toEqual([
      "libx264",
      "veryfast",
      pic(1280, 720, 30),
    ]);
    expect(textOf(offChip.command)).not.toContain("h264_amf");
    expect(off.calls, "Off is never tested").toEqual([]);
    // Off changes the encoder and nothing else: the picture, the rate and the quality are Fast's own either way (the typed twin of this export is case 2).
    expect(after(offChip.command, "-r")).toBe("30");
    expect(after(offChip.command, "-crf")).toBe("23");
    expect(offChip.record.route).toBe("quick");
  });

  it("Off beats a proof the PC already remembered, and Auto brings the chip back without a new test", async () => {
    const pc = harness([amd]);
    expect((await fastWith(pc, "auto")).codec).toBe("h264_amf");
    const tested = pc.calls.length;
    expect(tested).toBeGreaterThan(0);
    const off = await fastWith(pc, "off");
    expect([off.codec, off.preset]).toEqual(["libx264", "veryfast"]);
    expect(pc.calls.length, "nothing was tested while it was Off").toBe(tested);
    expect((await fastWith(pc, "auto")).codec).toBe("h264_amf");
    expect(pc.calls.length, "the remembered proof was used").toBe(tested);
  });

  it("with the faster compression's own switch off as well, Off gives plain libx264", async () => {
    __setExportFlag("faster_x264", false);
    const off = await fastWith(harness([amd]), "off");
    expect([off.codec, off.preset]).toEqual(["libx264", undefined]);
    expect(off.output).toEqual(pic(1280, 720, 30));
  });
});
