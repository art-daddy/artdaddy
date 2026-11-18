// whisper says on stderr which backend it ran on and how long it took (4i part 4). The fixtures are
// stderr captured from the shipped binary on this machine's Radeon (Vulkan), the same run forced onto
// the CPU (-ng), and the same run with -np (which hid everything: why the app stopped passing it),
// with only the paths replaced. Windows' stderr ends lines with CRLF and the others' with LF: every
// fixture is read both ways.
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  GPU_MAKERS,
  backendFamily,
  gpuMakerOf,
  whisperRunFacts,
  type GpuMaker,
} from "./whisperFacts";

const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "__fixtures__", "whisper", `${name}.stderr.txt`), "utf8");
const lf = (s: string): string => s.replace(/\r\n/g, "\n");
const both = (s: string): string[] => [lf(s), lf(s).replace(/\n/g, "\r\n")];

describe("what a run of whisper says about itself", () => {
  it("on the GPU: Vulkan, the audio's length and its own time", () => {
    for (const s of both(fixture("vulkan")))
      expect(whisperRunFacts(s)).toEqual({
        backend: "vulkan",
        audioSeconds: 171562 / 16000,
        wallSeconds: 2.72378,
        model: "small",
        threads: 8,
        gpu: "amd",
      });
  });

  it("on the CPU, when there is no GPU to use", () => {
    for (const s of both(fixture("cpu")))
      expect(whisperRunFacts(s)).toEqual({
        backend: "cpu",
        audioSeconds: 171562 / 16000,
        wallSeconds: 6.03789,
        model: "small",
        threads: 8,
      });
  });

  it("on the CPU, when the GPU it found would not start", () => {
    const failed = lf(fixture("vulkan")).replace(
      "whisper_backend_init_gpu: using Vulkan0 backend\n",
      "whisper_backend_init_gpu: using Vulkan0 backend\n" +
        "whisper_backend_init_gpu: failed to initialize Vulkan0 backend\n",
    );
    expect(failed).not.toBe(lf(fixture("vulkan")));
    expect(whisperRunFacts(failed).backend).toBe("cpu");
  });

  it("nothing at all with -np: a Vulkan library loading is not the model running on it", () => {
    const quiet = lf(fixture("no-prints"));
    expect(quiet).toMatch(/loaded Vulkan backend/);
    expect(whisperRunFacts(quiet)).toEqual({
      backend: null,
      audioSeconds: null,
      wallSeconds: null,
      model: null,
      threads: null,
    });
  });

  it("reads a path with spaces and quotes in it, and a thread count past 9", () => {
    const odd = lf(fixture("vulkan"))
      .replace(
        /main: processing '[^']*'/,
        "main: processing 'C:\\Users\\O'Brien (work)\\clip 1.wav'",
      )
      .replace("), 8 threads", "), 16 threads");
    expect(whisperRunFacts(odd)).toMatchObject({ audioSeconds: 171562 / 16000, threads: 16 });
  });

  it("keeps a device name it cannot read as it is", () => {
    expect(backendFamily("0x1F")).toBe("0x1f");
  });

  it.each([
    ["Vulkan0", "vulkan"],
    ["Vulkan1", "vulkan"],
    ["MTL0", "metal"],
    ["Metal", "metal"],
    ["CUDA0", "cuda"],
    ["SYCL0", "sycl"],
  ])("names the device %s by its backend, %s", (device, family) => {
    expect(backendFamily(device)).toBe(family);
    const s = lf(fixture("vulkan")).replace(/Vulkan0 backend/, `${device} backend`);
    expect(whisperRunFacts(s).backend).toBe(family);
  });

  it("property: anything at all reads as known facts or none, never a wrong number", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const f = whisperRunFacts(s);
        for (const n of [f.audioSeconds, f.wallSeconds, f.threads])
          expect(n === null || (Number.isFinite(n) && n >= 0)).toBe(true);
      }),
    );
  });

  it("property: what is printed around a run's lines changes nothing", () => {
    const run = lf(fixture("vulkan"));
    const facts = whisperRunFacts(run);
    const noise = fc.string().map((s) => s.replace(/[w:]/g, "")); // cannot spell a whisper line
    fc.assert(
      fc.property(noise, noise, (before, after) => {
        expect(whisperRunFacts(`${before}\n${run}\n${after}`)).toEqual(facts);
      }),
    );
  });
});

