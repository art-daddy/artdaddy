// The person steering a running turn: Stop it, let it go on after the automatic pause, try a
// failed one again. The waits recorded here are the ones a person feels at those buttons.
import path from "node:path";
import { performance } from "node:perf_hooks";

import { HANGING_WORDS, hangs } from "./fixtures/replies/hangs";
import { manyReads } from "./fixtures/replies/manyReads";
import { plainText } from "./fixtures/replies/plainText";
import { serverError } from "./fixtures/replies/serverError";
import { callTools, type Round } from "./lib/reply";
import { expect, test, type AgentRig } from "./lib/qa";
import { inBrowser, record, startTimer } from "./lib/waits";

const STILL = path.resolve("e2e/ui/agent-and-models/fixtures/media/still.png");

test.describe("steering a turn", () => {
  test.setTimeout(120_000);

  test("Stop while the answer streams ends the turn at once, hangs up the stream, and the chat goes on", async ({
    qa,
  }) => {
    qa.server.script(hangs());
    const id = await qa.openProject();
    await qa.send("Check every clip for black frames");
    await expect(qa.reply(HANGING_WORDS)).toBeVisible({ timeout: 15_000 });

    const clicked = performance.now();
    const stopped = startTimer(inBrowser("Stop taking effect while the answer streams"));
    await qa.stopButton.click();
    await expect(qa.sendButton).toBeVisible();
    stopped.stop();
    // The app hung up on the round (in production that is what stops the charge), promptly.
    await expect.poll(() => qa.server.modelRounds()[0].end, { timeout: 5000 }).toBe("left");
    record(
      inBrowser("Stop to the stream closing"),
      (qa.server.modelRounds()[0].endedAt ?? 0) - clicked,
    );
    // A Stop is not a failure: no error, no "Try again".
    await expect(qa.pane.getByRole("button", { name: /Try again/ })).toHaveCount(0);
    await expect(qa.pane.getByText(/went wrong|couldn't|failed/i)).toHaveCount(0);

    // The conversation is usable at once, and the stopped message is part of its history.
    qa.server.script(plainText("OK, I stopped. What should I do instead?"));
    await qa.send("Never mind");
    await expect(qa.reply("OK, I stopped. What should I do instead?")).toBeVisible({
      timeout: 15_000,
    });
    await qa.idle();
    expect(qa.server.modelRounds()).toHaveLength(2);
    const history = JSON.stringify(qa.server.modelRounds()[1].body);
    expect(history).toContain("Check every clip for black frames");
    await expect
      .poll(() => qa.savedTranscriptText(id), { timeout: 10_000 })
      .toContain("OK, I stopped. What should I do instead?");
    const saved = await qa.savedTranscript(id);
    expect(saved?.requests?.map((r) => r.message?.text)).toEqual([
      "Check every clip for black frames",
      "Never mind",
    ]);
  });

  /** Start a turn whose first call is a long ffmpeg job (paced to real time: a minute, no CPU)
   *  with an edit queued behind it, Stop it while ffmpeg runs, then send one more message.
   *  Returns what that message carried back to the model for the two calls. */
  async function stopDuringTool(qa: AgentRig) {
    const id = await qa.openProject();
    await qa.attach(STILL);
    const ref = String(
      (await qa.savedAssets(id)).find((a) => JSON.stringify(a).includes("still.png"))?.id ?? "",
    );
    const before = JSON.stringify(await qa.savedTimeline(id));
    qa.server.script(
      callTools(
        [
          {
            name: "run_ffmpeg",
            arguments: {
              inputs: [ref],
              output_name: "long_hold.mp4",
              args: [
                "-re",
                "-loop",
                "1",
                "-i",
                "{in0}",
                "-t",
                "60",
                "-r",
                "5",
                "-s",
                "160x90",
                "{out}",
              ],
            },
          },
          { name: "add_track", arguments: { kind: "text" } },
        ],
        "Rendering a hold frame, then adding a track.",
      ),
    );
    await qa.send("Make a one minute hold of this picture, then add a text track");
    await expect
      .poll(() => qa.shell.calls.some((c) => c.cmd === "sidecar_run"), { timeout: 15_000 })
      .toBe(true);
    const stopped = startTimer(inBrowser("Stop taking effect while a tool runs"));
    await qa.stopButton.click();
    await expect(qa.sendButton).toBeVisible({ timeout: 15_000 });
    stopped.stop();

    let owed: Round["toolResults"] = [];
    qa.server.script((round: Round) => {
      owed = round.toolResults;
      return plainText("Understood, I left everything as it was.");
    });
    await qa.send("Leave it");
    await expect(qa.reply("Understood, I left everything as it was.")).toBeVisible({
      timeout: 15_000,
    });
    await qa.idle();
    return { id, before, owed };
  }

  test("Stop during a tool batch kills the running tool, runs nothing more, and every call is answered", async ({
    qa,
  }) => {
    const { id, before, owed } = await stopDuringTool(qa);
    // The ffmpeg the tool started was killed, and the edit queued behind it never ran.
    expect(qa.shell.calls.some((c) => c.cmd === "sidecar_kill")).toBe(true);
    expect(JSON.stringify(await qa.savedTimeline(id))).toBe(before);
    expect((await qa.savedAssets(id)).some((a) => JSON.stringify(a).includes("long_hold"))).toBe(
      false,
    );
    await expect(qa.pane.getByRole("button", { name: /Try again/ })).toHaveCount(0);
    // The next message owes the model an answer for each call it issued, and the queued one says
    // it was not run.
    expect(owed.map((o) => o.name).sort()).toEqual(["add_track", "run_ffmpeg"]);
    const addTrack = owed.find((o) => o.name === "add_track");
    expect(addTrack?.result).toMatchObject({ ok: false });
    expect(String(addTrack?.result.error)).toMatch(/not run — the turn was stopped/);
  });

  test("a tool that Stop ended is answered as stopped, not as a failure to fix", async ({ qa }) => {
    test.fail(
      true,
      'BUG: Stop during run_ffmpeg shows "Couldn\'t run ffmpeg" and tells the model to fix its args',
    );
    const { owed } = await stopDuringTool(qa);
    // src/lib/stopped.ts: a call Stop ended answers `cancelled`, and the chat never says "Couldn't".
    const ffmpeg = owed.find((o) => o.name === "run_ffmpeg");
    expect(ffmpeg?.result).toEqual({ ok: false, error: "cancelled" });
    await expect(qa.pane.getByText("Couldn't run ffmpeg")).toHaveCount(0);
  });

  test("after 40 steps the turn pauses and asks; Continue sends the paused results and the agent finishes", async ({
    qa,
  }) => {
    let resumed: Round | null = null;
    qa.server.script(manyReads(40), (round: Round) => {
      resumed = round;
      return plainText("All 40 checks are done; the timeline is consistent.");
    });
    await qa.openProject();
    await qa.send("Check the timeline thoroughly");
    const ask = qa.pane.getByText(/has been running for a long time — continue to iterate\?/);
    await expect(ask).toBeVisible({ timeout: 30_000 });
    // Paused means paused: no round goes out until the person answers.
    await qa.page.waitForTimeout(1500);
    expect(qa.server.modelRounds()).toHaveLength(1);

    const resumedWait = startTimer(inBrowser("Continue to the next answer"));
    await qa.pane.getByRole("button", { name: "▶ Continue" }).click();
    await expect(qa.reply("All 40 checks are done; the timeline is consistent.")).toBeVisible({
      timeout: 20_000,
    });
    resumedWait.stop();
    await qa.idle();
    expect(qa.server.modelRounds()).toHaveLength(2);
    expect(resumed).not.toBeNull();
    const results = (resumed as Round | null)?.toolResults ?? [];
    expect(results).toHaveLength(40);
    expect(results.every((r) => r.name === "get_timeline" && r.result.ok !== false)).toBe(true);
  });

  test("a failed turn offers Try again, which sends the same message once and gets the answer", async ({
    qa,
  }) => {
    qa.server.script(serverError(), plainText("Here it is, second time lucky."));
    const id = await qa.openProject();
    await qa.send("Summarise the project");
    await expect(
      qa.pane.getByText(/The service ran into a problem\. Your project is safe\./).first(),
    ).toBeVisible({ timeout: 15_000 });
    const again = qa.pane.getByRole("button", { name: "↻ Try again" });
    await expect(again).toBeVisible();
    // Nothing is sent again by itself.
    await qa.page.waitForTimeout(1500);
    expect(qa.server.modelRounds()).toHaveLength(1);

    const retried = startTimer(inBrowser("Try again to the answer"));
    await again.click();
    await expect(qa.reply("Here it is, second time lucky.")).toBeVisible({ timeout: 15_000 });
    retried.stop();
    await qa.idle();
    const rounds = qa.server.modelRounds();
    expect(rounds).toHaveLength(2);
    const textOf = (b: unknown) =>
      String((b as { round_input?: { user_text?: string } }).round_input?.user_text ?? "");
    expect(textOf(rounds[1].body)).toBe(textOf(rounds[0].body));
    // One message in the record, not two, and the answer that came on the second try is kept.
    await expect
      .poll(async () => qa.savedTranscriptText(id), { timeout: 10_000 })
      .toContain("Here it is, second time lucky.");
    const saved = await qa.savedTranscript(id);
    expect(saved?.requests?.map((r) => r.message?.text)).toEqual(["Summarise the project"]);
  });
});
