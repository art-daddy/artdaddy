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