// One run over several files (T-34 step 3). The capture is the shipped engine reading three short clips
// in a single process: a line for each file, one total for all of them.
describe("a batch: one run over several files", () => {
  const SAMPLES = [70061, 76779, 68541];

  it("reads the audio of every file against the run's own time", () => {
    for (const s of both(fixture("batch3")))
      expect(whisperRunFacts(s, { batch: true })).toEqual({
        backend: "vulkan",
        audioSeconds: (SAMPLES[0] + SAMPLES[1] + SAMPLES[2]) / 16000,
        wallSeconds: 2.41897,
        model: "small",
        threads: 6,
        gpu: "amd",
      });
  });

  it("a batch of one is read like a single file", () => {
    const one = lf(fixture("vulkan"));
    expect(whisperRunFacts(one, { batch: true })).toEqual(whisperRunFacts(one));
  });

  it("a file the engine could not read prints no line and adds nothing", () => {
    const run = lf(fixture("batch3"));
    const without = run.replace(/main: processing 'W:\\b\.wav'[^\n]*\n/, "");
    expect(without).not.toBe(run);
    expect(whisperRunFacts(without, { batch: true }).audioSeconds).toBe(
      (SAMPLES[0] + SAMPLES[2]) / 16000,
    );
  });

  it("is unknown, never short, when the middle of the output was elided", () => {
    const run = lf(fixture("batch3"));
    const elided = run.replace(
      /main: processing 'W:\\b\.wav'[^\n]*\n/,
      "\n…[1234 bytes elided]…\n",
    );
    expect(elided).not.toBe(run);
    expect(whisperRunFacts(elided, { batch: true }).audioSeconds).toBeNull();
    // the rest of what it said is still true of the run
    expect(whisperRunFacts(elided, { batch: true })).toMatchObject({
      backend: "vulkan",
      wallSeconds: 2.41897,
    });
  });

  it("property: the audio is the sum of the files, whatever number there are", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 8 }),
        (samples) => {
          const lines = samples.map(
            (n, i) =>
              `main: processing 'W:\\f${i}.wav' (${n} samples, ${(n / 16000).toFixed(1)} sec), 6 threads, 1 processors, 1 beams + best of 1, lang = en, task = transcribe, timestamps = 1 ...`,
          );
          const run = [
            "whisper_backend_init_gpu: using Vulkan0 backend",
            ...lines,
            "whisper_print_timings:    total time =  1000.00 ms",
          ].join("\n");
          expect(whisperRunFacts(run, { batch: true }).audioSeconds).toBe(
            samples.reduce((a, b) => a + b, 0) / 16000,
          );
        },
      ),
    );
  });
});

// The maker of the graphics chip a run used: the one word the speech sample carries for it (`gpu=`). The engine lists
// the devices it found and says which one it opened; the maker is read from THAT device's own line, to one of five
// words, and nothing of the line (its name, its driver, its number) is kept. The lines below are the shapes the
// engine's backends print: Vulkan `n = name (driver) | facts`, CUDA and HIP `  Device n: name, facts`, Metal
// `GPU name: name`.

type NamedMaker = Exclude<GpuMaker, "other">;
/** What the sample's spec says, written here and not read from the reader: the makers in the order they are tried
 *  (the first with a word in the name wins) and the whole words of a name that say each of them. Keyed by the
 *  makers, so a new maker does not compile until this table has its words. */
const MAKERS_IN_ORDER: readonly NamedMaker[] = ["nvidia", "amd", "intel", "apple"];
const VENDOR_WORDS: Record<NamedMaker, string[]> = {
  nvidia: ["nvidia", "geforce", "quadro", "tesla", "titan", "rtx", "gtx"],
  amd: ["amd", "radeon", "ati"],
  intel: ["intel"],
  apple: ["apple"],
};
const ALL_VENDOR_WORDS = MAKERS_IN_ORDER.flatMap((maker) => VENDOR_WORDS[maker]);
const casings = (word: string): string[] => [
  word,
  word.toUpperCase(),
  word[0].toUpperCase() + word.slice(1),
];

