import { describe, expect, it } from "vitest";
import { jobNoteSummary } from "./jobNoteSummary";
import { CreditLimitError } from "../api/usage";
import { jobWakePrompt } from "../store/chat";
import type { SettledJob } from "../store/jobNotes";

const job = (over: Partial<SettledJob> = {}): SettledJob => ({
  id: "j1",
  tool: "generate_image",
  label: "an image",
  status: "done",
  startedBy: "chat",
  media_refs: ["media_gen_abc"],
  ...over,
});

describe("job note summary", () => {
  // Driven by the REAL prompt builder, so a change to the wake text cannot leave this
  // reading a shape nothing produces.
  it("reduces a ready job to one human line", () => {
    expect(jobNoteSummary(jobWakePrompt([job()]))).toBe("an image ready");
  });

  it("never shows the model-facing instructions", () => {
    const out = jobNoteSummary(jobWakePrompt([job()]));
    expect(out).not.toMatch(/costs money/i);
    expect(out).not.toMatch(/Continue what you were doing/i);
    expect(out).not.toContain("media_gen_abc");
  });

  it("joins several ready jobs", () => {
    const out = jobNoteSummary(
      jobWakePrompt([job(), job({ id: "j2", label: "a bed" }), job({ id: "j3", label: "a clip" })]),
    );
    expect(out).toBe("an image, a bed and a clip ready");
  });

  it("reports a failure with its reason", () => {
    const out = jobNoteSummary(
      jobWakePrompt([job({ status: "failed", error: "content filter", media_refs: undefined })]),
    );
    expect(out).toBe("an image failed — content filter");
  });

  // The failure text was written for the MODEL ("Do NOT retry ... and stop"); a person needs
  // the reason, and the button ChatView puts beside it.
  it("reports running out of credits as that, not as the model's instructions", () => {
    const error = new CreditLimitError({ used: 500, limit: 500 }).message;
    const out = jobNoteSummary(
      jobWakePrompt([job({ status: "failed", error, media_refs: undefined })]),
    );
    expect(out).toBe("an image failed — out of credits");
  });

  it("shows ready and failed together", () => {
    const out = jobNoteSummary(
      jobWakePrompt([
        job(),
        job({ id: "j2", label: "a clip", status: "failed", error: "nope", media_refs: undefined }),
      ]),
    );
    expect(out).toBe("an image ready · a clip failed — nope");
  });

  it("degrades to a plain line rather than showing nothing", () => {
    expect(jobNoteSummary("something unparseable")).toBe("Background work finished");
  });

  // The words of files the assistant was told were not ready, in the prompt the wake really sends.
  it("reduces the words of files to one human line, without the file ids", () => {
    const words = job({
      id: "w1",
      tool: "inspect_media",
      kind: "words",
      label: "the words of 3 files",
      media_refs: ["m_12", "m_13", "m_14"],
    });
    const out = jobNoteSummary(jobWakePrompt([words]));
    expect(out).toBe("the words of 3 files ready");
    expect(out).not.toContain("m_12");
    expect(out).not.toMatch(/Continue what you were doing/i);
  });

  it("shows the words of files beside an export that finished with them", () => {
    const words = job({
      id: "w1",
      tool: "inspect_media",
      kind: "words",
      label: "the words of 2 files",
      media_refs: ["m_1", "m_2"],
    });
    const out = jobNoteSummary(jobWakePrompt([job(), words]));
    expect(out).toBe("an image and the words of 2 files ready");
  });

  // A failed export's wake ends with its failure code, for the model; the line a person reads is the sentence.
  it("shows a failed export as the app's sentence, without the failure code the model is given", () => {
    const sentence = "Your PC ran short of memory. Close other programs and try again.";
    const wake = jobWakePrompt([
      job({
        tool: "export",
        label: "the export long.mp4",
        status: "failed",
        error: "native render failed: render memory floor crossed",
        failure: sentence,
        failure_code: "memory_limit",
        media_refs: undefined,
      }),
    ]);
    expect(wake).toContain("(failure_code: memory_limit)");
    expect(jobNoteSummary(wake)).toBe(`the export long.mp4 failed — ${sentence}`);
  });
});
