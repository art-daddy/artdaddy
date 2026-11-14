import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CommandRunner } from "../tools/command";
import { parseShowinfo, probeLean, probedFromLog } from "./leanProbe";

const frameLine = (instance: number, n: number, fmt: string, size: string): string =>
  `[Parsed_showinfo_${instance} @ 000001ff1b7ae080] n:   ${n} pts:      0 pts_time:0       duration:    256 duration_time:0.0166667 fmt:${fmt} cl:left sar:1/1 s:${size} i:P iskey:1 type:I checksum:3D5BDD03 plane_checksum:[674E12E6 148E3791 D420928C] mean:[126 127 126] stdev:[55.9 79.5 83.8]`;
const noise = (instance: number): string[] => [
  `[Parsed_showinfo_${instance} @ 000001ff1b7ae080]   side data - H.26[45] User Data Unregistered SEI message: UUID=dc45e9bd`,
  `[Parsed_showinfo_${instance} @ 000001ff1b7ae080] color_range:unknown color_space:unknown color_primaries:unknown color_trc:unknown`,
];

// The shape of the log ffmpeg printed for a real 1920x1080 screen recording with the probe's filter text: BOTH filters report frame 0 and then frame 1 (the second frame gets through before
// ffmpeg stops at -frames:v 1). The first version of the parser required exactly two lines and so never answered for a video clip.
const VIDEO_LOG = [
  "[Parsed_showinfo_1 @ 000001ff1b7ae080] config in time_base: 1/15360, frame_rate: 60/1",
  "[Parsed_showinfo_3 @ 000001ff1c55a180] config in time_base: 1/15360, frame_rate: 60/1",
  frameLine(1, 0, "yuv420p", "1920x1080"),
  ...noise(1),
  frameLine(3, 0, "yuv420p", "5462x3072"),
  ...noise(3),
  frameLine(1, 1, "yuv420p", "1920x1080"),
  frameLine(3, 1, "yuv420p", "5462x3072"),
].join("\n");