const vulkanLine = (n: number, nameAndDriver: string): string =>
  `ggml_vulkan: ${n} = ${nameAndDriver} | uma: 1 | fp16: 1 | bf16: 1 | fp4: 0 | warp size: 64 | shared memory: 32768 | int dot: 1 | matrix cores: KHR_coopmat`;
const vulkanListing = (...devices: string[]): string[] => [
  `ggml_vulkan: Found ${devices.length} Vulkan devices:`,
  ...devices.map((device, n) => vulkanLine(n, device)),
];
const cudaListing = (library: "CUDA" | "ROCm", ...devices: string[]): string[] => [
  "ggml_cuda_init: GGML_CUDA_FORCE_MMQ:    no",
  "ggml_cuda_init: GGML_CUDA_FORCE_CUBLAS: no",
  `ggml_cuda_init: found ${devices.length} ${library} devices:`,
  ...devices.map((device, n) => `  Device ${n}: ${device}`),
];
const metalListing = (found: string[], opened: string): string[] => [
  "ggml_metal_init: allocating",
  ...found.map((name) => `ggml_metal_init: found device: ${name}`),
  `ggml_metal_init: picking default device: ${opened}`,
  `ggml_metal_init: GPU name:   ${opened}`,
  "ggml_metal_init: GPU family: MTLGPUFamilyApple8  (1008)",
  "ggml_metal_init: GPU family: MTLGPUFamilyCommon3 (3003)",
];

/** The capture of the Vulkan run from the first line the engine prints about a backend's devices (the capture's own
 *  two lines of them are not here): everything after them is the engine's, as it printed it. */
const AFTER_THE_DEVICES = lf(fixture("vulkan")).split("\n").slice(2).join("\n");

/** That capture with another engine's device lines, the device it opened and the library it loaded put in. */
function runOn(listing: string[], opened: string, library = "Vulkan"): string {
  let body = AFTER_THE_DEVICES.replace(/Vulkan0/g, opened);
  body = body.replace("loaded Vulkan backend", `loaded ${library} backend`);
  body = body.replace("ggml-vulkan.dll", `ggml-${library.toLowerCase()}.dll`);
  return `${listing.join("\n")}\n${body}`;
}

type Way = "vulkan" | "cuda" | "hip" | "metal";
/** A run on one device, listed the way `way` lists it. CUDA and HIP print facts after the name, Vulkan after the driver. */
function runWith(way: Way, name: string): string {
  switch (way) {
    case "vulkan":
      return runOn(vulkanListing(name), "Vulkan0");
    case "cuda":
      return runOn(
        cudaListing("CUDA", `${name}, compute capability 8.6, VMM: yes`),
        "CUDA0",
        "CUDA",
      );
    case "hip":
      return runOn(
        cudaListing("ROCm", `${name}, gfx1100 (0x1100), VMM: no, Wave Size: 32`),
        "ROCm0",
        "ROCm",
      );
    case "metal":
      return runOn(metalListing([name], name), "MTL0", "Metal");
  }
}

/** [how the engine lists the device, the name it prints, the maker a person would name]. For Vulkan the name is the
 *  text before the first `|`, its driver included; for CUDA and HIP the text before the first comma; for Metal the
 *  whole name. */
