import { describe, expect, it } from "vitest";
import { jobWakePrompt } from "./chat";
import type { SettledJob } from "./jobNotes";

const done = (over: Partial<SettledJob> = {}): SettledJob => ({
  id: "j1",
  tool: "generate_image",
  label: "a hero still",
  status: "done",
  startedBy: "chat",
  media_refs: ["media_gen_abc"],
  ...over,
});

describe("job wake prompt", () => {
  // The ids are the point: the next round has to be able to place the media without a lookup.
  it("names the media that is ready", () => {
    const text = jobWakePrompt([done()]);
    expect(text).toContain("a hero still is ready");
    expect(text).toContain("media_gen_abc");
  });

  it("lists every finished job, not just the first", () => {
    const text = jobWakePrompt([
      done(),
      done({ id: "j2", label: "a bed", media_refs: ["media_gen_x"] }),
    ]);
    expect(text).toContain("a hero still");
    expect(text).toContain("a bed");
    expect(text).toContain("media_gen_x");
  });

  // Without this the agent's last message still claims the work is underway.
  it("reports a failure and its reason", () => {
    const text = jobWakePrompt([
      done({ status: "failed", error: "content filter", media_refs: undefined }),
    ]);
    expect(text).toContain("FAILED");
    expect(text).toContain("content filter");
  });

  it("tells the agent not to silently re-spend on a failure", () => {
    expect(jobWakePrompt([done({ status: "failed", error: "x" })])).toMatch(/costs money/i);
  });

  it("survives a job that produced no refs", () => {
    const text = jobWakePrompt([done({ media_refs: undefined })]);
    expect(text).toContain("a hero still is ready");
    expect(text).not.toContain("()");
  });

  it("mixes ready and failed in one wake", () => {
    const text = jobWakePrompt([
      done(),
      done({ id: "j2", label: "a clip", status: "failed", error: "nope", media_refs: undefined }),
    ]);
    expect(text).toContain("a hero still is ready");
    expect(text).toContain("a clip FAILED: nope");
  });
});

// What the prompt said before a failed export was told in the app's own words, captured from the tree before that change: a rewrite of the
// text must not move a generation's wake, a finished export's, the words' or the lines around them by a byte.
describe("job wake prompt: everything but a failed export reads as it always did", () => {
  const TRAILER =
    "\n\nContinue what you were doing if there is more to do. If a job failed, say so and offer a\nway forward instead of silently retrying anything that costs money.";
  const LEAD = "Background work you started earlier has finished:\n";
  const exportDone = (over: Partial<SettledJob> = {}): SettledJob => ({
    id: "e1",
    tool: "export",
    label: "the export long.mp4",
    status: "done",
    startedBy: "chat",
    detail: "saved as long.mp4",
    ...over,
  });
  const words = (): SettledJob => ({
    id: "w1",
    tool: "transcribe",
    label: "the words of a.mp4",
    status: "done",
    startedBy: "chat",
    kind: "words",
  });
  const CASES: Array<[string, SettledJob[], string]> = [
    [
      "a generation that finished",
      [done()],
      `${LEAD}- a hero still is ready (media_gen_abc)${TRAILER}`,
    ],
    [
      "a generation that failed",
      [done({ status: "failed", error: "content filter", media_refs: undefined })],
      `${LEAD}- a hero still FAILED: content filter${TRAILER}`,
    ],
    [
      "a generation that failed without a reason",
      [done({ status: "failed", media_refs: undefined })],
      `${LEAD}- a hero still FAILED: unknown error${TRAILER}`,
    ],
    [
      "two generations that finished",
      [done(), done({ id: "j2", label: "a bed", media_refs: ["media_gen_x", "media_gen_y"] })],
      `${LEAD}- a hero still is ready (media_gen_abc)\n- a bed is ready (media_gen_x, media_gen_y)${TRAILER}`,
    ],
    [
      "one that finished and one that failed",
      [
        done(),
        done({ id: "j2", label: "a clip", status: "failed", error: "nope", media_refs: undefined }),
      ],
      `${LEAD}- a hero still is ready (media_gen_abc)\n- a clip FAILED: nope${TRAILER}`,
    ],
    [
      "an export that finished",
      [exportDone()],
      `${LEAD}- the export long.mp4 is ready — saved as long.mp4${TRAILER}`,
    ],
    [
      "an export that finished after the app started it again",
      [exportDone({ detail: "saved as long.mp4 (restarted once on the processor)" })],
      `${LEAD}- the export long.mp4 is ready — saved as long.mp4 (restarted once on the processor)${TRAILER}`,
    ],
    [
      "a failure that carries no words of the app's own (the encoder's, as it was)",
      [
        exportDone({
          status: "failed",
          detail: undefined,
          error: "native render failed: ffmpeg exited with code 1",
        }),
      ],
      `${LEAD}- the export long.mp4 FAILED: native render failed: ffmpeg exited with code 1${TRAILER}`,
    ],
    [
      "only the words of a file",
      [words()],
      `${LEAD}- the words of a.mp4 are ready\n\nContinue what you were doing if there is more to do.`,
    ],
    [
      "the words of a file and an export",
      [words(), exportDone()],
      `${LEAD}- the words of a.mp4 are ready\n- the export long.mp4 is ready — saved as long.mp4${TRAILER}`,
    ],
  ];

  it.each(CASES)("%s", (_what, jobs, expected) => {
    expect(jobWakePrompt(jobs)).toBe(expected);
  });
});

