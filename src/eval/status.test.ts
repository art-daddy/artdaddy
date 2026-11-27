import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { KNOWN_FAILURE_REF, runStatus } from "./status";

describe("runStatus", () => {
  // The rule the known-failure mark exists for: a marked case never reads as a regression, and
  // the first run where it passes says so, so the mark can be removed.
  it("reads a marked case as a known failure while it fails and fixed once it passes", () => {
    const ref = "art-daddy/backlog#93";
    expect(runStatus({ passed: false, knownFailure: ref })).toBe("known_failure");
    expect(runStatus({ passed: true, knownFailure: ref })).toBe("fixed");
    expect(runStatus({ passed: false })).toBe("fail");
    expect(runStatus({ passed: true })).toBe("pass");
  });

  it("never calls a skipped or broken run a pass, a fail or a fix", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.constant("art-daddy/backlog#93"), { nil: undefined }),
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        (passed, knownFailure, skipped, harnessError) => {
          const s = runStatus({ passed, knownFailure, skipped, harnessError });
          if (skipped) expect(s).toBe("skipped");
          else if (harnessError) expect(s).toBe("harness_error");
          else if (knownFailure) expect(s).toBe(passed ? "fixed" : "known_failure");
          else expect(s).toBe(passed ? "pass" : "fail");
        },
      ),
    );
  });
});

describe("KNOWN_FAILURE_REF", () => {
  it("takes a backlog reference and nothing looser", () => {
    for (const ok of ["art-daddy/backlog#93", "art-daddy/artdaddy#7", "a.b/c_d-e#1234"])
      expect(ok).toMatch(KNOWN_FAILURE_REF);
    for (const bad of [
      "#93",
      "backlog#93",
      "art-daddy/backlog",
      "art-daddy/backlog#0",
      "art-daddy/backlog#9x",
      "see #93",
      "",
    ])
      expect(bad).not.toMatch(KNOWN_FAILURE_REF);
  });
});
