// The assistant asks for the words of audio files that are not ready yet (lane L6, Phase 8), replayed in process on
// the app's real chat store, tool host and speech wait, with a fake speech engine and a scripted model
// (src/test/wakeHarness.ts). What is checked is what the person and the model see: which turns ran, how many
// rounds, which words reached the model, never how the app got there.
//
//   S1, S2  the behaviour wanted: ONE wake once every file of the batch has its words. They FAIL on an app that has
//           no wake for transcripts, because no wake happens.
//   S3, S4  controls that hold with or without it: the person got there first; an export wakes the assistant.
//   the harness's own checks: it must show what it claims to, and S1 and S2 must be satisfiable (a stand-in wake,
//           sent through the app's job queue, makes them pass), or a red S1 could mean a broken harness.
//
// Run: npx vitest run src/store/speechWake.harness.test.ts --maxWorkers=1
// With L6_EVIDENCE_DIR set, each scenario also writes its metrics there as <scenario>.json.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/api", async () => (await import("../test/wakeModel")).modelModule());
vi.mock("../tools/tauri", async () => (await import("../test/wakeWiring")).tauriModule());
vi.mock("../tools/dataRoot", async (original) => ({
  ...(await original<typeof import("../tools/dataRoot")>()),
  projectDirFor: async () => (await import("../test/wakeWiring")).wiring.projectDir,
}));
vi.mock("../api/appEvents", async (original) => ({
  ...(await original<typeof import("../api/appEvents")>()),
  reportAppError: () => undefined,
  reportTranscription: () => undefined,
}));

import { JOB_WAKE_LEAD, SETTLE_WINDOW_MS } from "./jobNotes";
import {
  createWakeHarness,
  type WakeHarness,
  type WakeMetrics,
  type WakeOptions,
} from "../test/wakeHarness";
import { wakeFiles } from "../test/wakeFs";

let open: WakeHarness | null = null;
afterEach(async () => {
  await open?.dispose();
  open = null;
});

async function start(options: WakeOptions): Promise<WakeHarness> {
  open = await createWakeHarness(options);
  return open;
}

const THIRTEEN_FILES: WakeOptions = {
  files: 13,
  fileSeconds: 30,
  engineSecondsPerFile: 30,
  task: "look_at_every_file",
};
const SEVEN_CLIPS: WakeOptions = {
  files: 7,
  fileSeconds: 20,
  engineSecondsPerFile: 75, // slower than the minute add_captions waits
  task: "add_captions",
  placeOnTimeline: true,
};
const FIRST_MESSAGE = "make a highlight reel from these clips";
const CAPTIONS_MESSAGE = "add captions to everything on the timeline";

/** One wake, after the last of the files has its words; none before, and no more than one. */
function expectOneWakeAfterTheLastWords(m: WakeMetrics, files: number, what: string): void {
  const wakes = m.wakeTurns.length;
  const lastLanding = m.lastLandingS ?? 0;
  expect
    .soft(
      wakes,
      `expected exactly 1 wake turn once the words of ${files} ${what} had landed (the last at ${lastLanding} s), got ${wakes}` +
        (wakes === 0
          ? ` (system turns of any kind: ${m.systemTurns}): no wake happened, so the person has to say "continue"`
          : ""),
    )
    .toBe(1);
  if (wakes > 0)
    expect
      .soft(
        m.wakeTurns[0].startedAtS,
        `the wake must start after the last file's words landed (${lastLanding} s), not at the first`,
      )
      .toBeGreaterThanOrEqual(lastLanding);
}

/** S1: after the wake the assistant has read all 13 files, in few rounds, and the person never said more. */
function expectS1(m: WakeMetrics): void {
  expectOneWakeAfterTheLastWords(m, 13, "files");
  expect
    .soft(
      m.wordsFetched,
      `the words of ${m.wordsFetched} of ${m.filesTotal} files reached the model: ` +
        (m.wakeTurns.length === 0
          ? "with no wake the assistant is never asked to look again"
          : "the assistant looks at the files the wake names, by id or by file name, and it was not given all 13"),
    )
    .toBe(13);
  expect.soft(m.modelRounds, "model rounds for the whole conversation").toBeLessThanOrEqual(5);
  expect
    .soft(m.turns.filter((t) => t.kind === "user").length, "messages the person had to send")
    .toBe(1);
}