const DEVICES: [Way, string, GpuMaker][] = [
  ["vulkan", "AMD Radeon(TM) 780M (AMD proprietary driver)", "amd"],
  ["vulkan", "AMD Radeon RX 7900 XTX (RADV NAVI31) (radv)", "amd"],
  ["vulkan", "AMD Radeon Graphics (RADV RAPHAEL_MENDOCINO) (radv)", "amd"],
  ["vulkan", "ATI Radeon HD 4850 (AMD proprietary driver)", "amd"],
  ["hip", "AMD Radeon RX 7900 XTX", "amd"],
  ["hip", "AMD Instinct MI300X", "amd"],
  ["vulkan", "NVIDIA GeForce RTX 4070 (NVIDIA)", "nvidia"],
  ["vulkan", "NVIDIA GeForce GTX 1650 with Max-Q Design (NVIDIA)", "nvidia"],
  ["vulkan", "NVIDIA TITAN Xp (NVIDIA)", "nvidia"],
  ["cuda", "NVIDIA GeForce RTX 3060", "nvidia"],
  ["cuda", "Quadro T1000", "nvidia"],
  ["cuda", "Tesla T4", "nvidia"],
  ["vulkan", "Intel(R) UHD Graphics 770 (Intel Corporation)", "intel"],
  ["vulkan", "Intel(R) Arc(TM) A770 Graphics (Intel open-source Mesa driver)", "intel"],
  ["vulkan", "Intel(R) Iris(R) Xe Graphics (Intel Corporation)", "intel"],
  ["metal", "Apple M2 Pro", "apple"],
  ["vulkan", "llvmpipe (LLVM 17.0.6, 256 bits) (Mesa)", "other"],
  ["vulkan", "Microsoft Basic Render Driver (Microsoft Corporation)", "other"],
  [
    "vulkan",
    "Qualcomm(R) Adreno(TM) 730 (Qualcomm Technologies Inc. Adreno Vulkan Driver)",
    "other",
  ],
  ["vulkan", "Mali-G78 (ARM proprietary)", "other"],
];

const IGPU = "AMD Radeon(TM) Graphics (AMD proprietary driver)";
const DGPU = "NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA)";
const INTEL_IGPU = "Intel(R) UHD Graphics 770 (Intel Corporation)";

