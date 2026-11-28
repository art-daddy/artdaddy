// Credits, the way a person meets them: the readout in the status bar (what is left, and on hover what
// was used and what is held for generations in progress), the same numbers on the profile page, the
// out-of-credits state and its one way out (the community, Discord), the shared budget paused for
// everyone, the readout keeping up after each turn, and credits granted after the wall. The app sells
// nothing today: no purchase screen exists, and no test here may start one. The fake server signs the
// app in; nothing reaches a vendor or a payment provider.
import { askImage } from "../generation/fixtures/replies/generate";
import { imageAnswer } from "../generation/lib/genDesk";
import { expect, knownBug, test, waitName, type GenRig } from "../generation/lib/gen";
import { outOfCredits } from "../agent-and-models/fixtures/replies/outOfCredits";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import { httpAnswer, stream, textResult } from "../agent-and-models/lib/reply";
import type { AgentRig } from "../agent-and-models/lib/qa";
import { startTimer } from "../../lib/timing";

const PAUSED = "AI generation is paused for everyone right now.";
const OVER = { metered: true, used: 500, limit: 500, remaining: 0, over: true };

/** The credit readout in the status bar. */
const readout = (qa: AgentRig) => qa.page.getByTestId("status-bar");
const discordReadout = (qa: AgentRig) =>
  qa.page.getByRole("button", { name: "0 cr — Join our Discord to get more" });

/** Account menu > Profile, as a person opens it. */
async function openProfile(qa: AgentRig): Promise<void> {
  await qa.page.locator('button[aria-haspopup="menu"]', { hasText: "QA" }).click();
  await qa.page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(qa.page.getByRole("heading", { name: "Credits" })).toBeVisible({ timeout: 10_000 });
}

/** A row of the profile's Credits section ("Remaining 388"). */
const profileRow = (qa: AgentRig, label: string) =>
  qa.page.getByText(label, { exact: true }).locator("xpath=..");

/** Nothing on screen offers to sell credits, and nothing was sent to a payment route. */
async function nothingForSale(qa: AgentRig, gen: GenRig): Promise<void> {
  const forSale = /\b(buy|upgrade|top.?up|subscribe|checkout|pricing|plans?)\b/i;
  await expect(qa.page.getByRole("button", { name: forSale })).toHaveCount(0);
  await expect(qa.page.getByRole("link", { name: forSale })).toHaveCount(0);
  const paymentish = qa.server.seen.filter((s) =>
    /billing|checkout|payment|subscri|dodo|portal|top.?up|plan/i.test(s.path),
  );
  expect(paymentish.map((s) => s.path)).toEqual([]);
  expect(gen.desk.calls()).toHaveLength(0);
}

