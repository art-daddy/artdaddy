import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetComposer, composerHasDraft, isDraft, useComposer } from "./composer";

afterEach(__resetComposer);

describe("the chat box's draft, as the wake sees it", () => {
  it("is empty until the box says otherwise, and follows what the box says", () => {
    expect(composerHasDraft()).toBe(false);
    useComposer.getState().setDraft(true);
    expect(composerHasDraft()).toBe(true);
    useComposer.getState().setDraft(false);
    expect(composerHasDraft()).toBe(false);
  });

  it("tells a subscriber only when the answer changes", () => {
    const seen = vi.fn();
    const stop = useComposer.subscribe((s) => seen(s.hasDraft));
    useComposer.getState().setDraft(false);
    useComposer.getState().setDraft(true);
    useComposer.getState().setDraft(true);
    useComposer.getState().setDraft(false);
    stop();
    expect(seen.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ["", 0, false],
    ["   \n\t ", 0, false],
    ["continue", 0, true],
    ["", 1, true],
    ["  a ", 0, true],
  ])("counts %j with %i attachments as a draft: %s", (text, attachments, expected) => {
    expect(isDraft(text, attachments)).toBe(expected);
  });
});
