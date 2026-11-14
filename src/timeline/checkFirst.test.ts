import { describe, expect, it } from "vitest";
import { PC_CLASSES } from "./exportTypes3c";
import { checkFirstDue, type CheckFirstInput } from "./checkFirst";

const due: CheckFirstInput = {
  via: "chat",
  pcClass: "unknown",
  matchingHistory: false,
  heavy: true,
  alreadyAsked: false,
};

describe("the check-first question", () => {
  it("is asked for a heavy export that starts without the dialog on a PC nothing is known about", () => {
    expect(checkFirstDue(due)).toBe(true);
    expect(checkFirstDue({ ...due, via: "mcp" })).toBe(true);
    expect(checkFirstDue({ ...due, via: "other" })).toBe(true);
  });

  it("is never asked when any one reason not to is present (each condition removed in turn would make it ask)", () => {
    expect(checkFirstDue({ ...due, via: "menu" })).toBe(false);
    expect(checkFirstDue({ ...due, matchingHistory: true })).toBe(false);
    expect(checkFirstDue({ ...due, heavy: false })).toBe(false);
    expect(checkFirstDue({ ...due, alreadyAsked: true })).toBe(false);
  });

  it("is never asked of a PC that already has a class, finished or not", () => {
    for (const pcClass of PC_CLASSES.filter((c) => c !== "unknown"))
      expect(checkFirstDue({ ...due, pcClass })).toBe(false);
  });
});
