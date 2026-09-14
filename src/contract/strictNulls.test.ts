import { beforeAll, describe, expect, it } from "vitest";

import { setContract } from ".";
import { dropStrictNulls } from "./clamp";

// We send tools to OpenAI in STRICT mode, where every declared property must be
// present and optionality is a ["integer","null"] union — so the model says "I'm not
// setting this" by sending null. The contract we SERVE is un-strictified, so a param
// that declares null itself means null for real.
beforeAll(() => {
  setContract({
    version: "test",
    tools: [
      {
        name: "set_project_settings",
        parameters: {
          type: "object",
          properties: {
            fps: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
            aspect_ratio: { type: "string" },
          },
        },
      },
      {
        name: "set_transition",
        parameters: {
          type: "object",
          properties: {
            clip_id: { type: "string" },
            // Declares null ON PURPOSE: null means "remove the transition".
            transition_in: {
              type: ["object", "null"],
              properties: { kind: { type: "string" }, duration: { type: "integer" } },
            },
          },
        },
      },
      {
        name: "apply_color",
        parameters: {
          type: "object",
          properties: {
            clip_ids: { type: "array", items: { type: "string" } },
            exposure: { type: "number" },
            // Free-form: no declared properties, so the model's own data (nulls
            // included) is none of our business.
            color: { type: "object" },
          },
        },
      },
      {
        name: "add_clips",
        parameters: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  media_ref: { type: "string" },
                  track_id: { type: "string" },
                  timeline_in: { type: "integer" },
                },
              },
            },
          },
        },
      },
    ],
  });
});

describe("dropStrictNulls", () => {
  it("drops the nulls strict mode forced, keeping the fields actually set", () => {
    // The eval repro: the model wanted 16:9 @24fps and had no idea of the size.
    // Under strict it MUST emit width/height, and null is its only honest blank.
    const r = dropStrictNulls("set_project_settings", {
      width: null,
      height: null,
      aspect_ratio: "16:9",
      fps: 24,
    });
    expect(r).toEqual({ aspect_ratio: "16:9", fps: 24 });
    expect("width" in r).toBe(false); // absent, NOT 0
  });

  it("keeps a null the contract itself declares (null = remove, not 'unset')", () => {
    const r = dropStrictNulls("set_transition", { clip_id: "c1", transition_in: null });
    expect(r).toEqual({ clip_id: "c1", transition_in: null });
  });

  it("drops an empty STRING too — a blank id must not be looked up as a real one", () => {
    // The model reaches for "" on string params the same way it reaches for null on
    // numbers, with or without strict mode. other NLEs hit this and strips both.
    const r = dropStrictNulls("set_project_settings", { aspect_ratio: "", fps: 24 });
    expect(r).toEqual({ fps: 24 });
  });

  it("drops blanks inside array entries as well", () => {
    const r = dropStrictNulls("add_clips", {
      entries: [{ media_ref: "m1", track_id: "", timeline_in: 0 }],
    });
    expect(r.entries).toEqual([{ media_ref: "m1", timeline_in: 0 }]);
  });

  it("keeps a string that only LOOKS blank", () => {
    const r = dropStrictNulls("set_project_settings", { aspect_ratio: " ", fps: 24 });
    expect(r).toEqual({ aspect_ratio: " ", fps: 24 }); // not our call to trim
  });

  it("does not descend into a free-form object", () => {
    // `color` is the grade-copy path: its keys are the model's data, not our schema.
    const r = dropStrictNulls("apply_color", {
      clip_ids: ["a"],
      exposure: null,
      color: { exposure: 1, lut: null },
    });
    expect(r).toEqual({ clip_ids: ["a"], color: { exposure: 1, lut: null } });
  });

  it("strips forced nulls inside array entries too", () => {
    // Nested optional fields are widened by strict as well, so entries[].track_id
    // arrives as null and would otherwise become a real track named "null".
    const r = dropStrictNulls("add_clips", {
      entries: [
        { media_ref: "m1", track_id: null, timeline_in: 0 },
        { media_ref: "m2", track_id: "v2", timeline_in: null },
      ],
    });
    expect(r.entries).toEqual([
      { media_ref: "m1", timeline_in: 0 },
      { media_ref: "m2", track_id: "v2" },
    ]);
  });

  it("leaves an undeclared arg alone so unknownParams can still report it", () => {
    const r = dropStrictNulls("set_project_settings", { bogus: null, fps: 30 });
    expect("bogus" in r).toBe(true);
  });

  it("passes real values through untouched, including falsy ones", () => {
    const r = dropStrictNulls("set_project_settings", { fps: 0, width: 1280, height: 720 });
    expect(r).toEqual({ fps: 0, width: 1280, height: 720 });
  });

  it("is a no-op for a tool the contract does not describe", () => {
    const args = { anything: null };
    expect(dropStrictNulls("not_a_tool", args)).toBe(args);
  });
});
