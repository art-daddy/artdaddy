// The paid looks (video_ask, video_find_moment) as a person meets them: the app asks before it
// spends, Deny sends nothing, Allow sends one request whose answer comes back in the right units.
// The vision proxy (/ai/vision_video) is answered by the test with what the vision model would
// have written (lib/vision.ts): no vendor is ever reached. Judged on what the app sent the proxy
// (the clip itself, probed) and what it told the model.
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
import { sentClip, visionAnswers } from "./lib/vision";

const inBrowser = (what: string): string => `vision: ${what} [${test.info().project.name}]`;
const paidCalls = (qa: AgentRig) => qa.server.requests("/ai/").filter((s) => !/quote/.test(s.path));

async function projectWithClip(
  qa: AgentRig,
  name: string,
  where: Parameters<typeof placeSpoken>[2] = {},
) {
  // The approval card itself is the agent lane's, in both engines; what is tested here is tool logic.
  chromiumCovers();
  await SpeechStandIn.install(qa);
  await qa.openProject(name);
  const ref = await attachSpoken(qa);
  const placed = await placeSpoken(qa, ref, where);
  return { ref, ...placed };
}

test.describe("the paid looks", () => {
  test.setTimeout(150_000);

  test("video_ask asks first; Deny sends nothing to the vision service and the assistant is told", async ({
    qa,
  }) => {
    const { video } = await projectWithClip(qa, "sweep_qa_vision_deny");
    const answered = visionAnswers(qa.server, "never sent");
    let told: Round["toolResults"] = [];
    qa.server.script(
      callTools([
        {
          name: "video_ask",
          arguments: { clip_id: video.id, prompt: "When does the picture turn green?" },
        },
      ]),
      (round: Round) => {
        told = round.toolResults;
        return say("OK, I will not look.");
      },
    );
    const asked = startTimer(inBrowser("approval prompt appears for video_ask"));
    await qa.send("When does it turn green?");
    const deny = qa.pane.getByRole("button", { name: "Deny", exact: true });
    await expect(deny).toBeVisible({ timeout: 30_000 });
    asked.stop();
    await expect(qa.pane.getByText("This spends your credits.")).toBeVisible();
    expect(paidCalls(qa)).toHaveLength(0);
    await deny.click();
    await expect(qa.reply("OK, I will not look.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      name: "video_ask",
      result: { ok: false, error: "user denied this tool call" },
    });
    expect(paidCalls(qa)).toHaveLength(0);
    expect(answered).toHaveLength(0);
    expect(qa.server.requests("/uploads")).toHaveLength(0);
  });

  test("video_ask allowed: one request, a silent copy of the clip, and the moment comes back in project frames for a placed clip", async ({
    qa,
  }) => {
    // The clip starts at frame 60 of the timeline, untrimmed: source second 4 is project frame 60 + 4 x fps.
    const { video, fps } = await projectWithClip(qa, "sweep_qa_vision_ask", { timeline_in: 60 });
    const answered = visionAnswers(
      qa.server,
      "The picture turns green at 00:04.000 and blue at 00:08.000.",
    );
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([
        {
          name: "video_ask",
          arguments: { clip_id: video.id, prompt: "When does the colour change?" },
        },
      ]),
      (round: Round) => {
        told = resultOf(round, "video_ask");
        return say("It turns green, then blue.");
      },
    );
    await qa.send("When does the colour change?");
    await qa.pane.getByRole("button", { name: "Allow", exact: true }).click({ timeout: 30_000 });
    const looked = startTimer(inBrowser("Allow on video_ask to the answer, vision stand-in"));
    await expect(qa.reply("It turns green, then blue.")).toBeVisible({ timeout: 90_000 });
    looked.stop();
    await qa.idle();

    expect(answered.map((a) => a.name)).toEqual(["vision_video"]);
    const clip = sentClip(answered[0].body);
    expect(clip.duration).toBeGreaterThan(11);
    expect(told.ok, JSON.stringify(told)).toBe(true);
    expect(told.timing).toBe("project_frames");
    expect(told.timestamps_found).toEqual([
      { text: "00:04.000", frame: 60 + 4 * fps },
      { text: "00:08.000", frame: 60 + 8 * fps },
    ]);
  });

  test("video_ask on a window of a placed clip: the moment it names is placed where it is in the clip", async ({
    qa,
  }) => {
    knownBug(
      "art-daddy/backlog#39: a video_ask with a time window on a clip returns frames early by the window's start",
      /timestamps_found/,
    );
    const { video, fps } = await projectWithClip(qa, "sweep_qa_vision_window", { timeline_in: 60 });
    // The window is source 6 s to 10 s. The vision model sees a 4 s clip of its own, so the blue
    // that starts at source 8 s is at 00:02.000 in what it was sent.
    const answered = visionAnswers(qa.server, "It turns blue at 00:02.000.");
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([
        {
          name: "video_ask",
          arguments: {
            clip_id: video.id,
            prompt: "When does it turn blue?",
            start_seconds: 6,
            end_seconds: 10,
          },
        },
      ]),
      (round: Round) => {
        told = resultOf(round, "video_ask");
        return say("It turns blue there.");
      },
    );
    await qa.send("When does it turn blue, after second 6?");
    await qa.pane.getByRole("button", { name: "Allow", exact: true }).click({ timeout: 30_000 });
    await expect(qa.reply("It turns blue there.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    // What was sent is the window alone, its clock starting at 0: the model's times are the window's.
    const clip = sentClip(answered[0].body);
    expect(clip.duration).toBeGreaterThan(3.5);
    expect(clip.duration).toBeLessThan(4.5);
    expect(told.ok, JSON.stringify(told)).toBe(true);
    expect(told.timestamps_found, "timestamps_found").toEqual([
      { text: "00:02.000", frame: 60 + 8 * fps },
    ]);
  });

  test("video_find_moment allowed: the best moment and its shots come back in project frames, through the clip's trim", async ({
    qa,
  }) => {
    // Source 2 s to 12 s plays from frame 60: source second s is frame 60 + (s - 2) x fps.
    const { video, fps } = await projectWithClip(qa, "sweep_qa_vision_moment", {
      timeline_in: 60,
      source_span: [2, 12],
    });
    const answered = visionAnswers(
      qa.server,
      [
        "## Moment 1  00:04.000 \u2013 00:08.000",
        "**Why:** the whole green scene, steady and clear.",
        "",
        "**Shot 1**",
        "*   **Timestamp:** 00:04.000 \u2013 00:08.000",
        "*   **What is in frame:** a flat green field filling the frame",
        "*   **On-screen text:** none",
        "*   **Tone/mood:** calm static",
      ].join("\n"),
    );
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([
        { name: "video_find_moment", arguments: { clip_id: video.id, query: "the green part" } },
      ]),
      (round: Round) => {
        told = resultOf(round, "video_find_moment");
        return say("Found the green part.");
      },
    );
    await qa.send("Find the green part");
    await qa.pane.getByRole("button", { name: "Allow", exact: true }).click({ timeout: 30_000 });
    const found = startTimer(
      inBrowser("Allow on video_find_moment to the answer, vision stand-in"),
    );
    await expect(qa.reply("Found the green part.")).toBeVisible({ timeout: 90_000 });
    found.stop();
    await qa.idle();
    expect(answered.map((a) => a.name)).toEqual(["vision_video"]);
    expect(told.ok, JSON.stringify(told)).toBe(true);
    expect(told.timing).toBe("project_frames");
    const [moment] = told.moments as Array<Record<string, unknown>>;
    const at = (s: number) => 60 + Math.round((s - 2) * fps);
    expect(moment).toMatchObject({ start_frame: at(4), end_frame: at(8) });
    expect(moment.shots).toEqual([expect.objectContaining({ in_frame: at(4), out_frame: at(8) })]);
  });

  test("when the vision service refuses, the assistant is told the reason, the call is not repeated, and the turn goes on", async ({
    qa,
  }) => {
    const { video } = await projectWithClip(qa, "sweep_qa_vision_refused");
    const answered = visionAnswers(qa.server, () => ({
      status: 403,
      body: { detail: "Request rejected in accordance with our terms of use and policies" },
    }));
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "video_ask", arguments: { clip_id: video.id, prompt: "What happens?" } }]),
      (round: Round) => {
        told = resultOf(round, "video_ask");
        return say("The video service refused that clip.");
      },
    );
    await qa.send("What happens in this clip?");
    await qa.pane.getByRole("button", { name: "Allow", exact: true }).click({ timeout: 30_000 });
    await expect(qa.reply("The video service refused that clip.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    expect(answered).toHaveLength(1);
    expect(told.ok).toBe(false);
    expect(String(told.error)).toMatch(/rejected|refus|403/i);
  });
});
