import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LeanOptions } from "./leanOptions";
import { leanDecoderCap, type DecoderCapRequest } from "./leanDecoders";
import { LeanTally } from "./leanRecord";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function request(over: Partial<DecoderCapRequest> = {}, lean: LeanOptions = { decoders: true }) {
  const tally = new LeanTally();
  const req: DecoderCapRequest = {
    lean,
    tally,
    engine: "file-sequence-v1",
    kind: "audio",
    ...over,
  };
  return { req, tally };
}

describe("leanDecoderCap: one decoder thread for a picture read once and for a sound-only input, on the one-pass engine", () => {
  it("a sound-only input and a picture that fix 3 reads once take the cap, and the record says decoders ran", () => {
    const audio = request();
    expect(leanDecoderCap(audio.req)).toEqual(["-threads:a", "1"]);
    expect(audio.tally.record()).toEqual({ ran: ["decoders"], kept: [] });
    const picture = request({ kind: "picture", readOnce: true });
    expect(leanDecoderCap(picture.req)).toEqual(["-threads:v", "1"]);
    expect(picture.tally.record()).toEqual({ ran: ["decoders"], kept: [] });
  });

  it("a picture that is read again for every frame keeps ffmpeg's own threads (that is where the cap made exports slower), and nothing is counted for it", () => {
    for (const readOnce of [undefined, false]) {
      const picture = request({ kind: "picture", readOnce });
      expect(leanDecoderCap(picture.req)).toBeNull();
      expect(picture.tally.record()).toEqual({ ran: [], kept: [] });
    }
  });

  it("the streamed engine already gives these inputs one thread: unchanged and uncounted; the switch off and the plain retry keep today's options", () => {
    const streamed = request({ engine: "partition-pipes-v1" });
    expect(leanDecoderCap(streamed.req)).toBeNull();
    expect(streamed.tally.record()).toEqual({ ran: [], kept: [] });

    const off = request({}, { decoders: false });
    expect(leanDecoderCap(off.req)).toBeNull();
    expect(off.tally.record()).toEqual({ ran: [], kept: ["flag_off"] });
    const offPicture = request({ kind: "picture", readOnce: true }, {});
    expect(leanDecoderCap(offPicture.req)).toBeNull();
    expect(offPicture.tally.record()).toEqual({ ran: [], kept: ["flag_off"] });

    const plain = request({}, { decoders: true, plain: true });
    expect(leanDecoderCap(plain.req)).toBeNull();
    expect(plain.tally.record()).toEqual({ ran: [], kept: [] });
  });

  it("the options are a rule of the input's kind and the engine (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("file-sequence-v1", "partition-pipes-v1", undefined),
        fc.constantFrom("picture", "audio"),
        fc.boolean(),
        fc.boolean(),
        (engine, kind, readOnce, on) => {
          const { req } = request({ engine, kind, readOnce }, { decoders: on });
          const out = leanDecoderCap(req);
          const expected =
            engine !== "partition-pipes-v1" && (kind === "audio" || readOnce) && on
              ? kind === "audio"
                ? ["-threads:a", "1"]
                : ["-threads:v", "1"]
              : null;
          return JSON.stringify(out) === JSON.stringify(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The builder: which input carries the cap in the command. Nothing here runs ffmpeg.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const OUT = "/out.mp4";
const CANVAS = { width: 108, height: 192, fps: 30 };
const clip = (media_ref: string, extra: Record<string, unknown> = {}, seconds = 2) => ({
  media_ref,
  source_in: 0,
  source_out: seconds,
  timeline_in: 0,
  timeline_out: seconds,
  fit: "cover",
  ...extra,
});
const sound = (media_ref: string, seconds = 2) => ({
  id: "m0",
  kind: "audio",
  media_ref,
  source_in: 0,
  source_out: seconds,
  timeline_in: 0,
  timeline_out: seconds,
});
const project = (): Timeline =>
  ({
    canvas: CANVAS,
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          clip("/p0.jpg"),
          clip("/v0.mp4", { timeline_in: 2, timeline_out: 4, source_out: 2 }),
        ],
      },
      { id: "a", kind: "audio", z: 0, clips: [sound("/m0.mp3", 4)] },
    ],
  }) as Any as Timeline;
const argsOf = (plan: { args: string[] }): string => plan.args.join(" ");

describe("the builder: where the cap sits in the command", () => {
  it("one-pass with fix 3 and fix 5: the picture and the sound-only input carry one decoder thread each, the video clip keeps its own budget", () => {
    const plan = buildRenderCommand(project(), OUT, {
      lean: { stills: true, decoders: true },
    } as Any);
    const args = argsOf(plan);
    expect(args).toContain("-t 2.000000 -threads:v 1 -i /p0.jpg");
    expect(args).toContain("-threads:a 1 -i /m0.mp3");
    expect(args).not.toMatch(/-threads:a 1 -i \/v0\.mp4/);
    expect(plan.lean).toEqual({ ran: ["stills", "decoders"], kept: [] });

    const base = buildRenderCommand(project(), OUT);
    expect(argsOf(base)).not.toContain("-threads:a");
    // The video input's decoder options are the same with or without the cap.
    const video = (a: string): string => /(-threads:v \d+ )?-i \/v0\.mp4/.exec(a)?.[0] ?? "";
    expect(video(args)).toBe(video(argsOf(base)));
  });

  it("without fix 3 the picture is read for every frame and keeps its threads; the sound-only input is still capped", () => {
    const plan = buildRenderCommand(project(), OUT, {
      lean: { stills: false, decoders: true },
    } as Any);
    const args = argsOf(plan);
    expect(args).toContain("-loop 1 -framerate 30 -t 2.000000 -i /p0.jpg");
    expect(args).toContain("-threads:a 1 -i /m0.mp3");
    expect(plan.lean?.ran).toEqual(["decoders"]);
    expect(plan.lean?.kept).toContain("flag_off");
  });

  it("with the switch off, with the plain retry, or on the streamed engine the command carries no cap beyond what 0.27.0 gave", () => {
    const base = buildRenderCommand(project(), OUT);
    for (const lean of [
      { stills: true, decoders: false },
      { stills: true, decoders: true, plain: true },
    ] as const) {
      const plan = buildRenderCommand(project(), OUT, { lean } as Any);
      expect(argsOf(plan)).not.toContain("-threads:a");
      if (lean.plain === true) expect(plan.args).toEqual(base.args);
    }
    const streamed = buildRenderCommand(project(), OUT, {
      engine: "partition-pipes-v1",
      lean: { stills: true, decoders: true },
    } as Any);
    const everyCommand = [streamed.args, ...(streamed.steps ?? []).map((step) => step.args)];
    expect(everyCommand.length).toBeGreaterThan(0);
    for (const args of everyCommand) expect(args.join(" ")).not.toContain("-threads:a");
  });
});
