import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
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

const HOUR_MS = 60 * 60 * 1000;
/** The release string the test build carries (vitest.config.ts defines it). */
const VERSION = __ARTDADDY_RELEASE__;

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
  beforeEach(() => __resetExportFlags());
  afterEach(() => __resetExportFlags());

  /** What a hold looks like in storage, whoever wrote it. */
  const put = (store: ReturnType<typeof memory>, record: unknown): void =>
    void store.kept.set(SPEECH_CPU_ONLY_KEY, JSON.stringify(record));

  it("is on for six hours after it was put, to the millisecond, and then off", () => {
    const store = memory();
    expect(cpuOnlyNow(1_000, store)).toBe(false);
    holdCpuOnly(-1073740791, 1_000, store);
    expect(cpuOnlyNow(1_000, store)).toBe(true);
    expect(cpuOnlyNow(1_000 + 6 * HOUR_MS - 1, store), "never earlier than six hours").toBe(true);
    expect(cpuOnlyNow(1_000 + 6 * HOUR_MS, store)).toBe(false);
    expect(cpuOnlyNow(1_000 + 7 * HOUR_MS, store), "not still on after seven hours").toBe(false);
  });

  it("is let go at once when the app is not the one that put it (an update)", () => {
    const store = memory();
    put(store, {
      since: 1_000,
      until: 1_000 + CPU_ONLY_HOLD_MS,
      code: 1,
      version: "artdaddy@0.0.0",
    });
    expect(cpuOnlyNow(1_001, store)).toBe(false);
    put(store, { since: 1_000, until: 1_000 + CPU_ONLY_HOLD_MS, code: 1, version: VERSION });
    expect(cpuOnlyNow(1_001, store), "the same app, within six hours").toBe(true);
  });

  it("lets a hold written by 0.27.0, which has no version and no 'since', go at the first run after the update", () => {
    const store = memory();
    const until = 5_000_000 + CPU_ONLY_HOLD_MS;
    put(store, { until, code: -1073740791 });
    expect(cpuOnlyNow(5_000_001, store), "an hour after it was written").toBe(false);
    expect(cpuOnlyNow(until - 1, store)).toBe(false);
  });

  it("still writes the seven-day 'until' an older app would read, beside since, code and version", () => {
    const store = memory();
    holdCpuOnly(-1073740791, 1_000, store);
    expect(JSON.parse(store.kept.get(SPEECH_CPU_ONLY_KEY)!)).toEqual({
      since: 1_000,
      until: 1_000 + 7 * 24 * HOUR_MS,
      code: -1073740791,
      version: VERSION,
    });
    expect(CPU_ONLY_HOLD_MS).toBe(7 * 24 * HOUR_MS);
  });

  it("with the remote switch off is the seven-day 'until', whatever the version or the hours", () => {
    __setExportFlag("speech_gpu_retry", false);
    const store = memory();
    holdCpuOnly(1, 1_000, store);
    expect(cpuOnlyNow(1_000 + 7 * HOUR_MS, store)).toBe(true);
    expect(cpuOnlyNow(1_000 + CPU_ONLY_HOLD_MS - 1, store)).toBe(true);
    expect(cpuOnlyNow(1_000 + CPU_ONLY_HOLD_MS, store)).toBe(false);
    put(store, {
      since: 1_000,
      until: 1_000 + CPU_ONLY_HOLD_MS,
      code: 1,
      version: "artdaddy@0.0.0",
    });
    expect(
      cpuOnlyNow(2_000, store),
      "another version does not release it while the switch is off",
    ).toBe(true);
    put(store, { until: 9_000_000 });
    expect(cpuOnlyNow(8_999_999, store), "a 0.27.0 hold is read as it always was").toBe(true);
    __setExportFlag("speech_gpu_retry", true);
    expect(cpuOnlyNow(8_999_999, store), "flipping the switch needs no rewrite of the hold").toBe(
      false,
    );
  });

  it("property: it is never released before the earlier of six hours and a new version, never kept past the seven days, and a release is final", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 20 * 24 }),
        fc.integer({ min: 0, max: 20 * 24 }),
        (since, sameVersion, hoursA, hoursB) => {
          const store = memory();
          put(store, {
            since,
            until: since + CPU_ONLY_HOLD_MS,
            code: 1,
            version: sameVersion ? VERSION : "artdaddy@other",
          });
          const [early, late] = hoursA <= hoursB ? [hoursA, hoursB] : [hoursB, hoursA];
          const at = (hours: number): boolean => cpuOnlyNow(since + hours * HOUR_MS, store);
          if (sameVersion && early < 6) expect(at(early), "released early").toBe(true);
          if (!sameVersion) expect(at(early), "a new version keeps it").toBe(false);
          if (late >= 6) expect(at(late), "kept past six hours").toBe(false);
          if (!at(early)) expect(at(late), "back on after a release").toBe(false);
        },
      ),
      { numRuns: 200 },
    );
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
      { until: 500, since: "x", version: 7 }, // out of date whatever the rest says
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