describe("the size probe's log reading (leanProbe)", () => {
  it("answers from the first frame of each filter when a video lets a second frame through (the real shape of a screen recording)", () => {
    expect(probedFromLog(VIDEO_LOG)).toEqual({
      fmt: "yuv420p",
      source: [1920, 1080],
      scaled: [5462, 3072],
    });
  });

  it("answers for a picture that gives one frame per filter, and carries the source's pixel format (an alpha format is the caller's refusal)", () => {
    const log = [frameLine(1, 0, "rgba", "800x600"), frameLine(3, 0, "rgba", "2560x1920")].join(
      "\n",
    );
    expect(probedFromLog(log)).toEqual({ fmt: "rgba", source: [800, 600], scaled: [2560, 1920] });
  });

  it("gives no answer when it is not the two sizes of one first frame", () => {
    expect(probedFromLog(frameLine(1, 0, "yuv420p", "1920x1080"))).toBeNull();
    expect(
      probedFromLog(
        [frameLine(1, 0, "yuv420p", "1920x1080"), frameLine(3, 1, "yuv420p", "5462x3072")].join(
          "\n",
        ),
      ),
    ).toBeNull();
    expect(
      probedFromLog(
        [frameLine(1, 0, "yuv420p", "0x1080"), frameLine(3, 0, "yuv420p", "5462x3072")].join("\n"),
      ),
    ).toBeNull();
    expect(
      probedFromLog(
        [frameLine(1, 0, "yuv420p", "1920x1080"), frameLine(3, 0, "yuv420p", "99999x3072")].join(
          "\n",
        ),
      ),
    ).toBeNull();
    expect(
      probedFromLog(
        [
          frameLine(1, 0, "yuv420p", "1920x1080"),
          frameLine(3, 0, "yuv420p", "1x1"),
          frameLine(5, 0, "yuv420p", "2x2"),
        ].join("\n"),
      ),
    ).toBeNull();
    expect(probedFromLog("")).toBeNull();
  });

  it("never throws, and an answer always has two positive sizes, whatever text it is given", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const a = probedFromLog(text);
        if (a) expect([...a.source, ...a.scaled].every((n) => n > 0)).toBe(true);
        parseShowinfo(text);
      }),
      { numRuns: 300 },
    );
  });

  it("reads only lines that begin with the filter's own tag: a tag in the middle of a line (the input's path, echoed in ffmpeg's log) is not a showinfo line", () => {
    const embedded = `Input #0, from 'x [Parsed_showinfo_1 @ 0] n: 0 fmt:yuv420p s:10x10 [Parsed_showinfo_3 @ 0] n: 0 fmt:yuv420p s:20x20'`;
    expect(parseShowinfo(embedded)).toEqual([]);
    expect(probedFromLog(embedded)).toBeNull();
    expect(probedFromLog(VIDEO_LOG)).not.toBeNull(); // and the real shape still answers
  });

  it("the probe maps the FIRST video stream, as the export's own `[N:v]` does, so both see the same picture", async () => {
    let seen: string[] = [];
    const runner: CommandRunner = {
      async run(_program, args) {
        seen = args;
        return { code: 0, stdout: "", stderr: VIDEO_LOG };
      },
    };
    await probeLean(runner, [
      { key: "a.mp4\nscale", path: "a.mp4", filters: "setsar=1,showinfo,scale=1:1,showinfo" },
    ]);
    const map = seen.indexOf("-map");
    expect(map).toBeGreaterThan(seen.indexOf("-i"));
    expect(seen[map + 1]).toBe("0:v:0");
    expect(map).toBeLessThan(seen.indexOf("-vf"));
  });

  it("probeLean asks once per distinct key, leaves a failed probe out of the answers, and never throws", async () => {
    const asked: string[] = [];
    const runner: CommandRunner = {
      async run(_program, args) {
        const path = args[args.indexOf("-i") + 1];
        asked.push(path);
        if (path.includes("broken")) return { code: 1, stdout: "", stderr: "Invalid data found" };
        if (path.includes("throws")) throw new Error("spawn failed");
        return { code: 0, stdout: "", stderr: VIDEO_LOG };
      },
    };
    const request = (name: string) => ({
      key: `${name}\nscale`,
      path: name,
      filters: "setsar=1,showinfo,scale=1:1,showinfo",
    });
    const answers = await probeLean(runner, [
      request("a.mp4"),
      request("a.mp4"),
      request("broken.mp4"),
      request("throws.mp4"),
      request("b.mp4"),
    ]);
    expect([...answers.keys()].sort()).toEqual(["a.mp4\nscale", "b.mp4\nscale"]);
    expect(asked.filter((p) => p === "a.mp4")).toHaveLength(1);
  });

  it("probeLean stops at its overall deadline, keeps the answers it already has, and aborts the probes still running", async () => {
    let aborted = 0;
    const runner: CommandRunner = {
      run: (_program, args, signal) =>
        new Promise((resolve) => {
          const path = args[args.indexOf("-i") + 1];
          if (path === "fast.mp4") resolve({ code: 0, stdout: "", stderr: VIDEO_LOG });
          else
            signal?.addEventListener(
              "abort",
              () => {
                aborted += 1;
                resolve({ code: null, stdout: "", stderr: "cancelled" });
              },
              { once: true },
            );
        }),
    };
    const request = (name: string) => ({
      key: `${name}\nscale`,
      path: name,
      filters: "setsar=1,showinfo,scale=1:1,showinfo",
    });
    const started = Date.now();
    const answers = await probeLean(
      runner,
      ["fast.mp4", "hung1.mp4", "hung2.mp4", "hung3.mp4", "hung4.mp4"].map(request),
      undefined,
      150,
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect([...answers.keys()]).toEqual(["fast.mp4\nscale"]);
    expect(aborted).toBeGreaterThanOrEqual(2);
  });

  it("probeLean answers nothing and starts nothing when the export was already cancelled", async () => {
    let started = 0;
    const runner: CommandRunner = {
      run: async () => {
        started += 1;
        return { code: 0, stdout: "", stderr: VIDEO_LOG };
      },
    };
    const stop = new AbortController();
    stop.abort();
    const answers = await probeLean(
      runner,
      [{ key: "a\nscale", path: "a.mp4", filters: "x" }],
      stop.signal,
    );
    expect(answers.size).toBe(0);
    expect(started).toBe(0);
  });
});
