// The first-word fix's pure rules: which launches get word times, where a token sits once its own sound time is
// used, and how the words of a transcript are settled. What is checked is the outcome of each rule for any input,
// not how it is computed: the one launch that carries the arguments is named, every other of the 32 is not.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __resetHostInfo, type HostOs } from "../platform/host";
import { MODEL_MANIFEST } from "./modelManifest";
import { WINDOWS_LOAD_FAILURES } from "./speechBackend";
import { LEADING_QUIET_MS, type VoiceStart } from "./speechLeadingQuiet";
import {
  __resetWordTimesShipped,
  __setWordTimesChipShipped,
  __setWordTimesShipped,
  DTW_ARGS,
  retryWithoutWordTimes,
  segmentFollowsWords,
  settleWords,
  tokenOnSound,
  WINDOW_MS,
  WORD_TIMES_CHIP_HOSTS,
  WORD_TIMES_CHIP_MODELS,
  WORD_TIMES_CHIP_SHIPPED,
  WORD_TIMES_MODELS,
  WORD_TIMES_SHIPPED,
  wordTimesArgs,
  wordTimesOn,
  wordTimesPossible,
} from "./speechWordTimes";

/** What the webview says on each kind of host (the app's own reading of it: platform/host.ts `osFromUserAgent`). */
const USER_AGENT: Record<HostOs, string> = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  macos:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  unknown: "SomeBrowser/1.0",
};
const HOSTS = Object.keys(USER_AGENT) as HostOs[];
const hostIs = (os: HostOs): void => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(USER_AGENT[os]);
  __resetHostInfo();
};

// The PC is a Windows one unless a test says otherwise: that is the host the graphics-chip path was measured on.
beforeEach(() => {
  __resetExportFlags();
  __resetWordTimesShipped();
  hostIs("windows");
});
afterEach(() => {
  __resetExportFlags();
  __resetWordTimesShipped();
  vi.restoreAllMocks();
  __resetHostInfo();
});

const SIZES = ["small", "base", "large", ""];
/** A voice that starts well after the quiet the rule allows. */
const LATE: VoiceStart = { kind: "at", ms: 2000 };
const arguments_ = (
  gate: boolean,
  flag: boolean,
  size: string,
  cpuOnly: boolean,
  voice: VoiceStart = LATE,
): string[] => {
  __setWordTimesShipped(gate);
  __setExportFlag("speech_word_times", flag);
  return wordTimesArgs({ size, cpuOnly, voice });
};

