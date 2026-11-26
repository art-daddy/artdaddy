// The one place the agent stops and asks: before something paid or something that cannot be
// undone. Allow runs it; Deny records the refusal and the agent is told. Nothing paid is ever
// called here: the fake server's paid proxy only records that it was asked.
import { existsSync } from "node:fs";
import path from "node:path";

import { deleteAsset, generateImage } from "./fixtures/replies/gatedCalls";
import { plainText } from "./fixtures/replies/plainText";
import { type Round } from "./lib/reply";
import { expect, test, type AgentRig } from "./lib/qa";
import { inBrowser, startTimer } from "./lib/waits";

const STILL = path.resolve("e2e/ui/agent-and-models/fixtures/media/still.png");

/** Requests that would have reached a vendor through the paid proxy (the price quote is free). */
const paidCalls = (qa: AgentRig) => qa.server.requests("/ai/").filter((s) => !/quote/.test(s.path));

async function attachStill(qa: AgentRig, id: string): Promise<string> {
  await qa.attach(STILL);
  return String(
    (await qa.savedAssets(id)).find((a) => JSON.stringify(a).includes("still.png"))?.id ?? "",
  );
}

test.describe("approving a paid or destructive call", () => {
  test.setTimeout(90_000);

  test("a paid generation asks first; Deny sends nothing to the paid service and the agent is told", async ({
    qa,
  }) => {
    let told: Round["toolResults"] = [];
    qa.server.script(generateImage(), (round: Round) => {
      told = round.toolResults;
      return plainText("OK, no picture then.");
    });
    const id = await qa.openProject();
    const prompt = startTimer(inBrowser("approval prompt appears for a paid call"));
    await qa.send("Make an opening picture of a kite");
    await expect(qa.pane.getByText("Generate an image")).toBeVisible({ timeout: 15_000 });
    prompt.stop();
    await expect(qa.pane.getByText("This spends your credits.")).toBeVisible();
    await expect(qa.pane.getByRole("status")).toHaveText(/Waiting for your OK/);
    // Waiting means waiting: no further round, nothing paid, until the person answers.
    await qa.page.waitForTimeout(1500);
    expect(qa.server.modelRounds()).toHaveLength(1);
    expect(paidCalls(qa)).toHaveLength(0);

    await qa.pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(qa.reply("OK, no picture then.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      name: "generate_image",
      result: { ok: false, error: "user denied this tool call" },
    });
    expect(paidCalls(qa)).toHaveLength(0);
    await expect
      .poll(() => qa.savedTranscriptText(id), { timeout: 10_000 })
      .toContain("user denied this tool call");
  });

  test("Allow on a paid generation sends exactly one request to the paid service, and the turn goes on", async ({
    qa,
  }) => {
    // The fake paid proxy refuses (it never calls anything); a generation that fails later wakes
    // the agent with a note, so a reply is scripted for that round too.
    qa.server.script(
      generateImage(),
      plainText("Started the picture."),
      plainText("The picture did not come out; nothing else was changed."),
    );
    await qa.openProject();
    await qa.send("Make an opening picture of a kite");
    await expect(qa.pane.getByText("Generate an image")).toBeVisible({ timeout: 15_000 });
    expect(paidCalls(qa)).toHaveLength(0);
    const resumed = startTimer(inBrowser("Allow on a paid call to the next answer"));
    await qa.pane.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(qa.reply("Started the picture.")).toBeVisible({ timeout: 20_000 });
    resumed.stop();
    await qa.idle();
    await qa.page.waitForTimeout(2000);
    // One approval, one paid request: never a second one behind the person's back.
    const paid = paidCalls(qa);
    expect(paid, paid.map((p) => p.path).join(", ")).toHaveLength(1);
    expect(JSON.stringify(paid[0].body)).toContain("a red kite over green hills at dawn");
  });

  test("deleting a library asset asks first; Delete removes it from the saved library and leaves the person's own file alone", async ({
    qa,
  }) => {
    const id = await qa.openProject();
    const ref = await attachStill(qa, id);
    expect(ref).toMatch(/^media_/);
    let told: Round["toolResults"] = [];
    qa.server.script(deleteAsset(ref), (round: Round) => {
      told = round.toolResults;
      return plainText("Removed it from the library.");
    });
    await qa.send("Remove the picture I attached from the library");
    await expect(qa.pane.getByText("Delete media from your library")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      qa.pane.getByText("This removes the file and every clip using it. It can't be undone."),
    ).toBeVisible();
    expect(qa.server.modelRounds()).toHaveLength(1);

    const resumed = startTimer(inBrowser("Delete approved to the next answer"));
    await qa.pane.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(qa.reply("Removed it from the library.")).toBeVisible({ timeout: 15_000 });
    resumed.stop();
    await qa.idle();
    expect(told[0]?.result?.ok).not.toBe(false);
    await expect
      .poll(async () => (await qa.savedAssets(id)).some((a) => a.id === ref), { timeout: 10_000 })
      .toBe(false);
    // It came in linked in place, so the person's own file on disk is never touched.
    expect(existsSync(path.join(qa.shell.root, "media", "still.png"))).toBe(true);
  });

  test("Deny on a delete keeps the asset, and the agent is told it was refused", async ({ qa }) => {
    const id = await qa.openProject();
    const ref = await attachStill(qa, id);
    let told: Round["toolResults"] = [];
    qa.server.script(deleteAsset(ref), (round: Round) => {
      told = round.toolResults;
      return plainText("Kept it.");
    });
    await qa.send("Remove the picture I attached from the library");
    await expect(qa.pane.getByText("Delete media from your library")).toBeVisible({
      timeout: 15_000,
    });
    await qa.pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(qa.reply("Kept it.")).toBeVisible({ timeout: 15_000 });
    await qa.idle();
    expect(told[0]).toMatchObject({
      name: "library_op",
      result: { ok: false, error: "user denied this tool call" },
    });
    expect((await qa.savedAssets(id)).some((a) => a.id === ref)).toBe(true);
  });
});
