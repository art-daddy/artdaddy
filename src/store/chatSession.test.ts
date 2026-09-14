import { describe, expect, it } from "vitest";

import { localSession, undoFlags } from "./chatSession";
import type { Turn } from "./chatTranscript";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function turn(over: Partial<Turn> = {}): Turn {
  return { id: "t", userText: "", attachments: [], parts: [], status: "done", ...over };
}

describe("undoFlags", () => {
  it("can_undo when any turn is live; can_redo when the last is undone", () => {
    expect(undoFlags([])).toEqual({ can_undo: false, can_redo: false });
    expect(undoFlags([turn({ undone: false })])).toEqual({ can_undo: true, can_redo: false });
    expect(undoFlags([turn({ undone: true })])).toEqual({ can_undo: false, can_redo: true });
    expect(undoFlags([turn({ undone: false }), turn({ undone: true })])).toEqual({
      can_undo: true,
      can_redo: true,
    });
  });
});

describe("localSession", () => {
  it("defaults to zeros + the given mode, folding in undo flags", () => {
    const s = localSession([turn({ undone: false })], "default");
    expect(s.cost_usd).toBe(0);
    expect(s.approval_mode).toBe("default");
    expect(s.can_undo).toBe(true);
    expect(s.finished).toBe(true);
  });

  it("carries cost / tokens / approval_mode from the base", () => {
    const base = { cost_usd: 1.5, input_tokens: 10, approval_mode: "autopilot" } as Any;
    const s = localSession([], "default", base);
    expect(s.cost_usd).toBe(1.5);
    expect(s.input_tokens).toBe(10);
    expect(s.approval_mode).toBe("autopilot");
  });
});