describe("which launches carry word times", () => {
  // The release decision: this commit arms the graphics chip (its constant and list, on Windows only) and still ships the
  // behaviour dark: the build's own gate is off. A release that turns it on changes that line on purpose, after the owner
  // has looked at real captions.
  it("ships dark: the build's own gate is off, so nothing carries them, on the chip's host too", () => {
    expect(WORD_TIMES_SHIPPED).toBe(false);
    expect(WORD_TIMES_CHIP_SHIPPED).toBe(true);
    expect(wordTimesOn()).toBe(false);
    for (const os of HOSTS) {
      hostIs(os);
      for (const size of SIZES)
        for (const cpuOnly of [true, false])
          expect(wordTimesArgs({ size, cpuOnly, voice: LATE }), `${os} ${size} ${cpuOnly}`).toEqual(
            [],
          );
    }
  });

  it("is ONE kind of launch of the 192 combinations of gate, flag, size, backend and where the voice starts: the processor, on the measured model, with both on, and a voice that starts more than a second in; and, on a Windows host only, the same on the graphics chip", () => {
    const voices: VoiceStart[] = [
      { kind: "none" },
      { kind: "unknown" },
      { kind: "at", ms: 0 },
      { kind: "at", ms: LEADING_QUIET_MS },
      { kind: "at", ms: LEADING_QUIET_MS + 20 },
      LATE,
    ];
    const rows: Array<{
      gate: boolean;
      flag: boolean;
      size: string;
      cpuOnly: boolean;
      voice: VoiceStart;
    }> = [];
    for (const gate of [true, false])
      for (const flag of [true, false])
        for (const size of SIZES)
          for (const cpuOnly of [true, false])
            for (const voice of voices) rows.push({ gate, flag, size, cpuOnly, voice });
    expect(rows).toHaveLength(192);
    const processor = [
      { gate: true, flag: true, size: "small", cpuOnly: true, voice: { kind: "at", ms: 1020 } },
      { gate: true, flag: true, size: "small", cpuOnly: true, voice: LATE },
    ];
    const chip = processor.map((r) => ({ ...r, cpuOnly: false }));
    for (const os of HOSTS) {
      hostIs(os);
      const carrying = rows.filter(
        (r) => arguments_(r.gate, r.flag, r.size, r.cpuOnly, r.voice).length > 0,
      );
      expect(carrying, os).toEqual(os === "windows" ? [...processor, ...chip] : processor);
    }
    hostIs("windows");
    expect(arguments_(true, true, "small", true)).toEqual(["-dtw", "small", "-nfa"]);
    expect(arguments_(true, true, "small", false)).toEqual(["-dtw", "small", "-nfa"]);
  });

  it("never gives the smaller model file (the processor-only one) word times, with everything on: nobody measured the alignment with it", () => {
    for (const cpuOnly of [true, false])
      expect(arguments_(true, true, "small_q8_0", cpuOnly), `cpuOnly ${cpuOnly}`).toEqual([]);
    // The rule is ONE list of manifest keys (the line a release that measures the smaller file changes), and every
    // key in it is a file of the manifest.
    expect(WORD_TIMES_MODELS).not.toContain("small_q8_0");
    for (const key of WORD_TIMES_MODELS) expect(MODEL_MANIFEST[key], key).toBeDefined();
    expect(
      Object.keys(MODEL_MANIFEST).filter((k) => arguments_(true, true, k, true).length > 0),
    ).toEqual([...WORD_TIMES_MODELS]);
  });

  it("takes the voice's start strictly: exactly one second in is today's, one frame later is not", () => {
    expect(arguments_(true, true, "small", true, { kind: "at", ms: LEADING_QUIET_MS })).toEqual([]);
    expect(arguments_(true, true, "small", true, { kind: "at", ms: LEADING_QUIET_MS + 1 })).toEqual(
      [...DTW_ARGS],
    );
  });

  it("is 0.27.0 for the opposite ordering: the gate on and the flag off (the operator's way back) carries nothing, on any model and backend", () => {
    for (const size of SIZES)
      for (const cpuOnly of [true, false])
        expect(arguments_(true, false, size, cpuOnly), size).toEqual([]);
  });

  it("gives every launch its own array, so a caller that edits the arguments edits nobody else's", () => {
    const first = arguments_(true, true, "small", true);
    first.push("-x");
    first[0] = "changed";
    expect(wordTimesArgs({ size: "small", cpuOnly: true, voice: LATE })).toEqual([...DTW_ARGS]);
  });

  it("follows the flag live: the answer changes when the server's answer does, not only at start", () => {
    __setWordTimesShipped(true);
    expect(wordTimesOn()).toBe(true);
    __setExportFlag("speech_word_times", false);
    expect(wordTimesOn()).toBe(false);
    __setExportFlag("speech_word_times", true);
    expect(wordTimesOn()).toBe(true);
  });
});

