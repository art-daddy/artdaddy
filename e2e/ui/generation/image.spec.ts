// An image, from the request to the picture in the library: the approval bar says what it may cost
// before anything is spent, Allow sends exactly one paid call, the turn ends while the picture is
// still being made, and when it is ready the picture lands in the library (the real bytes, at the
// placeholder's path), the server is told once that the app has it, and the agent is woken once.
// Nothing reaches a vendor: the paid side is scripted (lib/genDesk.ts).
import { STILL_PNG, imageAnswer } from "./lib/genDesk";
import { askImage, IMAGE_PROMPT } from "./fixtures/replies/generate";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import { startTimer } from "../../lib/timing";
import { expect, knownBug, test, waitName, WAKE_LEAD } from "./lib/gen";

test.describe("generating an image", () => {
  test.setTimeout(120_000);

  test("the bar shows the price before anything is spent; Allow sends one paid call; the picture lands once and the agent is told once", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.generate_image = 24;
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer(), charged: 21 });
    qa.server.script(askImage(), plainText("The picture is on its way."));
    const id = await qa.openProject("sweep_qa_gen_image");

    const asked = startTimer(waitName("generation", "approval bar with its price"));
    await qa.send("Make an opening picture of a paper boat");
    await expect(qa.pane.getByText("Generate an image")).toBeVisible({ timeout: 15_000 });
    await expect(qa.pane.getByText(`“${IMAGE_PROMPT}”`)).toBeVisible();
    await expect(qa.pane.getByText("This spends your credits.")).toBeVisible();
    await expect(gen.priceLine).toHaveText("Up to 24 credits · you have 488 left", {
      timeout: 10_000,
    });
    asked.stop();

    // The price was asked about the call that will be sent (the default model, one picture, its first
    // resolution), and nothing of the person's travelled with it: not the prompt.
    expect(gen.desk.quotes).toHaveLength(1);
    expect(gen.desk.quotes[0].args).toEqual({
      backend_id: "gemini-3-pro-image",
      count: 1,
      resolution: "1K",
    });
    expect(JSON.stringify(gen.desk.quotes[0])).not.toContain("paper boat");
    // Waiting for the person spends nothing.
    expect(gen.desk.calls()).toHaveLength(0);

    await gen.allowButton.click();
    await expect(qa.reply("The picture is on its way.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();

    // One paid call, as an order, carrying what the person approved.
    const calls = gen.desk.calls("generate_image");
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { args?: Record<string, unknown>; order_id?: string };
    expect(body.args).toMatchObject({
      prompt: IMAGE_PROMPT,
      aspect_ratio: "16:9",
      count: 1,
      backend_id: "gemini-3-pro-image",
    });
    expect(body.order_id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

    // The turn is over and the picture is still being made: its placeholder is in the library,
    // saying so, with what made it.
    await expect.poll(async () => (await gen.generatedRows(id)).length).toBe(1);
    const [pending] = await gen.generatedRows(id);
    expect(pending).toMatchObject({
      status: "generating",
      kind: "image",
      source: { origin: "generated", model: "nano-banana-pro", prompt: IMAGE_PROMPT },
    });
    const ref = String(pending.id);
    expect(ref).toMatch(/^media_gen_[0-9a-f]{12}$/);
    expect(await gen.fileOf(pending)).toBeNull();
    expect(gen.wakeRounds()).toHaveLength(0);

    // The server finishes it. The app collects it by itself: the picture is written where the
    // placeholder said, the row is finished, the server is told once, the agent is woken once, and
    // the credits readout shows the charge.
    qa.server.script(plainText("Your picture is ready and in the library."));
    qa.server.usage = { metered: true, used: 33, limit: 500, remaining: 467, over: false };
    gen.desk.finish();
    const landed = startTimer(waitName("generation", "a finished picture into the library"));
    await expect
      .poll(async () => (await gen.row(ref, id))?.status ?? "ready", { timeout: 30_000 })
      .toBe("ready");
    landed.stop();
    const row = (await gen.row(ref, id))!;
    expect(await gen.fileOf(row)).toEqual(STILL_PNG);
    expect(row.error).toBeUndefined();
    await expect(qa.reply("Your picture is ready and in the library.")).toBeVisible({
      timeout: 20_000,
    });
    await qa.idle();
    await expect(qa.pane.getByText("an image ready", { exact: true })).toBeVisible();
    await expect.poll(() => gen.desk.order().acks, { timeout: 10_000 }).toBe(1);
    const order = gen.desk.order();
    expect(order.downloads).toBe(1);
    expect(order.linkSawToken).toBe(false);

    const wakes = gen.wakeRounds();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain(WAKE_LEAD);
    expect(wakes[0].text).toContain(`- an image is ready (${ref})`);
    // Still one paid call: collecting is not paying again.
    expect(gen.desk.calls()).toHaveLength(1);
    await expect(
      qa.page.getByTestId("status-bar").getByText("467 cr left", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // The library panel shows it (under whichever name: see the known bug in the next test).
    await expect(
      qa.page.locator(`button[title$="${ref}.png"], button[title="generated-1.png"]`),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test("in Autopilot the paid call runs without asking and without a price question, once", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.generate_image = 24;
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer() });
    qa.server.script(askImage(), plainText("The picture is on its way."));
    const id = await qa.openProject("sweep_qa_gen_autopilot");
    await qa.pane
      .locator("select")
      .filter({ has: qa.page.locator('option[value="autopilot"]') })
      .selectOption("autopilot");
    await qa.send("Make an opening picture of a paper boat");
    await expect(qa.reply("The picture is on its way.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    expect((await gen.placeholder(id)).status).toBe("generating");
    // Autopilot is the person's choice to be asked nothing: no bar, so no price was asked either.
    await expect(gen.allowButton).toHaveCount(0);
    expect(gen.desk.quotes).toHaveLength(0);
    expect(gen.desk.calls("generate_image")).toHaveLength(1);
  });

  test("no price can be had: the bar says what it will do and Allow still works; a server that keeps no orders answers at once", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.generate_image = { status: 503 };
    gen.desk.next("generate_image", { kind: "inline", answer: imageAnswer() });
    qa.server.script(
      askImage(),
      plainText("The picture is on its way."),
      plainText("The picture is ready."),
    );
    const id = await qa.openProject("sweep_qa_gen_noprice");
    await qa.send("Make an opening picture of a paper boat");
    await expect(qa.pane.getByText("This spends your credits.")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => gen.desk.quotes.length).toBe(1);
    // The price is advice: none is shown, and the buttons do not wait for it.
    await expect(gen.priceLine).toHaveCount(0);
    await expect(gen.allowButton).toBeEnabled();
    await gen.allowButton.click();
    const row = await gen.settled(String((await gen.placeholder(id)).id), id);
    expect(row.status).toBeUndefined();
    expect(await gen.fileOf(row)).toEqual(STILL_PNG);
    await expect(qa.reply("The picture is ready.")).toBeVisible({ timeout: 20_000 });
    // Answered inline: there was no order to collect or confirm.
    expect(gen.desk.orders.size).toBe(0);
    expect(gen.desk.calls()).toHaveLength(1);
    // The library lists it under the name it was given (the one the timeline shows), not its id.
    knownBug(
      "A generated picture is listed in the Library under its internal id (media_gen_….png), not the name the timeline shows",
      /the library lists a generated picture under the name it was given/,
    );
    await expect
      .poll(() => qa.page.locator('button[title="generated-1.png"]').count(), {
        message: "the library lists a generated picture under the name it was given",
        timeout: 3_000,
      })
      .toBe(1);
  });

  test("two pictures asked, one filtered out: the one that came lands, the other says why, and the order is confirmed once", async ({
    qa,
    gen,
  }) => {
    // The vendor returned one picture of two (it filtered the other): what the server stores.
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer(1), ready: true });
    qa.server.script(askImage({ count: 2 }), plainText("Two pictures are on their way."));
    const id = await qa.openProject("sweep_qa_gen_two");
    await qa.send("Make two opening pictures to choose from");
    await gen.allowButton.click();
    await expect.poll(async () => (await gen.generatedRows(id)).length).toBe(2);
    qa.server.script(plainText("One picture came back; the other was filtered."));
    const [a, b] = await gen.generatedRows(id);
    const first = await gen.settled(String(a.id), id);
    const second = await gen.settled(String(b.id), id);
    expect(first.status).toBeUndefined();
    expect(await gen.fileOf(first)).toEqual(STILL_PNG);
    expect(second.status).toBe("failed");
    expect(String(second.error)).toMatch(/returned nothing for this one/);
    await expect(qa.reply("One picture came back; the other was filtered.")).toBeVisible({
      timeout: 20_000,
    });
    await expect.poll(() => gen.desk.order().acks, { timeout: 10_000 }).toBe(1);
    expect(gen.desk.calls()).toHaveLength(1);
    // Both the agent and the person should hear that one of the two did not come.
    knownBug(
      "When one of several pictures is filtered out, the chat says they are all ready and the agent is not told one failed",
      /the agent is told one picture of two did not come/,
    );
    await expect
      .poll(() => gen.wakeRounds()[0]?.text ?? "", {
        message: "the agent is told one picture of two did not come",
        timeout: 3_000,
      })
      .toContain(String(b.id));
    await expect(qa.pane.getByText("2 images ready", { exact: true })).toHaveCount(0);
  });

  test("after a restart, the note that a picture finished still reads as the app's note, not as something the person typed", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", { kind: "inline", answer: imageAnswer() });
    qa.server.script(
      askImage(),
      plainText("The picture is on its way."),
      plainText("Your picture is ready."),
    );
    const name = "sweep_qa_gen_note";
    await qa.openProject(name);
    await qa.send("Make an opening picture of a paper boat");
    await gen.allowButton.click();
    await expect(qa.reply("Your picture is ready.")).toBeVisible({ timeout: 30_000 });
    await qa.idle();
    await expect(qa.pane.getByText("an image ready", { exact: true })).toBeVisible();
    await expect(qa.pane.getByText(WAKE_LEAD)).toHaveCount(0);

    await qa.reopen(name);
    await expect(qa.reply("Your picture is ready.")).toBeVisible({ timeout: 20_000 });
    knownBug(
      "After a restart, the app's 'background work finished' note shows as a message the person typed, with the agent's instructions",
      /the app's own note reads as a note after a restart/,
    );
    await expect
      .poll(async () => qa.pane.getByText(WAKE_LEAD).count(), {
        message: "the app's own note reads as a note after a restart",
        timeout: 5_000,
      })
      .toBe(0);
    await expect(qa.pane.getByText("an image ready", { exact: true })).toBeVisible();
  });
});
