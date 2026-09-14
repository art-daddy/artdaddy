// "Approve `get_page_image`?" is our vocabulary, not the user's. These walk the REAL approval
// sets rather than a hand-written list, so a new paid tool shipped without plain-English copy
// fails here instead of reaching a tester as a raw identifier.
import { describe, expect, it } from "vitest";

import { EXTERNAL_FETCH_TOOLS, PAID_TOOLS, needsApproval } from "../agent/loop";
import { approvalReason, describeApproval } from "./approvalCopy";

describe("every gated tool has copy a non-engineer can read", () => {
  for (const name of [...PAID_TOOLS, ...EXTERNAL_FETCH_TOOLS]) {
    it(`${name} reads as an action, not an identifier`, () => {
      const copy = describeApproval(name);
      expect(copy).not.toBeNull();
      expect(copy!.action).not.toBe(name); // the fallback -> nobody wrote copy for it
      expect(copy!.action).not.toMatch(/_/); // still a snake_case tool name
      expect(copy!.because).toBeTruthy();
    });
  }

  it("covers the destructive call too, which is classified by an argument", () => {
    const copy = describeApproval("library_op", { action: "delete", media_ref: "clip.mp4" });
    expect(copy?.reason).toBe("destructive");
    expect(copy?.action).not.toBe("library_op");
    expect(copy?.approveLabel).toBe("Delete");
  });
});

describe("it never invents a reason", () => {
  it("returns nothing for a tool that runs without asking", () => {
    expect(describeApproval("add_clips", { track: "v1" })).toBeNull();
    expect(approvalReason("export")).toBeNull();
  });

  it("does not call a non-delete library_op destructive", () => {
    expect(describeApproval("library_op", { action: "rename" })).toBeNull();
  });

  it("agrees with the gate that decides whether to ask at all", () => {
    for (const name of ["generate_image", "download_video", "add_clips", "export"]) {
      expect(describeApproval(name) !== null).toBe(needsApproval(name));
    }
  });
});

describe("the consequential argument is shown", () => {
  it("prefers a url over other fields", () => {
    const copy = describeApproval("download_video", {
      url: "https://example.com/v.mp4",
      name: "v",
    });
    expect(copy?.subject).toBe("https://example.com/v.mp4");
  });

  it("falls back to the prompt when there is no url", () => {
    expect(describeApproval("generate_image", { prompt: "a red car" })?.subject).toBe("a red car");
  });

  it("has no subject when nothing meaningful was passed", () => {
    expect(describeApproval("generate_music", { seconds: 30 })?.subject).toBeUndefined();
  });
});