describe("which model files and engine paths the alignment was measured for", () => {
  it("lists only files of the manifest, and the processor path is where the first measurement is", () => {
    for (const key of [...WORD_TIMES_MODELS, ...WORD_TIMES_CHIP_MODELS])
      expect(MODEL_MANIFEST[key], key).toBeDefined();
    expect(WORD_TIMES_MODELS).toEqual(["small"]);
    // The graphics chip was measured with the same file, on one host (the line a release that measures another changes).
    expect(WORD_TIMES_CHIP_MODELS).toEqual(["small"]);
    expect(WORD_TIMES_CHIP_HOSTS).toEqual(["windows"]);
    for (const os of WORD_TIMES_CHIP_HOSTS) expect(HOSTS, os).toContain(os);
    expect(WORD_TIMES_CHIP_HOSTS, "a host the app cannot name is never allowed").not.toContain(
      "unknown",
    );
  });

  it("refuses every file of the manifest that is not listed for the path, on every combination of the switches", () => {
    __setWordTimesShipped(true);
    __setWordTimesChipShipped(true);
    __setExportFlag("speech_word_times", true);
    for (const key of Object.keys(MODEL_MANIFEST)) {
      expect(wordTimesPossible({ size: key, cpuOnly: true }), `${key} processor`).toBe(
        WORD_TIMES_MODELS.includes(key),
      );
      expect(wordTimesPossible({ size: key, cpuOnly: false }), `${key} chip`).toBe(
        WORD_TIMES_CHIP_MODELS.includes(key),
      );
    }
  });

  it("keeps the graphics chip off while its own constant is off, whatever else is on", () => {
    __setWordTimesShipped(true);
    __setExportFlag("speech_word_times", true);
    __setWordTimesChipShipped(false);
    expect(wordTimesPossible({ size: "small", cpuOnly: false })).toBe(false);
    expect(wordTimesPossible({ size: "small", cpuOnly: true })).toBe(true);
    // The chip's constant alone is not enough either: the file must be listed for it.
    __setWordTimesChipShipped(true);
    expect(wordTimesPossible({ size: "small", cpuOnly: false })).toBe(
      WORD_TIMES_CHIP_MODELS.includes("small"),
    );
    __setWordTimesShipped(false);
    expect(wordTimesPossible({ size: "small", cpuOnly: true })).toBe(false);
    expect(wordTimesPossible({ size: "small", cpuOnly: false })).toBe(false);
  });

  it("treats the chip's constant and its list of files as two keys: neither alone lets a chip launch carry the arguments", () => {
    const chipList = WORD_TIMES_CHIP_MODELS as string[];
    const asBuilt = [...chipList];
    __setWordTimesShipped(true);
    __setExportFlag("speech_word_times", true);
    try {
      chipList.length = 0;
      chipList.push("small");
      __setWordTimesChipShipped(false);
      expect(wordTimesPossible({ size: "small", cpuOnly: false }), "listed, constant off").toBe(
        false,
      );
      __setWordTimesChipShipped(true);
      expect(wordTimesPossible({ size: "small", cpuOnly: false }), "listed, constant on").toBe(
        true,
      );
      chipList.length = 0;
      expect(wordTimesPossible({ size: "small", cpuOnly: false }), "constant on, none listed").toBe(
        false,
      );
    } finally {
      chipList.splice(0, chipList.length, ...asBuilt);
    }
  });

  it("does not let a name from the object prototype or an empty key through", () => {
    __setWordTimesShipped(true);
    __setWordTimesChipShipped(true);
    __setExportFlag("speech_word_times", true);
    for (const size of ["", "toString", "__proto__", "constructor", "hasOwnProperty"])
      for (const cpuOnly of [true, false])
        expect(arguments_(true, true, size, cpuOnly), `${size} ${cpuOnly}`).toEqual([]);
  });
});

describe("which hosts the graphics-chip path may carry word times on", () => {
  const chipLaunch = (): string[] => arguments_(true, true, "small", false);
  const processorLaunch = (): string[] => arguments_(true, true, "small", true);

  it("carries them on a Windows host, where the path was measured, and on no other host: macOS, Linux and a host the app cannot name keep today's launch", () => {
    for (const os of HOSTS) {
      hostIs(os);
      expect(chipLaunch(), os).toEqual(os === "windows" ? [...DTW_ARGS] : []);
    }
  });

  it("leaves the processor path alone on every host: the file list decides there, never the host", () => {
    for (const os of HOSTS) {
      hostIs(os);
      expect(processorLaunch(), os).toEqual([...DTW_ARGS]);
    }
  });

  it("follows the app's host live: the user agent's first guess, then the answer that replaces it", () => {
    hostIs("unknown");
    expect(chipLaunch()).toEqual([]);
    hostIs("windows");
    expect(chipLaunch()).toEqual([...DTW_ARGS]);
    hostIs("macos");
    expect(chipLaunch()).toEqual([]);
  });

  it("never lets the host switch on what the build or the server has not: the gate and the flag still decide first", () => {
    hostIs("windows");
    expect(arguments_(false, true, "small", false)).toEqual([]);
    expect(arguments_(true, false, "small", false)).toEqual([]);
    __setWordTimesChipShipped(false);
    expect(arguments_(true, true, "small", false)).toEqual([]);
  });
});

