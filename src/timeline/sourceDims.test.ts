// sourceDims measures the size a decoder SHOWS, through the one size owner (tools/media probePath).
// It used to run its own stream probe, which reported the STORED size: a portrait phone video (a
// landscape frame plus a display matrix) and a portrait phone JPEG (EXIF orientation) were measured
// on their sides, so the ceiling on zooming into them was computed for the wrong shape.
import { beforeEach, describe, expect, it } from "vitest";

import { harnessProbeRunner } from "../eval/harness";
import { makeRunner, resetTestDocuments, seededCtx } from "../test/timelineKit";
import type { CommandRunner } from "../tools/command";
import { addClipsTool, clearDurationCache, clearHasAudioCache } from "./placement";
import { clearSourceDimsCache, sourceDims } from "./sourceDims";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

beforeEach(async () => {
  clearSourceDimsCache();
  clearDurationCache();
  clearHasAudioCache();
  await resetTestDocuments();
});

/** ffprobe for one file as the shipped build answers: placement's stream checks, the size owner's
 *  stream probe (`stream` = a display matrix on the stream, as a phone video has), and its first-
 *  frame probe (`frame` = the EXIF orientation a JPEG keeps only there). */
function fileRunner(f: {
  format: string;
  w: number;
  h: number;
  stream?: number;
  frame?: number;
  probe?: "fail" | "zero";
}): CommandRunner {
  return makeRunner((p, a) => {
    if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
    if (a.includes("-show_streams")) {
      if (f.probe === "fail") return { code: 1, stdout: "", stderr: "moov atom not found" };
      const s: Record<string, unknown> = {
        codec_type: "video",
        width: f.probe === "zero" ? 0 : f.w,
        height: f.probe === "zero" ? 0 : f.h,
      };
      if (f.stream !== undefined) s.side_data_list = [{ rotation: f.stream }];
      return {
        code: 0,
        stdout: JSON.stringify({ format: { format_name: f.format }, streams: [s] }),
        stderr: "",
      };
    }
    if (a.some((x) => x.includes("frame_side_data")))
      return {
        code: 0,
        stdout: JSON.stringify({
          frames: [{ side_data_list: f.frame === undefined ? [{}] : [{ rotation: f.frame }, {}] }],
        }),
        stderr: "",
      };
    if (a.includes("-select_streams"))
      return {
        code: 0,
        stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "",
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  });
}

async function measure(runner: CommandRunner, ref: string): Promise<unknown> {
  const { ctx } = await seededCtx(runner);
  const r = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30, with_audio: false }] },
    ctx,
  )) as Any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const id = String(r.created[0].clip_id);
  return (await sourceDims(ctx, [id])).get(id);
}

describe("sourceDims measures the picture a decoder shows", () => {
  it("a portrait phone video (landscape frame + display matrix) measures portrait", async () => {
    const runner = fileRunner({ format: "mov,mp4,m4a,3gp,3g2,mj2", w: 1920, h: 1080, stream: -90 });
    expect(await measure(runner, "IMG_0001.MOV")).toEqual({ w: 1080, h: 1920 });
  });

  it("a portrait phone JPEG (EXIF orientation 6) measures portrait", async () => {
    const runner = fileRunner({ format: "jpeg_pipe", w: 4032, h: 3024, frame: -90 });
    expect(await measure(runner, "IMG_0002.JPG")).toEqual({ w: 3024, h: 4032 });
  });

  it("an unturned source measures as stored", async () => {
    expect(await measure(fileRunner({ format: "jpeg_pipe", w: 640, h: 480 }), "a.jpg")).toEqual({
      w: 640,
      h: 480,
    });
    expect(
      await measure(fileRunner({ format: "mov,mp4,m4a,3gp,3g2,mj2", w: 854, h: 480 }), "b.mp4"),
    ).toEqual({ w: 854, h: 480 });
  });

  it("an unreadable source is unknown, never small: the clamp is skipped, not applied", async () => {
    // ffprobe exits 0 on an undecodable file and reports 0x0; a failed probe is no evidence either.
    expect(
      await measure(fileRunner({ format: "mov", w: 1, h: 1, probe: "zero" }), "z.mp4"),
    ).toBeNull();
    expect(
      await measure(fileRunner({ format: "mov", w: 1, h: 1, probe: "fail" }), "f.mp4"),
    ).toBeNull();
  });

  // The eval harness answers ffprobe for every scenario. If its answers stop matching what the size
  // owner asks, every source silently becomes "unknown" and no scenario can see the zoom ceiling.
  it("the eval harness's stand-in still gives every scenario a source size", async () => {
    expect(await measure(harnessProbeRunner, "talk_480p.mp4")).toEqual({ w: 854, h: 480 });
    expect(await measure(harnessProbeRunner, "outro.mp4")).toEqual({ w: 1920, h: 1080 });
  });
});
