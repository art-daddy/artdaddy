// Starting a turn in the assistant pane, as a person does: type, press Enter or Send, watch the
// answer form, and find the conversation saved with the project. The model is a scripted reply
// on a local fake server (lib/fakeServer.ts); nothing here reaches a real model.
import path from "node:path";

import { addTitle } from "./fixtures/replies/addTitle";
import { LONG_REPLY_LAST_LINE, longReply } from "./fixtures/replies/longReply";
import { plainText } from "./fixtures/replies/plainText";
import { slowFirstToken } from "./fixtures/replies/slowFirstToken";
import { say } from "./lib/reply";
import { expect, test } from "./lib/qa";
import { inBrowser, startTimer } from "./lib/waits";

const STILL = path.resolve("e2e/ui/agent-and-models/fixtures/media/still.png");

type RoundBody = {
  round_input?: { user_text?: string; extra_texts?: string[] };
  model?: string;
  effort?: string;
  catalog_id?: string;
  history_mode?: string;
};
const bodyOf = (b: unknown): RoundBody => (b ?? {}) as RoundBody;

test.describe("starting a turn", () => {
  test.setTimeout(90_000);

  test("Enter sends the prompt with the project's state; the reply streams in and is saved", async ({
    qa,
  }) => {
    const answer =
      "Your timeline is empty, so there is nothing to cut yet. Import a clip and I will trim it.";
    qa.server.script(say(answer, { gapMs: 150 }));
    const id = await qa.openProject();

    await qa.composer.fill("What can I cut?");
    const firstWord = startTimer(inBrowser("first visible reply"));
    const finished = startTimer(inBrowser("turn finished, a short streamed reply"));
    await qa.composer.press("Enter");

    // The prompt shows at once, and the answer forms word by word: the first words are on screen
    // while the rest of the sentence has not arrived yet.
    await expect(qa.pane.getByText("What can I cut?", { exact: true })).toBeVisible();
    await expect(qa.reply(/^Your timeline/)).toBeVisible({ timeout: 15_000 });
    firstWord.stop();
    await expect(qa.reply(answer)).toHaveCount(0);
    await expect(qa.reply(answer)).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    finished.stop();
    await expect(qa.composer).toHaveValue("");

    // What the agent was sent: the person's words, then the project the app read for it.
    const rounds = qa.server.modelRounds();
    expect(rounds).toHaveLength(1);
    const body = bodyOf(rounds[0].body);
    const text = body.round_input?.user_text ?? "";
    expect(text.startsWith("What can I cut?")).toBe(true);
    expect(text).toContain("[Project state");
    expect(text).toContain(`"project_id":"${id}"`);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.effort).toBe("medium");
    expect(body.catalog_id).toMatch(/^[0-9a-f]{64}$/);

    // What the project kept: the exchange, in order, with the whole answer.
    await expect.poll(() => qa.savedTranscriptText(id), { timeout: 10_000 }).toContain(answer);
    const saved = await qa.savedTranscript(id);
    expect(saved?.requests).toHaveLength(1);
    expect(saved?.requests?.[0].message?.text).toBe("What can I cut?");
    expect(saved?.requests?.[0].response).toContainEqual(
      expect.objectContaining({ kind: "text", text: answer }),
    );
  });

  test("a slow first word: the person sees 'Thinking' until it comes, then the answer", async ({
    qa,
  }) => {
    const delay = 3000;
    qa.server.script(slowFirstToken(delay));
    await qa.openProject();
    await qa.composer.fill("Is my project ready to export?");
    const firstWord = startTimer(inBrowser("first visible reply after a 3 s first token"));
    const t0 = Date.now();
    await qa.sendButton.click();

    // While the socket is silent the pane says what it is waiting on, and Stop is offered.
    await expect(qa.pane.getByRole("status")).toHaveText(/Thinking/, { timeout: 2000 });
    await expect(qa.stopButton).toBeVisible();
    await expect(qa.reply(/Sorry for the wait/)).toBeVisible({ timeout: delay + 10_000 });
    const waited = firstWord.stop().ms;
    expect(
      Date.now() - t0,
      "the first word appeared before the server sent it",
    ).toBeGreaterThanOrEqual(delay - 200);
    // The app adds little of its own on top of the model's silence.
    expect(waited).toBeLessThan(delay + 5000);
    await expect(
      qa.reply("Sorry for the wait. I looked at the project: it has no clips yet."),
    ).toBeVisible();
    await qa.idle();
  });

  test("a long answer arrives whole, the pane follows it to the end, and it is saved whole", async ({
    qa,
  }) => {
    qa.server.script(longReply(40));
    const id = await qa.openProject();
    const finished = startTimer(inBrowser("turn finished, a 40-paragraph reply"));
    await qa.send("Give me a step by step plan for the whole edit.");
    await qa.idle();
    finished.stop();
    const last = qa.reply(LONG_REPLY_LAST_LINE);
    await expect(last).toBeVisible();
    await expect(last).toBeInViewport();
    await expect(qa.reply(/^Step 1\. Trim the opening of clip 1 /)).toHaveCount(1);
    await expect
      .poll(() => qa.savedTranscriptText(id), { timeout: 10_000 })
      .toContain(LONG_REPLY_LAST_LINE);
    const saved = await qa.savedTranscriptText(id);
    expect(saved).toContain("Step 39. Trim the opening of clip 39");
  });

  test("editor context picked with @ (a clip and the playhead) rides the message", async ({
    qa,
  }) => {
    qa.server.script(addTitle("Summer in the hills", 90), plainText("Added the title."));
    const id = await qa.openProject();
    await qa.send("Add a title");
    await expect(qa.reply("Added the title.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    const timeline = await qa.savedTimeline(id);
    const placed = (timeline?.tracks ?? []).flatMap((t) =>
      (t.clips ?? []).map((c) => ({ track: String(t.id), clip: String(c.id) })),
    );
    expect(placed, "the agent's title is not on the saved timeline").toHaveLength(1);
    const { track, clip } = placed[0];

    qa.server.script(plainText("I will shorten it."));
    await qa.page.getByTitle("Add editor context — playhead, range, clip, gap, or media").click();
    await qa.pane.getByRole("button", { name: new RegExp(`clip ${clip}`) }).click();
    await qa.page.getByTitle("Add editor context — playhead, range, clip, gap, or media").click();
    await qa.pane.getByRole("button", { name: /playhead/ }).click();
    await expect(qa.pane.getByText(`@clip ${clip}`)).toBeVisible();
    await expect(qa.pane.getByText(/^@playhead /)).toBeVisible();
    await qa.send("Make this shorter");
    await expect(qa.reply("I will shorten it.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();

    const text = bodyOf(qa.server.modelRounds().at(-1)?.body).round_input?.user_text ?? "";
    expect(text.startsWith("Make this shorter")).toBe(true);
    expect(text).toContain("Editor context the user attached to THIS message");
    expect(text).toContain(`clip ${clip} on track ${track}: frames [0, 90)`);
    expect(text).toMatch(/playhead: frame \d+ \(\d\d:\d\d:\d\d:\d\d\)/);
  });

  test("a picture attached with the paperclip comes in by reference and rides the message", async ({
    qa,
  }) => {
    qa.server.script(plainText("It is a test card with colour bars."));
    const id = await qa.openProject();
    await qa.attach(STILL);
    await qa.send("What is in this picture?");
    await expect(qa.reply("It is a test card with colour bars.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();

    // It came in by reference, as a desktop import does: a library row pointing at the file.
    const assets = await qa.savedAssets(id);
    const still = assets.find((a) => JSON.stringify(a).includes("still.png"));
    expect(still, "the attached picture is not in the saved library").toBeTruthy();
    expect(String(still?.id ?? "")).toMatch(/^media_/);

    // The agent is told a file is attached, and the project keeps the attachment with the message.
    const text = bodyOf(qa.server.modelRounds()[0].body).round_input?.user_text ?? "";
    expect(text).toContain("Attached file(s)");
    expect(text).toContain("image (still.png)");
    await expect.poll(() => qa.savedTranscriptText(id), { timeout: 10_000 }).toContain("still.png");
    const saved = await qa.savedTranscript(id);
    expect(JSON.stringify(saved?.requests?.[0].message)).toContain("still.png");
  });

  test("an attached picture is named to the agent by its library ref, never its path on disk", async ({
    qa,
  }) => {
    test.fail(
      true,
      "BUG: a file attached in the desktop app is sent to the agent as its absolute path on disk, not its media ref",
    );
    qa.server.script(plainText("It is a test card with colour bars."));
    const id = await qa.openProject();
    await qa.attach(STILL);
    await qa.send("What is in this picture?");
    await expect(qa.reply("It is a test card with colour bars.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    const ref = String(
      (await qa.savedAssets(id)).find((a) => JSON.stringify(a).includes("still.png"))?.id ?? "",
    );
    expect(ref).toMatch(/^media_/);
    const text = bodyOf(qa.server.modelRounds()[0].body).round_input?.user_text ?? "";
    // The manifest line says "Reference each by its ref in tools ... never a filesystem path", and
    // tool results already have absolute paths scrubbed (src/agent/scrubPaths.ts): the message
    // must hold to the same rule. A real user's line would carry C:/Users/<name>/... instead.
    const line = text.split("\n").find((l) => l.includes("image (still.png)")) ?? "";
    expect(line).toContain(ref);
    expect(text).not.toContain("/qa-home/");
  });
});
