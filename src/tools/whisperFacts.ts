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
  /** Who made the graphics chip the run used (one of {@link GPU_MAKERS}). Present only for a run that used a chip whose
   *  device line could be read: never the device's name, its driver or its number. */
  gpu?: GpuMaker;
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
  const facts: WhisperRunFacts = {
    backend,
    audioSeconds: samples === null ? null : samples / SAMPLE_RATE,
    wallSeconds: total ? Number(total[1]) / 1000 : null,
    model: /whisper_model_load: type\s+=\s+\d+ \(([^)\n]+)\)/.exec(stderr)?.[1] ?? null,
    threads: processing ? Number(processing[2]) : null,
  };
  // The engine lists the chips it saw even when it then ran on the processor: only a run that used one has a maker.
  const maker = backend !== null && backend !== "cpu" ? gpuMakerOf(stderr) : null;
  if (maker !== null) facts.gpu = maker;
  return facts;
}

/** "Vulkan0" -> vulkan, "MTL0" -> metal, "CUDA1" -> cuda. */
export function backendFamily(device: string): string {
  const name = (/^[A-Za-z]+/.exec(device)?.[0] ?? device).toLowerCase();
  return name === "mtl" ? "metal" : name;
}

/** The makers a graphics chip is told as: one of these five words, never anything of the device's own line. */
export const GPU_MAKERS = ["amd", "nvidia", "intel", "apple", "other"] as const;
export type GpuMaker = (typeof GPU_MAKERS)[number];

/** The whole words of a device's name that say who made it, by maker, in the order the makers are tried: the first maker
 *  with a word in the name is the answer, and a name with none of them is "other". A word is a run of letters, so
 *  "RTX4090" holds "rtx" and "Pineati" holds no "ati". */
const MAKER_WORDS: ReadonlyArray<readonly [Exclude<GpuMaker, "other">, readonly string[]]> = [
  ["nvidia", ["nvidia", "geforce", "quadro", "tesla", "titan", "rtx", "gtx"]],
  ["amd", ["amd", "radeon", "ati"]],
  ["intel", ["intel"]],
  ["apple", ["apple"]],
];

/** How much of a device's name is read: a real one is a few dozen characters, and what follows is never looked at. */
const NAME_CHARS = 256;
/** How many devices of one backend are remembered: a log that lists more is not one chip's. */
const MAX_DEVICES = 64;

function makerOfName(name: string): GpuMaker {
  const words = new Set(
    name
      .slice(0, NAME_CHARS)
      .toLowerCase()
      .match(/[a-z]+/g) ?? [],
  );
  for (const [maker, list] of MAKER_WORDS) if (list.some((word) => words.has(word))) return maker;
  return "other";
}

type DeviceList = "vulkan" | "cuda" | "metal";

/** Which of the engine's device lists a device word of the `using` line ("Vulkan1", "CUDA0", "ROCm0", "MTL0") names: the
 *  list that backend prints. A word with no list that is read (SYCL and the rest) names none. */
const LIST_OF_BACKEND: ReadonlyMap<string, DeviceList> = new Map<string, DeviceList>([
  ["vulkan", "vulkan"],
  ["cuda", "cuda"],
  ["rocm", "cuda"],
  ["hip", "cuda"],
  ["musa", "cuda"],
  ["metal", "metal"],
  ["mtl", "metal"],
]);

/** Who made the graphics chip a run opened, as one of {@link GPU_MAKERS}, or null when the log does not say.
 *
 *  The engine lists the devices of a backend and then says which one it opened (`whisper_backend_init_gpu: using
 *  Vulkan1 backend`). The maker is read from THAT device's own line, to a word of the five: Vulkan prints
 *  `ggml_vulkan: <n> = <name> (<driver>) | facts`, CUDA and HIP `  Device <n>: <name>, facts` and Metal
 *  `ggml_metal_init: GPU name: <name>`. Nothing else of the line is kept: not the name, the driver or the number. When the
 *  log does not say which device it opened, or names a number that was not listed, the one device it listed is the answer,
 *  and several give none. A line is read only from its first character, so a file name that spells a device line is not one.
 *  One pass over the text, every line looked at by its first characters only: a log of megabytes costs what it is long. */
export function gpuMakerOf(stderr: string): GpuMaker | null {
  const lists: Record<DeviceList, Map<number, string>> = {
    vulkan: new Map(),
    cuda: new Map(),
    metal: new Map(),
  };
  /** undefined: the log does not say which device it opened; null: it opened one of a backend whose list is not read. */
  let opened: { list: DeviceList; index: number | null } | null | undefined;
  const keep = (list: DeviceList, index: number, name: string): void => {
    const devices = lists[list];
    if (!devices.has(index) && devices.size < MAX_DEVICES)
      devices.set(index, name.slice(0, NAME_CHARS));
  };
  for (let from = 0; from < stderr.length;) {
    let to = stderr.indexOf("\n", from);
    if (to < 0) to = stderr.length;
    if (stderr.startsWith("ggml_vulkan: ", from)) {
      const line = stderr.slice(from, Math.min(to, from + 40 + NAME_CHARS));
      const device = /^ggml_vulkan: (\d{1,4}) = ([^|]*)/.exec(line);
      if (device) keep("vulkan", Number(device[1]), device[2]);
    } else if (stderr.startsWith("whisper_backend_init_gpu: using ", from)) {
      if (opened === undefined) {
        const line = stderr.slice(from, Math.min(to, from + 120));
        const word = /^whisper_backend_init_gpu: using (\S+) backend/.exec(line)?.[1];
        const named = word === undefined ? null : /^([A-Za-z]+)(\d{0,4})$/.exec(word);
        if (named) {
          const list = LIST_OF_BACKEND.get(named[1].toLowerCase());
          opened = list ? { list, index: named[2] === "" ? null : Number(named[2]) } : null;
        }
      }
    } else if (
      stderr.startsWith("ggml_metal_init: GPU name:", from) ||
      stderr.startsWith("ggml_metal_device_init: GPU name:", from)
    ) {
      const line = stderr.slice(from, Math.min(to, from + 60 + NAME_CHARS));
      const head = /^ggml_metal(?:_device)?_init: GPU name:[ \t]*/.exec(line);
      if (head) keep("metal", 0, line.slice(head[0].length));
    } else {
      // CUDA and HIP indent their device lines: `  Device 0: NVIDIA GeForce RTX 3060, compute capability 8.6`.
      let start = from;
      while (start < to && (stderr[start] === " " || stderr[start] === "\t")) start++;
      if (stderr.startsWith("Device ", start)) {
        const line = stderr.slice(start, Math.min(to, start + 40 + NAME_CHARS));
        const device = /^Device (\d{1,4}): ([^,]*)/.exec(line);
        if (device) keep("cuda", Number(device[1]), device[2]);
      }
    }
    from = to + 1;
  }
  let name: string | undefined;
  if (opened === undefined) {
    const every = [...lists.vulkan.values(), ...lists.cuda.values(), ...lists.metal.values()];
    name = every.length === 1 ? every[0] : undefined;
  } else if (opened !== null) {
    const devices = lists[opened.list];
    if (opened.index !== null && devices.has(opened.index)) name = devices.get(opened.index);
    else if (devices.size === 1) name = [...devices.values()][0];
  }
  return name === undefined ? null : makerOfName(name);
}