describe("job wake prompt: a failed export", () => {
  const SENTENCE =
    "Some clips couldn't be read. They may have been moved or renamed, or are on a drive that is disconnected.";
  const failedExport = (over: Partial<SettledJob> = {}): SettledJob => ({
    id: "e1",
    tool: "export",
    label: "the export long.mp4",
    status: "failed",
    startedBy: "chat",
    error: "native render failed: C:\\Users\\someone\\Videos\\a.mp4: No such file or directory",
    failure: SENTENCE,
    failure_code: "source_unavailable",
    ...over,
  });

  it("says the app's plain sentence and the failure code, and none of the encoder's own words", () => {
    const text = jobWakePrompt([failedExport()]);
    expect(text).toContain(
      `- the export long.mp4 FAILED: ${SENTENCE} (failure_code: source_unavailable)\n`,
    );
    expect(text).not.toContain("native render failed");
    expect(text).not.toContain("No such file or directory");
    // The lines around it are the ones every wake has.
    expect(text.startsWith("Background work you started earlier has finished:\n- the export")).toBe(
      true,
    );
    expect(text.endsWith("retrying anything that costs money.")).toBe(true);
  });

  it.each([
    ["a Windows path", "C:\\Users\\someone\\Videos\\a.mp4"],
    ["a Windows path with slashes", "C:/Users/someone/Videos/a.mp4"],
    ["a network path", "\\\\office\\share\\someone\\a.mp4"],
    ["a macOS path", "/Users/someone/Movies/a.mp4"],
    ["a Linux path", "/home/someone/a.mp4"],
  ])("names no path of the person's PC when the encoder's words hold %s", (_what, path) => {
    const text = jobWakePrompt([
      failedExport({ error: `native render failed: ${path}: no such file` }),
    ]);
    expect(text).not.toContain("someone");
    expect(text).not.toContain("no such file");
    expect(text).toContain(SENTENCE);
  });

  it("goes on saying the encoder's words for work that has no words of the app's own", () => {
    const text = jobWakePrompt([
      failedExport({
        failure: undefined,
        failure_code: undefined,
        error: "ffmpeg exited with code 1",
      }),
    ]);
    expect(text).toContain("- the export long.mp4 FAILED: ffmpeg exited with code 1\n");
  });

  it("says the sentence alone when the code is missing, and never the word undefined", () => {
    const text = jobWakePrompt([failedExport({ failure_code: undefined })]);
    expect(text).toContain(`FAILED: ${SENTENCE}\n`);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("failure_code");
  });

  // Everything a wake carries crosses the one scrub a tool's reply crosses, whichever job it is about.
  it.each([
    [
      "a generation's reason",
      done({
        status: "failed",
        error: "could not read C:\\Users\\someone\\Pictures\\b.png",
        media_refs: undefined,
      }),
      "b.png",
    ],
    [
      "a finished export's detail",
      exportLike({ detail: "saved as long.mp4 (1 warning: font /home/someone/f.ttf missing)" }),
      "f.ttf",
    ],
    ["a label", done({ label: "the picture at /Users/someone/Pictures/c.png" }), "c.png"],
  ])("scrubs %s", (_what, job, basename) => {
    const text = jobWakePrompt([job]);
    expect(text).not.toContain("someone");
    expect(text).toContain(basename);
  });

  function exportLike(over: Partial<SettledJob>): SettledJob {
    return {
      id: "e2",
      tool: "export",
      label: "the export long.mp4",
      status: "done",
      startedBy: "chat",
      ...over,
    };
  }
});
