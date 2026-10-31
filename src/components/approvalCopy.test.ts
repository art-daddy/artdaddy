// "Approve `get_page_image`?" is our vocabulary, not the user's. These walk the REAL approval
// sets rather than a hand-written list, so a new paid tool shipped without plain-English copy
// fails here instead of reaching a tester as a raw identifier.
import { describe, expect, it } from "vitest";

import { EXTERNAL_FETCH_TOOLS, PAID_TOOLS, needsApproval } from "../agent/loop";
import { approvalReason, describeApproval, priceLine } from "./approvalCopy";

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

describe("the price line", () => {
  const account = { metered: true, used: 30, limit: 150, remaining: 120, over: false };

  it("says up to how many credits the call may spend and how many the person has left", () => {
    expect(priceLine(96, account)).toBe("Up to 96 credits · you have 120 left");
  });

  it("says credit in the singular for exactly one", () => {
    expect(priceLine(1, account)).toBe("Up to 1 credit · you have 120 left");
    expect(priceLine(1.5, account)).toBe("Up to 1.5 credits · you have 120 left");
  });

  it("leaves out what is left for an account with no limit, and for one that is not metered", () => {
    expect(priceLine(96, { ...account, limit: 0, remaining: 0 })).toBe("Up to 96 credits");
    expect(priceLine(96, { ...account, metered: false })).toBe("Up to 96 credits");
  });

  it("never shows a negative balance", () => {
    expect(priceLine(96, { ...account, remaining: -5 })).toBe("Up to 96 credits · you have 0 left");
  });

  it("formats credits like the rest of the readout", () => {
    expect(priceLine(0.1 + 0.2, { ...account, remaining: 0.1 + 0.2 })).toBe(
      "Up to 0.3 credits · you have 0.3 left",
    );
  });

  it("states a price that does not fit the balance too: the server refuses it in its own words", () => {
    expect(priceLine(96, { ...account, remaining: 30 })).toBe(
      "Up to 96 credits · you have 30 left",
    );
  });
});
