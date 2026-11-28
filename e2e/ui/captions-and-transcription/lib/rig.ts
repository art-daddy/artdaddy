// Helpers of the captions lane: put the spoken clip in a project the way a person does (the
// paperclip, then an agent edit on a scripted reply), and read captions back from what the app
// SAVED (internals/timeline.json). Built on the agent lane's rig (../../agent-and-models/lib).
import { expect, test, type AgentRig, type SavedTimeline } from "../../agent-and-models/lib/qa";
import { callTools, say, type Reply, type Round } from "../../agent-and-models/lib/reply";
import { SPOKEN_CLIP } from "./speech";

export interface PlacedClip extends Record<string, unknown> {
  id: string;
  track: string;
  trackKind: string;
  timeline_in: number;
  timeline_out: number;
}

export function clipsOf(tl: SavedTimeline | null): PlacedClip[] {
  return (tl?.tracks ?? []).flatMap((t) =>
    (t.clips ?? []).map(
      (c) =>
        ({
          ...c,
          id: String(c.id),
          track: String(t.id),
          trackKind: String(t.kind),
          timeline_in: Number(c.timeline_in),
          timeline_out: Number(c.timeline_out),
        }) as PlacedClip,
    ),
  );
}

/** The captions on the saved timeline, in time order. */
export function captionsOf(tl: SavedTimeline | null): PlacedClip[] {
  return clipsOf(tl)
    .filter((c) => typeof c.caption_group === "string" && c.caption_group)
    .sort((a, b) => a.timeline_in - b.timeline_in);
}

/** What a caption says, its runs joined as they are drawn. */
export function captionText(c: Record<string, unknown>): string {
  const content = c.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((r) => String((r as { text?: unknown }).text ?? ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  return "";
}

/** Words as a person reads them: lower case, no punctuation. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function fpsOf(tl: SavedTimeline | null): number {
  const fps = Number((tl as { canvas?: { fps?: unknown } } | null)?.canvas?.fps);
  return fps > 0 ? fps : 30;
}

/** Attach the spoken clip with the paperclip, as a person does; returns its library ref. */
export async function attachSpoken(qa: AgentRig): Promise<string> {
  await qa.attach(SPOKEN_CLIP);
  const ref = String(
    (await qa.savedAssets()).find((a) => JSON.stringify(a).includes("spoken_scenes"))?.id ?? "",
  );
  expect(ref, "the attached clip is not in the library").toMatch(/^media_/);
  return ref;
}

export interface Placement {
  timeline_in?: number;
  /** [startSeconds, endSeconds] of the source to use (a trimmed clip). */
  source_span?: [number, number];
}

/** The model places the clip (add_clips), and says so. */
export function placeClip(ref: string, where: Placement = {}): Reply {
  return callTools([
    {
      name: "add_clips",
      arguments: {
        entries: [
          {
            media_ref: ref,
            timeline_in: where.timeline_in ?? 0,
            ...(where.source_span ? { source_span: where.source_span } : {}),
          },
        ],
      },
    },
  ]);
}

/** Ask the app to place the spoken clip and wait until it is on the saved timeline. Returns the
 *  video clip and its linked audio clip. */
export async function placeSpoken(
  qa: AgentRig,
  ref: string,
  where: Placement = {},
): Promise<{ video: PlacedClip; audio: PlacedClip; fps: number }> {
  qa.server.script(placeClip(ref, where), say("The clip is on the timeline."));
  await qa.send("Put my clip on the timeline");
  await expect(qa.reply("The clip is on the timeline.")).toBeVisible({ timeout: 30_000 });
  await qa.idle();
  let placed: PlacedClip[] = [];
  await expect
    .poll(
      async () => {
        placed = clipsOf(await qa.savedTimeline()).filter((c) => c.media_ref === ref);
        return placed.map((c) => c.trackKind).sort();
      },
      { timeout: 15_000 },
    )
    .toEqual(["audio", "video"]);
  const tl = await qa.savedTimeline();
  return {
    video: placed.find((c) => c.trackKind === "video")!,
    audio: placed.find((c) => c.trackKind === "audio")!,
    fps: fpsOf(tl),
  };
}

/** The tool results the model was sent back in this round, by tool name. */
export function resultOf(round: Round, tool: string): Record<string, unknown> {
  const hit = round.toolResults.find((r) => r.name === tool);
  if (!hit)
    throw new Error(
      `the round carried no ${tool} result (it carried ${round.toolResults.map((r) => r.name).join(", ") || "none"})`,
    );
  return hit.result;
}

/** For a test of tool logic that runs the same in every engine (what the app asks the speech engine, the
 *  times it computes, what it tells the model): Chromium covers it, and WebKit skips it, to spare CI's
 *  shared macOS runners. Tests of what the person sees and clicks run in both. */
export function chromiumCovers(): void {
  test.skip(
    test.info().project.name !== "chromium",
    "the same tool logic in every engine: Chromium covers it (CI's macOS runners are shared)",
  );
}

/** The person asks for captions and the assistant (a scripted reply) calls add_captions with `args`.
 *  Resolves with what the tool answered and the captions saved. */
export async function captionsByAssistant(
  qa: AgentRig,
  args: Record<string, unknown> = {},
): Promise<{ told: Record<string, unknown>; captions: PlacedClip[] }> {
  let told: Record<string, unknown> = {};
  qa.server.script(callTools([{ name: "add_captions", arguments: args }]), (round: Round) => {
    told = resultOf(round, "add_captions");
    return say("Captions are on.");
  });
  await qa.send("Add captions");
  await expect(qa.reply("Captions are on.").last()).toBeVisible({ timeout: 90_000 });
  await qa.idle();
  expect(told.ok, JSON.stringify(told).slice(0, 400)).not.toBe(false);
  let captions: PlacedClip[] = [];
  await expect
    .poll(async () => (captions = captionsOf(await qa.savedTimeline())).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  return { told, captions };
}
