// The agent changing the project: an edit that lands, survives a restart and is undone; an edit
// the tools refuse. Judged on the saved project (internals/timeline.json) and on the screen.
import path from "node:path";

import { addClips } from "./fixtures/replies/addClips";
import { addTitle } from "./fixtures/replies/addTitle";
import { addTrack } from "./fixtures/replies/addTrack";
import { badArgument, unknownTool } from "./fixtures/replies/badToolCall";
import { plainText } from "./fixtures/replies/plainText";
import { say, type Round } from "./lib/reply";
import { expect, test, type SavedTimeline } from "./lib/qa";
import { inBrowser, startTimer } from "./lib/waits";

const STILL = path.resolve("e2e/ui/agent-and-models/fixtures/media/still.png");

const clipsOf = (tl: SavedTimeline | null) =>
  (tl?.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => ({ track: String(t.id), ...c })));

test.describe("the agent edits the project", () => {
  test.setTimeout(120_000);

  test("add_track then add_clips: the picture lands on the timeline, unasked, and is still there after a restart", async ({
    qa,
  }) => {
    const id = await qa.openProject();
    await qa.attach(STILL);
    const ref = String(
      (await qa.savedAssets(id)).find((a) => JSON.stringify(a).includes("still.png"))?.id ?? "",
    );
    expect(ref).toMatch(/^media_/);

    let newTrack = "";
    qa.server.script(
      addTrack("video"),
      (round: Round) => {
        newTrack = String(round.toolResults[0]?.result?.track_id ?? "");
        return addClips(ref, 90, newTrack);
      },
      plainText("Done: the picture opens the video for three seconds."),
    );
    const finished = startTimer(inBrowser("turn finished, add_track then add_clips"));
    await qa.send("Put this picture at the start for three seconds");
    await expect(qa.reply("Done: the picture opens the video for three seconds.")).toBeVisible({
      timeout: 20_000,
    });
    await qa.idle();
    finished.stop();

    // Ordinary edits ran without a prompt: three rounds with no click in between, no Allow/Deny.
    expect(qa.server.modelRounds()).toHaveLength(3);
    await expect(qa.page.getByRole("button", { name: "Deny" })).toHaveCount(0);
    expect(newTrack, "add_track did not report the track it made").not.toBe("");
    // The two calls fold into one line with a success mark; opening it shows each call.
    const row = qa.pane.getByRole("button", { name: /Added track v2 and 1 more/ });
    await expect(row).toBeVisible();
    await row.click();
    await expect(qa.pane.locator("code", { hasText: /^add_track$/ })).toBeVisible();
    await expect(qa.pane.locator("code", { hasText: /^add_clips$/ })).toBeVisible();
    await expect(qa.page.getByText(/3 tracks · 1 clips/)).toBeVisible();

    // The saved timeline holds the edit: the picture on the new track, frames [0, 90).
    await expect
      .poll(async () => clipsOf(await qa.savedTimeline(id)).length, { timeout: 10_000 })
      .toBe(1);
    const [placed] = clipsOf(await qa.savedTimeline(id));
    expect(placed).toMatchObject({
      track: newTrack,
      media_ref: ref,
      timeline_in: 0,
      timeline_out: 90,
    });
    await expect(qa.timelineClip(String(placed.id))).toBeVisible();

    // Quit, start again, open the project: the edit and the conversation are both still there.
    const reopened = startTimer(inBrowser("restart and reopen a project with an agent edit"));
    const again = await qa.reopen();
    expect(again).toBe(id);
    await expect(qa.timelineClip(String(placed.id))).toBeVisible({ timeout: 20_000 });
    reopened.stop();
    await expect(qa.reply("Done: the picture opens the video for three seconds.")).toBeVisible();
    expect(clipsOf(await qa.savedTimeline(id))).toEqual([placed]);
  });

  test("a title edit runs without an approval prompt, and the turn goes on by itself", async ({
    qa,
  }) => {
    qa.server.script(addTitle("Summer in the hills"), plainText("The title is on."));
    const id = await qa.openProject();
    await qa.send("Put a title at the start");
    await expect(qa.reply("The title is on.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    expect(qa.server.modelRounds()).toHaveLength(2);
    await expect(qa.page.getByRole("button", { name: "Deny" })).toHaveCount(0);
    await expect
      .poll(async () => clipsOf(await qa.savedTimeline(id)).map((c) => c.kind))
      .toEqual(["text"]);
  });

  test("a tool call with a made-up argument or a made-up tool is refused, shown, changes nothing, and the turn carries on", async ({
    qa,
  }) => {
    const id = await qa.openProject();
    const before = JSON.stringify(await qa.savedTimeline(id));
    let told: Round["toolResults"] = [];
    qa.server.script(
      badArgument(),
      (round: Round) => {
        told = round.toolResults;
        return unknownTool();
      },
      (round: Round) => {
        told = [...told, ...round.toolResults];
        return say("Sorry, those tools did not work, so nothing was changed.");
      },
    );
    await qa.send("Add a red video track");
    await expect(qa.reply("Sorry, those tools did not work, so nothing was changed.")).toBeVisible({
      timeout: 15_000,
    });
    await qa.idle();

    // Both failures are on screen, not hidden behind a success mark.
    await expect(qa.pane.getByText("Couldn't add a track")).toBeVisible();
    await expect(qa.pane.getByText(/colour/).first()).toBeVisible();
    // The model was told the truth: both calls answered ok:false with a reason.
    expect(told).toHaveLength(2);
    for (const r of told) {
      expect(r.result.ok).toBe(false);
      expect(String(r.result.error ?? "")).not.toBe("");
    }
    expect(JSON.stringify(told[1].result)).toMatch(/make_it_pop/);
    // Nothing reached the project.
    expect(JSON.stringify(await qa.savedTimeline(id))).toBe(before);
  });

  test("Undo takes the agent's edit back off the saved timeline, and Redo puts it back", async ({
    qa,
  }) => {
    qa.server.script(addTitle("Summer in the hills"), plainText("The title is on."));
    const id = await qa.openProject();
    const before = await qa.savedTimeline(id);
    await qa.send("Put a title at the start");
    await expect(qa.reply("The title is on.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    await expect.poll(async () => clipsOf(await qa.savedTimeline(id)).length).toBe(1);
    const edited = await qa.savedTimeline(id);
    const [title] = clipsOf(edited);
    await expect(qa.timelineClip(String(title.id))).toBeVisible();

    await qa.pane.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(qa.timelineClip(String(title.id))).toHaveCount(0);
    await expect.poll(async () => (await qa.savedTimeline(id))?.tracks).toEqual(before?.tracks);

    await qa.pane.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(qa.timelineClip(String(title.id))).toBeVisible();
    await expect.poll(async () => (await qa.savedTimeline(id))?.tracks).toEqual(edited?.tracks);
  });
});
