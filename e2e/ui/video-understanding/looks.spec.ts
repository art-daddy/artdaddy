// The free looks (inspect_media, inspect_timeline, inspect_color): what the assistant SEES when it
// looks at a clip. They run on this machine (the shipped ffmpeg through the QA shell) and send the
// model pictures; the test finds those pictures in what the app sent the model and measures their
// colour. The clip is red (0-4 s), green (4-8 s) and blue (8-12 s), so a picture at the wrong
// moment, or with no colour, shows.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { expect, knownBug, test, type AgentRig } from "../agent-and-models/lib/qa";
import { callTools, say, type Round } from "../agent-and-models/lib/reply";
import { startTimer } from "../../lib/timing";
import {
  attachSpoken,
  chromiumCovers,
  placeSpoken,
  resultOf,
} from "../captions-and-transcription/lib/rig";
import { SpeechStandIn } from "../captions-and-transcription/lib/speech";
import { colourName, meanColour, picturesIn } from "./lib/vision";

const inBrowser = (what: string): string => `vision: ${what} [${test.info().project.name}]`;

async function projectWithClip(qa: AgentRig, name: string) {
  chromiumCovers();
  await SpeechStandIn.install(qa);
  await qa.openProject(name);
  const ref = await attachSpoken(qa);
  return { ref, ...(await placeSpoken(qa, ref)) };
}

/** Run one look as the model asks for it; returns its result and the pictures that round carried. */
async function look(
  qa: AgentRig,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; pictures: Buffer[]; ms: number }> {
  let result: Record<string, unknown> = {};
  let pictures: Buffer[] = [];
  qa.server.script(callTools([{ name: tool, arguments: args }]), (round: Round) => {
    result = resultOf(round, tool);
    // The pictures travel beside the round's input (its attachments), not inside the tool result.
    pictures = picturesIn(round.body);
    return say(`Looked with ${tool}.`);
  });
  const t0 = Date.now();
  const tStart = performance.now();
  const wait = startTimer(inBrowser(`${tool} to the assistant's next answer, 12 s clip`));
  await qa.send(`Look at it (${tool})`);
  await expect(qa.reply(`Looked with ${tool}.`)).toBeVisible({ timeout: 90_000 });
  wait.stop();
  await qa.idle();
  await test.info().attach(`${tool}-result.json`, {
    body: JSON.stringify(
      result,
      (_k, v) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v),
      2,
    ),
    contentType: "application/json",
  });
  // Where the wait went: every shipped tool the look ran, how long each took.
  const runs = qa.shell.sidecarRuns
    .filter((r) => r.at >= tStart)
    .map((r) => ({
      program: r.program,
      ms: r.ended ? Math.round(r.ended.at - r.at) : null,
      args: r.args.join(" ").slice(0, 160),
    }));
  writeFileSync(test.info().outputPath(`${tool}-sidecars.json`), JSON.stringify(runs, null, 2));
  return { result, pictures, ms: Date.now() - t0 };
}

test.describe("the free looks", () => {
  test.setTimeout(150_000);

  test("inspect_media on a placed clip: the frames are the clip's moments, the times are project frames, nothing is paid", async ({
    qa,
  }) => {
    const { video, fps } = await projectWithClip(qa, "sweep_qa_look_media");
    const { result, pictures } = await look(qa, "inspect_media", {
      clip_id: video.id,
      max_frames: 6,
    });
    expect(result.ok, JSON.stringify(result).slice(0, 500)).not.toBe(false);
    expect(JSON.stringify(result)).toMatch(/frame/);
    expect(pictures.length).toBeGreaterThanOrEqual(3);
    expect(qa.server.requests("/ai/")).toHaveLength(0);
    // Every time it reports is a project frame inside the clip.
    const times = [
      ...JSON.stringify(result).matchAll(
        /"(?:frame|t_frame|at_frame|start_frame|end_frame)":(\d+)/g,
      ),
    ].map((m) => Number(m[1]));
    for (const f of times) expect(f).toBeLessThanOrEqual(video.timeline_out + fps);
  });

  test("inspect_media: the frames the assistant is sent show the clip's colours", async ({
    qa,
  }) => {
    knownBug(
      "inspect_media sends the assistant grey frames of a colour video (the grey sharpness branch reaches the frames)",
      /colours seen/,
    );
    const { video } = await projectWithClip(qa, "sweep_qa_look_colour");
    const { pictures } = await look(qa, "inspect_media", { clip_id: video.id, max_frames: 6 });
    // Not the bug: the assistant must have been sent frames at all.
    expect(pictures.length, "no frames were sent").toBeGreaterThanOrEqual(3);
    const named = pictures.map((p) => colourName(meanColour(p)));
    expect(new Set(named), `colours seen: ${named.join(", ")}`).toEqual(
      new Set(["red", "green", "blue"]),
    );
  });

  test("inspect_timeline: the picture at a frame is what the timeline shows there, in colour", async ({
    qa,
  }) => {
    const { fps } = await projectWithClip(qa, "sweep_qa_look_timeline");
    const green = await look(qa, "inspect_timeline", { start_frame: Math.round(6 * fps) });
    expect(green.result.ok, JSON.stringify(green.result).slice(0, 500)).not.toBe(false);
    expect(green.pictures.length).toBeGreaterThanOrEqual(1);
    expect(colourName(meanColour(green.pictures[green.pictures.length - 1]))).toBe("green");
    const blue = await look(qa, "inspect_timeline", { start_frame: Math.round(10 * fps) });
    expect(colourName(meanColour(blue.pictures[blue.pictures.length - 1]))).toBe("blue");
  });

  test("inspect_color on a placed clip: the measured look is the clip's red, and its picture too", async ({
    qa,
  }) => {
    const { video, fps } = await projectWithClip(qa, "sweep_qa_look_colour_read");
    const { result, pictures } = await look(qa, "inspect_color", {
      clip_id: video.id,
      at_frame: Math.round(2 * fps),
    });
    expect(result.ok, JSON.stringify(result).slice(0, 500)).not.toBe(false);
    expect(pictures.length).toBeGreaterThanOrEqual(1);
    expect(colourName(meanColour(pictures[pictures.length - 1]))).toBe("red");
  });
});
