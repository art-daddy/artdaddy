// A byte-identical gate on what the EXPORT tool emits.
//
// Built during an alpha pass that diffed the tool surface against the commit before the
// manual-editing phases: the entire render plan and ffmpeg command came back identical except
// the one filter that was meant to change (a keyframed `volume` went from a flat `1.0000` to a
// real envelope). This freezes that result so the next refactor has to justify any movement.
//
// The fixture is deliberately dense — animated and constant rotation, animated and constant
// opacity, crop, transform, fades on both media kinds, and both volume forms — because a golden
// file is only worth what it covers. If this fails, do NOT regenerate it: read the diff first,
// and only update once you can say which change caused which byte.
//
// MOVED ONCE, DELIBERATELY (frames-view normalisation): the fixture declares `units:"frames"`,
// but buildRenderCommand used to require callers to convert to seconds first and this one never
// did. So the frozen bytes described a 150-SECOND render of what is a 5-second timeline — the
// golden was pinning a misreading. No user was affected (both real callers, renderTimelineToPath
// and inspect.ts, converted first); the eval oracle's Tier-0 render check did not, and had been
// grading a plan no export could produce. buildRenderCommand now normalises internally, so every
// time below is 30x smaller. `duration is 5 seconds` pins that interpretation by MEANING, so
// this can never quietly slide back on a future regeneration.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildRenderCommand } from "./render";
import type { Timeline } from "./model";

const GOLDEN = "src/timeline/__golden.export.txt";

function fixture(): Timeline {
  return {
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "c1",
            kind: "video",
            media_ref: "/a.mp4",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
            opacity: 0.8,
            rotate: 12,
            fade: { in: 6, out: 9 },
            transform: { position: { x: 0.4, y: 0.6 }, scale_x: 0.5, scale_y: 0.5 },
          },
          {
            id: "c2",
            kind: "video",
            media_ref: "/b.png",
            timeline_in: 60,
            timeline_out: 120,
            crop: { left: 0.1, right: 0.05, top: 0, bottom: 0 },
            opacity: [
              { t: 0, v: 0 },
              { t: 30, v: 1 },
            ],
            rotate: [
              { t: 0, v: 0 },
              { t: 30, v: 45 },
            ],
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        z: 0,
        clips: [
          {
            id: "a-const",
            kind: "audio",
            media_ref: "/m.mp3",
            timeline_in: 0,
            timeline_out: 60,
            source_in: 0,
            source_out: 60,
            volume: 0.5,
            fade: { in: 3, out: 4 },
          },
          {
            id: "a-kf",
            kind: "audio",
            media_ref: "/n.mp3",
            timeline_in: 60,
            timeline_out: 150,
            source_in: 0,
            source_out: 90,
            volume: [
              { t: 0, v: 1 },
              { t: 45, v: 0.2 },
              { t: 90, v: 0.9 },
            ],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

describe("export golden", () => {
  it("emits byte-identical ffmpeg for a dense timeline", () => {
    const cmd = buildRenderCommand(fixture(), "/out.mp4");
    const actual = `${cmd.duration}\n${cmd.filterComplex}\n${cmd.args.join(" ")}\n`;
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, actual);
    // What is frozen here is the ffmpeg command, not how git chose to store the file: with no
    // .gitattributes, a Windows checkout rewrites this to CRLF and the compare fails on bytes
    // that have nothing to do with the render.
    expect(actual).toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n"));
  });

  it("still renders a keyframed volume as an envelope, not a level", () => {
    // The one line of the golden file that changed when this was first taken. Pinned by
    // meaning as well as by bytes, so a regenerated golden cannot quietly bury it.
    const { filterComplex } = buildRenderCommand(fixture(), "/out.mp4");
    expect(filterComplex).toContain("eval=frame");
    expect(filterComplex).toContain("volume=0.5000"); // ...and a constant is still a constant
  });

  it("reads the fixture's frames as frames", () => {
    // The fixture is 150 frames at 30fps. Stated as a RULE rather than as bytes: whoever
    // regenerates the golden next cannot reintroduce the 150-second misreading without this
    // failing, and it says plainly which number is the right one.
    const plan = buildRenderCommand(fixture(), "/out.mp4");
    expect(plan.duration).toBe(5);
    expect(plan.filterComplex).toContain("d=5.000000");
  });
});
