// The speed test of the PC check, for exports: the reference clip, three timed runs of ffmpeg and the reading of ffmpeg's -progress.
// Commands are only BUILT here and their output parsed from text: an injected `probe` runs them (the capability lane's
// `runCapabilityProbe`, `platform/host.ts`), so nothing in this module starts a process or touches a disk of its own.
//
// Every number the protocol rests on is in `SPEED_PROBE` and is a PLACEHOLDER until the rig has fitted it (design 2.1, I-1), as are
// the commands' details: they have only been checked against canned text, never against the pinned ffmpeg.
import { createProgressReader, type RenderProgress } from "../timeline/ffmpegProgress";
import {
  acceptCutoffs,
  classOf,
  rHatOf,
  type Cutoffs,
  type PcCheckRecord,
} from "../timeline/pcClass";
import type { PcCheckDeps, ProbeDefinition } from "./pcCheck";

export const EXPORT_SPEED_PROBE_ID = "export-speed";
/** Bumped when the test means something different (a changed recipe, a changed reading): an older answer is then not believed. */
export const EXPORT_SPEED_REVISION = 1;

export const SPEED_PROBE = {
  /** The reference clip: 4 s of 1080p30 test pattern with fixed-seed noise, H.264 veryfast, made once and kept. The kept file's
   *  name carries the version, so a changed recipe makes a new file. */
  referenceVersion: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  referenceSeconds: 4,
  referenceCrf: 23,
  referenceGop: 60,
  noise: 8,
  /** Frames one run asks for: the first try, and the longer ones for a PC so fast that a run ended before it could be read. */
  frameSteps: [60, 240, 960],
  /** How often ffmpeg reports (its own default is 0.5). */
  statsPeriodSeconds: 0.25,
  /** The first part of a run never counts: it is start-up (opening the clip, building the graph, filling the encoder). */
  skipSeconds: 0.5,
  /** A reading is a stretch of the run, after the skip, of at least this many frames and this long. */
  minFrames: 8,
  minSeconds: 1,
  /** The whole time box, the reference clip's making included. */
  boxMs: 20_000,
  /** A run is not started with less than this left of the box, and ends this long before the box does. */
  minRunMs: 1_500,
  marginMs: 500,
  /** A reference file outside these sizes is damaged (or not the clip): it is made again. */
  minReferenceBytes: 500_000,
  maxReferenceBytes: 150_000_000,
} as const;

export type ProbeKind = "a" | "b" | "c";

const REFERENCE_NAME = `reference-v${SPEED_PROBE.referenceVersion}.mp4`;
const REFERENCE_PART = `reference-v${SPEED_PROBE.referenceVersion}.part.mp4`;
const REFERENCE_FRAMES = SPEED_PROBE.referenceSeconds * SPEED_PROBE.fps;
const MAX_FRAMES_ASKED = 100_000;

// The commands ---------------------------------------------------------------------------------------------------------------

/** Makes the reference clip at `out`: ffmpeg's own test pattern with a fixed-seed noise (a flat clip would be too easy to read and
 *  to encode), 4 s of 1080p30, no sound, x264 veryfast. [] for a path that is not one. */
