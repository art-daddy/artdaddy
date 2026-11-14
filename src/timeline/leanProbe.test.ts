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
});
