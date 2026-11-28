// The studio stand-ins state facts of the case's own project from the case's timeline, read when the tool runs (so a
// change made during the run shows): get_project_state's canvas (a widescreen case used to be told 1080x1920), how long
// an export of the timeline runs (a 15 s timeline used to be said to run 10 s), the frame rate a transcript's frames
// are at, and the project frames a look at a placed clip reports (they assumed 30 fps and a clip placed whole at frame
// 0). A seed that places the footage whole at frame 0 at 30 fps is answered exactly as before.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Timeline } from "../timeline/model";
import { ClientToolRegistry } from "../tools/registry";
import { driveScripted } from "./reference";
import { ALL_SCENARIOS } from "./scenarios";
import { timeline, vclip, vtrack } from "./scenarios/helpers";
import {
  emptyStudioState,
  registerStudioStubs,
  STUDIO_MOMENT_FRAMES,
  timelineSeconds,
} from "./studio";

const widescreen = (): Timeline =>
  timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300), vclip("b", "b.mp4", 300, 450)])], {
    width: 1920,
    height: 1080,
    fps: 24,
  });

/** The footage placed late and trimmed at 24 fps: from frame 240, starting 1 s (24 frames) into the file. */
const placedLate = (): Timeline =>
  timeline(
    [vtrack("v1", 0, [vclip("late", "a.mp4", 240, 480, { source_in: 24, source_out: 264 })])],
    {
      width: 1920,
      height: 1080,
      fps: 24,
    },
  );

/** The studio stand-ins over a timeline the test can change between calls. */
function studioOver(initial: Timeline | null) {
  let current = initial;
  const registry = new ClientToolRegistry();
  registerStudioStubs(
    registry,
    emptyStudioState(),
    30,
    current ? async () => current as Timeline : undefined,
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await registry.run(name, args)) as Record<string, unknown>;
  return { call, set: (tl: Timeline) => (current = tl) };
}

type Moment = { start_frame: number; end_frame: number; peak_frame: number };
const momentOf = (reply: Record<string, unknown>) => (reply.moments as Moment[])[0];

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("network blocked in the studio stand-in test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy, "a stand-in reached the network").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("the studio stand-ins state the case's own project", () => {
  it("get_project_state reports the case's canvas, not a fixed vertical one", async () => {
    const { call } = studioOver(widescreen());
    const state = await call("get_project_state");
    expect(state.ok).toBe(true);
    expect(state.canvas).toMatchObject({ width: 1920, height: 1080, fps: 24 });
  });

  it("reads the canvas at every call, so a change made during the run shows", async () => {
    const { call, set } = studioOver(widescreen());
    const square = widescreen();
    square.canvas = { ...square.canvas, width: 1080, height: 1080 };
    set(square);
    expect((await call("get_project_state")).canvas).toMatchObject({ width: 1080, height: 1080 });
  });

  it("an export of the timeline says how long it runs, at the timeline's own frame rate", async () => {
    const { call } = studioOver(widescreen());
    const started = await call("export");
    expect(started).toMatchObject({ ok: true, status: "exporting" });
    expect(started.duration_s).toBe(18.75); // 450 frames at 24 fps
    expect(timelineSeconds(widescreen())).toBe(18.75);
  });

  it("an export of chosen clips is not said to run the timeline's length", async () => {
    const { call } = studioOver(widescreen());
    expect((await call("export", { clip_ids: ["a"] })).duration_s).not.toBe(18.75);
  });

  it("a transcript's frames are at the case's frame rate", async () => {
    const { call } = studioOver(widescreen());
    expect((await call("get_transcript")).fps).toBe(24);
  });

  it("a look at a placed clip reports where that clip puts the moment, at the case's frame rate", async () => {
    const { call } = studioOver(placedLate());
    // 3 s to 5 s into the file, peak at 4 s: frame 240 + (seconds * 24 - 24).
    const want = { start_frame: 288, end_frame: 336, peak_frame: 312 };
    expect(
      momentOf(await call("video_find_moment", { clip_id: "late", query: "liftoff" })),
    ).toMatchObject(want);
    const asked = await call("video_ask", {
      clip_id: "late",
      prompt: "when does it clear the tower?",
    });
    expect(asked.timestamps_found).toEqual([{ text: "clears the tower", frame: 312 }]);
    const looked = await call("inspect_media", {
      clip_id: "late",
      start_seconds: 3,
      end_seconds: 5,
    });
    const frames = (looked.frames as { frame: number }[]).map((f) => f.frame);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames)
      expect(f >= 288 && f <= 336, `frame ${f} is not 3-5 s into the file`).toBe(true);
    // A media_ref look stays in source seconds, whatever the clip.
    expect(
      momentOf(await call("video_find_moment", { media_ref: "a.mp4", query: "liftoff" })),
    ).toMatchObject({
      start_s: 3,
      end_s: 5,
    });
  });

  it("the footage placed whole at frame 0 at 30 fps is answered as before", async () => {
    const whole = timeline([vtrack("v1", 0, [vclip("a", "a.mp4", 0, 300)])]);
    for (const tl of [whole, null]) {
      const { call } = studioOver(tl);
      const moment = momentOf(await call("video_find_moment", { clip_id: "a", query: "liftoff" }));
      expect(moment).toMatchObject({
        start_frame: STUDIO_MOMENT_FRAMES.start,
        end_frame: STUDIO_MOMENT_FRAMES.end,
        peak_frame: STUDIO_MOMENT_FRAMES.peak,
      });
    }
  });

  it("passes a refused reply on as it was", async () => {
    const { call } = studioOver(widescreen());
    const refused = await call("export", { output_path: "relative/name.mp4" });
    expect(refused.ok).toBe(false);
    expect(refused).not.toHaveProperty("duration_s");
  });

  it("leaves every other tool's reply alone", async () => {
    const { call } = studioOver(widescreen());
    const look = await call("inspect_color", { clip_id: "a" });
    expect(look.ok).toBe(true);
    expect(look).not.toHaveProperty("canvas");
  });

  it("with no timeline to read, answers as it always did", async () => {
    const { call } = studioOver(null);
    expect((await call("get_project_state")).canvas).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect((await call("export")).duration_s).toBe(10);
    expect((await call("get_transcript")).fps).toBe(30);
  });
});

describe("through the harness, a widescreen case is told its canvas", () => {
  const WORK = path.resolve("reports", "eval", `studio-canvas-${process.pid}`);
  afterAll(() => fsp.rm(WORK, { recursive: true, force: true }));

  it("gen_widescreen_shot_matches_canvas: the read the agent makes says 1920x1080", async () => {
    const s = ALL_SCENARIOS.find((x) => x.id === "gen_widescreen_shot_matches_canvas")!;
    const { result } = await driveScripted(s, s.reference!, { workDir: WORK });
    const read = result.trace.toolCalls.find((c) => c.name === "get_project_state");
    expect(JSON.parse(read?.result ?? "{}").canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(result.passed).toBe(true);
  });
});
