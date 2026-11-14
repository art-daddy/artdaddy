import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { crfFor } from "../timeline/exportOptions";
import { classOf, readPcCheck, rHatOf, writePcCheck, type StorageLike } from "../timeline/pcClass";
import { createPcCheckService, type PcCheckDeps, type PcCheckSignals } from "./pcCheck";
import {
  EXPORT_SPEED_PROBE_ID,
  EXPORT_SPEED_REVISION,
  SPEED_PROBE,
  exportSpeedProbe,
  measureSpeed,
  probeRunArgs,
  referenceClipArgs,
  speedFromProgress,
  type ProbeKind,
} from "./pcCheckProbe";
import type { ProbeOutcome } from "./host";

// What ffmpeg writes with `-progress pipe:1` -------------------------------------------------------------------------------------

const timeText = (us: number): string => {
  const total = us / 1e6;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(6).padStart(9, "0")}`;
};

/** One block as the baseline's own parser test has it (the key set of ffmpeg's -progress output). */
const block = (o: {
  frame: number;
  fps: string;
  outUs: number | null;
  speed: string;
  end?: boolean;
}) =>
  [
    `frame=${o.frame}`,
    `fps=${o.fps}`,
    "stream_0_0_q=-1.0",
    "bitrate=N/A",
    "total_size=N/A",
    `out_time_us=${o.outUs ?? "N/A"}`,
    `out_time_ms=${o.outUs ?? "N/A"}`,
    `out_time=${o.outUs === null ? "N/A" : timeText(o.outUs)}`,
    "dup_frames=0",
    "drop_frames=0",
    `speed=${o.speed}`,
    `progress=${o.end ? "end" : "continue"}`,
    "",
  ].join("\n");

/** A run of ffmpeg as its progress shows it: nothing for `startup` seconds, then `fps` frames a second up to `frames`. A block
 *  comes every `period` seconds; `fps` is frames over wall time since the start (0 in the first second) and `speed` is output
 *  time over wall time (N/A until something is written, and the encoder holds back `lag` frames), both rounded as ffmpeg rounds
 *  them. The last block says `end`. */
function progressText(run: {
  fps: number;
  frames: number;
  startup?: number;
  period?: number;
  lag?: number;
}): string {
  const { fps, frames, startup = 0.3, period = 0.25, lag = 0 } = run;
  const total = startup + frames / fps;
  const at = (t: number, end: boolean): string => {
    const produced = Math.min(frames, Math.max(0, Math.floor((t - startup) * fps)));
    const written = Math.max(0, produced - lag);
    const outUs = written > 0 ? Math.round((written / 30) * 1e6) : null;
    return block({
      frame: produced,
      fps: t > 1 ? (produced / t).toFixed(2) : "0.00",
      outUs,
      speed: outUs ? `${Number((outUs / 1e6 / t).toPrecision(3))}x` : "N/A",
      end,
    });
  };
  let text = "";
  for (let i = 1; i * period <= total; i++) text += at(i * period, false);
  return text + at(total + 0.05, true);
}

const wholeRun = (fps: number, frames = 240) => progressText({ fps, frames });

/** A reading is within a frame a second of the truth and 3 percent: one frame more or less in a window of a second or more. */
const near = (got: number | null, truth: number): boolean =>
  got !== null && Math.abs(got - truth) <= 1.5 + 0.03 * truth;

describe("speedFromProgress", () => {
  it("reads the speed of a steady run, and the frames it reached", () => {
    const steady = speedFromProgress(wholeRun(40));
    expect(steady.fps).toBeCloseTo(40, 0);
    expect(steady.frames).toBe(240);
    const slow = speedFromProgress(wholeRun(10, 120));
    expect(slow.fps).toBeCloseTo(10, 0);
    expect(slow.frames).toBe(120);
  });

  it("does not count start-up: a run that was stalled for its first 1.2 seconds is read at its steady speed, not its average", () => {
    const text = progressText({ fps: 40, frames: 240, startup: 1.2 });
    const average = 240 / (1.2 + 240 / 40);
    expect(average).toBeLessThan(34);
    expect(speedFromProgress(text).fps).toBeCloseTo(40, 0);
  });

  it("is not fooled by an encoder that holds frames back before it writes any", () => {
    for (const lag of [0, 12, 40])
      expect(
        near(speedFromProgress(progressText({ fps: 25, frames: 240, lag })).fps, 25),
        `lag ${lag}`,
      ).toBe(true);
  });

  it("never counts the first half second: a stretch that is a second long only with it is not a reading", () => {
    // Blocks at 0.25 s, 0.5 s ... 1.25 s: from 0.5 s on the run has been read for 0.75 s; with the block at 0.25 s it would be 1 s.
    const short = progressText({ fps: 40, frames: 50, startup: 0.1 });
    expect(speedFromProgress(short)).toEqual({ fps: null, frames: 50 });
    // The same run, half a second longer, has a second after the first half second, and is read.
    expect(
      near(speedFromProgress(progressText({ fps: 40, frames: 70, startup: 0.1 })).fps, 40),
    ).toBe(true);
  });

  it("wants at least 8 frames over at least a second, and says nothing otherwise", () => {
    // 2 frames a second, 7 frames in all: a second is there, 8 frames are not.
    expect(speedFromProgress(progressText({ fps: 2, frames: 7, startup: 0.1 }))).toEqual({
      fps: null,
      frames: 7,
    });
    expect(speedFromProgress(progressText({ fps: 2, frames: 10, startup: 0.1 })).fps).toBeCloseTo(
      2,
      0,
    );
    // Plenty of frames, under a second.
    expect(speedFromProgress(progressText({ fps: 300, frames: 60, startup: 0.1 })).fps).toBeNull();
    expect(speedFromProgress(progressText({ fps: 6, frames: 4, startup: 0.1 }))).toEqual({
      fps: null,
      frames: 4,
    });
  });

  it("leaves out the last block, where the encoder's flush can count frames in a burst", () => {
    const steady = wholeRun(40);
    const withBurst =
      steady.slice(0, steady.lastIndexOf("frame=")) +
      block({ frame: 300, fps: "47.60", outUs: 10_000_000, speed: "1.59x", end: true });
    const got = speedFromProgress(withBurst);
    // had the burst counted, the last second would hold 100 frames (about 97 a second)
    expect(got.fps).toBeCloseTo(40, 0);
    expect(got.frames).toBe(300);
  });

  it("reads a counter that goes back as the start of something else: only what follows it counts", () => {
    const fast = wholeRun(40);
    const slow = wholeRun(10, 120);
    expect(speedFromProgress(fast + slow).fps).toBeCloseTo(10, 0);
    expect(speedFromProgress(slow + fast).fps).toBeCloseTo(40, 0);
  });

  it("takes the longest sensible stretch back from the end: the latest one that holds 8 frames and a second", () => {
    // 4 frames a second: a second holds only 4, so the stretch reaches back until it holds 8
    const result = speedFromProgress(progressText({ fps: 4, frames: 40, startup: 0.2 }));
    expect(result.fps).toBeCloseTo(4, 0);
  });

  it("copes with Windows line ends and with the app's own beat lines in the middle of ffmpeg's", () => {
    const clean = wholeRun(40);
    const crlf = clean.replace(/\n/g, "\r\n");
    expect(speedFromProgress(crlf)).toEqual(speedFromProgress(clean));
    const middle = clean.indexOf("out_time_us=") + "out_time_us=".length + 2;
    const glued = clean.slice(0, middle) + "artdaddy_verify=3\n" + clean.slice(middle);
    expect(speedFromProgress(glued)).toEqual(speedFromProgress(clean));
    expect(speedFromProgress("artdaddy_verify=1\n" + clean + "artdaddy_verify=2\n")).toEqual(
      speedFromProgress(clean),
    );
  });

  it("reads a block whose output time is not there yet by its frames, and one whose frames rate is not there yet by its speed", () => {
    const text = progressText({ fps: 20, frames: 240, startup: 0.3, lag: 60 });
    expect(text).toContain("out_time_us=N/A");
    expect(speedFromProgress(text).fps).toBeCloseTo(20, 0);
  });

  it("does not believe a block whose two clocks disagree", () => {
    const steady = wholeRun(40);
    // every speed doubled: the output clock now says the run is half as old as the frame clock does
    const doubled = steady.replace(/speed=([0-9.]+)x/g, (_m, s) => `speed=${Number(s) * 2}x`);
    expect(speedFromProgress(doubled).fps).toBeNull();
  });

  it("says nothing for garbage, and never throws", () => {
    const nothing = { fps: null, frames: 0 };
    for (const junk of [
      "",
      " \n \n",
      "garbage",
      "no equals sign here\nnor here\n",
      "\u0000\u0001\u0002\n=\n==\n",
      "progress=continue\n",
      "frame=\nfps=\nprogress=continue\n",
      "frame=abc\nfps=def\nout_time_us=ghi\nspeed=jkl\nprogress=continue\n",
      "frame=12\nfps=3",
      "x".repeat(1_000_000),
      "frame=1\n".repeat(100_000),
    ])
      expect(speedFromProgress(junk), junk.slice(0, 20)).toEqual(
        expect.objectContaining({ fps: null }),
      );
    for (const notText of [null, undefined, 5, {}, [], () => 1] as unknown as string[])
      expect(speedFromProgress(notText)).toEqual(nothing);
  });

  it("never returns a speed that is not a real positive number, whatever the numbers in the text are", () => {
    const huge = [
      "1e300",
      "1e999",
      "-1e999",
      "9007199254740993",
      "1e-300",
      "0",
      "-5",
      "NaN",
      "Infinity",
      "4294967296",
    ];
    for (const a of huge)
      for (const b of huge) {
        const text =
          block({ frame: 100, fps: "0.00", outUs: 400_000, speed: "0.8x" }) +
          `frame=${a}\nfps=${b}\nout_time_us=${a}\nspeed=${b}x\nprogress=continue\n` +
          `frame=${b}\nfps=${a}\nout_time_us=${b}\nspeed=${a}x\nprogress=continue\n`;
        const got = speedFromProgress(text);
        expect(got.fps === null || (Number.isFinite(got.fps) && got.fps > 0), `${a} ${b}`).toBe(
          true,
        );
        expect(Number.isFinite(got.frames) && got.frames >= 0).toBe(true);
      }
  });

  it("does not let one huge block spoil a reading that is otherwise sound", () => {
    const steady = wholeRun(40);
    const spoiled = steady.replace(/^frame=\d+/m, "frame=1e300");
    const got = speedFromProgress(spoiled);
    expect(got.fps === null || got.fps > 0).toBe(true);
    expect(speedFromProgress("frame=1e300\nfps=5\nprogress=continue\n" + steady).fps).toBeCloseTo(
      40,
      0,
    );
  });

  describe("(property)", () => {
    it("recovers the speed of any run long enough to be read, within a frame a second and 3 percent, and never over-reports", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 8, max: 300, noNaN: true }),
          fc.double({ min: 0.05, max: 0.9, noNaN: true }),
          fc.constantFrom(0.25, 0.5),
          fc.constantFrom(60, 240, 960),
          fc.integer({ min: 0, max: 45 }),
          (fps, startup, period, frames, lag) => {
            const text = progressText({ fps, frames, startup, period, lag });
            const got = speedFromProgress(text);
            expect(got.frames).toBe(frames);
            if (got.fps !== null)
              expect(Math.abs(got.fps - fps)).toBeLessThanOrEqual(1.5 + 0.03 * fps);
            // a run of four seconds or more, at a speed with 8 frames in a second, can always be read
            if (startup + frames / fps >= 4) expect(got.fps).not.toBeNull();
          },
        ),
        { numRuns: 400 },
      );
    });

    it("gives null or a finite positive speed under 100000, and finite frames, for any text at all", () => {
      const key = fc.constantFrom(
        "frame",
        "fps",
        "out_time_us",
        "out_time_ms",
        "out_time",
        "speed",
        "progress",
        "junk",
      );
      const value = fc.oneof(
        fc.double({ noNaN: false }).map(String),
        fc.integer().map(String),
        fc.constantFrom("N/A", "end", "continue", "1e999", "00:00:01.000000", "2x", "", "-3"),
        fc.string(),
      );
      const lines = fc.array(
        fc.tuple(key, value).map(([k, v]) => `${k}=${v}`),
        { maxLength: 80 },
      );
      fc.assert(
        fc.property(
          fc.oneof(
            lines.map((l) => l.join("\n")),
            fc.string(),
            fc.anything().map((value) => {
              try {
                return JSON.stringify(value) ?? "";
              } catch {
                return "";
              }
            }),
          ),
          (text) => {
            const got = speedFromProgress(text);
            expect(
              got.fps === null || (Number.isFinite(got.fps) && got.fps > 0 && got.fps <= 100_000),
            ).toBe(true);
            expect(Number.isFinite(got.frames) && got.frames >= 0 && got.frames <= 10_000_000).toBe(
              true,
            );
          },
        ),
        { numRuns: 600 },
      );
    });
  });
});

// The commands ----------------------------------------------------------------------------------------------------------------------

const valueAfter = (args: string[], flag: string, from = 0): string =>
  args[args.indexOf(flag, from) + 1];

describe("referenceClipArgs", () => {
  const args = referenceClipArgs("C:/cache/pc-check/ref.part.mp4");

  it("makes four seconds of 1080p30 test pattern with a fixed-seed noise, H.264 veryfast, no sound, into the file it is given", () => {
    const source = valueAfter(args, "-i");
    expect(valueAfter(args, "-f")).toBe("lavfi");
    expect(source).toMatch(/^testsrc2=/);
    expect(source).toContain("size=1920x1080");
    expect(source).toContain("rate=30");
    expect(source).toContain("duration=4");
    expect(source).toMatch(/noise=[^,]*all_seed=\d+/);
    expect(valueAfter(args, "-c:v")).toBe("libx264");
    expect(valueAfter(args, "-preset")).toBe("veryfast");
    expect(args).toContain("-an");
    expect(args.slice(-2)).toEqual(["-y", "C:/cache/pc-check/ref.part.mp4"]);
    expect(valueAfter(args, "-pix_fmt")).toBe("yuv420p");
  });

  it("is the same clip every time (nothing in it changes between calls) and takes nothing but the path", () => {
    expect(referenceClipArgs("x.mp4")).toEqual(referenceClipArgs("x.mp4"));
    expect(referenceClipArgs("a.mp4").slice(0, -1)).toEqual(
      referenceClipArgs("b.mp4").slice(0, -1),
    );
  });

  it("is nothing for a path that is not one", () => {
    for (const junk of ["", null, undefined, 5, {}] as unknown as string[])
      expect(referenceClipArgs(junk)).toEqual([]);
  });
});

describe("probeRunArgs", () => {
  const reference = "C:/cache/pc-check/reference-v1.mp4";
  const kinds: ProbeKind[] = ["a", "b", "c"];

  it("reads the reference clip, reports its progress on stdout and writes no file: its picture goes to a null sink", () => {
    for (const kind of kinds) {
      const args = probeRunArgs(kind, reference);
      expect(valueAfter(args, "-i"), kind).toBe(reference);
      expect(valueAfter(args, "-progress"), kind).toBe("pipe:1");
      expect(args, kind).toContain("-nostats");
      expect(args.slice(-3), kind).toEqual(["-f", "null", "-"]);
      // the reference is the only path in the command
      expect(
        args.filter((part) => /\.(mp4|mkv|mov|ts|nut)$/i.test(part)),
        kind,
      ).toEqual([reference]);
    }
  });

  it("asks for the frames it is told to, 60 by default, and bounds them for anything else", () => {
    expect(valueAfter(probeRunArgs("b", reference), "-frames:v")).toBe("60");
    expect(valueAfter(probeRunArgs("b", reference, { frames: 240 }), "-frames:v")).toBe("240");
    expect(valueAfter(probeRunArgs("b", reference, { frames: Number.NaN }), "-frames:v")).toBe(
      "60",
    );
    expect(valueAfter(probeRunArgs("b", reference, { frames: 0 }), "-frames:v")).toBe("1");
    expect(valueAfter(probeRunArgs("b", reference, { frames: -9 }), "-frames:v")).toBe("1");
    expect(valueAfter(probeRunArgs("b", reference, { frames: 1e12 }), "-frames:v")).toBe("100000");
    expect(valueAfter(probeRunArgs("b", reference, { frames: 59.6 }), "-frames:v")).toBe("60");
  });

  it("is one graph for all three kinds, so a difference between them is the encoder and nothing else", () => {
    const [a, b, c] = kinds.map((kind) => probeRunArgs(kind, reference));
    expect(valueAfter(a, "-filter_complex")).toBe(valueAfter(b, "-filter_complex"));
    expect(valueAfter(b, "-filter_complex")).toBe(valueAfter(c, "-filter_complex"));
    const outside = (args: string[]) => [
      ...args.slice(0, args.indexOf("-an")),
      ...args.slice(args.indexOf("-frames:v")),
    ];
    expect(outside(a)).toEqual(outside(b));
    expect(outside(b)).toEqual(outside(c));
  });

  it("builds the picture the way a plain project does: fitted to the canvas, held to the rate, laid on a black canvas, TV range yuv420p", () => {
    const graph = valueAfter(probeRunArgs("b", reference), "-filter_complex");
    expect(graph).toContain("color=c=black:s=1920x1080:r=30");
    expect(graph).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(graph).toContain("pad=1920:1080");
    expect(graph).toContain("fps=fps=30");
    expect(graph).toMatch(/overlay=/);
    expect(graph).toContain("scale=out_range=tv,format=yuv420p[tv]");
    expect(valueAfter(probeRunArgs("b", reference), "-map")).toBe("[tv]");
  });

  it("A reads and mixes only; B encodes at Medium with the baseline's own CRF; C is B at the faster setting", () => {
    const [a, b, c] = kinds.map((kind) => probeRunArgs(kind, reference));
    expect(a).not.toContain("-c:v");
    expect(a).not.toContain("-crf");
    expect(valueAfter(b, "-c:v")).toBe("libx264");
    expect(valueAfter(b, "-preset")).toBe("medium");
    expect(valueAfter(b, "-crf")).toBe(String(crfFor("medium")));
    expect(valueAfter(c, "-c:v")).toBe("libx264");
    expect(valueAfter(c, "-preset")).toBe("veryfast");
    expect(valueAfter(c, "-crf")).toBe(valueAfter(b, "-crf"));
  });

  it("loops the clip only when a run asks for more frames than it holds", () => {
    const held =
      Number(/rate=(\d+)/.exec(valueAfter(referenceClipArgs("r.mp4"), "-i"))![1]) *
      Number(/duration=(\d+)/.exec(valueAfter(referenceClipArgs("r.mp4"), "-i"))![1]);
    expect(held).toBe(120);
    expect(probeRunArgs("b", reference, { frames: held })).not.toContain("-stream_loop");
    expect(valueAfter(probeRunArgs("b", reference, { frames: held + 1 }), "-stream_loop")).toBe(
      "1",
    );
    expect(valueAfter(probeRunArgs("b", reference, { frames: 960 }), "-stream_loop")).toBe("7");
    // the loop flag is an input option: it comes before the clip
    const looped = probeRunArgs("b", reference, { frames: 960 });
    expect(looped.indexOf("-stream_loop")).toBeLessThan(looped.indexOf("-i"));
  });

  it("holds the clip enough for what it asks (property): loops are the fewest that cover the frames", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (frames) => {
        const args = probeRunArgs("b", reference, { frames });
        const loops = args.includes("-stream_loop") ? Number(valueAfter(args, "-stream_loop")) : 0;
        expect((loops + 1) * 120).toBeGreaterThanOrEqual(frames);
        expect(loops * 120).toBeLessThan(frames);
      }),
    );
  });

  it("is nothing for a kind or a path that is not one", () => {
    for (const junk of ["d", "", null, undefined, 1] as unknown as ProbeKind[])
      expect(probeRunArgs(junk, reference)).toEqual([]);
    for (const junk of ["", null, undefined, 3] as unknown as string[])
      expect(probeRunArgs("b", junk)).toEqual([]);
  });

  it("does not know how to start a process: the module builds commands and reads text, nothing else", () => {
    // Read from the repo's root, where the tests run: `import.meta.url` is not a file URL under every test environment.
    const source = readFileSync(resolve(process.cwd(), "src/platform/pcCheckProbe.ts"), "utf8");
    expect(source).not.toMatch(
      /from "\.\/host"|from "\.\.\/tools|child_process|invoke\(|fetch\(|XMLHttpRequest|localStorage|setTimeout|setInterval/,
    );
  });
});

// The test, with a scripted PC ----------------------------------------------------------------------------------------------------

type Ran = Extract<ProbeOutcome, { kind: "ran" }>;
const ran = (stdout: string, code = 0, ms = 100): Ran => ({
  kind: "ran",
  code,
  stdout,
  stderr: "",
  ms,
});

interface Script {
  /** What the clip's making does: its time, how it ends, the size of the file it leaves. */
  reference?: {
    ms?: number;
    outcome?: ProbeOutcome["kind"];
    code?: number;
    bytes?: number;
    hang?: boolean;
  };
  /** The size of a reference that is there already. */
  existing?: number | null;
  /** The speed of each timed run, by kind and by how many of that kind ran before it: a number, null for output that says nothing
   *  readable, or a function of the frames asked for. */
  speed?: (
    kind: ProbeKind,
    nth: number,
    frames: number,
  ) => number | null | "fail" | "busy" | "timeout" | "stopped";
  startup?: number;
  hang?: ProbeKind | "reference";
}

function rig(script: Script = {}, over: { now?: () => number } = {}) {
  let t = 1_700_000_000_000;
  const files = new Map<string, number>();
  const existing = script.existing === undefined ? 4_000_000 : script.existing;
  const dir = "C:/cache/pc-check";
  const reference = `${dir}/reference-v1.mp4`;
  if (existing !== null) files.set(reference, existing);
  const calls: {
    kind: string;
    args: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    at: number;
  }[] = [];
  const removed: string[] = [];
  const renamed: [string, string][] = [];
  const made: string[] = [];
  const count: Record<string, number> = {};
  const storage = new Map<string, string>();
  const deps = {
    now: over.now ?? (() => t),
    storage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    } as StorageLike,
    build: "artdaddy@1.0.0",
    cores: 8,
    probe: async (
      args: readonly string[],
      options: { timeoutMs: number; kind: string; signal?: AbortSignal },
    ): Promise<ProbeOutcome> => {
      calls.push({
        kind: options.kind,
        args: [...args],
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        at: t,
      });
      const which = options.kind.replace("pc-check-", "");
      if (script.hang === which) return new Promise<ProbeOutcome>(() => undefined);
      const take = (ms: number, fallback: ProbeOutcome): ProbeOutcome => {
        if (ms > options.timeoutMs) {
          t += options.timeoutMs;
          return { kind: "timeout" };
        }
        t += ms;
        return fallback;
      };
      if (which === "reference") {
        const spec = script.reference ?? {};
        const outcome = spec.outcome ?? "ran";
        if (outcome !== "ran") return { kind: outcome } as ProbeOutcome;
        const code = spec.code ?? 0;
        if (code === 0) files.set(args[args.length - 1], spec.bytes ?? 6_000_000);
        return take(spec.ms ?? 2_000, ran("", code));
      }
      const kind = which as ProbeKind;
      const frames = Number(args[args.indexOf("-frames:v") + 1]);
      const nth = (count[kind] = (count[kind] ?? -1) + 1);
      const said = script.speed ? script.speed(kind, nth, frames) : { a: 40, b: 30, c: 35 }[kind];
      if (said === "fail") return ran("", 1);
      if (said === "busy") return { kind: "busy" };
      if (said === "timeout") return take(Number.MAX_SAFE_INTEGER, { kind: "timeout" });
      if (said === "stopped") return { kind: "stopped" };
      if (said === null) return take(1_000, ran("nothing useful here\n"));
      const startup = script.startup ?? 0.3;
      return take(
        (startup + frames / said) * 1000,
        ran(progressText({ fps: said, frames, startup })),
      );
    },
    files: {
      dir: async () => dir,
      mkdir: async (path: string) => void made.push(path),
      remove: async (path: string) => {
        removed.push(path);
        files.delete(path);
      },
      rename: async (from: string, to: string) => {
        renamed.push([from, to]);
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      size: async (path: string) => files.get(path) ?? null,
    },
  };
  return {
    deps,
    calls,
    removed,
    renamed,
    made,
    files,
    reference,
    advance: (ms: number) => void (t += ms),
    now: () => t,
  };
}

describe("measureSpeed", () => {
  it("runs B, C, A and B again over the reference clip and says what it found", async () => {
    const pc = rig();
    const got = await measureSpeed(pc.deps, new AbortController().signal);
    expect(pc.calls.map((c) => c.kind)).toEqual([
      "pc-check-b",
      "pc-check-c",
      "pc-check-a",
      "pc-check-b",
    ]);
    expect(got).toMatchObject({
      revision: EXPORT_SPEED_REVISION,
      build: "artdaddy@1.0.0",
      cores: 8,
      outcome: "done",
    });
    expect(near(got!.bFps, 30)).toBe(true);
    expect(near(got!.cFps, 35)).toBe(true);
    expect(near(got!.aFps, 40)).toBe(true);
    expect(got!.rHat).toBe(rHatOf(got!.bFps));
    expect(got!.cls).toBe(classOf(got!.rHat));
    expect(got!.atMs).toBe(pc.now());
  });

  it("gives the class the store's cut-offs say: a pair the server moved applies to what is measured now", async () => {
    const slow = rig({ speed: (kind) => (kind === "b" ? 12 : 40) });
    expect((await measureSpeed(slow.deps, new AbortController().signal))!.cls).toBe("ok");
    const moved = rig({ speed: (kind) => (kind === "b" ? 12 : 40) });
    moved.deps.storage.setItem("artdaddy.pcClass.v1", JSON.stringify({ okOver: 0.5, weakOver: 2 }));
    expect((await measureSpeed(moved.deps, new AbortController().signal))!.cls).toBe("weak");
  });

  it("makes the reference clip first when there is none, into a part file that gets the clip's name only when it is whole", async () => {
    const pc = rig({ existing: null });
    const got = await measureSpeed(pc.deps, new AbortController().signal);
    expect(got).not.toBeNull();
    expect(pc.calls[0].kind).toBe("pc-check-reference");
    const part = pc.calls[0].args[pc.calls[0].args.length - 1];
    expect(part).not.toBe(pc.reference);
    expect(part).toMatch(/\.part\.mp4$/);
    expect(pc.renamed).toEqual([[part, pc.reference]]);
    expect(pc.made).toEqual(["C:/cache/pc-check"]);
    // the clip is kept; no part is left; nothing else was written
    expect(pc.files.has(pc.reference)).toBe(true);
    expect(pc.files.has(part)).toBe(false);
    expect(pc.removed).toEqual([]);
    // and every run reads the finished clip
    for (const call of pc.calls.slice(1))
      expect(call.args[call.args.indexOf("-i") + 1]).toBe(pc.reference);
  });

  it("uses the clip that is there, without making it again", async () => {
    const pc = rig({ existing: 4_000_000 });
    await measureSpeed(pc.deps, new AbortController().signal);
    expect(pc.calls.some((c) => c.kind === "pc-check-reference")).toBe(false);
    expect(pc.removed).toEqual([]);
  });

  for (const bytes of [0, 1, 499_999, 150_000_001])
    it(`makes the clip again when the one there is damaged (${bytes} bytes), removing it first`, async () => {
      const pc = rig({ existing: bytes });
      const got = await measureSpeed(pc.deps, new AbortController().signal);
      expect(got).not.toBeNull();
      expect(pc.removed[0]).toBe(pc.reference);
      expect(pc.calls[0].kind).toBe("pc-check-reference");
      expect(pc.files.get(pc.reference)).toBe(6_000_000);
    });

  describe("B is run twice and the faster run is taken: a disturbance can only slow a run", () => {
    for (const [first, second] of [
      [30, 12],
      [12, 30],
      [30, 30],
    ] as const)
      it(`runs of ${first} and ${second} frames a second: ${Math.max(first, second)}`, async () => {
        const pc = rig({ speed: (kind, nth) => (kind === "b" ? [first, second][nth] : 70) });
        const got = await measureSpeed(pc.deps, new AbortController().signal);
        expect(got!.bFps).toBeCloseTo(Math.max(first, second), 0);
      });

    it("and a repeat that fails or says nothing leaves the first run standing", async () => {
      for (const bad of [null, "fail", "busy", "timeout"] as const) {
        const pc = rig({
          speed: (kind, nth) => (kind === "b" && nth === 1 ? bad : kind === "b" ? 30 : 70),
        });
        const got = await measureSpeed(pc.deps, new AbortController().signal);
        expect(got?.bFps, String(bad)).toBeCloseTo(30, 0);
      }
    });
  });

  it("has no answer when B itself cannot be read, fails, is refused, times out or is stopped", async () => {
    for (const bad of [null, "fail", "busy", "timeout", "stopped"] as const) {
      const pc = rig({ speed: (kind) => (kind === "b" ? bad : 70) });
      expect(await measureSpeed(pc.deps, new AbortController().signal), String(bad)).toBeNull();
      expect(
        pc.calls.map((c) => c.kind),
        String(bad),
      ).toEqual(["pc-check-b"]);
    }
  });

  it("still has an answer when only A or C cannot be had: the class needs B alone", async () => {
    const pc = rig({ speed: (kind) => (kind === "b" ? 20 : kind === "c" ? "fail" : null) });
    const got = await measureSpeed(pc.deps, new AbortController().signal);
    expect(got).toMatchObject({ outcome: "done", aFps: null, cFps: null });
    expect(got!.bFps).toBeCloseTo(20, 0);
  });

  describe("a PC so fast that a run is over before it can be read", () => {
    it("is run again for longer, and the longer runs are used for everything after", async () => {
      const pc = rig({ speed: (kind) => ({ a: 900, b: 400, c: 600 })[kind] });
      const got = await measureSpeed(pc.deps, new AbortController().signal);
      const framesOf = (call: { args: string[] }) =>
        Number(call.args[call.args.indexOf("-frames:v") + 1]);
      const bs = pc.calls.filter((c) => c.kind === "pc-check-b").map(framesOf);
      expect(bs.slice(0, 3)).toEqual([60, 240, 960]);
      expect(framesOf(pc.calls[pc.calls.length - 1])).toBe(960);
      expect(Math.abs(got!.bFps! - 400)).toBeLessThan(1.5 + 0.03 * 400);
      // a clip that holds 120 frames is looped for the longer runs
      expect(pc.calls.some((c) => c.args.includes("-stream_loop"))).toBe(true);
    });

    it("is not run for ever: when the longest run is still too short there is no answer", async () => {
      const pc = rig({ speed: (kind) => (kind === "b" ? 5_000 : 70) });
      expect(await measureSpeed(pc.deps, new AbortController().signal)).toBeNull();
      expect(pc.calls.map((c) => c.kind)).toEqual(["pc-check-b", "pc-check-b", "pc-check-b"]);
    });

    it("does not make a run that was cut short, or that said nothing, longer", async () => {
      const pc = rig({ speed: (kind) => (kind === "b" ? null : 70) });
      await measureSpeed(pc.deps, new AbortController().signal);
      expect(pc.calls).toHaveLength(1);
    });
  });

  describe("the time box: 20 seconds in all, the clip's making included", () => {
    const BOX = SPEED_PROBE.boxMs;

    it("never starts a run with more time than is left, or that cannot end before the box does", async () => {
      const pc = rig({
        existing: null,
        reference: { ms: 6_000 },
        speed: (kind) => ({ a: 40, b: 12, c: 36 })[kind],
      });
      const start = pc.now();
      await measureSpeed(pc.deps, new AbortController().signal);
      expect(pc.calls.length).toBeGreaterThan(1);
      for (const call of pc.calls) {
        expect(Number.isFinite(call.timeoutMs) && call.timeoutMs > 0).toBe(true);
        expect(call.at - start + call.timeoutMs, call.kind).toBeLessThanOrEqual(BOX);
      }
      expect(pc.now() - start).toBeLessThanOrEqual(BOX);
    });

    it("keeps the answer it has when the time runs out before the repeat or the other kinds: B stands alone", async () => {
      // the clip takes 12 s and B 6.3 s: 1.7 s are left, and C needs more than that
      const pc = rig({
        existing: null,
        reference: { ms: 12_000 },
        speed: (kind) => (kind === "b" ? 10 : 40),
      });
      const start = pc.now();
      const got = await measureSpeed(pc.deps, new AbortController().signal);
      expect(got).toMatchObject({ outcome: "done" });
      expect(got!.bFps).toBeCloseTo(10, 0);
      expect(got!.aFps).toBeNull();
      expect(got!.cFps).toBeNull();
      expect(pc.now() - start).toBeLessThan(BOX);
    });

    it("has no answer when the clip alone uses up the box, and leaves no part file behind", async () => {
      const pc = rig({ existing: null, reference: { ms: 25_000 } });
      expect(await measureSpeed(pc.deps, new AbortController().signal)).toBeNull();
      expect(pc.calls.map((c) => c.kind)).toEqual(["pc-check-reference"]);
      expect(pc.removed).toEqual([pc.calls[0].args[pc.calls[0].args.length - 1]]);
      expect(pc.files.has(pc.reference)).toBe(false);
    });

    it("has no answer when B itself cannot end inside the box", async () => {
      const pc = rig({ speed: (kind) => (kind === "b" ? 1 : 70) });
      expect(await measureSpeed(pc.deps, new AbortController().signal)).toBeNull();
    });
  });

  describe("a failing clip leaves no part file behind and has no answer", () => {
    it("when ffmpeg fails, is refused or is stopped", async () => {
      for (const spec of [
        { code: 1 },
        { outcome: "busy" as const },
        { outcome: "timeout" as const },
        { outcome: "stopped" as const },
      ]) {
        const pc = rig({ existing: null, reference: spec });
        expect(
          await measureSpeed(pc.deps, new AbortController().signal),
          JSON.stringify(spec),
        ).toBeNull();
        expect(pc.removed.length, JSON.stringify(spec)).toBe(1);
        expect(pc.removed[0]).toMatch(/\.part\.mp4$/);
        expect(pc.files.size).toBe(0);
      }
    });

    it("when the file it left is not a sound clip, or cannot be put in place", async () => {
      const small = rig({ existing: null, reference: { bytes: 1_000 } });
      expect(await measureSpeed(small.deps, new AbortController().signal)).toBeNull();
      expect(small.removed[0]).toMatch(/\.part\.mp4$/);
      const stuck = rig({ existing: null });
      stuck.deps.files.rename = async () => {
        throw new Error("the folder is locked");
      };
      expect(await measureSpeed(stuck.deps, new AbortController().signal)).toBeNull();
      expect(stuck.removed[0]).toMatch(/\.part\.mp4$/);
    });
  });

  describe("a stop", () => {
    it("before it starts: nothing is run, nothing is touched", async () => {
      const pc = rig({ existing: null });
      const controller = new AbortController();
      controller.abort();
      expect(await measureSpeed(pc.deps, controller.signal)).toBeNull();
      expect(pc.calls).toEqual([]);
      expect(pc.made).toEqual([]);
      expect(pc.removed).toEqual([]);
    });

    it("while the clip is being made, with a probe that never answers: it ends at once, passes the signal on and removes the part", async () => {
      const pc = rig({ existing: null, hang: "reference" });
      const controller = new AbortController();
      const pending = measureSpeed(pc.deps, controller.signal);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(pc.calls.map((c) => c.kind)).toEqual(["pc-check-reference"]);
      expect(pc.calls[0].signal).toBe(controller.signal);
      controller.abort();
      await expect(pending).resolves.toBeNull();
      expect(pc.removed).toEqual([pc.calls[0].args[pc.calls[0].args.length - 1]]);
      expect(pc.files.has(pc.reference)).toBe(false);
    });

    it("while a timed run never answers: it ends at once, and the finished clip stays", async () => {
      const pc = rig({ hang: "b" });
      const controller = new AbortController();
      const pending = measureSpeed(pc.deps, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      await expect(pending).resolves.toBeNull();
      expect(pc.calls.map((c) => c.kind)).toEqual(["pc-check-b"]);
      expect(pc.calls[0].signal).toBe(controller.signal);
      expect(pc.removed).toEqual([]);
      expect(pc.files.has(pc.reference)).toBe(true);
    });

    it("between two runs: no run starts after it, and there is no answer", async () => {
      const controller = new AbortController();
      const pc = rig({
        speed: (kind) => {
          if (kind === "c") controller.abort();
          return kind === "b" ? 30 : 70;
        },
      });
      expect(await measureSpeed(pc.deps, controller.signal)).toBeNull();
      expect(pc.calls.map((c) => c.kind)).toEqual(["pc-check-b", "pc-check-c"]);
    });
  });

  it("never throws: not for a clock, a folder, a size, a removal or a probe that fails", async () => {
    const broken: [string, (pc: ReturnType<typeof rig>) => void][] = [
      ["now", (pc) => void (pc.deps.now = () => Number.NaN)],
      [
        "dir",
        (pc) => void (pc.deps.files.dir = async () => Promise.reject(new Error("no folder"))),
      ],
      [
        "size",
        (pc) =>
          void (pc.deps.files.size = () => {
            throw new Error("no size");
          }),
      ],
      ["probe", (pc) => void (pc.deps.probe = async () => Promise.reject(new Error("no ffmpeg")))],
      [
        "probe sync",
        (pc) =>
          void (pc.deps.probe = () => {
            throw new Error("no ffmpeg");
          }),
      ],
      [
        "mkdir",
        (pc) => void (pc.deps.files.mkdir = async () => Promise.reject(new Error("locked"))),
      ],
      [
        "storage",
        (pc) =>
          void (pc.deps.storage = {
            getItem: () => {
              throw new Error("off");
            },
            setItem: () => undefined,
            removeItem: () => undefined,
          }),
      ],
    ];
    for (const [name, damage] of broken) {
      const pc = rig({ existing: null });
      damage(pc);
      await expect(measureSpeed(pc.deps, new AbortController().signal), name).resolves.toSatisfy(
        (got) => got === null || (got as { outcome: string }).outcome === "done",
      );
    }
  });

  it("labels every command it runs as its own, so the capability lane can tell it from the chip test's", async () => {
    const pc = rig({ existing: null });
    await measureSpeed(pc.deps, new AbortController().signal);
    for (const call of pc.calls) expect(call.kind).toMatch(/^pc-check-(reference|a|b|c)$/);
  });

  it("is a record the store accepts: whatever it measures can be kept and read back for this PC", async () => {
    const pc = rig();
    const got = await measureSpeed(pc.deps, new AbortController().signal);
    writePcCheck(pc.deps.storage, "export-speed", got!);
    expect(
      readPcCheck(pc.deps.storage, "export-speed", {
        atMs: pc.now(),
        build: "artdaddy@1.0.0",
        cores: 8,
        revision: EXPORT_SPEED_REVISION,
      }),
    ).toEqual(got);
  });
});

// The probe in the service, over a scripted PC ----------------------------------------------------------------------------------------

describe("the export speed test as a probe of the service", () => {
  it("is the speed test: its id, the 20 second box, 30 days, and the record that is the PC's class", () => {
    const definition = exportSpeedProbe();
    expect(definition).toMatchObject({
      id: EXPORT_SPEED_PROBE_ID,
      revision: EXPORT_SPEED_REVISION,
      ttlMs: 30 * 86_400_000,
      budgetMs: 20_000,
      definesClass: true,
    });
    expect(EXPORT_SPEED_PROBE_ID).toBe("export-speed");
  });

  /** The service over a fake clock and the scripted PC. */
  function inService(script: Script) {
    const pc = rig(script);
    let now = 1_700_000_000_000;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const deps: PcCheckDeps = {
      ...pc.deps,
      now: () => now,
      setTimer: (fn, ms) => {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (id) => void timers.delete(id as number),
    };
    const advance = async (ms: number) => {
      const settle = async () => {
        for (let i = 0; i < 400; i++) await Promise.resolve();
      };
      const target = now + ms;
      await settle();
      for (let fired = 0; fired < 1_000; fired++) {
        const next = [...timers]
          .filter(([, v]) => v.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await settle();
      }
      now = target;
      await settle();
    };
    const service = createPcCheckService(deps);
    service.registerProbe(exportSpeedProbe());
    const quiet = (): PcCheckSignals => ({
      exportBusy: false,
      exportAsked: false,
      playing: false,
      lookOrSpeechJob: false,
      projectOpen: true,
      lastInputAtMs: now,
    });
    return { pc, service, deps, advance, quiet, timers: () => timers.size };
  }

  it("is measured when the editor has been idle, and gives the PC its class", async () => {
    for (const [bFps, expected] of [
      [60, "fast"],
      [20, "ok"],
      [5, "weak"],
    ] as const) {
      const { service, advance, quiet, deps } = inService({
        speed: (kind) => (kind === "b" ? bFps : 40),
      });
      expect(service.pcClass()).toBe("unknown");
      service.setSignals(quiet());
      await advance(20_000);
      expect(service.pcClass(), String(bFps)).toBe(expected);
      expect(service.result("export-speed")).toMatchObject({ outcome: "done", cores: 8 });
      expect(
        JSON.parse(deps.storage!.getItem("artdaddy.pcCheck.v1")!)["export-speed"],
      ).toMatchObject({ outcome: "done" });
    }
  });

  it("is ended by the time box when ffmpeg never answers: the signal is aborted, the part file removed, the class is `unfinished` at once, nothing is left running", async () => {
    const { pc, service, advance, quiet, timers } = inService({
      existing: null,
      hang: "reference",
    });
    service.setSignals(quiet());
    await advance(20_000);
    expect(service.status().running).toBe("export-speed");
    const during = service.pcClass();
    expect(during).toBe("unknown");
    expect(pc.calls).toHaveLength(1);
    expect(pc.calls[0].signal!.aborted).toBe(false);
    await advance(20_000);
    expect(pc.calls[0].signal!.aborted).toBe(true);
    expect(pc.removed).toEqual([pc.calls[0].args[pc.calls[0].args.length - 1]]);
    expect(service.status()).toEqual({
      running: null,
      lastOutcome: { "export-speed": "unfinished" },
    });
    expect(service.pcClass()).toBe("unfinished");
    service.dispose();
    expect(timers()).toBe(0);
  });

  it("stores nothing when an export is admitted while it measures, and leaves no part file", async () => {
    const { pc, service, advance, quiet, deps } = inService({ existing: null, hang: "reference" });
    service.setSignals(quiet());
    await advance(20_000);
    const before = JSON.stringify(deps.storage!.getItem("artdaddy.pcCheck.v1"));
    service.setSignals({ ...quiet(), exportBusy: true, lastInputAtMs: 1_700_000_000_000 });
    await advance(1_500);
    expect(pc.calls[0].signal!.aborted).toBe(true);
    expect(pc.removed).toHaveLength(1);
    expect(JSON.stringify(deps.storage!.getItem("artdaddy.pcCheck.v1"))).toBe(before);
    expect(service.pcClass()).toBe("unknown");
    expect(service.status().lastOutcome).toEqual({ "export-speed": "aborted" });
  });
});
