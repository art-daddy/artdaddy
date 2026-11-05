// The encoder an export gets, decided in one place from facts (exporter document 19.7, I-S4-3). The Export dialog asks
// it to know whether to show the Mode row and what the row starts on; every export asks it again at the moment it
// starts, so an export from the menu, from the app's chat and from MCP are given the encoder by the same rule. The
// rule itself is the pure `chooseEncoder`; this adds the facts it needs (the chip that has proven itself, this PC's
// estimates for each way) and never lets a failing lookup fail an export.
import type { GraphicsAdapter } from "../platform/host";
import { exportFlag } from "../api/exportFlags";
import type { ExportEncoderKind } from "../api/exportVocabulary";
import {
  findChip,
  takeChipTestEvents,
  type ChipLookup,
  type ChipTestEvent,
  type ChipVerdict,
} from "./chipTest";
import {
  chooseEncoder,
  sizeClassOf,
  type ChipMaker,
  type ModeReason,
  type ModeRequest,
} from "./exportEncoder";
import {
  deliveredPicture,
  estimateForDialog,
  promiseLineOf,
  promiseMultipleOf,
  type ExportCalibration,
  type ExportMode,
  type ExportQuality,
  type ExportResolution,
} from "./exportOptions";
import type { RenderWorkload } from "./renderPlan";

/** The longest an export waits for a chip's test that has not finished (the first ever, on this PC). After it the export
 *  goes on the processor and the test finishes for the next one. */
export const CHIP_WAIT_MS = 20_000;

export interface ChoiceInput {
  /** What the person picked in the Export dialog; "auto" for every other way an export starts. */
  readonly request: ModeRequest;
  readonly workload: RenderWorkload;
  readonly settings: {
    readonly resolution?: ExportResolution;
    readonly quality?: ExportQuality;
    readonly fps?: number | null;
  };
  readonly history: readonly ExportCalibration[];
  /** Whether a chip that has not been tested yet may be tested now. Default true. */
  readonly allowRun?: boolean;
  /** Ends the wait for a test (the export was stopped); the test itself goes on. */
  readonly signal?: AbortSignal;
  /** How long to wait for a test. Default {@link CHIP_WAIT_MS}; the dialog waits as long as it takes. */
  readonly waitMs?: number;
  /** A look for the Export dialog, not an export: the chip's untold test results are left for the export that follows. */
  readonly preview?: boolean;
}

/** What an export records about how its encoder was chosen: plain data, kept with the plan, the job and the report. */
export interface ChoiceFacts {
  /** The encoder that runs, in the report's own words. */
  readonly encoder: ExportEncoderKind;
  /** The chip that has proven itself at this picture size, whether or not this export uses it. */
  readonly chip?: ChipMaker;
  readonly reason: ModeReason;
  /** What the Mode row started on, for an export started from the menu while the row was shown. */
  readonly shown?: "full" | "fast";
  readonly fullSeconds?: number;
  readonly fastSeconds?: number;
  /** The chip's tests since the last export (or what it remembers), for the export's story. */
  readonly tests: readonly ChipTestEvent[];
  /** The chip's device and driver, which key the local cache and never leave this PC: kept so a chip that fails an
   *  export can be set aside. */
  readonly adapter?: GraphicsAdapter;
}

export interface ExportEncoderDecision {
  /** What `buildRenderCommand` is given: `fast` runs on the chip, and only then. */
  readonly mode: ExportMode;
  readonly chip?: ChipMaker;
  /** The processor's faster setting (x264 `veryfast`). */
  readonly faster?: true;
  readonly reason: ModeReason;
  /** Whether the Export dialog shows the Mode row, and what it starts on. */
  readonly showRow: boolean;
  readonly defaultMode: ExportMode;
  readonly fullSeconds: number | null;
  readonly fastSeconds: number | null;
  /** `fullSeconds` is a guess from the size of the export, not a measurement made on this PC. */
  readonly fullGuessed: boolean;
  readonly tests: readonly ChipTestEvent[];
  readonly facts: ChoiceFacts;
}

/** `task`, or `fallback` once `signal` fires or `ms` has passed. The task is left to finish: it is shared. */
function within<T>(
  task: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  fallback: T,
): Promise<T> {
  if (signal?.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (value: T) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    const stop = () => done(fallback);
    signal?.addEventListener("abort", stop, { once: true });
    if (Number.isFinite(ms)) timer = setTimeout(stop, Math.max(0, ms));
    task.then(done, () => done(fallback));
  });
}

export async function decideExportEncoder(
  input: ChoiceInput,
  lookup: typeof findChip = findChip,
): Promise<ExportEncoderDecision> {
  const settings = {
    resolution: input.settings.resolution ?? ("source" as const),
    quality: input.settings.quality ?? ("medium" as const),
    fps: input.settings.fps ?? null,
  };
  const picture = deliveredPicture(input.workload, settings);
  const sizeClass = sizeClassOf(picture.width, picture.height, picture.fps);

  // A person's Full never needs a chip, so none is tested for it.
  let found: ChipLookup = { chip: null, events: [] };
  if (input.request !== "full" && sizeClass !== null) {
    const asked = lookup(
      sizeClass,
      { allowRun: input.allowRun ?? true, signal: input.signal },
      undefined,
    ).catch((): ChipLookup => ({ chip: null, events: [] }));
    found = await within(asked, input.waitMs ?? CHIP_WAIT_MS, input.signal, {
      chip: null,
      events: [],
    } as ChipLookup);
  }
  const chip: ChipVerdict | null = found.chip;
  const real = input.preview ? [] : takeChipTestEvents();
  const tests = real.length > 0 ? real : found.events;

  const full = estimateForDialog(input.workload, { ...settings, mode: "quality" }, input.history);
  const fast = chip
    ? estimateForDialog(input.workload, { ...settings, mode: "fast" }, input.history, {
        chip: chip.maker,
      })
    : null;
  const choice = chooseEncoder({
    request: input.request,
    chip: chip?.maker ?? null,
    chipDefaultOn: exportFlag("chip_default"),
    fasterX264On: exportFlag("faster_x264"),
    fullSeconds: full.seconds,
    fullMeasured: !full.guessed,
    fastSeconds: fast?.seconds ?? null,
    durationSeconds: input.workload.durationSeconds,
    promiseMultiple: promiseMultipleOf(promiseLineOf(input.workload)),
  });
  const onChip =
    choice.encoder === "amd" || choice.encoder === "nvidia" || choice.encoder === "intel";
  const used = onChip && chip ? chip : null;
  const facts: ChoiceFacts = {
    encoder: choice.encoder,
    ...(chip ? { chip: chip.maker } : {}),
    reason: choice.reason,
    ...(full.seconds !== null ? { fullSeconds: full.seconds } : {}),
    ...(fast?.seconds != null ? { fastSeconds: fast.seconds } : {}),
    tests,
    ...(used ? { adapter: used.adapter } : {}),
  };
  return {
    mode: used ? "fast" : "quality",
    ...(used ? { chip: used.maker } : {}),
    ...(choice.preset === "veryfast" ? { faster: true as const } : {}),
    reason: choice.reason,
    showRow: choice.showRow,
    defaultMode: choice.defaultMode,
    fullSeconds: full.seconds,
    fastSeconds: fast?.seconds ?? null,
    fullGuessed: full.guessed,
    tests,
    facts,
  };
}
