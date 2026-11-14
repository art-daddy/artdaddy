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
    readOnce: true,
    ...over,
  };
  return { req, tally };
}

describe("leanDecoderCap: one decoder thread for a picture that fix 3 reads once, on the one-pass engine", () => {
  it("a picture read once takes the cap, and the record says decoders ran", () => {
    const { req, tally } = request();
    expect(leanDecoderCap(req)).toEqual(["-threads:v", "1"]);
    expect(tally.record()).toEqual({ ran: ["decoders"], kept: [] });
  });

  it("a picture that is read again for every frame keeps ffmpeg's own threads (that is where the cap made exports slower), and nothing is counted for it", () => {
    const { req, tally } = request({ readOnce: false });
    expect(leanDecoderCap(req)).toBeNull();
    expect(tally.record()).toEqual({ ran: [], kept: [] });
  });

  it("the streamed engine already gives pictures one thread: unchanged and uncounted; the switch off and the plain retry keep today's options", () => {
    const streamed = request({ engine: "partition-pipes-v1" });
    expect(leanDecoderCap(streamed.req)).toBeNull();
    expect(streamed.tally.record()).toEqual({ ran: [], kept: [] });

    const off = request({}, { decoders: false });
    expect(leanDecoderCap(off.req)).toBeNull();
    expect(off.tally.record()).toEqual({ ran: [], kept: ["flag_off"] });
    const unset = request({}, {});
    expect(leanDecoderCap(unset.req)).toBeNull();
    expect(unset.tally.record()).toEqual({ ran: [], kept: ["flag_off"] });

    const plain = request({}, { decoders: true, plain: true });
    expect(leanDecoderCap(plain.req)).toBeNull();
    expect(plain.tally.record()).toEqual({ ran: [], kept: [] });
  });

  it("the options are a rule of the engine, the switch and whether the picture is read once (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("file-sequence-v1", "partition-pipes-v1", undefined),
        fc.boolean(),
        fc.boolean(),
        (engine, readOnce, on) => {
          const { req } = request({ engine, readOnce }, { decoders: on });
          const expected =
            engine !== "partition-pipes-v1" && readOnce && on ? ["-threads:v", "1"] : null;
          return JSON.stringify(leanDecoderCap(req)) === JSON.stringify(expected);
        },
      ),
      { numRuns: 100 },
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
  it("one-pass with fix 3 and fix 5: the held picture carries one decoder thread; the video clip keeps its own budget and the sound-only input is left alone", () => {
    const plan = buildRenderCommand(project(), OUT, {
      lean: { stills: true, decoders: true },
    } as Any);
    const args = argsOf(plan);
    expect(args).toContain("-t 2.000000 -threads:v 1 -i /p0.jpg");
    expect(args).not.toContain("-threads:a");
    expect(plan.lean).toEqual({ ran: ["stills", "decoders"], kept: [] });

    const base = buildRenderCommand(project(), OUT);
    // The video input's decoder options are the same with or without the cap.
    const video = (a: string): string => /(-threads:v \d+ )?-i \/v0\.mp4/.exec(a)?.[0] ?? "";
    expect(video(args)).toBe(video(argsOf(base)));
    // The sound-only input's options are 0.27.0's.
    const music = (a: string): string =>
      /-ss [\d.]+ -to [\d.]+(?: -threads:[av] \d+)* -i \/m0\.mp3/.exec(a)?.[0] ?? "";
    expect(music(args)).not.toBe("");
    expect(music(args)).toBe(music(argsOf(base)));
  });

  it("without fix 3 the picture is read for every frame and keeps its threads", () => {
    const plan = buildRenderCommand(project(), OUT, {
      lean: { stills: false, decoders: true },
    } as Any);
    expect(argsOf(plan)).toContain("-loop 1 -framerate 30 -t 2.000000 -i /p0.jpg");
    expect(plan.lean?.ran).toEqual([]);
    expect(plan.lean?.kept).toEqual(["flag_off"]);
  });

  it("with the switch off, with the plain retry, or on the streamed engine the command carries no cap beyond what 0.27.0 gave", () => {
    const base = buildRenderCommand(project(), OUT);
    const off = buildRenderCommand(project(), OUT, {
      lean: { stills: true, decoders: false },
    } as Any);
    expect(argsOf(off)).toContain("-t 2.000000 -i /p0.jpg");
    expect(off.lean).toEqual({ ran: ["stills"], kept: ["flag_off"] });
    const plain = buildRenderCommand(project(), OUT, {
      lean: { stills: true, decoders: true, plain: true },
    } as Any);
    expect(plain.args).toEqual(base.args);
    const streamed = buildRenderCommand(project(), OUT, {
      engine: "partition-pipes-v1",
      lean: { stills: true, decoders: true },
    } as Any);
    const everyCommand = [streamed.args, ...(streamed.steps ?? []).map((step) => step.args)];
    expect(everyCommand.length).toBeGreaterThan(0);
    for (const args of everyCommand) expect(args.join(" ")).not.toContain("-threads:a");
  });
});
