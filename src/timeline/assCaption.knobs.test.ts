// Conformance: every knob on CaptionSpec must reach the .ass.
//
// A caption knob that is silently dropped is the exact bug class that once let 38 green tests sit
// beside a video with ZERO caption pixels. The table lives in __captionKnobs.ts and is typed
// `Record<keyof CaptionSpec, Knob>`, so a new field cannot arrive uncovered.
//
// This lane proves the knob reaches the FILE. Proving it reaches the PIXELS is
// assCaption.knobs.smoke.e2e.ts — libass silently ignores a tag it does not understand, so a
// changed string is necessary but not sufficient.
import { describe, expect, it } from "vitest";

import { assFor, BASE_CAPTION, CANVAS, KNOB_NAMES, KNOBS } from "./__captionKnobs";
import { buildBandAss } from "./assCaption";

describe("every CaptionSpec knob reaches the .ass", () => {
  it.each(KNOB_NAMES)("%s", (name) => {
    const knob = KNOBS[name];
    expect(
      assFor(knob, "varied"),
      `'${name}' produced a byte-identical .ass — the knob is being dropped`,
    ).not.toBe(assFor(knob, "base"));
  });

  it("the base fixture is a caption libass would actually draw", () => {
    const ass = buildBandAss([BASE_CAPTION], CANVAS);
    // If the baseline were empty, every knob above would "differ" for the wrong reason.
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toMatch(/^Dialogue: /m);
    expect(ass).toContain("hello there world");
  });

  it("varying nothing changes nothing (the walk's own control)", () => {
    expect(buildBandAss([BASE_CAPTION], CANVAS)).toBe(buildBandAss([{ ...BASE_CAPTION }], CANVAS));
  });

  it("covers every field of CaptionSpec, with no invented ones", () => {
    // BASE_CAPTION is typed as CaptionSpec, so its keys ARE the field list.
    expect(KNOB_NAMES.slice().sort()).toEqual(Object.keys(BASE_CAPTION).sort());
  });
});