describe("which launches that carried word times are made once more without them", () => {
  const failed = {
    carried: true,
    stopped: false,
    code: 1 as number | null,
    stderr: "",
    output: "missing" as "readable" | "missing" | "unreadable",
  };

  it("retries a launch that carried them and ended in failure: a non-zero exit, no output, an output that is not JSON", () => {
    expect(retryWithoutWordTimes(failed)).toBe(true);
    expect(retryWithoutWordTimes({ ...failed, code: null })).toBe(true);
    expect(retryWithoutWordTimes({ ...failed, code: 0, output: "missing" })).toBe(true);
    expect(retryWithoutWordTimes({ ...failed, code: 0, output: "unreadable" })).toBe(true);
    expect(retryWithoutWordTimes({ ...failed, code: -1073740791 })).toBe(true);
    expect(retryWithoutWordTimes({ ...failed, code: 1, output: "readable" })).toBe(true);
  });

  it("never retries a launch that worked, that did not carry them, or that was stopped", () => {
    expect(retryWithoutWordTimes({ ...failed, code: 0, output: "readable" })).toBe(false);
    expect(retryWithoutWordTimes({ ...failed, carried: false })).toBe(false);
    expect(retryWithoutWordTimes({ ...failed, stopped: true })).toBe(false);
    expect(retryWithoutWordTimes({ ...failed, stderr: "cancelled" })).toBe(false);
  });

  it("never retries what a launch without them would end in the same way: an engine that cannot start (every load failure the app knows), a language it does not know", () => {
    expect(WINDOWS_LOAD_FAILURES.size).toBeGreaterThan(0);
    for (const code of WINDOWS_LOAD_FAILURES)
      expect(retryWithoutWordTimes({ ...failed, code }), String(code)).toBe(false);
    expect(
      retryWithoutWordTimes({
        ...failed,
        code: 0,
        stderr: "error: unknown language 'xx'\nusage: whisper-cli",
      }),
    ).toBe(false);
  });
});

