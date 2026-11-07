// Hardware decode for the agent's looks: the rules that keep it from ever costing a wrong frame or a failed look.
//
// The promise: the GPU is used only for a stream shape this PC has PROVED to decode to the same bytes as the
// software decoder, and a hardware run that does not succeed is redone in software. A driver may cost time; it
// may never cost a different picture or a look that fails when software would have worked.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import { accelFor, createLookDecoder, parseFrameMd5 } from "./lookDecode";

const H264 = { codec: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080 };
const HEVC10 = { codec: "hevc", pix_fmt: "yuv420p10le", width: 3840, height: 2160 };

const md5Lines = (hashes: string[]): string =>
  [
    "#format: frame checksums",
    "#version: 2",
    ...hashes.map((h, i) => `0, ${i}, ${i}, 1, 3110400, ${h}`),
  ].join("\n");

/** A runner that answers the proof's two framemd5 runs. `software` / `hardware` say what each prints. */
function fakeRunner(opts: {
  software?: CommandResult | (() => CommandResult);
  hardware?: CommandResult | (() => CommandResult) | "hang";
}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const ok = (hashes: string[]): CommandResult => ({
    code: 0,
    stdout: md5Lines(hashes),
    stderr: "",
  });
  const pick = (
    v: CommandResult | (() => CommandResult) | undefined,
    fallback: CommandResult,
  ): CommandResult => (typeof v === "function" ? v() : (v ?? fallback));
  return {
    calls,
    run: (_program, args, signal) => {
      calls.push(args);
      const hw = args.includes("-hwaccel");
      if (hw && opts.hardware === "hang")
        return new Promise<CommandResult>((resolve) =>
          signal?.addEventListener("abort", () =>
            resolve({ code: -1, stdout: "", stderr: "cancelled" }),
          ),
        );
      return Promise.resolve(
        hw
          ? pick(opts.hardware === "hang" ? undefined : opts.hardware, ok(["aa", "bb", "cc"]))
          : pick(opts.software, ok(["aa", "bb", "cc"])),
      );
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

const proofRuns = (r: { calls: string[][] }): number =>
  r.calls.filter((a) => a.includes("framemd5")).length;

afterEach(() => vi.useRealTimers());

describe("accelFor", () => {
  it("names the OS's own hardware decoder, and nothing on Linux or an unknown host", () => {
    expect(accelFor("windows")).toBe("d3d11va");
    expect(accelFor("macos")).toBe("videotoolbox");
    expect(accelFor("linux")).toBeNull();
    expect(accelFor("unknown")).toBeNull();
  });
});

describe("parseFrameMd5", () => {
  it("reads one checksum per frame and ignores the header and blank lines", () => {
    expect(parseFrameMd5(md5Lines(["aa", "bb"]) + "\n\n")).toEqual(["aa", "bb"]);
    expect(parseFrameMd5("")).toEqual([]);
    expect(parseFrameMd5("# only a header")).toEqual([]);
  });
});

describe("when the hardware decoder is allowed", () => {
  it("uses it for a shape that decodes to the same bytes, proving it once with the same frames both ways", async () => {
    const runner = fakeRunner({});
    const dec = createLookDecoder({
      os: () => "windows",
      storage: memoryStorage(),
      now: () => 1_000,
    });
    await expect(dec.flags(runner, "/v/a.mp4", H264)).resolves.toEqual(["-hwaccel", "d3d11va"]);
    const proofs = runner.calls.filter((a) => a.includes("framemd5"));
    expect(proofs).toHaveLength(2);
    const [soft, hard] = [
      proofs.find((a) => !a.includes("-hwaccel"))!,
      proofs.find((a) => a.includes("-hwaccel"))!,
    ];
    // Both compare in the SOURCE's own pixel format, so a hardware repack cannot look like a difference.
    for (const a of proofs) expect(a.join(" ")).toContain("format=yuv420p");
    expect(hard.slice(hard.indexOf("-hwaccel"), hard.indexOf("-hwaccel") + 2)).toEqual([
      "-hwaccel",
      "d3d11va",
    ]);
    expect(soft.join(" ").replace("-hwaccel d3d11va ", "")).toBe(
      hard.join(" ").replace("-hwaccel d3d11va ", ""),
    );
    // A repeat for the same shape costs nothing.
    await dec.flags(runner, "/v/b.mp4", H264);
    expect(proofRuns(runner)).toBe(2);
  });

  it("proves a different shape on its own (10-bit 4K is not 8-bit 1080p)", async () => {
    const runner = fakeRunner({});
    const dec = createLookDecoder({
      os: () => "windows",
      storage: memoryStorage(),
      now: () => 1_000,
    });
    await dec.flags(runner, "/v/a.mp4", H264);
    await dec.flags(runner, "/v/c.mp4", HEVC10);
    expect(proofRuns(runner)).toBe(4);
    expect(runner.calls.some((a) => a.join(" ").includes("format=yuv420p10le"))).toBe(true);
  });

  it("never uses it when a single frame differs, and does not ask again until the verdict is old", async () => {
    let clock = 1_000;
    const runner = fakeRunner({
      hardware: { code: 0, stdout: md5Lines(["aa", "XX", "cc"]), stderr: "" },
    });
    const dec = createLookDecoder({
      os: () => "windows",
      storage: memoryStorage(),
      now: () => clock,
    });
    await expect(dec.flags(runner, "/v/a.mp4", H264)).resolves.toEqual([]);
    await expect(dec.flags(runner, "/v/a.mp4", H264)).resolves.toEqual([]);
    expect(proofRuns(runner)).toBe(2);
    clock += 4 * 24 * 3_600_000; // a driver update may have fixed it: ask again after a few days
    await dec.flags(runner, "/v/a.mp4", H264);
    expect(proofRuns(runner)).toBe(4);
  });

  it("never uses it when the hardware run fails or prints nothing", async () => {
    for (const hardware of [
      { code: 1, stdout: "", stderr: "driver error" },
      { code: 0, stdout: md5Lines([]), stderr: "" },
    ]) {
      const dec = createLookDecoder({
        os: () => "windows",
        storage: memoryStorage(),
        now: () => 1,
      });
      await expect(dec.flags(fakeRunner({ hardware }), "/v/a.mp4", H264)).resolves.toEqual([]);
    }
  });

  it("does not blame the hardware when software cannot decode the file either", async () => {
    const storage = memoryStorage();
    const dec = createLookDecoder({ os: () => "windows", storage, now: () => 1 });
    const broken = fakeRunner({ software: { code: 1, stdout: "", stderr: "moov atom not found" } });
    await expect(dec.flags(broken, "/v/corrupt.mp4", H264)).resolves.toEqual([]);
    // The next, healthy file of the same shape is still proven on its own merits.
    await expect(dec.flags(fakeRunner({}), "/v/fine.mp4", H264)).resolves.toEqual([
      "-hwaccel",
      "d3d11va",
    ]);
  });

  it("remembers verdicts across restarts, and survives broken storage", async () => {
    const storage = memoryStorage();
    const first = createLookDecoder({ os: () => "windows", storage, now: () => 5 });
    await first.flags(fakeRunner({}), "/v/a.mp4", H264);
    const runner = fakeRunner({});
    const second = createLookDecoder({ os: () => "windows", storage, now: () => 6 });
    await expect(second.flags(runner, "/v/a.mp4", H264)).resolves.toEqual(["-hwaccel", "d3d11va"]);
    expect(proofRuns(runner)).toBe(0);

    const hostile = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const third = createLookDecoder({ os: () => "windows", storage: hostile, now: () => 7 });
    await expect(third.flags(fakeRunner({}), "/v/a.mp4", H264)).resolves.toEqual([
      "-hwaccel",
      "d3d11va",
    ]);
    const junk = memoryStorage({ "artdaddy-look-decode-v1": "{not json" });
    const fourth = createLookDecoder({ os: () => "windows", storage: junk, now: () => 8 });
    await expect(fourth.flags(fakeRunner({}), "/v/a.mp4", H264)).resolves.toEqual([
      "-hwaccel",
      "d3d11va",
    ]);
  });

  it("runs one proof when several looks ask about the same new shape at once", async () => {
    const runner = fakeRunner({});
    const dec = createLookDecoder({ os: () => "windows", storage: memoryStorage(), now: () => 1 });
    const all = await Promise.all([1, 2, 3, 4].map((i) => dec.flags(runner, `/v/${i}.mp4`, H264)));
    expect(all.every((f) => f.join() === "-hwaccel,d3d11va")).toBe(true);
    expect(proofRuns(runner)).toBe(2);
  });

  it("gives up on a hung driver after its time limit and uses software", async () => {
    vi.useFakeTimers();
    const dec = createLookDecoder({
      os: () => "windows",
      storage: memoryStorage(),
      now: () => Date.now(),
    });
    const pending = dec.flags(fakeRunner({ hardware: "hang" }), "/v/a.mp4", H264);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual([]);
  });

  it("starts nothing after Stop", async () => {
    const runner = fakeRunner({});
    const dec = createLookDecoder({ os: () => "windows", storage: memoryStorage(), now: () => 1 });
    const stopped = new AbortController();
    stopped.abort();
    await expect(dec.flags(runner, "/v/a.mp4", H264, stopped.signal)).resolves.toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("when the hardware decoder is not allowed", () => {
  it("answers software without running anything: Linux, an unknown host, other codecs, no pixel format", async () => {
    const runner = fakeRunner({});
    for (const [os, video] of [
      ["linux", H264],
      ["unknown", H264],
      ["windows", { ...H264, codec: "vp9" }],
      ["windows", { ...H264, codec: "prores" }],
      ["windows", { ...H264, pix_fmt: undefined }],
      ["windows", null],
    ] as const) {
      const dec = createLookDecoder({ os: () => os, storage: memoryStorage(), now: () => 1 });
      await expect(dec.flags(runner, "/v/a.mp4", video)).resolves.toEqual([]);
    }
    expect(runner.calls).toHaveLength(0);
  });
});

describe("run: a hardware look that does not succeed is redone in software", () => {
  it("returns the software result, and remembers the shape as bad only when software worked", async () => {
    const dec = createLookDecoder({ os: () => "windows", storage: memoryStorage(), now: () => 1 });
    const runner = fakeRunner({});
    const seen: string[][] = [];
    const out = await dec.run(runner, "/v/a.mp4", H264, undefined, async (flags) => {
      seen.push(flags);
      return flags.length
        ? { ok: false, value: "hardware failed" }
        : { ok: true, value: "software frame" };
    });
    expect(out).toBe("software frame");
    expect(seen).toEqual([["-hwaccel", "d3d11va"], []]);
    // Remembered: the next look on this shape goes straight to software.
    const next: string[][] = [];
    await dec.run(runner, "/v/b.mp4", H264, undefined, async (flags) => {
      next.push(flags);
      return { ok: true, value: "x" };
    });
    expect(next).toEqual([[]]);
  });

  it("does not blame the hardware when software fails too (it is the file)", async () => {
    const dec = createLookDecoder({ os: () => "windows", storage: memoryStorage(), now: () => 1 });
    const runner = fakeRunner({});
    await dec.run(runner, "/v/bad.mp4", H264, undefined, async (flags) => ({
      ok: false,
      value: flags.length ? "hw" : "sw",
    }));
    const next: string[][] = [];
    await dec.run(runner, "/v/good.mp4", H264, undefined, async (flags) => {
      next.push(flags);
      return { ok: true, value: "x" };
    });
    expect(next).toEqual([["-hwaccel", "d3d11va"]]);
  });

  it("makes exactly one attempt when there is no hardware, and none after Stop", async () => {
    const dec = createLookDecoder({ os: () => "linux", storage: memoryStorage(), now: () => 1 });
    let n = 0;
    await dec.run(fakeRunner({}), "/v/a.mp4", H264, undefined, async () => {
      n++;
      return { ok: false, value: "nope" };
    });
    expect(n).toBe(1);

    const win = createLookDecoder({ os: () => "windows", storage: memoryStorage(), now: () => 1 });
    const stop = new AbortController();
    let attempts = 0;
    await win.run(fakeRunner({}), "/v/a.mp4", H264, stop.signal, async (flags) => {
      attempts++;
      stop.abort(); // the person pressed Stop while the hardware attempt ran
      return { ok: false, value: flags.length ? "stopped" : "late" };
    });
    expect(attempts).toBe(1);
  });
});

// The look's own report says how each frame was decoded: it must say what actually happened, never what was asked.
describe("run: how the look was made", () => {
  const modes = async (
    os: "windows" | "linux",
    attempt: (flags: string[]) => Promise<{ ok: boolean; value: string }>,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    const dec = createLookDecoder({ os: () => os, storage: memoryStorage(), now: () => 1 });
    const told: string[] = [];
    await dec.run(fakeRunner({}), "/v/a.mp4", H264, signal, attempt, (mode) => told.push(mode));
    return told;
  };

  it("says gpu when the hardware attempt worked", async () => {
    expect(await modes("windows", async () => ({ ok: true, value: "frame" }))).toEqual(["gpu"]);
  });

  it("says retried when the hardware attempt failed and software redid it, whether or not software worked", async () => {
    const worked = async (flags: string[]) => ({ ok: flags.length === 0, value: "x" });
    expect(await modes("windows", worked)).toEqual(["retried"]);
    expect(await modes("windows", async () => ({ ok: false, value: "x" }))).toEqual(["retried"]);
  });

  it("says software where there is no hardware to ask, or it was not proved", async () => {
    expect(await modes("linux", async () => ({ ok: true, value: "frame" }))).toEqual(["software"]);
    expect(await modes("linux", async () => ({ ok: false, value: "nope" }))).toEqual(["software"]);
  });

  it("says it once per look, and says gpu (not retried) when Stop ended the hardware attempt: nothing was redone", async () => {
    const stop = new AbortController();
    const told = await modes(
      "windows",
      async () => {
        stop.abort();
        return { ok: false, value: "stopped" };
      },
      stop.signal,
    );
    expect(told).toEqual(["gpu"]);
  });

  it("changes nothing when nobody is told: the same answer, the same attempts", async () => {
    const dec = createLookDecoder({ os: () => "windows", storage: memoryStorage(), now: () => 1 });
    const seen: string[][] = [];
    const out = await dec.run(fakeRunner({}), "/v/a.mp4", H264, undefined, async (flags) => {
      seen.push(flags);
      return flags.length ? { ok: false, value: "hw" } : { ok: true, value: "sw" };
    });
    expect(out).toBe("sw");
    expect(seen).toEqual([["-hwaccel", "d3d11va"], []]);
  });
});
