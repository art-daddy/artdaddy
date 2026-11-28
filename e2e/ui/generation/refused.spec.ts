// What a refused paid generation looks like: out of credits before anything is sent, the server's
// credit wall on the paid call itself, a request bigger than what is left, the vendor busy, the
// content refused, and a request the tool itself cannot make. Each must say why in plain words,
// spend nothing it should not, and never be sent again behind the person's back.
import { imageAnswer, videoAnswer } from "./lib/genDesk";
import { askImage, askVideo } from "./fixtures/replies/generate";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import type { Round } from "../agent-and-models/lib/reply";
import { expect, knownBug, test } from "./lib/gen";

const OUT_OF_CREDITS = { metered: true, used: 500, limit: 500, remaining: 0, over: true };

test.describe("a paid generation that is refused", () => {
  test.setTimeout(120_000);

  test("out of credits before the call: nothing is submitted or saved, and the way out is shown", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = { ...OUT_OF_CREDITS };
    gen.desk.quote.generate_image = 24;
    let told: Round["toolResults"] = [];
    qa.server.script(askImage(), (round: Round) => {
      told = round.toolResults;
      return plainText("You are out of credits, so I could not make the picture.");
    });
    const id = await qa.openProject("sweep_qa_gen_nocredit");
    await expect(
      qa.page.getByRole("button", { name: "0 cr — Join our Discord to get more" }),
    ).toBeVisible();
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.priceLine).toHaveText("Up to 24 credits · you have 0 left", {
      timeout: 15_000,
    });
    await gen.allowButton.click();
    await expect(qa.reply("You are out of credits, so I could not make the picture.")).toBeVisible({
      timeout: 20_000,
    });
    await qa.idle();
    // Nothing was sent to the paid service and nothing was put in the library.
    expect(gen.desk.calls()).toHaveLength(0);
    expect(await gen.generatedRows(id)).toHaveLength(0);
    // The agent was told to stop, not to try another paid tool.
    expect(told[0]?.name).toBe("generate_image");
    expect(String(told[0]?.result?.error)).toMatch(/credit limit is reached/);
    expect(String(told[0]?.result?.error)).toMatch(/Do NOT retry this or any other paid tool/);
    // The person sees it in plain words, with the way to get more.
    await expect(qa.pane.getByText("Out of credits.").first()).toBeVisible();
    const before = gen.communityLinksOpened();
    await qa.pane.getByRole("button", { name: "Join our Discord" }).first().click();
    await expect.poll(() => gen.communityLinksOpened()).toBe(before + 1);
  });

  test("the server's credit wall on the paid call: the placeholder fails with why, the readout turns to the way out, and nothing is retried", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.generate_image = 24;
    gen.desk.next("generate_image", {
      kind: "http",
      status: 402,
      detail: { error: "credit_limit_reached", scope: "user", used: 500, limit: 500 },
    });
    qa.server.script(
      askImage(),
      plainText("The picture is on its way."),
      plainText("The picture could not be made: you are out of credits."),
    );
    const id = await qa.openProject("sweep_qa_gen_wall");
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.priceLine).toHaveText("Up to 24 credits · you have 488 left", {
      timeout: 15_000,
    });
    // The server's balance now says what its refusal says.
    qa.server.usage = { ...OUT_OF_CREDITS };
    await gen.allowButton.click();
    await expect(qa.reply("The picture could not be made: you are out of credits.")).toBeVisible({
      timeout: 30_000,
    });
    await qa.idle();
    expect(gen.desk.calls()).toHaveLength(1);
    const [row] = await gen.generatedRows(id);
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/credit limit is reached/);
    await expect(qa.pane.getByText("an image failed — out of credits")).toBeVisible();
    await expect(
      qa.page.getByRole("button", { name: "0 cr — Join our Discord to get more" }),
    ).toBeVisible();
    expect(gen.wakeRounds()[0]?.text).toMatch(/- an image FAILED: .*credit limit is reached/);
    await qa.page.waitForTimeout(2000);
    expect(gen.desk.calls()).toHaveLength(1);
  });

  test("a request bigger than what is left is refused with both numbers, and other work is not blocked", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = { metered: true, used: 495, limit: 500, remaining: 5, over: false };
    gen.desk.quote.generate_image = 24;
    gen.desk.next("generate_image", {
      kind: "http",
      status: 402,
      detail: {
        error: "credit_limit_reached",
        scope: "user",
        used: 495,
        limit: 500,
        remaining: 5,
        requested: 24,
      },
    });
    qa.server.script(
      askImage(),
      plainText("The picture is on its way."),
      plainText("That picture needs more credits than you have left."),
    );
    const id = await qa.openProject("sweep_qa_gen_toobig");
    await expect(qa.page.getByText("5 cr left")).toBeVisible();
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.priceLine).toHaveText("Up to 24 credits · you have 5 left", {
      timeout: 15_000,
    });
    await gen.allowButton.click();
    await expect(qa.reply("That picture needs more credits than you have left.")).toBeVisible({
      timeout: 30_000,
    });
    await qa.idle();
    const [row] = await gen.generatedRows(id);
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("This request needs up to 24 credits; 5 credits remain.");
    // Not out of credits: what is left is still shown, and still spendable on something smaller.
    await expect(qa.page.getByText("5 cr left")).toBeVisible();
    await expect(qa.page.getByRole("button", { name: /Join our Discord to get more/ })).toHaveCount(
      0,
    );
    await expect(
      qa.pane.getByText(
        /^an image failed — This request needs up to 24 credits; 5 credits remain\./,
      ),
    ).toBeVisible();
    expect(gen.desk.calls()).toHaveLength(1);
    // What the person reads is for the person: the instructions written for the agent stay with the agent.
    knownBug(
      "A failed generation's note in the chat shows the person the instructions written for the agent",
      /the person's note carries no instructions meant for the agent/,
    );
    await expect
      .poll(() => qa.pane.getByText(/Do NOT retry|Ask the user to approve/).count(), {
        message: "the person's note carries no instructions meant for the agent",
        timeout: 3_000,
      })
      .toBe(0);
  });

  for (const kind of ["image", "video"] as const)
    test(`the vendor is busy (${kind}): the placeholder fails and the agent is told to pick another model, with no second paid call`, async ({
      qa,
      gen,
    }) => {
      knownBug(
        "A generation the vendor refused as busy stays 'Generating…' and the agent is never told",
        /an? (image|video) the vendor refused as busy is failed, not left generating/,
      );
      const proxy = kind === "image" ? "generate_image" : "generate_video";
      gen.desk.next(proxy, {
        kind: "order",
        answer: kind === "image" ? imageAnswer() : videoAnswer(),
      });
      qa.server.script(
        kind === "image" ? askImage() : askVideo(),
        plainText(`The ${kind} is on its way.`),
      );
      const id = await qa.openProject(`sweep_qa_gen_busy_${kind}`);
      await qa.send(`Make an opening ${kind}`);
      await gen.allowButton.click();
      await expect(qa.reply(`The ${kind} is on its way.`)).toBeVisible({ timeout: 20_000 });
      await qa.idle();
      const ref = String((await gen.placeholder(id)).id);
      qa.server.script(plainText(`The ${kind} service is busy; I can try another model.`));
      // The server's verdict on the order: the vendor answered 429 (closed at zero, never charged).
      gen.desk.fail("The model is busy right now (rate limited).", {
        code: "rate_limited",
        retryable: true,
      });
      await expect
        .poll(async () => (await gen.row(ref, id))?.status, {
          message: `${kind === "image" ? "an image" : "a video"} the vendor refused as busy is failed, not left generating`,
          timeout: 12_000,
        })
        .toBe("failed");
      await expect(qa.reply(`The ${kind} service is busy; I can try another model.`)).toBeVisible({
        timeout: 20_000,
      });
      expect(gen.wakeRounds()[0]?.text).toMatch(/switch to a DIFFERENT (image|video) model/);
      expect(gen.desk.calls()).toHaveLength(1);
      expect(gen.desk.order().acks).toBe(0);
    });

  test("the content is refused: the placeholder and the placed clip say it failed, with the server's words", async ({
    qa,
    gen,
  }) => {
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer() });
    qa.server.script(askImage(), plainText("The picture is on its way."));
    const id = await qa.openProject("sweep_qa_gen_refused");
    await qa.send("Make an opening picture of a paper boat");
    await gen.allowButton.click();
    await expect(qa.reply("The picture is on its way.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    const reason =
      "The picture was blocked by the provider's safety filter. Try a different prompt.";
    qa.server.script(plainText("The picture was blocked; shall I try a different prompt?"));
    gen.desk.fail(reason, { code: "content_refused" });
    await expect(qa.reply("The picture was blocked; shall I try a different prompt?")).toBeVisible({
      timeout: 30_000,
    });
    const [row] = await gen.generatedRows(id);
    expect(row).toMatchObject({ status: "failed", error: reason });
    await expect(qa.pane.getByText(`an image failed — ${reason}`)).toBeVisible();
    expect(gen.wakeRounds()[0]?.text).toContain(`- an image FAILED: ${reason}`);
    // A failed order is never collected (nothing to collect) and never sent again.
    expect(gen.desk.order().acks).toBe(0);
    expect(gen.desk.calls()).toHaveLength(1);
  });

  test("a model the app does not offer is refused before anything is sent: no price, no placeholder, no paid call", async ({
    qa,
    gen,
  }) => {
    let told: Round["toolResults"] = [];
    qa.server.script(askImage({ model: "imagen-9" }), (round: Round) => {
      told = round.toolResults;
      return plainText("That model is not available; I will use the default.");
    });
    const id = await qa.openProject("sweep_qa_gen_badmodel");
    await qa.send("Make an opening picture with imagen-9");
    await expect(qa.pane.getByText("Generate an image")).toBeVisible({ timeout: 15_000 });
    await gen.allowButton.click();
    await expect(qa.reply("That model is not available; I will use the default.")).toBeVisible({
      timeout: 20_000,
    });
    await qa.idle();
    expect(gen.desk.quotes).toHaveLength(0);
    expect(gen.desk.calls()).toHaveLength(0);
    expect(await gen.generatedRows(id)).toHaveLength(0);
    expect(String(told[0]?.result?.error)).toMatch(/unknown image model "imagen-9"/);
  });
});