describe("a token's own sound time", () => {
  it("moves the token onto its dtw time and keeps its length (the Arabic clip: a first word stored at 0 that sounds at 0.94 s)", () => {
    expect(tokenOnSound({ from: 0, to: 270 }, 94)).toEqual({ from: 940, to: 1210 });
  });

  it("moves a token earlier too: the sound can come before where whisper stored it", () => {
    expect(tokenOnSound({ from: 5000, to: 5400 }, 380)).toEqual({ from: 3800, to: 4200 });
  });

  it("takes only a finite number of 0 or more: -1 (none), NaN, infinity, text, null, a list and an object are no time", () => {
    for (const bad of [
      -1,
      -0.5,
      NaN,
      Infinity,
      -Infinity,
      "94",
      "",
      null,
      undefined,
      [94],
      { v: 94 },
      true,
    ])
      expect(tokenOnSound({ from: 0, to: 270 }, bad), String(bad)).toBeNull();
    expect(tokenOnSound({ from: 0, to: 270 }, 0)).toEqual({ from: 0, to: 270 });
  });

  it("refuses a time more than a whisper window (30 s) from where it was stored, from either side, and takes exactly 30 s", () => {
    expect(tokenOnSound({ from: 0, to: 100 }, WINDOW_MS / 10)).toEqual({
      from: WINDOW_MS,
      to: WINDOW_MS + 100,
    });
    expect(tokenOnSound({ from: 0, to: 100 }, WINDOW_MS / 10 + 0.1)).toBeNull();
    expect(tokenOnSound({ from: 40_000, to: 40_100 }, 1000)).toEqual({ from: 10_000, to: 10_100 });
    expect(tokenOnSound({ from: 40_001, to: 40_100 }, 1000)).toBeNull();
  });

  it("works in whole milliseconds, so a time on a window's clock (moved by a part of 10 ms) stays a whole number", () => {
    const moved = tokenOnSound({ from: 12_345, to: 12_800 }, 94 + 1234.5);
    expect(moved).toEqual({ from: 13_285, to: 13_740 });
    expect(Number.isInteger(moved!.from)).toBe(true);
  });

  it("holds for any stored interval and any value: a time is taken only if it is the number it says, keeps the length, and is never further than 30 s", () => {
    const anyValue = fc.oneof(
      fc.integer({ min: -5, max: 100_000 }),
      fc.double(),
      fc.constantFrom("12", "", null, undefined, true, [], {}),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        anyValue,
        (from, length, value) => {
          const moved = tokenOnSound({ from, to: from + length }, value);
          if (moved === null) return;
          expect(typeof value).toBe("number");
          expect(Number.isFinite(value)).toBe(true);
          expect(value as number).toBeGreaterThanOrEqual(0);
          expect(moved.from === Math.round((value as number) * 10)).toBe(true);
          expect(moved.to - moved.from).toBe(length);
          expect(Math.abs(moved.from - from)).toBeLessThanOrEqual(WINDOW_MS);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("settling the words of a transcript", () => {
  const settled = (words: Array<[number, number]>): Array<[number, number]> =>
    settleWords(words.map(([start, end]) => ({ start, end }))).map((w) => [w.start, w.end]);

  it("leaves words that are already in order and apart exactly as they are, touching ones too (no harm where nothing is wrong)", () => {
    const words: Array<[number, number]> = [
      [0.2, 0.7],
      [0.7, 1.1],
      [1.5, 1.5],
      [2, 3],
    ];
    expect(settled(words)).toEqual(words);
  });

  it("pushes a start that comes before the word before it up to that word's start", () => {
    expect(
      settled([
        [1, 2],
        [0.5, 3],
        [4, 5],
      ]),
    ).toEqual([
      [1, 1],
      [1, 3],
      [4, 5],
    ]);
  });

  it("makes an end that is before its own start end where it starts", () => {
    expect(settled([[2, 1]])).toEqual([[2, 2]]);
  });

  it("cuts a word that runs over the next one back to where the next one starts: they touch, they never overlap", () => {
    expect(
      settled([
        [0, 5],
        [3, 4],
        [3.5, 9],
      ]),
    ).toEqual([
      [0, 3],
      [3, 3.5],
      [3.5, 9],
    ]);
  });

  it("never lets a time go below 0", () => {
    expect(
      settled([
        [-3, -1],
        [-2, 4],
      ]),
    ).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("settles an empty list and a single word", () => {
    expect(settled([])).toEqual([]);
    expect(settled([[1, 2]])).toEqual([[1, 2]]);
  });

  it("takes a time that is not a number as no time: the word starts where the word before it did and ends where it starts", () => {
    expect(
      settled([
        [1, 2],
        [NaN, NaN],
        [Infinity, 5],
        [3, -Infinity],
      ]),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 3],
      [3, 3],
    ]);
  });

  it("does not touch what it is given", () => {
    const given = [{ start: 3, end: 1 }];
    settleWords(given);
    expect(given).toEqual([{ start: 3, end: 1 }]);
  });

  const anyTime = fc.oneof(
    fc.double({ min: -50, max: 500, noNaN: true }),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, -0),
  );
  const anyWords = fc.array(fc.record({ start: anyTime, end: anyTime }), { maxLength: 40 });

  it("holds for any words at all: starts never go back, an end is never before its start, no two overlap, nothing is below 0 or not a number", () => {
    fc.assert(
      fc.property(anyWords, (words) => {
        const out = settleWords(words);
        expect(out).toHaveLength(words.length);
        out.forEach((w, i) => {
          expect(Number.isFinite(w.start) && Number.isFinite(w.end), `word ${i} is a number`).toBe(
            true,
          );
          expect(w.start).toBeGreaterThanOrEqual(0);
          expect(w.end).toBeGreaterThanOrEqual(w.start);
          if (i > 0) {
            expect(w.start).toBeGreaterThanOrEqual(out[i - 1].start);
            expect(out[i - 1].end).toBeLessThanOrEqual(w.start);
          }
        });
      }),
      { numRuns: 400 },
    );
  });

  it("only ever moves a start later and an end earlier (the sweep takes nothing from the sound, it only keeps the order)", () => {
    const finite = fc.array(
      fc.record({
        start: fc.double({ min: 0, max: 500, noNaN: true }),
        end: fc.double({ min: 0, max: 500, noNaN: true }),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(finite, (words) => {
        const out = settleWords(words);
        out.forEach((w, i) => {
          expect(w.start).toBeGreaterThanOrEqual(words[i].start);
          expect(w.end).toBeLessThanOrEqual(Math.max(words[i].end, w.start));
        });
      }),
      { numRuns: 300 },
    );
  });

  it("is its own fixed point, and leaves alone any words that were already settled", () => {
    fc.assert(
      fc.property(anyWords, (words) => {
        const once = settleWords(words);
        expect(settleWords(once)).toEqual(once);
      }),
      { numRuns: 300 },
    );
    const inOrder = fc
      .array(
        fc.tuple(
          fc.double({ min: 0, max: 10, noNaN: true }),
          fc.double({ min: 0, max: 10, noNaN: true }),
        ),
        { maxLength: 30 },
      )
      .map((gaps) => {
        let t = 0;
        return gaps.map(([gap, length]) => {
          const start = t + gap;
          t = start + length;
          return { start, end: t };
        });
      });
    fc.assert(
      fc.property(inOrder, (words) => {
        expect(settleWords(words)).toEqual(words);
      }),
      { numRuns: 300 },
    );
  });
});

describe("a segment follows its words", () => {
  it("starts where its first word starts when that is later than where it was stored (the first segment 'starts at 0' artefact)", () => {
    expect(segmentFollowsWords({ start: 0, end: 7.5 }, [{ start: 0.94, end: 1.21 }])).toEqual({
      start: 0.94,
      end: 7.5,
    });
  });

  it("never starts earlier than it was stored, whatever its first word does", () => {
    expect(segmentFollowsWords({ start: 3, end: 8 }, [{ start: 2.5, end: 4 }])).toEqual({
      start: 3,
      end: 8,
    });
  });

  it("ends where its last word ends when that is later than where it was stored, and never earlier", () => {
    expect(
      segmentFollowsWords({ start: 0, end: 2 }, [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
      ]),
    ).toEqual({
      start: 0,
      end: 3,
    });
    expect(segmentFollowsWords({ start: 0, end: 9 }, [{ start: 0, end: 1 }])).toEqual({
      start: 0,
      end: 9,
    });
  });

  it("is what it was for a segment with no words (all of it an annotation)", () => {
    expect(segmentFollowsWords({ start: 1, end: 2 }, [])).toEqual({ start: 1, end: 2 });
  });

  it("is never earlier at either edge than the stored segment, for any words", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.array(
          fc.record({
            start: fc.double({ min: 0, max: 200, noNaN: true }),
            end: fc.double({ min: 0, max: 200, noNaN: true }),
          }),
          {
            maxLength: 20,
          },
        ),
        (a, b, words) => {
          const stored = { start: Math.min(a, b), end: Math.max(a, b) };
          const out = segmentFollowsWords(stored, settleWords(words));
          expect(out.start).toBeGreaterThanOrEqual(stored.start);
          expect(out.end).toBeGreaterThanOrEqual(stored.end);
        },
      ),
      { numRuns: 300 },
    );
  });
});