describe("the maker of the graphics chip a run used", () => {
  it.each(DEVICES)("%s: %s is %s", (way, name, maker) => {
    for (const run of both(runWith(way, name))) {
      expect(gpuMakerOf(run)).toBe(maker);
      expect(whisperRunFacts(run).gpu).toBe(maker);
    }
  });

  it("on a Mac with two chips: the one Metal opened, not the first it found", () => {
    const found = ["Intel(R) UHD Graphics 630", "AMD Radeon Pro 5500M"];
    // the engine's lines are `ggml_metal_init:` in one release and `ggml_metal_device_init:` in the next
    for (const prefix of ["ggml_metal_init", "ggml_metal_device_init"]) {
      const listed = runOn(metalListing(found, found[1]), "MTL0", "Metal");
      const run = listed.replaceAll("ggml_metal_init", prefix);
      expect(run).toContain(`${prefix}: GPU name:   AMD Radeon Pro 5500M`);
      expect(gpuMakerOf(run)).toBe("amd");
    }
  });

  it("with two devices: the one the engine opened, whichever is listed first", () => {
    const cases: [string[], string, GpuMaker][] = [
      [[IGPU, DGPU], "Vulkan0", "amd"],
      [[IGPU, DGPU], "Vulkan1", "nvidia"],
      [[DGPU, IGPU], "Vulkan0", "nvidia"],
      [[DGPU, IGPU], "Vulkan1", "amd"],
    ];
    for (const [listed, opened, maker] of cases)
      for (const run of both(runOn(vulkanListing(...listed), opened))) {
        expect(gpuMakerOf(run), `${opened} of ${listed.length}`).toBe(maker);
        expect(whisperRunFacts(run).gpu).toBe(maker);
      }
  });

  it("compares the device's number whole: device 1 is not device 10", () => {
    const devices = Array.from({ length: 11 }, (_, n) =>
      n === 1 ? INTEL_IGPU : n === 10 ? DGPU : IGPU,
    );
    expect(gpuMakerOf(runOn(vulkanListing(...devices), "Vulkan10"))).toBe("nvidia");
    expect(gpuMakerOf(runOn(vulkanListing(...devices), "Vulkan1"))).toBe("intel");
    expect(gpuMakerOf(runOn(vulkanListing(...devices), "Vulkan0"))).toBe("amd");
  });

  it("a number that matches nothing: the one device listed, or no maker when there are several", () => {
    expect(gpuMakerOf(runOn(vulkanListing(DGPU), "Vulkan3"))).toBe("nvidia");
    const several = runOn(vulkanListing(IGPU, DGPU), "Vulkan7");
    expect(gpuMakerOf(several)).toBeNull();
    // the run still ran on a graphics chip: it is the maker that is not known
    const facts = whisperRunFacts(several);
    expect(facts.backend).toBe("vulkan");
    expect("gpu" in facts).toBe(false);
  });

  it("with no line saying which device it opened: the one device listed, or no maker for several", () => {
    const unsaid = (run: string): string =>
      run.replace(/^whisper_backend_init_gpu: using .*\n/m, "");
    const one = runOn(vulkanListing(DGPU), "Vulkan0");
    expect(unsaid(one)).not.toBe(one);
    expect(gpuMakerOf(unsaid(one))).toBe("nvidia");
    expect(gpuMakerOf(unsaid(runOn(vulkanListing(IGPU, DGPU), "Vulkan1")))).toBeNull();
    // and a run that does not say what it ran on has no maker, though its chip is listed
    expect("gpu" in whisperRunFacts(unsaid(one))).toBe(false);
  });

  it("a backend whose device list is not read has no maker, whatever else is listed; a word it cannot read is as if nothing was said", () => {
    const listed = vulkanListing(DGPU);
    // SYCL opened a device of its own: the Vulkan chip that is listed is not the one that ran
    expect(gpuMakerOf(runOn(listed, "SYCL0"))).toBeNull();
    // the names every object has are words like any other, never a way into the tables of the reader
    for (const word of ["constructor", "toString", "hasOwnProperty", "valueOf"])
      expect(() => gpuMakerOf(runOn(listed, `${word}0`)), word).not.toThrow();
    expect(gpuMakerOf(runOn(listed, "constructor0"))).toBeNull();
    // no letters to read a backend from, or a number of five digits: unreadable, so the one chip listed is the answer
    for (const word of ["__proto__", "0", "Vulkan12345"])
      expect(gpuMakerOf(runOn(listed, word)), word).toBe("nvidia");
    expect(gpuMakerOf(runOn(vulkanListing(IGPU, DGPU), "Vulkan12345"))).toBeNull();
  });

  it("reads each backend's own list: Vulkan's first device is not CUDA's", () => {
    const hybrid = [
      ...vulkanListing(INTEL_IGPU, DGPU),
      ...cudaListing(
        "CUDA",
        "NVIDIA GeForce RTX 4060 Laptop GPU, compute capability 8.9, VMM: yes",
      ),
    ];
    const run = (opened: string, lines = hybrid): string => runOn(lines, opened, "CUDA");
    expect(gpuMakerOf(run("CUDA0"))).toBe("nvidia");
    expect(gpuMakerOf(run("Vulkan0"))).toBe("intel");
    expect(gpuMakerOf(run("Vulkan1"))).toBe("nvidia");
    // whichever list comes first
    const cudaFirst = [...hybrid.slice(2 + 1), ...hybrid.slice(0, 2 + 1)];
    expect(gpuMakerOf(run("CUDA0", cudaFirst))).toBe("nvidia");
    expect(gpuMakerOf(run("Vulkan0", cudaFirst))).toBe("intel");
  });

  it("no device line to read, no maker", () => {
    const unlisted = lf(fixture("vulkan")).replace(/^ggml_vulkan: .*\n/gm, "");
    expect(unlisted).not.toMatch(/ggml_vulkan/);
    expect(gpuMakerOf(unlisted)).toBeNull();
    const facts = whisperRunFacts(unlisted);
    expect(facts.backend).toBe("vulkan");
    expect("gpu" in facts).toBe(false);
    for (const empty of ["", "\n", "ggml_vulkan: Found 0 Vulkan devices:\n"])
      expect(gpuMakerOf(empty)).toBeNull();
  });

  it("reads only the name: what follows the first | or the first comma is facts", () => {
    const vendors = "NVIDIA AMD Intel Apple";
    const vulkan = runOn(
      [`ggml_vulkan: 0 = Mali-G78 (ARM proprietary) | note: ${vendors}`],
      "Vulkan0",
    );
    expect(gpuMakerOf(vulkan)).toBe("other");
    const cuda = cudaListing("CUDA", `Mali-G78, compute capability 8.6, VMM: yes, ${vendors}`);
    expect(gpuMakerOf(runOn(cuda, "CUDA0", "CUDA"))).toBe("other");
    // Metal prints the name alone on its line, so the whole line is the name
    expect(gpuMakerOf(runOn(metalListing([], "Mali-G78, Intel"), "MTL0", "Metal"))).toBe("intel");
  });

  it("a file name or a path is never read as a device", () => {
    const named = (path: string): string =>
      lf(fixture("vulkan")).replace(/main: processing '[^']*'/, () => `main: processing '${path}'`);
    const spelled = [
      "/Users/me/ggml_vulkan: 0 = NVIDIA GeForce RTX 4090 | x.wav",
      "/Users/me/Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9.wav",
      "/Users/me/ggml_metal_init: GPU name:   NVIDIA GeForce RTX 4090.wav",
    ];
    for (const path of spelled) {
      const run = named(path);
      expect(run).toContain(path);
      // the real device line still decides...
      expect(gpuMakerOf(run)).toBe("amd");
      // ...and with it gone there is nothing to read
      expect(gpuMakerOf(run.replace(/^ggml_vulkan: .*\n/gm, ""))).toBeNull();
    }
  });

  it("is reported for the run that used the chip, not for a run that only saw it", () => {
    const failed = lf(fixture("vulkan")).replace(
      "whisper_backend_init_gpu: using Vulkan0 backend\n",
      "whisper_backend_init_gpu: using Vulkan0 backend\n" +
        "whisper_backend_init_gpu: failed to initialize Vulkan0 backend\n",
    );
    const sawOnly = [fixture("cpu"), fixture("no-prints"), failed].map(lf);
    for (const run of sawOnly) {
      // the engine did print the chip's line: it is the run's backend that says the chip was not used
      expect(run).toMatch(/^ggml_vulkan: 0 = AMD Radeon/m);
      for (const s of both(run)) expect("gpu" in whisperRunFacts(s)).toBe(false);
    }
    expect(whisperRunFacts(failed).backend).toBe("cpu");
    expect(whisperRunFacts(lf(fixture("no-prints"))).backend).toBeNull();
    for (const s of both(fixture("vulkan"))) expect(whisperRunFacts(s).gpu).toBe("amd");
  });

  it("a batch run reads the same maker as a single run of the same engine", () => {
    const single = whisperRunFacts(lf(fixture("vulkan")));
    for (const s of both(fixture("batch3"))) {
      const batch = whisperRunFacts(s, { batch: true });
      expect(batch.gpu).toBe("amd");
      expect(batch.gpu).toBe(single.gpu);
    }
    // a batch whose middle was elided still has its chip's line at the top
    const elided = lf(fixture("batch3")).replace(
      /main: processing 'W:\\b\.wav'[^\n]*\n/,
      "\n…[1234 bytes elided]…\n",
    );
    expect(elided).toContain("elided");
    expect(whisperRunFacts(elided, { batch: true }).gpu).toBe("amd");
  });

  describe("the words", () => {
    it.each(
      MAKERS_IN_ORDER.flatMap((maker) =>
        VENDOR_WORDS[maker].map((word): [string, NamedMaker] => [word, maker]),
      ),
    )("the word %s alone is %s, in any case and in each way of listing a device", (word, maker) => {
      for (const cased of casings(word))
        for (const way of ["vulkan", "cuda", "hip", "metal"] as const)
          expect(gpuMakerOf(runWith(way, `Xyz ${cased} 100 (driver)`)), `${way} ${cased}`).toBe(
            maker,
          );
    });

    it("a word inside a longer word is not a word", () => {
      for (const word of ALL_VENDOR_WORDS)
        for (const name of [`x${word}`, `${word}x`, `x${word}x`, `Pine${word}`])
          expect(gpuMakerOf(runWith("vulkan", name)), name).toBe("other");
    });

    it("the first maker in the order nvidia, amd, intel, apple wins, wherever its word is in the name", () => {
      for (let hi = 0; hi < MAKERS_IN_ORDER.length; hi++)
        for (let lo = hi + 1; lo < MAKERS_IN_ORDER.length; lo++) {
          const high = VENDOR_WORDS[MAKERS_IN_ORDER[hi]][0];
          const low = VENDOR_WORDS[MAKERS_IN_ORDER[lo]][0];
          for (const name of [`${high} ${low} X1`, `${low} ${high} X1`])
            expect(gpuMakerOf(runWith("vulkan", name)), name).toBe(MAKERS_IN_ORDER[hi]);
        }
    });

    it("conformance: every word of the list can be the answer, and every vendor word is in a row", () => {
      expect([...GPU_MAKERS]).toEqual(["amd", "nvidia", "intel", "apple", "other"]);
      expect(new Set(DEVICES.map(([, , maker]) => maker))).toEqual(new Set(GPU_MAKERS));
      for (const maker of MAKERS_IN_ORDER)
        for (const word of VENDOR_WORDS[maker])
          expect(
            DEVICES.some(
              ([, name, m]) =>
                m === maker && new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(name),
            ),
            `a row names ${maker} by ${word}`,
          ).toBe(true);
    });

    it("property: the maker is the first of the order with a word in the name, whatever else the name says", () => {
      const filler = fc.constantFrom(
        ...[
          "Graphics",
          "Series",
          "Laptop",
          "GPU",
          "Pro",
          "Max",
          "Design",
          "RADV",
          "NAVI31",
          "Mesa",
        ],
        ...[
          "driver",
          "Corporation",
          "open-source",
          "proprietary",
          "Adreno",
          "Mali-G78",
          "llvmpipe",
        ],
        ...["780M", "7900", "XTX", "A770", "M2", "(R)", "(TM)", "X1", "Xe"],
      );
      const vendor = fc
        .constantFrom(...ALL_VENDOR_WORDS)
        .chain((word) => fc.constantFrom(...casings(word)));
      const separator = fc.constantFrom(" ", "-", "/", "_", ". ", " (", ") ");
      const name = fc
        .array(fc.tuple(fc.oneof(filler, filler, vendor), separator), {
          minLength: 1,
          maxLength: 9,
        })
        .map((parts) => parts.map(([word, sep]) => word + sep).join(""));
      fc.assert(
        fc.property(name, fc.constantFrom<Way>("vulkan", "cuda", "hip", "metal"), (text, way) => {
          const words: string[] = text.toLowerCase().match(/[a-z]+/g) ?? [];
          const maker =
            MAKERS_IN_ORDER.find((m) => VENDOR_WORDS[m].some((w) => words.includes(w))) ?? "other";
          expect(gpuMakerOf(runWith(way, text))).toBe(maker);
        }),
      );
    });
  });

  describe("what can be read from any text at all", () => {
    const POOL = [
      ...lf(fixture("vulkan")).split("\n"),
      ...lf(fixture("cpu")).split("\n"),
      ...runOn(vulkanListing(IGPU, DGPU), "Vulkan1").split("\n"),
      ...runWith("cuda", "NVIDIA GeForce RTX 3060").split("\n"),
      ...runWith("metal", "Apple M2 Pro").split("\n"),
      "whisper_backend_init_gpu: failed to initialize Vulkan1 backend",
      "whisper_backend_init_gpu: no GPU found",
    ];
    const soup = fc
      .array(fc.constantFrom(...POOL), { maxLength: 40 })
      .map((lines) => lines.join("\n"));

    it("property: a word of the list or none, and a word in the facts only for a run on a chip", () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.string(), fc.string({ unit: "binary" }), soup),
          fc.boolean(),
          (text, batch) => {
            const maker = gpuMakerOf(text);
            expect(maker === null || GPU_MAKERS.includes(maker)).toBe(true);
            // the line ending makes no difference
            expect(gpuMakerOf(text.replace(/\n/g, "\r\n"))).toBe(maker);
            const facts = whisperRunFacts(text, { batch });
            const onChip = facts.backend !== null && facts.backend !== "cpu";
            if (onChip && maker !== null) expect(facts.gpu).toBe(maker);
            else expect("gpu" in facts).toBe(false);
          },
        ),
      );
    });

    it("property: whatever a device is called, nothing of its name comes out, only its maker's word", () => {
      const standIn: Record<GpuMaker, string> = {
        amd: "AMD Radeon(TM) 780M (AMD proprietary driver)",
        nvidia: "NVIDIA GeForce RTX 4070 (NVIDIA)",
        intel: INTEL_IGPU,
        apple: "Apple M2 (MoltenVK)",
        other: "Mali-G78 (ARM proprietary)",
      };
      const names = fc.oneof(
        fc.string({ unit: "binary", maxLength: 200 }),
        fc.string({ maxLength: 3000 }),
        fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.repeat(1500)),
        fc.emailAddress(),
        fc.webUrl(),
        fc.constantFrom("", "\n", "\r\n", "|", "||", ",", "\u0000", "\u2028", "İntel", "NVİDIA"),
        fc.constantFrom(
          "C:\\Users\\bob\\Videos\\clip 1.mp4",
          "/home/bob/clip.wav",
          "bob@example.com",
        ),
      );
      fc.assert(
        fc.property(names, fc.constantFrom<Way>("vulkan", "cuda", "metal"), (name, way) => {
          const facts = whisperRunFacts(runWith(way, name));
          expect(GPU_MAKERS).toContain(facts.gpu);
          // the same run on a device that is only called what its maker is called says exactly the same
          expect(facts).toEqual(whisperRunFacts(runWith(way, standIn[facts.gpu as GpuMaker])));
        }),
      );
    });
  });

  describe("megabytes of log", () => {
    const FIVE_MB = 5 * 1024 * 1024;
    const FILLER = "whisper_init_state: compute buffer (conv)   =   23.38 MB\n";
    const bulk = FILLER.repeat(Math.ceil(FIVE_MB / FILLER.length / 2));
    const timed = <T>(read: () => T): [T, number] => {
      const start = performance.now();
      const result = read();
      return [result, performance.now() - start];
    };

    it("is read in a fraction of a second: five megabytes of lines with one device line in them", () => {
      const listing = vulkanListing(IGPU).join("\n");
      const run = `${bulk}${listing}\nwhisper_backend_init_gpu: using Vulkan0 backend\n${bulk}`;
      expect(run.length).toBeGreaterThan(FIVE_MB);
      const [maker, ms] = timed(() => gpuMakerOf(run));
      expect(maker).toBe("amd");
      expect(ms).toBeLessThan(2000);
      const [facts, factsMs] = timed(() => whisperRunFacts(run));
      expect(facts.gpu).toBe("amd");
      expect(factsMs).toBeLessThan(2000);
    });

    it.each([
      ["one line of spaces", " ".repeat(FIVE_MB)],
      ["blank lines", "\n".repeat(FIVE_MB)],
      ["spaces and tabs, then a device line", `${"\t ".repeat(FIVE_MB / 2)}Device 0: x, y`],
      ["device prefixes with no end", "ggml_vulkan: 0 = ".repeat(FIVE_MB / 17)],
      ["CUDA prefixes with no end", "Device 0: ".repeat(FIVE_MB / 10)],
      ["opened-device prefixes", "whisper_backend_init_gpu: using ".repeat(FIVE_MB / 32)],
      ["a device number of five million digits", `ggml_vulkan: ${"1".repeat(FIVE_MB)} = x`],
      [
        "an opened device of five million digits",
        `whisper_backend_init_gpu: using V${"1".repeat(FIVE_MB)}x backend`,
      ],
      ["a name of five megabytes", `ggml_vulkan: 0 = ${"a".repeat(FIVE_MB)}`],
      ["a name of near-misses", `ggml_vulkan: 0 = ${"amdx ".repeat(FIVE_MB / 5)}`],
      ["a Metal name of five megabytes", `ggml_metal_init: GPU name: ${"i".repeat(FIVE_MB)}`],
      ["the same device line over and over", "ggml_vulkan: 1 = x\n".repeat(FIVE_MB / 19)],
    ])("is read in a fraction of a second: %s", (_shape, text) => {
      const [, ms] = timed(() => gpuMakerOf(text));
      expect(ms).toBeLessThan(2000);
    });
  });
});
