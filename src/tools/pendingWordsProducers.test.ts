// Every place that tells the assistant "the words are not ready" must also tell the wake, or the assistant is never
// brought back for them. A new producer that does not is the bug this guards: it fails here until the producer is
// listed with its wake, or with the reason it has none.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const NOT_TESTS = /^(?!.*\.(test|e2e|smoke|property|eval)\.tsx?$).*\.tsx?$/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return NOT_TESTS.test(e.name) && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** What a file that answers "not ready" must contain, and why each is there. */
const PRODUCERS: Record<string, { calls: string[]; why: string }> = {
  "tools/inspect.ts": {
    calls: ["wakeTargetOf(", "noteWordsFetched("],
    why: "inspect_media: the wait for a look's words registers, and a look that returns words says so",
  },
  "tools/captionTranscript.ts": {
    calls: ["wakeTargetOf(", "noteWordsFetched("],
    why: "add_captions: the wait for each clip's words registers, and words used for captions say so",
  },
  "tools/transcribe.ts": {
    calls: ["wakeTargetOf(", "registerPendingWords(", "registerCachedWords(", "noteWordsFetched("],
    why: "get_transcript: the run still going and the clips handed to the project's transcriber register",
  },
  "tools/transcriptWait.ts": {
    calls: ["registerPendingWords("],
    why: "the one boundary of every waitForRun: a pending answer registers the file with the run's end",
  },
};

/** Files that say "in progress" about something that is not the words of a file the assistant looked at, or
 *  that are named exclusions of the wake. Each says why. */
const NAMED_EXCLUSIONS: Record<string, string> = {
  "tools/loudness.ts": "loudness measurement, not words: nothing is brought back for it",
};

describe("every producer of 'the words are not ready' is wired to the wake, or says why not", () => {
  // Test support (src/test) is not product code: the harness's scripted model reads "in_progress" answers.
  const files = sources(SRC)
    .map((f) => ({
      name: path.relative(SRC, f).split(path.sep).join("/"),
      text: readFileSync(f, "utf8"),
    }))
    .filter((f) => !f.name.startsWith("test/"));
  const talksOfWaiting = files.filter(
    (f) =>
      /\bwaitForRun\(/.test(f.text) ||
      /["'`]in_progress["'`]/.test(f.text) ||
      /status: "in_progress"/.test(f.text),
  );

  it("finds the producers it knows, so this passes for nothing if the scan finds none", () => {
    for (const name of Object.keys(PRODUCERS))
      expect(
        talksOfWaiting.some((f) => f.name === name),
        name,
      ).toBe(true);
  });

  it("knows every file that waits for words or answers in_progress", () => {
    const unknown = talksOfWaiting
      .map((f) => f.name)
      .filter((name) => !(name in PRODUCERS) && !(name in NAMED_EXCLUSIONS));
    expect(
      unknown,
      "add each to PRODUCERS with the calls that wire it, or to NAMED_EXCLUSIONS with a reason",
    ).toEqual([]);
  });

  it.each(Object.entries(PRODUCERS))("%s tells the wake", (name, { calls }) => {
    const text = files.find((f) => f.name === name)?.text ?? "";
    for (const call of calls) expect(text, `${name} must call ${call}`).toContain(call);
  });

  it("passes a wake target at every waitForRun, so that a new caller has to decide", () => {
    // The type makes the field required; this reads the calls themselves, so a cast cannot hide one.
    for (const f of files) {
      const calls = [...f.text.matchAll(/\bwaitForRun\(\{([\s\S]*?)\n\s*\}\)/g)];
      for (const call of calls)
        expect(call[1], `${f.name}: waitForRun without wake`).toMatch(/\bwake:/);
    }
  });
});
