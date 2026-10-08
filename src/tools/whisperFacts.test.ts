// whisper says on stderr which backend it ran on and how long it took (4i part 4). The fixtures are
// stderr captured from the shipped binary on this machine's Radeon (Vulkan), the same run forced onto
// the CPU (-ng), and the same run with -np (which hid everything: why the app stopped passing it),
// with only the paths replaced. Windows' stderr ends lines with CRLF and the others' with LF: every
// fixture is read both ways.
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { backendFamily, whisperRunFacts } from "./whisperFacts";

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
