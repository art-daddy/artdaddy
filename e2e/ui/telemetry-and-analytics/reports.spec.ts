// What a person can send about their own work, and what the app reports while they work, judged against what the
// privacy text promises (src-tauri/PRIVACY.txt, "When you send feedback" and the editor-actions paragraph). The app has
// no consent or settings screen for usage reporting: the text says so ("There is no switch to turn off usage
// reporting yet"), so the consent a person meets is the Report a problem dialog, and the promise is what is checked.
//
//   npm run e2e:ui -- e2e/ui/telemetry-and-analytics
import { readFileSync } from "node:fs";
import path from "node:path";

import { startTimer } from "../../lib/timing";
import { expect, Rig, test } from "../auth-and-accounts/lib/rig";

const browserName = () => test.info().project.name;
const STILL = path.resolve("e2e/ui/agent-and-models/fixtures/media/still.png");
/** A file name a person would not want in anyone's logs. */
const PRIVATE_NAME = "qa-private-holiday-photo.png";

/** Bring a copy of the fixture in through File > Import Media…, as a person picks it in the OS dialog. */
async function importStill(qa: Rig): Promise<void> {
  const media = await qa.shell.addMedia(STILL, PRIVATE_NAME);
  qa.shell.pickFiles([media]);
  await qa.choose("File", "Import Media…");
  // The OS dialog was opened and answered (the shell answers it with the file queued above)...
  await expect
    .poll(() => qa.shell.calls.some((c) => c.cmd === "plugin:dialog|open"), { timeout: 15_000 })
    .toBe(true);
  // ...and the file is in the project's library.
  await expect(qa.page.getByText(PRIVATE_NAME).first()).toBeVisible({ timeout: 30_000 });
}

const dialog = (qa: Rig) => qa.page.getByRole("dialog", { name: "Report a problem" });
const note = (qa: Rig) => dialog(qa).getByRole("textbox", { name: "What went wrong?" });
const send = (qa: Rig) => dialog(qa).getByRole("button", { name: "Send report" });

test.describe("Report a problem", () => {
  test("it says what is sent, waits for a note, and sends the note with the conversation and timeline, never the media", async ({
    qa,
  }) => {
    const reports: Array<Record<string, unknown>> = [];
    await qa.route("/telemetry/feedback", async (route) => {
      reports.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill(Rig.json(200, { ok: true }));
    });
    await qa.openToMenu();
    const id = await qa.newProject("sweep_qa_tel report");
    await importStill(qa);
    await qa.choose("Help", "Report a Problem…");
    await expect(
      dialog(qa).getByText("this chat's transcript and your timeline (no media files)", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(send(qa)).toBeDisabled();
    await note(qa).fill("   ");
    await expect(send(qa)).toBeDisabled();
    await note(qa).fill("The clip jumps when I press play.");
    const sent = startTimer(`feedback: Send report to the thank-you [${browserName()}]`);
    await send(qa).click();
    await expect(qa.page.getByText("Report sent — thank you")).toBeVisible({ timeout: 30_000 });
    sent.stop();
    await expect(dialog(qa)).toHaveCount(0);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "report",
      note: "The clip jumps when I press play.",
      project_id: id,
    });
    expect(reports[0].bundle).toHaveProperty("timeline");
    // Never the media itself: the picture's bytes appear nowhere in what was sent.
    const body = JSON.stringify(reports[0]);
    const pictureStart = readFileSync(STILL).subarray(0, 60).toString("base64");
    expect(body).not.toContain(pictureStart);
  });

  test("Cancel sends nothing", async ({ qa }) => {
    await qa.openToMenu();
    await qa.newProject("sweep_qa_tel cancel");
    await qa.choose("Help", "Report a Problem…");
    await note(qa).fill("Never mind.");
    await dialog(qa).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(qa)).toHaveCount(0);
    expect(qa.requests("/telemetry/feedback")).toHaveLength(0);
  });

  test("the server cannot be reached: the note stays, and Send works once it is back", async ({
    qa,
  }) => {
    let online = false;
    await qa.route("/telemetry/feedback", async (route) => {
      if (!online) return route.abort("internetdisconnected");
      await route.fulfill(Rig.json(200, { ok: true }));
    });
    await qa.openToMenu();
    await qa.newProject("sweep_qa_tel offline");
    await qa.choose("Help", "Report a Problem…");
    await note(qa).fill("Export stopped at 40 percent.");
    await send(qa).click();
    await expect(
      dialog(qa)
        .getByRole("alert")
        .filter({ hasText: "Couldn't reach the server. Your note is still here" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(note(qa)).toHaveValue("Export stopped at 40 percent.");
    online = true;
    await send(qa).click();
    await expect(qa.page.getByText("Report sent — thank you")).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("what the app reports while a person works", () => {
  test("the editor's report of an import names no file and no folder", async ({ qa }) => {
    const flushes: string[] = [];
    await qa.route("/telemetry/editor", async (route) => {
      flushes.push(route.request().postData() ?? "");
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await qa.page.clock.install();
    await qa.openToMenu();
    await qa.newProject("sweep_qa_tel editor");
    await importStill(qa);
    // The editor's actions leave in a flush a minute after the first one: move the page's clock on until it has gone
    // (the import is noted a moment after the library shows it, so one jump can come too early).
    await expect
      .poll(
        async () => {
          await qa.page.clock.fastForward("01:05");
          return flushes.length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const sent = flushes.join("\n");
    // The import itself was reported, as a fact...
    expect(sent).toMatch(/import/i);
    // ...but never the file's name or where it was.
    expect(sent).not.toContain("qa-private-holiday-photo");
    expect(sent).not.toContain("/qa-home");
  });
});