/** S2: after the wake the second add_captions succeeded, so the captions are on the timeline. */
async function expectS2(m: WakeMetrics, h: WakeHarness): Promise<void> {
  expectOneWakeAfterTheLastWords(m, 7, "clips");
  const why =
    m.wakeTurns.length === 0
      ? "with no wake the assistant never calls add_captions again"
      : "after the wake";
  expect
    .soft(
      m.captionsAnswers,
      `what add_captions answered (${why}): the second call should add the captions`,
    )
    .toEqual(["pending", "added"]);
  expect.soft(await h.captionClips(), `caption clips on the timeline (${why})`).toBeGreaterThan(0);
}

/** The premise of S1: every one of the 13 looks found the words not ready, and the assistant handed back. */
function expectThirteenLooksNotReady(h: WakeHarness): void {
  const told = h.metrics();
  expect(Object.values(told.looks).map((answers) => answers.join())).toEqual(
    Array(13).fill("not_ready"),
  );
  expect(told.turns.map((t) => t.rounds)).toEqual([2]);
}

/** The premise of S2: the engine is slower than the call's wait, so the first call adds nothing, for all 7 clips. */
async function expectCaptionsNotAddedYet(h: WakeHarness): Promise<void> {
  const first = h.metrics().timeline.find((e) => e.event === "captions_answer");
  expect(first?.answer).toBe("pending");
  expect(String(first?.said)).toMatch(/speech in 7 audio clip\(s\) is still being transcribed/);
  expect(await h.captionClips()).toBe(0);
}

describe("the assistant waits for the words of 13 files", () => {
  it("is woken once, after the last file's words are ready, and reads all 13 without being asked again", async () => {
    const h = await start(THIRTEEN_FILES);
    await h.say(FIRST_MESSAGE);
    expectThirteenLooksNotReady(h);
    await h.advanceTo(h.lastLandingS() + 10);
    await h.writeEvidence("s1-fan-out");

    expectS1(h.metrics());
  }, 120_000);
});

describe("the assistant waits for the words of the clips it was asked to caption", () => {
  it("is woken once, after the 7th clip's words are ready, and then adds the captions", async () => {
    const h = await start(SEVEN_CLIPS);
    await h.say(CAPTIONS_MESSAGE);
    await expectCaptionsNotAddedYet(h);
    await h.advanceTo(h.lastLandingS() + 10);
    await h.writeEvidence("s2-captions");

    await expectS2(h.metrics(), h);
  }, 120_000);
});

describe("the person says continue after the words landed", () => {
  it("gets the words at once, in the person's own turn, and no wake turn happens before or after it", async () => {
    const h = await start(THIRTEEN_FILES);
    await h.say(FIRST_MESSAGE);
    await h.advanceTo(h.lastLandingS()); // the last word has just landed
    await h.say("continue");
    await h.advance(60_000); // long enough for any wake to have come
    await h.writeEvidence("s3-person-first");

    const m = h.metrics();
    expect(m.turns.map((t) => t.kind)).toEqual(["user", "user"]);
    expect(m.wakeTurns).toEqual([]);
    expect(m.systemTurns).toBe(0);
    expect(m.wordsFetched).toBe(13);
    expect(m.engineRuns, "the second look found the words in the cache").toHaveLength(13);
    const [, second] = m.turns;
    expect(second.endedAtS).toBe(second.startedAtS);
    for (const answers of Object.values(m.looks)) expect(answers).toEqual(["not_ready", "words"]);
  }, 120_000);
});

describe("an export that finishes wakes the assistant", () => {
  it("starts one system turn, whose message begins with the wake's first line", async () => {
    const h = await start({ ...THIRTEEN_FILES, files: 0 });
    h.settleExport();
    await h.advance(SETTLE_WINDOW_MS + 10_000);
    await h.writeEvidence("s4-export-wake");

    const m = h.metrics();
    expect(m.turns).toHaveLength(1);
    expect(m.turns[0].kind).toBe("system");
    expect(m.turns[0].textStart.startsWith(JOB_WAKE_LEAD)).toBe(true);
    expect(m.wakeTurns).toHaveLength(1);
    expect(m.turns[0].endedAtS).not.toBeNull();
    expect(m.finalAssistantTexts).toHaveLength(1);
  }, 60_000);
});

