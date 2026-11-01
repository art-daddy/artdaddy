import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CPU_ONLY_HOLD_MS,
  cpuOnlyNow,
  holdCpuOnly,
  isCrash,
  isGpuCrash,
  releaseCpuOnly,
  SPEECH_CPU_ONLY_KEY,
  WINDOWS_LOAD_FAILURES,
} from "./speechBackend";

/** A storage that keeps what it is given, under any key. */
function memory() {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
}

const VULKAN = "ggml_vulkan: Found 1 Vulkan devices:\nggml_vulkan: 0 = AMD Radeon(TM) Graphics";

describe("what counts as a crash", () => {
  it("is the process dying: a Windows error status, no exit code, or a shell's 128 + signal", () => {
    expect(isCrash(-1073740791)).toBe(true); // 0xC0000409, the one seen
    expect(isCrash(-1073741819)).toBe(true); // 0xC0000005, an access violation
    expect(isCrash(null)).toBe(true);
    expect(isCrash(139)).toBe(true); // 128 + SIGSEGV
    expect(isCrash(134)).toBe(true); // 128 + SIGABRT
  });

  it("is not a program that finished badly, or Stop", () => {
    for (const code of [0, 1, 2, 3, 127, 128, 255, -1, 100_000])
      expect(isCrash(code), String(code)).toBe(false);
  });

  it("is every Windows error status and no ordinary exit status", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (low) => {
        expect(isCrash(0xc0000000 + low - 2 ** 32)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 127 }), (code) => {
        expect(isCrash(code)).toBe(false);
      }),
    );
  });
});

describe("what counts as the GPU's crash", () => {
  it("is a crash after the engine named a GPU", () => {
    expect(isGpuCrash({ code: -1073740791, stderr: VULKAN })).toBe(true);
    expect(isGpuCrash({ code: null, stderr: "ggml_metal_init: allocating" })).toBe(true);
    expect(isGpuCrash({ code: 139, stderr: "ggml_cuda_init: found 1 CUDA devices" })).toBe(true);
  });

  it("is not a crash that never named a GPU", () => {
    expect(isGpuCrash({ code: -1073740791, stderr: "" })).toBe(false);
    expect(isGpuCrash({ code: -1073740791, stderr: "whisper_init_from_file: loading model" })).toBe(
      false,
    );
  });

  it("is not a failure to start at all, whatever the log says", () => {
    for (const code of WINDOWS_LOAD_FAILURES)
      expect(isGpuCrash({ code, stderr: VULKAN }), String(code)).toBe(false);
  });

  it("is not an ordinary failure, or a cancelled run, on a GPU", () => {
    for (const code of [1, 2, 3, 0, -1])
      expect(isGpuCrash({ code, stderr: VULKAN }), String(code)).toBe(false);
  });
});

describe("the GPU being off", () => {
  it("is on for a week after it was put, to the millisecond, and then off", () => {
    const store = memory();
    expect(cpuOnlyNow(1_000, store)).toBe(false);
    holdCpuOnly(-1073740791, 1_000, store);
    expect(cpuOnlyNow(1_000, store)).toBe(true);
    expect(cpuOnlyNow(1_000 + CPU_ONLY_HOLD_MS - 1, store)).toBe(true);
    expect(cpuOnlyNow(1_000 + CPU_ONLY_HOLD_MS, store)).toBe(false);
    expect(CPU_ONLY_HOLD_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("can be let go", () => {
    const store = memory();
    holdCpuOnly(null, 1_000, store);
    releaseCpuOnly(store);
    expect(cpuOnlyNow(1_001, store)).toBe(false);
  });

  it("reads whatever is in storage as a hold or as none, and never throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json().map((j) => JSON.stringify(j)),
        ),
        (raw) => {
          const store = memory();
          store.kept.set(SPEECH_CPU_ONLY_KEY, raw);
          expect(typeof cpuOnlyNow(1_000, store)).toBe("boolean");
        },
      ),
    );
    const store = memory();
    for (const odd of [
      { until: "9999999999999" },
      { until: null },
      { until: NaN },
      [],
      7,
      "x",
      null,
    ]) {
      store.kept.set(SPEECH_CPU_ONLY_KEY, JSON.stringify(odd));
      expect(cpuOnlyNow(1_000, store), JSON.stringify(odd)).toBe(false);
    }
  });

  it("is no hold, and no error, where the storage throws or is missing", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(cpuOnlyNow(1_000, hostile)).toBe(false);
    expect(() => holdCpuOnly(1, 1_000, hostile)).not.toThrow();
    expect(() => releaseCpuOnly(hostile)).not.toThrow();
    expect(cpuOnlyNow(1_000, null)).toBe(false);
    expect(() => holdCpuOnly(1, 1_000, null)).not.toThrow();
  });
});
