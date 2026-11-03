// What a whisper-cli run prints about itself on stderr: backend, audio length, time (4i part 4).
// Formats are whisper.cpp's own log lines, pinned by real captures in __fixtures__/whisper.

export interface WhisperRunFacts {
  /** "vulkan", "metal", "cuda", ... or "cpu"; null when the run did not say. */
  backend: string | null;
  audioSeconds: number | null;
  /** whisper's own total, model load included. */
  wallSeconds: number | null;
  model: string | null;
  threads: number | null;
}

const SAMPLE_RATE = 16000;

const PROCESSING = /main: processing '[^\n]*' \((\d+) samples, [\d.]+ sec\), (\d+) threads/g;
/** What the job supervisor leaves where it dropped the middle of a long output (jobStderr). */
const ELIDED = /…\[\d+ bytes elided\]…/;

/** What the run said about itself. A batch (one run over several files) prints a line for each file it
 *  read and one total for them all, so its audio is the sum of those lines; pass `{ batch: true }` to
 *  read it that way. When the middle of its output was elided some of those lines are gone, and the
 *  audio is then unknown rather than a sum that is too short. A single file is read as it always was. */
export function whisperRunFacts(stderr: string, opts: { batch?: boolean } = {}): WhisperRunFacts {
  const gpu = /whisper_backend_init_gpu: using (\S+) backend/.exec(stderr)?.[1] ?? null;
  const seen = [...stderr.matchAll(PROCESSING)];
  const processing = seen[0] ?? null;
  const total = /whisper_print_timings:\s+total time =\s+(\d+(?:\.\d+)?) ms/.exec(stderr);
  // A GPU that failed to start leaves the model on the CPU.
  let backend: string | null = null;
  if (gpu && !/whisper_backend_init_gpu: failed to initialize/.test(stderr))
    backend = backendFamily(gpu);
  else if (gpu || /whisper_backend_init_gpu: no GPU found/.test(stderr)) backend = "cpu";
  let samples: number | null = processing ? Number(processing[1]) : null;
  if (opts.batch) {
    const sum = seen.reduce((n, m) => n + Number(m[1]), 0);
    samples = ELIDED.test(stderr) || sum <= 0 ? null : sum;
  }
  return {
    backend,
    audioSeconds: samples === null ? null : samples / SAMPLE_RATE,
    wallSeconds: total ? Number(total[1]) / 1000 : null,
    model: /whisper_model_load: type\s+=\s+\d+ \(([^)\n]+)\)/.exec(stderr)?.[1] ?? null,
    threads: processing ? Number(processing[2]) : null,
  };
}

/** "Vulkan0" -> vulkan, "MTL0" -> metal, "CUDA1" -> cuda. */
export function backendFamily(device: string): string {
  const name = (/^[A-Za-z]+/.exec(device)?.[0] ?? device).toLowerCase();
  return name === "mtl" ? "metal" : name;
}