describe("the harness shows what it claims to", () => {
  it("answers every first look with the not-ready words (wording C) and no word of the speech", async () => {
    const h = await start(THIRTEEN_FILES);
    await h.say(FIRST_MESSAGE);

    const m = h.metrics();
    const answers = m.timeline.filter((e) => e.event === "look_answer");
    expect(answers).toHaveLength(13);
    for (const a of answers) {
      expect(a.answer).toBe("not_ready");
      expect(String(a.said)).toMatch(/^The words are not ready yet/);
      expect(String(a.said)).toContain(
        "Don't guess what is said. Tell the user, and ask again later",
      );
    }
    expect(m.wordsFetched).toBe(0);
    // The turn is the hand-back: one round of looks, one of text, and the person is told.
    expect(m.turns).toHaveLength(1);
    expect(m.turns[0].rounds).toBe(2);
    expect(m.finalAssistantTexts[0]).toMatch(/not ready yet/);
  }, 60_000);

  it("runs the engine on one file at a time: 13 runs of 30 s, the words landing at 30, 60 ... 390 s", async () => {
    const h = await start(THIRTEEN_FILES);
    await h.say(FIRST_MESSAGE);
    await h.advanceTo(h.lastLandingS() + 10);

    const runs = h.metrics().engineRuns;
    expect(runs.map((r) => r.file).sort()).toEqual(wakeFiles(13, 30, 0).map((f) => f.label));
    const byStart = [...runs].sort((a, b) => a.startS - b.startS);
    byStart.forEach((run, i) => {
      expect(run.endS! - run.startS).toBe(30);
      expect(run.endS).toBe(30 * (i + 1));
      if (i > 0) expect(run.startS, "no two runs overlap").toBe(byStart[i - 1].endS);
    });
  }, 60_000);

  it("keeps the words: a second look at the files gets each file's own words, and the engine is not run again", async () => {
    const h = await start({ ...THIRTEEN_FILES, files: 3 });
    await h.say(FIRST_MESSAGE);
    await h.advanceTo(h.lastLandingS());
    expect(h.metrics().engineRuns).toHaveLength(3);
    await h.say("continue");

    const m = h.metrics();
    expect(m.engineRuns).toHaveLength(3);
    const words = m.timeline.filter((e) => e.event === "look_answer" && e.answer === "words");
    expect(words.map((w) => w.file)).toEqual(["clip-01", "clip-02", "clip-03"]);
    const marks = ["one", "two", "three"];
    words.forEach((w, i) => expect(String(w.said)).toContain(`Clip ${marks[i]} opens`));
  }, 60_000);

  it("makes no network call and runs no program but ffprobe, ffmpeg and whisper-cli", async () => {
    const h = await start({ ...THIRTEEN_FILES, files: 3 });
    await h.say(FIRST_MESSAGE);
    await h.advanceTo(h.lastLandingS() + 10);
    expect(h.metrics().networkCalls).toBe(0);
    expect(h.metrics().refusedPrograms).toEqual([]);
  }, 60_000);

  // S1 and S2 are red on an app with no wake. These two show that it is for that reason: a wake sent through the
  // app's own job queue when the last words land (a stand-in for the one the app does not have) makes the very
  // same expectations pass.
  it("lets S1 be met: a wake that names the 13 files, sent when their words are ready, gets all 13 read", async () => {
    const h = await start(THIRTEEN_FILES);
    await h.say(FIRST_MESSAGE);
    expectThirteenLooksNotReady(h);
    await h.advanceTo(h.lastLandingS());
    h.settleJob({
      tool: "inspect_media",
      label: "the words of 13 clips",
      media_refs: h.files.map((f) => f.ref),
    });
    await h.advanceTo(h.lastLandingS() + 10);
    await h.writeEvidence("s1-fan-out.stand-in-wake");

    expectS1(h.metrics());
  }, 120_000);

  it("lets S2 be met: a wake sent when the 7 clips' words are ready gets the captions added", async () => {
    const h = await start(SEVEN_CLIPS);
    await h.say(CAPTIONS_MESSAGE);
    await expectCaptionsNotAddedYet(h);
    await h.advanceTo(h.lastLandingS());
    h.settleJob({
      tool: "add_captions",
      label: "the speech in the 7 clips",
      detail: "the words of all 7 clips are ready",
    });
    await h.advanceTo(h.lastLandingS() + 10);
    await h.writeEvidence("s2-captions.stand-in-wake");

    await expectS2(h.metrics(), h);
  }, 120_000);
});
