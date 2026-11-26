// When a turn cannot happen: no connection, a connection lost mid-answer, no credits, a refusal,
// a model the server does not allow, an app too old for the server. Each must be said plainly,
// cost nothing more, and never be "fixed" behind the person's back by sending the round again.
import { breaksAfterFirstWord, FIRST_WORD } from "./fixtures/replies/breaksAfterFirstWord";
import { modelNotAllowed } from "./fixtures/replies/modelNotAllowed";
import { outOfCredits } from "./fixtures/replies/outOfCredits";
import { plainText } from "./fixtures/replies/plainText";
import { REFUSAL_SENTENCE, refusal } from "./fixtures/replies/refusal";
import { updateRequired } from "./fixtures/replies/updateRequired";
import { expect, test } from "./lib/qa";
import { inBrowser, startTimer } from "./lib/waits";

const CANT_REACH = "Couldn't reach the server. Check your connection and try again.";
const tryAgain = (qa: { pane: import("@playwright/test").Locator }) =>
  qa.pane.getByRole("button", { name: "↻ Try again" });

test.describe("when the turn cannot happen", () => {
  test.setTimeout(90_000);

  test("sending with no connection says so, sends nothing, and Try again works once it is back", async ({
    qa,
  }) => {
    const id = await qa.openProject();
    // The connection to ArtDaddy drops (the app's own page keeps running).
    const offline = `${qa.server.origin}/**`;
    await qa.page.route(offline, (route) => route.abort("internetdisconnected"));
    const said = startTimer(inBrowser("no connection to the message saying so"));
    await qa.send("Tighten the cuts");
    // It tries the connection once more before giving up, and says that it is.
    await expect(qa.pane.getByRole("status")).toHaveText(/Reconnecting/, { timeout: 5000 });
    await expect(qa.pane.getByText(CANT_REACH).first()).toBeVisible({ timeout: 15_000 });
    said.stop();
    expect(qa.server.modelRounds()).toHaveLength(0);
    await expect(tryAgain(qa)).toBeVisible();

    await qa.page.unroute(offline);
    qa.server.script(plainText("Back online. The cuts are already tight."));
    await tryAgain(qa).click();
    await expect(qa.reply("Back online. The cuts are already tight.")).toBeVisible({
      timeout: 15_000,
    });
    await qa.idle();
    expect(qa.server.modelRounds()).toHaveLength(1);
    await expect
      .poll(() => qa.savedTranscriptText(id), { timeout: 10_000 })
      .toContain("Back online. The cuts are already tight.");
    const saved = await qa.savedTranscript(id);
    expect(saved?.requests?.map((r) => r.message?.text)).toEqual(["Tighten the cuts"]);
  });

  test("a connection lost after the first word: the failure is said and the round is never sent again by itself", async ({
    qa,
    browserName,
  }) => {
    qa.server.script(breaksAfterFirstWord());
    await qa.openProject();
    await qa.send("Describe my project");
    await expect(qa.reply(new RegExp(`^${FIRST_WORD}`))).toBeVisible({ timeout: 15_000 });
    // Chromium reports the cut socket (TypeError "network error") and the app names a lost
    // connection. Playwright's WebKit ends a cut stream as if it were complete, so the app only sees
    // a stream that ended without its result, which has no sentence of its own and reads as
    // "couldn't tell why" (reported as a bug; which one macOS WebKit gives is on the run's report).
    const lost = qa.pane.getByText(CANT_REACH).first();
    const unknown = qa.pane.getByText(/^That didn't work, and we couldn't tell why\./).first();
    await expect(lost.or(unknown)).toBeVisible({ timeout: 15_000 });
    const said = (await lost.isVisible()) ? "lost connection" : "couldn't tell why";
    test
      .info()
      .annotations.push({ type: "cut stream reads", description: `${browserName}: ${said}` });
    if (browserName === "chromium") expect(said).toBe("lost connection");
    await qa.idle();
    // The round had begun (in production its tokens were already spent): no silent second try.
    await qa.page.waitForTimeout(2500);
    expect(qa.server.modelRounds()).toHaveLength(1);
    expect(qa.server.modelRounds()[0].end).toBe("cut");
    await expect(tryAgain(qa)).toBeVisible();
  });

  test("out of credits: the credit wall is shown, with no Try again and no second request", async ({
    qa,
  }) => {
    qa.server.script(outOfCredits());
    await qa.openProject();
    const said = startTimer(inBrowser("out of credits to the message saying so"));
    await qa.send("Add captions to everything");
    await expect(qa.pane.getByText(/out of credits|credit limit/i).first()).toBeVisible({
      timeout: 15_000,
    });
    said.stop();
    await qa.idle();
    await expect(qa.pane.getByRole("button", { name: /discord/i }).first()).toBeVisible();
    await expect(tryAgain(qa)).toHaveCount(0);
    await qa.page.waitForTimeout(2000);
    expect(qa.server.modelRounds()).toHaveLength(1);
  });

  test("a provider refusal is said in the server's words, changes nothing, and can be tried again", async ({
    qa,
  }) => {
    qa.server.script(refusal());
    const id = await qa.openProject();
    const before = JSON.stringify(await qa.savedTimeline(id));
    await qa.send("What is in the first frame?");
    await expect(qa.pane.getByText(REFUSAL_SENTENCE).first()).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    await expect(tryAgain(qa)).toBeVisible();
    await expect(qa.pane.getByRole("button", { name: "Report this problem" })).toBeVisible();
    expect(JSON.stringify(await qa.savedTimeline(id))).toBe(before);
    expect(qa.server.modelRounds()).toHaveLength(1);
  });

  test("a model the server does not allow is refused plainly, and the app does not switch model by itself", async ({
    qa,
  }) => {
    qa.server.script(modelNotAllowed());
    await qa.openProject();
    const model = qa.pane
      .locator("select")
      .filter({ has: qa.page.locator('option[value="gpt-6.1-sol"]') });
    await model.selectOption("gpt-6.1-sol");
    await qa.send("Hello");
    await expect(
      qa.pane.getByText(/The AI model you picked isn't available right now/).first(),
    ).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    await expect(tryAgain(qa)).toHaveCount(0);
    await expect(model).toHaveValue("gpt-6.1-sol");
    await qa.page.waitForTimeout(1500);
    const rounds = qa.server.modelRounds();
    expect(rounds).toHaveLength(1);
    expect((rounds[0].body as { model?: string }).model).toBe("gpt-6.1-sol");
  });

  test("an app too old for the server is stopped at start, before any model work", async ({
    qa,
  }) => {
    qa.server.supported = false;
    await qa.page.goto("/");
    await expect(qa.page.getByRole("heading", { name: "ArtDaddy update required" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      qa.page.getByText("This build can no longer be used. Update ArtDaddy to continue."),
    ).toBeVisible();
    await expect(qa.composer).toHaveCount(0);
    expect(qa.server.modelRounds()).toHaveLength(0);
  });

  test("a message refused as 'update required' stops the app at the update screen and is not sent again", async ({
    qa,
  }) => {
    qa.server.script(updateRequired());
    await qa.openProject();
    await qa.send("Export it");
    await expect(qa.page.getByRole("heading", { name: "ArtDaddy update required" })).toBeVisible({
      timeout: 15_000,
    });
    await qa.page.waitForTimeout(1500);
    expect(qa.server.modelRounds()).toHaveLength(1);
  });
});
