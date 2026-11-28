// What happens to a generation after the turn that asked for it: the agent places the picture while
// it is still being made (the clip says so, then shows the picture), the app is quit and started
// again before it is ready (the same order is collected, never paid for twice), and the person
// presses Stop (a paid call already made is never thrown away). Judged on the saved project and on
// what the paid side saw. Nothing reaches a vendor.
import { STILL_PNG, imageAnswer } from "./lib/genDesk";
import { askImage } from "./fixtures/replies/generate";
import { addClips } from "../agent-and-models/fixtures/replies/addClips";
import { hangs, HANGING_WORDS } from "../agent-and-models/fixtures/replies/hangs";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import type { Round } from "../agent-and-models/lib/reply";
import { startTimer } from "../../lib/timing";
import { expect, knownBug, test, waitName, type GenRig } from "./lib/gen";
import type { SavedTimeline } from "../agent-and-models/lib/qa";

const clipsOf = (tl: SavedTimeline | null): Array<Record<string, unknown>> =>
  (tl?.tracks ?? []).flatMap((t) => t.clips ?? []);

/** The media_ref the image tool handed the model back. */
const refFrom = (round: Round): string =>
  String(
    (round.toolResults[0]?.result?.assets as Array<{ media_ref?: string }> | undefined)?.[0]
      ?.media_ref ?? "",
  );

/** Ask for a picture as an order and allow it; returns the placeholder's id once it is saved. */
async function startPicture(gen: GenRig, project: string): Promise<string> {
  await gen.allowButton.click();
  await expect.poll(async () => (await gen.generatedRows(project)).length).toBe(1);
  const [row] = await gen.generatedRows(project);
  expect(row.status).toBe("generating");
  return String(row.id);
}