export function referenceClipArgs(out: string): string[] {
  if (typeof out !== "string" || out === "") return [];
  const { width, height, fps, referenceSeconds, noise, referenceCrf, referenceGop } = SPEED_PROBE;
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${referenceSeconds},noise=alls=${noise}:allf=t:all_seed=7,format=yuv420p`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(referenceCrf),
    "-g",
    String(referenceGop),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-f",
    "mp4",
    "-y",
    out,
  ];
}

/** The graph a plain project runs: the clip fitted to the canvas (scale, pad), held to the project's rate, overlaid on a black
 *  canvas, in TV range as yuv420p: the baseline's own chain for one clip (render.ts), without effects, sound or captions. */
function graph(seconds: number): string {
  const { width: w, height: h, fps } = SPEED_PROBE;
  return [
    `color=c=black:s=${w}x${h}:r=${fps}:d=${seconds}[base]`,
    `[0:v]setsar=1,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=fps=${fps}:start_time=0:round=near:eof_action=round[v0]`,
    "[base][v0]overlay=x=0:y=0:eof_action=pass[ov0]",
    "[ov0]scale=out_range=tv,format=yuv420p[tv]",
  ].join(";");
}

/** What each kind adds after the graph: A reads and mixes only (a null sink with no encoder), B encodes at Medium (CRF 23, the
 *  encoder's own default speed: the reference export) and C at the faster setting (x264 veryfast). */
function encoderArgs(kind: ProbeKind): string[] {
  const { fps } = SPEED_PROBE;
  const x264 = (preset: string) => [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
  ];
  if (kind === "a") return ["-r", String(fps)];
  return kind === "b" ? x264("medium") : x264("veryfast");
}

/** One timed run over the reference clip: its progress goes to stdout, its picture to a null sink (no file), and it stops after
 *  `options.frames` frames (the clip is looped when that is more than it holds). [] for a kind or a path that is not one. */
export function probeRunArgs(
  kind: ProbeKind,
  reference: string,
  options: { frames?: number } = {},
): string[] {
  if ((kind !== "a" && kind !== "b" && kind !== "c") || typeof reference !== "string") return [];
  if (reference === "") return [];
  const asked = options?.frames;
  const frames =
    typeof asked === "number" && Number.isFinite(asked)
      ? Math.min(MAX_FRAMES_ASKED, Math.max(1, Math.round(asked)))
      : SPEED_PROBE.frameSteps[0];
  const loops = Math.max(0, Math.ceil(frames / REFERENCE_FRAMES) - 1);
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-stats_period",
    String(SPEED_PROBE.statsPeriodSeconds),
    ...(loops > 0 ? ["-stream_loop", String(loops)] : []),
    "-i",
    reference,
    "-filter_complex",
    graph(Math.ceil(frames / SPEED_PROBE.fps) + 1),
    "-map",
    "[tv]",
    "-an",
    ...encoderArgs(kind),
    "-frames:v",
    String(frames),
    "-f",
    "null",
    "-",
  ];
}

// Reading the progress ---------------------------------------------------------------------------------------------------------

const MAX_TEXT = 262_144;
const MAX_FRAMES = 10_000_000;
const MAX_WALL_SECONDS = 3_600;
/** The most frames a second this module will believe: more is a garbled reading. */
const FPS_CAP = 100_000;
/** How far the two clocks of a block (frames over the rate, output time over the speed) may differ before it is not believed. */
const CLOCK_TOLERANCE = 0.15;

/** Seconds since ffmpeg started, at the moment a block was written, or null. Both `fps` (frames over wall time, 0 for the first
 *  second) and `speed` (output seconds over wall time, N/A until something is written) are averages over the whole run, so each
 *  gives the wall time by itself: when both are there they must agree, or the block is not believed. */
function wallSeconds(block: RenderProgress): number | null {
  const byFrames = block.fps > 0 && block.frame > 0 ? block.frame / block.fps : null;
  const byOutput = block.speed > 0 && block.outMs > 0 ? block.outMs / 1000 / block.speed : null;
  if (
    byFrames !== null &&
    byOutput !== null &&
    Math.abs(byFrames - byOutput) > CLOCK_TOLERANCE * Math.max(byFrames, byOutput)
  )
    return null;
  const seconds = byFrames ?? byOutput;
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The speed of a run, in frames a second, from the text ffmpeg wrote with `-progress`, and the frames the run reached. The
 *  speed is read from the LAST stretch of the run after its first half second (so start-up and a stall at the start never count),
 *  and only if that stretch holds at least 8 frames and lasts at least a second: the last block of the run (its flush, which can
 *  count frames in a burst) is not part of it. Anything that cannot give such a reading gives null; garbage never throws and never
 *  gives a speed that is not finite and above zero. */
export function speedFromProgress(text: string): { fps: number | null; frames: number } {
  try {
    if (typeof text !== "string" || text === "") return { fps: null, frames: 0 };
    const blocks: RenderProgress[] = [];
    createProgressReader((block) => blocks.push(block))(
      (text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text) + "\n",
    );
    const sane = blocks.filter((block) => block.frame <= MAX_FRAMES);
    const frames = sane.reduce((most, block) => Math.max(most, block.frame), 0);
    // The blocks of the run, after the first half second, as one stretch that only rises: a counter that goes back is
    // something else (garbage, or a second run) and what came before it does not count.
    let stretch: { t: number; frame: number }[] = [];
    for (const block of sane) {
      if (block.done) continue;
      const t = wallSeconds(block);
      if (t === null || t < SPEED_PROBE.skipSeconds || t > MAX_WALL_SECONDS) continue;
      const before = stretch[stretch.length - 1];
      if (before && (t <= before.t || block.frame < before.frame)) stretch = [];
      stretch.push({ t, frame: block.frame });
    }
    const last = stretch[stretch.length - 1];
    if (!last) return { fps: null, frames };
    for (let i = stretch.length - 2; i >= 0; i--) {
      const from = stretch[i];
      if (
        last.t - from.t < SPEED_PROBE.minSeconds ||
        last.frame - from.frame < SPEED_PROBE.minFrames
      )
        continue;
      const fps = (last.frame - from.frame) / (last.t - from.t);
      return { fps: Number.isFinite(fps) && fps > 0 && fps <= FPS_CAP ? fps : null, frames };
    }
    return { fps: null, frames };
  } catch {
    return { fps: null, frames: 0 };
  }
}

// The test -----------------------------------------------------------------------------------------------------------------------

export type SpeedProbeDeps = Pick<
  PcCheckDeps,
  "now" | "storage" | "build" | "cores" | "probe" | "files" | "cutoffs"
>;

const STOPPED = Symbol("stopped");

/** The cut-offs in force now, if the service was given a way to ask: the class a record carries is the one it had when it was measured, and the service
 *  derives it again at every read. */
function cutoffsOf(deps: SpeedProbeDeps): Cutoffs | undefined {
  try {
    return acceptCutoffs(deps.cutoffs?.()) ?? undefined;
  } catch {
    return undefined;
  }
}

function discard(files: SpeedProbeDeps["files"], path: string): void {
  try {
    void Promise.resolve(files.remove(path)).catch(() => undefined);
  } catch {
    /* a file that cannot be removed now is made over next time */
  }
}

/** Measures this PC: makes the reference clip if it is not there, runs B (the reference export's work: read, mix and encode at
 *  Medium), C (with the faster setting) and A (read and mix only), then B again and keeps the faster of its two runs (a disturbance
 *  can only slow a run). The whole of it is inside 20 s; null means the time ran out, a command failed, the run was refused or it was
 *  stopped. C, A and the repeat are optional once B has been read: each is started only when what is left of the box is what B took
 *  and a margin, so none of them is cut off by the box. `onRefused` is told when the job supervisor answers busy to the clip's making
 *  or to a run before B has been read: that is a refusal (an export it lists that the queue does not know yet, no supervisor to ask),
 *  not a PC that could not finish.
 *  Never throws. A run that is stopped leaves nothing behind but the finished reference clip, which is kept on purpose. */
export async function measureSpeed(
  deps: SpeedProbeDeps,
  signal: AbortSignal,
  onRefused?: () => void,
): Promise<PcCheckRecord | null> {
  const clock = (): number => {
    const t = deps.now();
    return Number.isFinite(t) ? t : 0;
  };
  const deadline = clock() + SPEED_PROBE.boxMs;
  let part: string | null = null;
  let onAbort: (() => void) | null = null;
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    if (signal.aborted) return resolve(STOPPED);
    onAbort = () => resolve(STOPPED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Work that never answers must not hold the run: a stop ends the wait, whatever the work does after it.
  const guard = <T>(work: Promise<T>): Promise<T | typeof STOPPED> => Promise.race([work, stopped]);
  try {
    if (signal.aborted) return null;
    const timeLeft = (): number => deadline - clock();

    const dir = await guard(deps.files.dir());
    if (dir === STOPPED) return null;
    const reference = `${dir}/${REFERENCE_NAME}`;
    const kept = await guard(deps.files.size(reference));
    if (kept === STOPPED) return null;
    const sound = (bytes: number | null): bytes is number =>
      bytes !== null &&
      bytes >= SPEED_PROBE.minReferenceBytes &&
      bytes <= SPEED_PROBE.maxReferenceBytes;
    if (!sound(kept)) {
      if (kept !== null && (await guard(deps.files.remove(reference))) === STOPPED) return null;
      if ((await guard(deps.files.mkdir(dir))) === STOPPED) return null;
      if (timeLeft() < SPEED_PROBE.minRunMs) return null;
      part = `${dir}/${REFERENCE_PART}`;
      const made = await guard(
        deps.probe(referenceClipArgs(part), {
          timeoutMs: Math.floor(timeLeft() - SPEED_PROBE.marginMs),
          kind: "pc-check-reference",
          signal,
        }),
      );
      if (made !== STOPPED && made.kind === "busy") onRefused?.();
      if (made === STOPPED || made.kind !== "ran" || made.code !== 0) return null;
      const size = await guard(deps.files.size(part));
      if (size === STOPPED || !sound(size)) return null;
      if ((await guard(deps.files.rename(part, reference))) === STOPPED) return null;
      part = null;
    }

    type Read =
      | { ok: true; fps: number; wallMs: number }
      | { ok: false; why: "stopped" | "failed" | "no_time" | "too_short" | "unreadable" };
    let bRead = false;
    /** What C, A and the repeat of B need left of the box once B has been read (0 before): what B took, which none of them is expected to
     *  need more of, and the margin. The runner answers only after it has cleaned up after the run, so a run started with less than
     *  that left is cut off by the box, and the box ending the check stores a check that had read B as not finished. */
    let optionalNeedMs = 0;
    const timed = async (kind: ProbeKind, frames: number): Promise<Read> => {
      if (signal.aborted) return { ok: false, why: "stopped" };
      const left = timeLeft();
      if (left < Math.max(SPEED_PROBE.minRunMs, optionalNeedMs))
        return { ok: false, why: "no_time" };
      const began = clock();
      const outcome = await guard(
        deps.probe(probeRunArgs(kind, reference, { frames }), {
          timeoutMs: Math.floor(left - SPEED_PROBE.marginMs),
          kind: `pc-check-${kind}`,
          signal,
        }),
      );
      if (outcome === STOPPED) return { ok: false, why: "stopped" };
      // Before B has been read every run decides the answer: a refusal there is no answer, and not a slow PC.
      if (outcome.kind === "busy" && !bRead) onRefused?.();
      if (outcome.kind !== "ran" || outcome.code !== 0) return { ok: false, why: "failed" };
      const seen = speedFromProgress(outcome.stdout);
      if (seen.fps !== null)
        return { ok: true, fps: seen.fps, wallMs: Math.max(0, clock() - began) };
      // The run reached everything it was asked for and still could not be read: it was over too soon (a fast PC). Anything
      // else (it stopped early, or said nothing readable) a longer run would not mend.
      return { ok: false, why: seen.frames >= frames ? "too_short" : "unreadable" };
    };
    /** One kind, from the step of the frame list it starts at, going on to a longer run only when a run was over too soon. */
    const measure = async (
      kind: ProbeKind,
      first: number,
    ): Promise<{ fps: number; step: number; wallMs: number } | null> => {
      for (let step = first; step < SPEED_PROBE.frameSteps.length; step++) {
        const read = await timed(kind, SPEED_PROBE.frameSteps[step]);
        if (read.ok) return { fps: read.fps, step, wallMs: read.wallMs };
        if (read.why !== "too_short") return null;
      }
      return null;
    };

    const b = await measure("b", 0);
    if (!b) return null;
    bRead = true;
    optionalNeedMs = b.wallMs + SPEED_PROBE.marginMs;
    const c = await measure("c", b.step);
    const a = await measure("a", b.step);
    const again = await measure("b", b.step);
    if (signal.aborted) return null;

    const bFps = Math.max(b.fps, again?.fps ?? 0);
    const rHat = rHatOf(bFps);
    return {
      revision: EXPORT_SPEED_REVISION,
      build: deps.build,
      atMs: clock(),
      cores: Number.isFinite(deps.cores) && deps.cores >= 1 ? Math.floor(deps.cores) : 1,
      outcome: "done",
      aFps: a?.fps ?? null,
      bFps,
      cFps: c?.fps ?? null,
      rHat,
      cls: classOf(rHat, cutoffsOf(deps)),
    };
  } catch {
    return null;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (part !== null) discard(deps.files, part);
  }
}

/** The export speed test as a probe the service runs: nothing about it is the service's to know. A refusal by the job supervisor is
 *  said as such (`refused`): the service then stores nothing and does not ask again in the same quiet stretch. */
export function exportSpeedProbe(): ProbeDefinition {
  return {
    id: EXPORT_SPEED_PROBE_ID,
    revision: EXPORT_SPEED_REVISION,
    ttlMs: 30 * 86_400_000,
    budgetMs: SPEED_PROBE.boxMs,
    definesClass: true,
    run: async ({ signal, deps }) => {
      let refused = false;
      const record = await measureSpeed(deps, signal, () => {
        refused = true;
      });
      return record === null && refused
        ? { record, stored: false, refused: true }
        : { record, stored: false };
    },
  };
}