test.describe("credits", () => {
  test.setTimeout(120_000);

  test("the readout: what is left in the status bar, used and held on hover, and the same numbers on the profile", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = {
      metered: true,
      used: 112,
      limit: 500,
      remaining: 388,
      over: false,
      held: 24,
    };
    await qa.openProject("sweep_qa_credits_readout");
    const left = readout(qa).getByText("388 cr left", { exact: true });
    await expect(left).toBeVisible({ timeout: 15_000 });
    await expect(left).toHaveAttribute(
      "title",
      "112 / 500 credits used (24 reserved for generations in progress)",
    );
    await expect(discordReadout(qa)).toHaveCount(0);

    const opened = startTimer(waitName("billing", "profile page with current credits"));
    await openProfile(qa);
    await expect(profileRow(qa, "Remaining")).toHaveText(/^Remaining\s*388$/);
    opened.stop();
    await expect(profileRow(qa, "Used")).toHaveText(/^Used\s*112$/);
    await expect(profileRow(qa, "Limit")).toHaveText(/^Limit\s*500$/);
    await nothingForSale(qa, gen);
    // Opening the page asked for the balance again, so it is current.
    expect(qa.server.requests("/usage").length).toBeGreaterThan(1);
    await qa.page.getByRole("button", { name: "Go back" }).click();
    await expect(qa.composer).toBeVisible({ timeout: 10_000 });
  });

  test("an account with no limit shows no count, and a generation's price is shown without a balance", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = { metered: false };
    gen.desk.quote.generate_image = 24;
    qa.server.script(askImage(), plainText("No picture then."));
    await qa.openProject("sweep_qa_credits_unmetered");
    await expect(readout(qa).getByText(/cr left|cr —|AI paused/)).toHaveCount(0);
    await qa.send("Make an opening picture of a paper boat");
    await expect(gen.priceLine).toHaveText("Up to 24 credits", { timeout: 15_000 });
    await gen.denyButton.click();
    await expect(qa.reply("No picture then.")).toBeVisible({ timeout: 15_000 });
    await openProfile(qa);
    await expect(qa.page.getByText("This account is not metered.")).toBeVisible();
    await nothingForSale(qa, gen);
  });

  test("out of credits: the readout and the profile show the one way out, the community, and nothing is offered for sale", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = { ...OVER };
    await qa.openProject("sweep_qa_credits_out");
    await expect(discordReadout(qa)).toBeVisible({ timeout: 15_000 });
    await expect(discordReadout(qa)).toHaveAttribute("title", "500 / 500 credits used");
    await expect(readout(qa).getByText(/\d+ cr left/)).toHaveCount(0);
    const before = gen.communityLinksOpened();
    await discordReadout(qa).click();
    await expect.poll(() => gen.communityLinksOpened()).toBe(before + 1);

    await openProfile(qa);
    await expect(profileRow(qa, "Remaining")).toHaveText(/^Remaining\s*0$/);
    await expect(qa.page.getByText("Out of credits.")).toBeVisible();
    await expect(qa.page.getByText(/For more credits,/)).toBeVisible();
    await qa.page.getByRole("button", { name: "Join our Discord", exact: true }).click();
    await expect.poll(() => gen.communityLinksOpened()).toBe(before + 2);
    await nothingForSale(qa, gen);
    // The app's own pages only: the link is opened by the desktop side, never navigated in the app.
    expect(qa.page.url()).toMatch(/\/profile$/);
  });

  test("the shared budget paused: the readout says AI is paused for everyone, with what the person still has", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = {
      metered: true,
      used: 120,
      limit: 500,
      remaining: 380,
      over: true,
      pause_scope: "global",
    };
    await qa.openProject("sweep_qa_credits_paused");
    const paused = readout(qa).getByText("AI paused - 380 cr left", { exact: true });
    await expect(paused).toBeVisible({ timeout: 15_000 });
    await expect(paused).toHaveAttribute("title", PAUSED);
    await expect(discordReadout(qa)).toHaveCount(0);
    await openProfile(qa);
    await expect(qa.page.getByText(PAUSED)).toBeVisible();
    // The person's own credits are not the problem, so they are not sent off to get more.
    await expect(qa.page.getByText(/For more credits,/)).toHaveCount(0);
    await nothingForSale(qa, gen);
  });

  test("the shared budget paused: a message refused for it says so, and does not send the person off for more credits", async ({
    qa,
  }) => {
    qa.server.usage = { metered: true, used: 120, limit: 500, remaining: 380, over: false };
    qa.server.script(
      httpAnswer(402, { error: "credit_limit_reached", scope: "global", used: 9000, limit: 9000 }),
    );
    await qa.openProject("sweep_qa_credits_paused_chat");
    // The server's own balance says what its refusal says: paused for everyone.
    qa.server.usage = { ...qa.server.usage, over: true, pause_scope: "global" };
    await qa.send("Add captions to everything");
    await expect(qa.pane.getByText(PAUSED).first()).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    await expect(readout(qa).getByText(/^AI paused - \d+ cr left$/)).toBeVisible();
    await expect(discordReadout(qa)).toHaveCount(0);
    expect(qa.server.modelRounds()).toHaveLength(1);
    knownBug(
      "When AI is paused for everyone, the chat still tells the person to join Discord for more credits",
      /a pause for everyone does not send the person off for more credits/,
    );
    await expect
      .poll(() => qa.pane.getByText(/For more credits,/).count(), {
        message: "a pause for everyone does not send the person off for more credits",
        timeout: 3_000,
      })
      .toBe(0);
  });

  test("a message refused for credits turns the readout into the way out at once, and is not sent again", async ({
    qa,
  }) => {
    qa.server.usage = { metered: true, used: 497, limit: 500, remaining: 3, over: false };
    qa.server.script(outOfCredits(500, 500));
    await qa.openProject("sweep_qa_credits_refused");
    await expect(readout(qa).getByText("3 cr left", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The server's balance says what its refusal says.
    qa.server.usage = { ...OVER };
    const flipped = startTimer(
      waitName("billing", "a refused message to the out-of-credits readout"),
    );
    await qa.send("Add captions to everything");
    await expect(discordReadout(qa)).toBeVisible({ timeout: 15_000 });
    flipped.stop();
    await expect(qa.pane.getByText(/out of credits/i).first()).toBeVisible();
    await qa.idle();
    await qa.page.waitForTimeout(1500);
    expect(qa.server.modelRounds()).toHaveLength(1);
  });

  test("the balance is read again after a turn that cost credits, so the readout keeps up without a restart", async ({
    qa,
  }) => {
    // A round's result reports what it cost, as the server's does.
    const spent = { ...textResult("Checking done.") };
    spent.usage = { ...spent.usage, cost_usd: 0.19 };
    qa.server.script(
      stream("answers after a pause", { delta: "Checking " }, { hold: true }, { result: spent }),
    );
    await qa.openProject("sweep_qa_credits_refresh");
    await expect(readout(qa).getByText("488 cr left", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await qa.send("Tidy the timeline");
    await expect(qa.reply(/^Checking/)).toBeVisible({ timeout: 15_000 });
    // The turn spent credits on the server.
    qa.server.usage = { metered: true, used: 31, limit: 500, remaining: 469, over: false };
    qa.server.release();
    const updated = startTimer(waitName("billing", "readout updated after a turn"));
    await expect(readout(qa).getByText("469 cr left", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    updated.stop();
  });

  test("credits granted after the wall: the next generation goes through without a restart", async ({
    qa,
    gen,
  }) => {
    qa.server.usage = { ...OVER };
    gen.desk.next("generate_image", { kind: "order", answer: imageAnswer() });
    qa.server.script(askImage(), plainText("The picture is on its way."));
    const id = await qa.openProject("sweep_qa_credits_granted");
    await expect(discordReadout(qa)).toBeVisible({ timeout: 15_000 });
    // More credits are granted on the server; the app has not heard yet.
    qa.server.usage = { metered: true, used: 500, limit: 1000, remaining: 500, over: false };
    await qa.send("Make an opening picture of a paper boat");
    await gen.allowButton.click();
    await expect(qa.reply("The picture is on its way.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    // It asked for the balance before refusing, found credit, and sent the one paid call.
    expect(gen.desk.calls("generate_image")).toHaveLength(1);
    expect((await gen.placeholder(id)).status).toBe("generating");
    await expect(readout(qa).getByText("500 cr left", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });
});
