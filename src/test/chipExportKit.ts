// The pieces every journey of a graphics-chip export shares: a project on a fake disk, the app process played by FakeJobs, a chip the
// test decides about, and the words the app process prints when an encoder fails. The test files that use it mock `./chipTest` and
// `../api/exportEvents` themselves (vi.mock is per file).
import { createHash } from "node:crypto";
import { vi } from "vitest";

import { useExportJob } from "../store/exportJob";
import { findChip, markChipSuspect, type ChipVerdict } from "../timeline/chipTest";
import { ensureTimeline } from "../timeline/engine";
import {
  dismissExport,
  localDeliveryPort,
  whenExportEnds,
  whenExportsSettle,
} from "../timeline/exportQueue";
import { addClipsTool } from "../timeline/placement";
import { exportTimelineTool } from "../timeline/render";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __setJobSupervisor } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { FakeJobs } from "./fakeJobs";
import { MemFs, registerTestDocument } from "./timelineKit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const DIR = "C:/proj";
export const DEST = "C:/Users/test/Downloads/proj.mp4";
export const DEST_LONG = "C:/Users/test/Downloads/long.mp4";
export const GIB = 1024 ** 3;

export class Fs extends MemFs {
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(joinPath(from));
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), v);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
  async copyFile(from: string, to: string): Promise<void> {
    const value = this.files.get(joinPath(from));
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(joinPath(to), value);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return new TextEncoder().encode(String(v));
  }
  async probeMedia(p: string, headBytes: number) {
    const bytes = await this.readBytes(p);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      id12: sha256.slice(0, 12),
      sha256,
      size: bytes.length,
      head: bytes.slice(0, headBytes),
    };
  }
}

export const settleTick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function flush(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await settleTick();
}

/** What the app process prints for an encoder that falls over mid-export, and for a PC that ran short of memory. */
export const DRIVER_ERROR =
  "native render failed: [h264_amf @ 0000028f] Error submitting video frame to the encoder\n";
export const resident = (peak: number): string =>
  `native render resident: ${JSON.stringify({ limit: 3.5 * GIB, sampled_peak: peak, workers_at_peak: [] })}\n`;
export const MEMORY_SHORT =
  resident(1.2 * GIB) +
  "native render failed: render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself\n";

/** What ffmpeg prints as it goes: `frame` frames made, `ms` milliseconds of the project in. */
export const progressBlock = (frame: number, ms: number): string =>
  `frame=${frame}\nfps=30\nout_time_us=${ms * 1000}\nspeed=1.0x\nprogress=continue\n`;

export const amdChip = (): ChipVerdict => ({
  maker: "amd",
  adapter: { maker: "amd", device: "15bf", driver: "32.0.1" },
  sizeClass: "hd",
  ok: true,
  result: "passed",
  ssimMilli: 870,
  ms: 1800,
});

export const codecOf = (spec: { args: string[] }): string =>
  spec.args[spec.args.lastIndexOf("-c:v") + 1];
export const encoderOf = (spec: { meta: Record<string, unknown> }): string =>
  ((spec.meta.telemetry as Any).choice?.encoder ?? "x264") as string;
export const rungOf = (spec: { meta: Record<string, unknown> }): number =>
  ((spec.meta.telemetry as Any).plan?.rung ?? 0) as number;
export const story = (report: Any): string[] =>
  (report.trace as Any[]).map((e) => (e.v ? `${e.e}:${e.v}` : e.e));

/** A project of one clip on a fake disk, the app process played by FakeJobs, and the export tool in front of it. */
export async function setupExport() {
  const fs = new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  registerTestDocument(DIR);
  await ensureTimeline(store);
  let jobs: FakeJobs | undefined;
  const runner: CommandRunner = {
    run: async (program, args): Promise<CommandResult> => {
      if (program === "ffprobe") {
        const spec = jobs?.submitted.find((submitted) => submitted.meta.stagePath === args.at(-1));
        const plan = spec?.meta.plan as
          | {
              duration: number;
              audioExpected: boolean;
              output: { width: number; height: number; fps: number };
            }
          | undefined;
        const output = plan?.output ?? { width: 1920, height: 1080, fps: 30 };
        const duration = plan?.duration ?? 2;
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                width: output.width,
                height: output.height,
                avg_frame_rate: `${output.fps}/1`,
                nb_read_frames: String(Math.ceil(duration * output.fps)),
                duration: String(duration),
              },
              ...(plan?.audioExpected ? [{ codec_type: "audio", duration: String(duration) }] : []),
            ],
            format: { duration: String(duration) },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    { store, runner },
  );
  jobs = new FakeJobs();
  jobs.delivery = localDeliveryPort(store);
  jobs.onStart = (spec) => fs.writeTextFile(String(spec.meta.stagePath), "a whole video");
  __setJobSupervisor(jobs);
  const base: ClientToolContext = { store, runner };
  const exportNow = async (name?: string) =>
    (await exportTimelineTool(
      name ? { name } : {},
      agentToolContext(base, new AbortController().signal),
    )) as Any;
  const nextPage = () => ({ store: new ProjectStoreAccess(DIR, fs), runner });
  return { fs, store, jobs, exportNow, nextPage };
}
export type ExportRig = Awaited<ReturnType<typeof setupExport>>;

/** A project this PC has measured to take ten minutes on the processor: long enough for the app to choose the chip by itself. Leaves
 *  the chip lookup answering with `chip` (a proven AMD chip unless told otherwise), and no trace of the measuring export on the card
 *  or in the list. */
export async function longProject(chip: ChipVerdict | null = amdChip()): Promise<ExportRig> {
  const t = await setupExport();
  const first = await t.exportNow("first");
  await flush();
  const calibration = (t.jobs.submitted[0].meta.telemetry as Any).calibration;
  t.jobs.exit(first.job_id, 0);
  await whenExportEnds(first.job_id);
  await whenExportsSettle();
  dismissExport(first.job_id);
  useExportJob.getState().rememberCalibration({
    ...calibration,
    elapsedSeconds: 600,
    finalBytes: 50_000_000,
    memoryBytes: 1_000_000_000,
    temporaryBytes: 0,
  });
  vi.mocked(findChip).mockClear();
  // As the real lookup answers: a chip that failed an export is set aside, so it is not found again.
  vi.mocked(findChip).mockImplementation(async () => ({
    chip: vi.mocked(markChipSuspect).mock.calls.length > 0 ? null : chip,
    events: [],
  }));
  return t;
}

/** Holds the restart's start at the moment its delivery intent is prepared, which comes only after the app has decided to start the
 *  export again: the gap in which the first attempt's row says it is starting again. `arm()` just before the first attempt fails;
 *  `release()` lets the start go on. */
export function holdTheRestart(t: { jobs: FakeJobs }) {
  let armed = false;
  let held = false;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const delivery = t.jobs.delivery!;
  const prepare = delivery.prepare.bind(delivery);
  delivery.prepare = async (...args) => {
    if (armed && !held) {
      held = true;
      await gate;
    }
    return prepare(...args);
  };
  return { arm: () => (armed = true), release: () => open() };
}

/** Makes the delivery owner refuse the first export's check, as it does for a file that is not what the render promised. */
export function failTheCheckOf(t: { jobs: FakeJobs }, jobId: string): void {
  const delivery = t.jobs.delivery!;
  const verify = delivery.verify.bind(delivery);
  delivery.verify = async (id) => {
    if (id === jobId)
      throw new Error("export artifact failed verification: the file is not the one rendered");
    return verify(id);
  };
}
