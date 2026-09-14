import { describe, expect, it } from "vitest";
import { jobNoteSummary } from "./jobNoteSummary";
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
});
