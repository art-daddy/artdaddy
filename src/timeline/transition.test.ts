import { describe, expect, it } from "vitest";

import { parseTransitionIn, TRANSITION_KINDS, transitionProgress } from "./transition";

describe("parseTransitionIn", () => {
  it("returns null for a clip without a valid transition", () => {
    expect(parseTransitionIn(null)).toBeNull();
    expect(parseTransitionIn({} as never)).toBeNull();
    expect(parseTransitionIn({ transition_in: { kind: "", duration: 10 } } as never)).toBeNull();
    expect(
      parseTransitionIn({ transition_in: { kind: "crossfade", duration: 0 } } as never),
    ).toBeNull();
    expect(parseTransitionIn({ transition_in: { kind: "crossfade" } } as never)).toBeNull();
  });

  it("parses kind + duration and an optional custom expr", () => {
    expect(
      parseTransitionIn({ transition_in: { kind: "crossfade", duration: 15 } } as never),
    ).toEqual({
      kind: "crossfade",
      duration: 15,
    });
    expect(
      parseTransitionIn({ transition_in: { kind: "custom", duration: 12, expr: "A*B" } } as never),
    ).toEqual({
      kind: "custom",
      duration: 12,
      expr: "A*B",
    });
  });

  it("exposes the seven schema kinds", () => {
    expect(TRANSITION_KINDS).toEqual([
      "crossfade",
      "dip-to-black",
      "dip-to-white",
      "whip",
      "wipe-l",
      "wipe-r",
      "custom",
    ]);
  });
});

describe("transitionProgress", () => {
  const t = { kind: "crossfade", duration: 10 };
  it("ramps 0..1 across the window and is null outside it", () => {
    expect(transitionProgress(t, 0)).toBe(0);
    expect(transitionProgress(t, 5)).toBe(0.5);
    expect(transitionProgress(t, 10)).toBe(1);
    expect(transitionProgress(t, -1)).toBeNull();
    expect(transitionProgress(t, 11)).toBeNull();
  });
  it("is null with no transition or zero duration", () => {
    expect(transitionProgress(null, 3)).toBeNull();
    expect(transitionProgress({ kind: "crossfade", duration: 0 }, 0)).toBeNull();
  });
});
