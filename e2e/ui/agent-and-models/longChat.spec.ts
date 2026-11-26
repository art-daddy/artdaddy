// A long conversation: every turn stays on screen and in the saved chat, every round carries the
// whole history while it fits, and once the chat is long enough to slow every step the app offers
// a new chat, which puts the old one away intact.
import { promises as fsp } from "node:fs";
import path from "node:path";

import { say } from "./lib/reply";
import { expect, test } from "./lib/qa";
import { inBrowser, record, startTimer } from "./lib/waits";

const TURNS = 24;
/** What each answer reports as the conversation's size: past 100K the app offers a new chat. */
const contextAfter = (n: number) => n * 5000;
const answer = (n: number) =>
  `Answer ${n}: ` +
  "the cut on the second beat works, the colour is even, and the music can come up a little. ".repeat(
    4,
  );

test("a 24-turn conversation keeps everything, sends the whole history, then offers and makes a new chat", async ({
  qa,
}) => {
  test.setTimeout(300_000);
  const id = await qa.openProject();
  const firstReply: number[] = [];
  for (let n = 1; n <= TURNS; n++) {
    qa.server.script(say(answer(n), { usage: { input_tokens: contextAfter(n) } }));
    const wait = startTimer(inBrowser(`first visible reply, turn ${n} of a long chat`));
    await qa.send(`Question ${n}: how does the cut look?`);
    await expect(qa.reply(new RegExp(`^Answer ${n}:`))).toBeVisible({ timeout: 15_000 });
    firstReply.push(wait.stop().ms);
    await qa.idle();
  }
  // The last turn is no slower to start answering than the first by more than a few seconds.
  record(inBrowser("first reply, turn 24 minus turn 1"), firstReply[TURNS - 1] - firstReply[0]);
  expect(firstReply[TURNS - 1]).toBeLessThan(firstReply[0] + 5000);

  // Every round carried the whole conversation so far, oldest first, and stayed far under the
  // server's 64 MB request ceiling.
  const rounds = qa.server.modelRounds();
  expect(rounds).toHaveLength(TURNS);
  const last = rounds[TURNS - 1].body as { transcript?: { requests?: unknown[] } };
  const history = JSON.stringify(last.transcript ?? {});
  for (const n of [1, 12, 23]) expect(history).toContain(`Question ${n}: how does the cut look?`);
  expect(history).toContain("Answer 1:");
  expect(JSON.stringify(last).length).toBeLessThan(64 * 1024 * 1024);

  // On screen and on disk: all 24 exchanges.
  await expect(qa.reply(/^Answer 1:/)).toHaveCount(1);
  await expect
    .poll(async () => (await qa.savedTranscript(id))?.requests?.length ?? 0, { timeout: 10_000 })
    .toBe(TURNS);

  // 120K of context: the meter says so and offers a fresh chat.
  await expect(qa.pane.getByText(/120K\/400K · 30%/)).toBeVisible();
  const fresh = qa.pane.getByRole("button", { name: "Start a new chat" });
  await expect(fresh).toBeVisible();
  const putAway = (await qa.savedTranscript(id)) as { id?: string } | null;
  await fresh.click();
  await expect(qa.pane.getByText("Ask anything, or start with:")).toBeVisible({ timeout: 10_000 });
  await expect(qa.reply(/^Answer 24:/)).toHaveCount(0);

  // The old chat is kept whole beside the project (internals/chat/sessions); the open one is empty.
  const chats = path.join(qa.shell.projectDir(id), "internals", "chat", "sessions");
  await expect
    .poll(async () => (await fsp.readdir(chats).catch(() => [])).filter((f) => f.endsWith(".json")))
    .toContain(`${putAway?.id}.json`);
  const kept = JSON.parse(await fsp.readFile(path.join(chats, `${putAway?.id}.json`), "utf8")) as {
    requests?: unknown[];
  };
  expect(kept.requests).toHaveLength(TURNS);
  await expect
    .poll(async () => (await qa.savedTranscript(id))?.requests?.length ?? 0, { timeout: 10_000 })
    .toBe(0);
});