test.describe("a generation after its turn", () => {
  test.setTimeout(150_000);

  test("placed while still being made: the clip says Generating…, then shows the picture, and the placement is kept", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer() });
    let ref = "";
    qa.server.script(
      askImage(),
      (round: Round) => {
        ref = refFrom(round);
        return addClips(ref, 90);
      },
      plainText("The picture is placed at the start; it will appear when it is ready."),
    );
    const id = await qa.openProject("sweep_qa_gen_place");
    await qa.send("Make an opening picture and put it at the start");
    await expect(gen.allowButton).toBeVisible({ timeout: 15_000 });
    await startPicture(gen, id);
    await expect(
      qa.reply("The picture is placed at the start; it will appear when it is ready."),
    ).toBeVisible({ timeout: 20_000 });
    await qa.idle();

    // The clip is on the timeline, pointing at the placeholder, and says the media is being made.
    expect(ref).toMatch(/^media_gen_/);
    await expect.poll(async () => clipsOf(await qa.savedTimeline(id)).length).toBe(1);
    const [clip] = clipsOf(await qa.savedTimeline(id));
    expect(clip).toMatchObject({ media_ref: ref, timeline_in: 0, timeline_out: 90 });
    const onTimeline = qa.timelineClip(String(clip.id));
    await expect(onTimeline.getByText("Generating…")).toBeVisible({ timeout: 10_000 });

    qa.server.script(plainText("The opening picture is in."));
    gen.desk.finish();
    const shown = startTimer(waitName("generation", "a placed picture from Generating… to done"));
    await expect(onTimeline.getByText("Generating…")).toHaveCount(0, { timeout: 30_000 });
    shown.stop();
    await expect(qa.reply("The opening picture is in.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    // The placement made while it was being made is the one kept: same clip, same id, same span.
    expect(clipsOf(await qa.savedTimeline(id))).toEqual([clip]);
    expect(await gen.fileOf((await gen.row(ref, id))!)).toEqual(STILL_PNG);
    expect(gen.desk.calls()).toHaveLength(1);
    // And the clip shows the picture now that it exists (a reopen shows it; the live clip should too).
    knownBug(
      "A picture placed while it was being made stays blank on the timeline after it lands, until the project is reopened",
      /the placed clip shows its picture once it has landed/,
    );
    await expect
      .poll(() => onTimeline.locator("img").count(), {
        message: "the placed clip shows its picture once it has landed",
        timeout: 6_000,
      })
      .toBe(1);
  });

  test("the app is quit while the picture is being made: after a restart the same order is collected, once, with no second paid call", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer() });
    qa.server.script(askImage(), plainText("The picture is on its way."));
    const name = "sweep_qa_gen_restart";
    const id = await qa.openProject(name);
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.allowButton).toBeVisible({ timeout: 15_000 });
    const ref = await startPicture(gen, id);
    await expect(qa.reply("The picture is on its way.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    const orderId = gen.desk.order().id;

    // Quit and start the app again while the server is still making it.
    const reopened = startTimer(waitName("generation", "restart with a generation running"));
    expect(await qa.reopen(name)).toBe(id);
    reopened.stop();
    // The app asks the server about the order it recorded; nothing is sent again.
    await expect.poll(() => gen.desk.order(orderId).polls, { timeout: 30_000 }).toBeGreaterThan(0);
    expect((await gen.row(ref, id))?.status).toBe("generating");

    qa.server.script(plainText("Noted."), plainText("Noted."));
    gen.desk.finish(orderId);
    await expect
      .poll(async () => (await gen.row(ref, id))?.status ?? "ready", { timeout: 30_000 })
      .toBe("ready");
    expect(await gen.fileOf((await gen.row(ref, id))!)).toEqual(STILL_PNG);
    await expect.poll(() => gen.desk.order(orderId).acks, { timeout: 10_000 }).toBe(1);
    // One paid call in all: the restart collected the order, it did not place a second one.
    expect(gen.desk.calls()).toHaveLength(1);
    expect(gen.desk.orders.size).toBe(1);
    // The agent hears of it once and is never left out: by itself once the chat is ready, or at the latest
    // when the person's next turn ends. Which one is recorded: by itself is what a person should get, and the
    // other is a known race (the QA worker's bug report "after reopening, a finished generation may not wake
    // the agent until the next message").
    const byItself = await expect
      .poll(() => gen.wakeRounds().length, { timeout: 8_000 })
      .toBe(1)
      .then(
        () => true,
        () => false,
      );
    test.info().annotations.push({
      type: "agent woken after the restart",
      description: byItself ? "by itself" : "only after the person's next message",
    });
    if (!byItself) await qa.send("Is the picture ready?");
    await expect.poll(() => gen.wakeRounds().length, { timeout: 20_000 }).toBe(1);
    expect(gen.wakeRounds()[0].text).toContain(`- an image is ready (${ref})`);
    await qa.idle();
    expect(gen.wakeRounds()).toHaveLength(1);
  });

  test("Stop after a paid call does not throw the picture away: it still lands, once", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer() });
    qa.server.script(askImage(), hangs());
    const id = await qa.openProject("sweep_qa_gen_stop");
    await qa.send("Make an opening picture, then tidy the timeline");
    await expect(gen.allowButton).toBeVisible({ timeout: 15_000 });
    const ref = await startPicture(gen, id);
    await expect(qa.reply(new RegExp(`^${HANGING_WORDS}`))).toBeVisible({ timeout: 20_000 });
    await qa.stopButton.click();
    await qa.idle();

    qa.server.script(plainText("The picture you asked for is ready."));
    gen.desk.finish();
    await expect
      .poll(async () => (await gen.row(ref, id))?.status ?? "ready", { timeout: 30_000 })
      .toBe("ready");
    expect(await gen.fileOf((await gen.row(ref, id))!)).toEqual(STILL_PNG);
    await expect.poll(() => gen.desk.order().acks, { timeout: 10_000 }).toBe(1);
    expect(gen.desk.calls()).toHaveLength(1);
  });

  test("the server took the paid call but its answer was lost: the app asks about the order instead of sending it again, and collects it once", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", {
      kind: "order",
      answer: imageAnswer(),
      ready: true,
      lostAnswer: true,
    });
    qa.server.script(
      askImage(),
      plainText("The picture is on its way."),
      plainText("The picture is ready."),
    );
    const id = await qa.openProject("sweep_qa_gen_lost");
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.allowButton).toBeVisible({ timeout: 15_000 });
    const ref = await startPicture(gen, id);
    const row = await gen.settled(ref, id);
    expect(row.status).toBeUndefined();
    expect(await gen.fileOf(row)).toEqual(STILL_PNG);
    await expect.poll(() => gen.desk.order().acks, { timeout: 10_000 }).toBe(1);
    // One paid request in all: the lost answer was settled by asking, never by sending again.
    expect(gen.desk.calls()).toHaveLength(1);
    expect(gen.desk.order().polls).toBeGreaterThan(0);
    await expect(qa.reply("The picture is ready.")).toBeVisible({ timeout: 20_000 });
  });

  test("the paid call failed before the server took it: the app asks, hears there is no such order, fails it plainly, and never sends it again", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", {
      kind: "http",
      status: 503,
      detail: { error: "internal_error" },
    });
    qa.server.script(askImage(), plainText("The picture is on its way."));
    const id = await qa.openProject("sweep_qa_gen_notaken");
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.allowButton).toBeVisible({ timeout: 15_000 });
    const ref = await startPicture(gen, id);
    await expect(qa.reply("The picture is on its way.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    qa.server.script(plainText("The picture could not be made; shall I try again?"));
    const row = await gen.settled(ref, id, 45_000);
    expect(row.status).toBe("failed");
    // It asked whether the server had the order (twice, a few seconds apart) before concluding it did not.
    expect(gen.desk.unknownAsks).toBeGreaterThanOrEqual(2);
    expect(gen.desk.orders.size).toBe(0);
    await expect(qa.reply("The picture could not be made; shall I try again?")).toBeVisible({
      timeout: 20_000,
    });
    expect(gen.wakeRounds()[0]?.text).toMatch(/- an image FAILED: /);
    expect(gen.desk.calls()).toHaveLength(1);
  });
});
