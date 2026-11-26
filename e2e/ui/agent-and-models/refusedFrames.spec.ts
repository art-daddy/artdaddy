// A picture the AI provider refused (UJ-046): the agent looked at a video, the provider refused one
// of the frames, and the server named it. The app must mark it, say so once, and never send it
// again, or every later message in the chat fails the same way. inspect_media runs the shipped
// ffmpeg on a real fixture video, so the frames are real pictures.
import path from "node:path";

import { plainText } from "./fixtures/replies/plainText";
import { callIdsOf, callTools, say, type Round } from "./lib/reply";
import { expect, test } from "./lib/qa";

const VIDEO = path.resolve("e2e/ui/agent-and-models/fixtures/media/two_seconds.mp4");

type Frame = { call_id?: string; index?: number; b64?: string };
/** The pictures a round carried: this round's own and the history's. */
function framesOf(body: unknown): Frame[] {
  const b = (body ?? {}) as { attachments?: Frame[]; history_frames?: Frame[] };
  return [...(b.attachments ?? []), ...(b.history_frames ?? [])];
}

test("a picture the provider refused is marked, said once, and never sent again", async ({
  qa,
}) => {
  test.setTimeout(120_000);
  const id = await qa.openProject();
  await qa.attach(VIDEO);
  const ref = String(
    (await qa.savedAssets(id)).find((a) => JSON.stringify(a).includes("two_seconds.mp4"))?.id ?? "",
  );
  expect(ref).toMatch(/^media_/);

  const look = callTools([{ name: "inspect_media", arguments: { media_ref: ref, max_frames: 2 } }]);
  const [lookId] = callIdsOf(look);
  let second: Round | null = null;
  qa.server.script(look, (round: Round) => {
    second = round;
    return say("I can see a moving test pattern.", {
      refusedFrames: [{ call_id: lookId, index: 0 }],
    });
  });
  await qa.send("Look at the video and tell me what is in it");
  await expect(qa.reply("I can see a moving test pattern.")).toBeVisible({ timeout: 60_000 });
  await qa.idle();

  // The look really produced pictures, and they went to the model with the next round.
  const shown = framesOf((second as Round | null)?.body).filter((f) => f.call_id === lookId);
  expect(shown.map((f) => f.index).sort()).toEqual([0, 1]);
  expect(shown.every((f) => typeof f.b64 === "string" && f.b64.length > 100)).toBe(true);
  // Said once, in plain words.
  await expect(
    qa.pane.getByText(
      "The AI provider refused 1 picture from this conversation, so it is left out of every message from now on.",
    ),
  ).toHaveCount(1);

  let third: Round | null = null;
  qa.server.script((round: Round) => {
    third = round;
    return plainText("Carrying on without that frame.");
  });
  await qa.send("OK, carry on");
  await expect(qa.reply("Carrying on without that frame.")).toBeVisible({ timeout: 15_000 });
  await qa.idle();
  const after = framesOf((third as Round | null)?.body).filter((f) => f.call_id === lookId);
  expect(after.map((f) => f.index)).toEqual([1]);

  // The mark is saved with the conversation, so a restart does not bring the picture back.
  await expect
    .poll(() => qa.savedTranscriptText(id), { timeout: 10_000 })
    .toContain('"refused":true');
});
