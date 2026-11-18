// The shared harness of the Export dialog's Fast journeys: a project on a fake disk, the app process played by FakeJobs, and the real `export` tool and queue in front of it, called the way
// the dialog's menu bar calls it. The test files that use it mock `../api/exportEvents`, `../timeline/chipTest` and `../timeline/brandRecovery` themselves (vi.mock is per file): the lookup of the
// graphics chip is the test's to answer (`findChip`), and nothing here runs ffmpeg, reaches a vendor or uses the network.
import { expect, vi } from "vitest";

import { __resetExportFlags, __setExportFlag, __setHeldOffByBuild } from "../api/exportFlags";
import type { ExportSettings } from "../components/ExportDialog";
import { useExportJob } from "../store/exportJob";
import { findChip } from "../timeline/chipTest";
import { exportTool } from "../timeline/exportItems";
import type { ExportEngine } from "../timeline/exportOptions";
import {
  __resetExportQueue,
  cancelExport,
  listExportOutcomes,
  listExportRecords,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
} from "../timeline/exportQueue";
import { setCanvasTool } from "../timeline/ops";
import { agentToolContext } from "../tools/agentStore";
import { _resetAppCaches } from "../tools/appCache";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs } from "../tools/genJobs";
import { __resetJobSupervisor, type JobSpec } from "../tools/jobSupervisor";
import { __resetWorkGate } from "../tools/workGate";
import { amdChip, settleTick, setupExport, type Any } from "./chipExportKit";
import { resetTestDocuments } from "./timelineKit";

export type { Any };
export type Canvas = { w: number; h: number; fps: number };
export type Picture = { width: number; height: number; fps: number };
export const pic = (width: number, height: number, fps: number): Picture => ({
  width,
  height,
  fps,
});

/** The tool call the menu bar makes of the settings the dialog hands over (`exportVideo` in MenuBar.tsx: the arguments, the dialog's own pick of the encoder as `exportMode`, and the
 *  route as the slot only where the settings carry one). The menu bar's own mapping is held to this one by MenuBar.fastWire.test.tsx. */
export function callOf(settings: ExportSettings) {
  return {
    args: {
      resolution: settings.resolution,
      quality: settings.quality,
      ...(settings.fps === null ? {} : { fps: settings.fps }),
    } as Record<string, unknown>,
    slot: settings.route,
    mode: settings.mode ?? undefined,
  };
}

/** What the person's picks of the three lists give for the encoder's quality: high 18, medium 23, low 28 (the owner's table). */
export const CRF: Record<string, string> = { high: "18", medium: "23", low: "28" };

// The world: one project on a fake disk at a time, the app process, the chip lookup, and the tool called the way the dialog calls it.
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

/** For the test file's `beforeEach`: the switches as the unit suite has them (`quick_route` on), no chip, the engine pinned. */
export function resetBefore(): void {
  __resetExportFlags();
  __setHeldOffByBuild(false);
  __setExportFlag("quick_route", true);
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useExportJob.getState().setEngine("file-sequence-v1");
  vi.mocked(findChip).mockReset();
  vi.mocked(findChip).mockResolvedValue({ chip: null, events: [] });
}
/** For the test file's `afterEach`. */
export async function resetAfter(): Promise<void> {
  if (current) await finish(current);
  __resetExportFlags();
  __setHeldOffByBuild(null);
  useExportJob.setState({ calibrations: [], modeRowOnScreen: null });
  useExportJob.getState().setEngine("auto");
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 1000 && !done(); tick++) await settleTick();
  if (!done()) throw new Error(`never happened: ${what}`);
}

export async function world(
  canvas: Canvas,
  options: { chip?: boolean; engine?: ExportEngine } = {},
) {
  if (current) await finish(current);
  const t = await setupExport();
  current = t;
  const base: ClientToolContext = { store: t.store, runner: t.nextPage().runner };
  const set = await setCanvasTool({ width: canvas.w, height: canvas.h, fps: canvas.fps }, base);
  if (set.ok === false) throw new Error(`the canvas was not set: ${JSON.stringify(set)}`);
  vi.mocked(findChip).mockResolvedValue({ chip: options.chip ? amdChip() : null, events: [] });
  useExportJob.getState().setEngine(options.engine ?? "file-sequence-v1");
  /** One call of the `export` tool as the menu bar makes it. The slot goes in before the context is made, as the host does. */
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
  return { ...t, base, call, handedOver };
}

export type Cmd = { args: string[]; steps: string[][] };
/** The same text for two exports of one project: only the staging file's random name and the job's id differ between them. */
export function scrub<T>(value: T, ids: readonly string[] = []): T {
  return JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === "string"
      ? ids
          .reduce((text, id) => text.split(id).join("JOB"), item)
          .replace(/\.[a-z0-9]{6}\.partial/g, ".X.partial")
      : item,
  ) as T;
}
export const commandOf = (spec: JobSpec): Cmd =>
  scrub({ args: spec.args, steps: spec.steps ?? [] }, [spec.id]);
export const textOf = (cmd: Cmd): string => [cmd.args, ...cmd.steps].flat().join(" ");
export const outputOf = (spec: JobSpec): Picture => (spec.meta.plan as { output: Picture }).output;
/** The value after `flag` in the command's last part: the one encode that makes the delivered file (a streamed export's first parts only make the pieces). */
export const after = (cmd: Cmd, flag: string): string | undefined => {
  const last = [cmd.args, ...cmd.steps].at(-1)!;
  const at = last.lastIndexOf(flag);
  return at < 0 ? undefined : last[at + 1];
};
/** The command with the faster setting's pair `-preset veryfast` taken out of every part of it. */
export const withoutPreset = (cmd: Cmd): Cmd => {
  const strip = (list: string[]) => {
    const at = list.indexOf("-preset");
    return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 2)];
  };
  return { args: strip(cmd.args), steps: cmd.steps.map(strip) };
};
export const keysOf = (value: object): string[] => Object.keys(value).sort();
export const recordOf = (id: string) => listExportRecords().find((r) => r.job_id === id)!;

export interface Run {
  canvas: Canvas;
  args?: Record<string, unknown>;
  slot?: unknown;
  /** The dialog's own pick of the encoder (`ctx.exportMode`): how an export typed by hand asks for its encoder. */
  mode?: "fast" | "quality";
  chip?: boolean;
  engine?: ExportEngine;
  /** The switch `quick_route`: held off by the build (as shipped), off on the server, or on (the unit suite's state). */
  switch?: "held" | "off" | "on";
  /** The door the call came through: the assistant in the app (the default) or an outside program over MCP. */
  surface?: "app" | "mcp";
}

/** One export of a fresh project, from the call to its end: what the app process was handed, the reply, the record while it ran and after, and the assistant's list row. */
export async function observe(run: Run) {
  __setHeldOffByBuild(run.switch === "held");
  __setExportFlag("quick_route", run.switch !== "off");
  const t = await world(run.canvas, run);
  const extra: Partial<ClientToolContext> = {
    ...(run.mode ? { exportMode: run.mode } : {}),
    ...(run.surface ? { surface: run.surface } : {}),
  };
  const reply = await t.call(run.args ?? {}, run.slot, extra);
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
  const out = { ...seen, done };
  await finish(t);
  return out;
}
export type Seen = Awaited<ReturnType<typeof observe>>;
