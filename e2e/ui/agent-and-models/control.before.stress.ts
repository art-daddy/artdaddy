// TEMPORARY (work/agent-flake, removed before merge): "Stop while the answer streams" as it was
// before the fix: the round writes its words and then goes SILENT. Run on Linux CI beside the fixed
// test (playwright.config.ts, stress-* projects) to show how often Linux WebKit keeps the words
// back. Not a *.spec.ts file, so the normal projects never run it.
import { HANGING_WORDS } from "./fixtures/replies/hangs";
import { stream } from "./lib/reply";
import { expect, test } from "./lib/qa";

test("BEFORE THE FIX: Stop while the answer streams, on a stream that goes silent after its words", async ({
  qa,
}) => {
  test.setTimeout(60_000);
  qa.server.script(
    stream(
      "streams a few words, then goes silent",
      ...HANGING_WORDS.split(" ").map((w) => ({ delta: `${w} ` })),
      { wait: 600_000 },
    ),
  );
  await qa.openProject();
  await qa.send("Check every clip for black frames");
  await expect(qa.reply(HANGING_WORDS)).toBeVisible({ timeout: 15_000 });
  await qa.stopButton.click();
  await expect(qa.sendButton).toBeVisible();
});
