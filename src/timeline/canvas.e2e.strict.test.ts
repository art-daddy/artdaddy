// The two halves of the strict-mode fix, JOINED. The server widens optional params to
// ["integer","null"] so the model can say "unset"; the dispatch boundary strips those
// nulls back to absent; the canvas resolver treats absent as "keep current". Each half
// is unit-tested separately, so each could keep passing while the seam between them
// breaks — and the seam is where the original bug lived.
//
// Repro under test (the literal arguments gpt-5.4-mini produced): the model wants a
// frame-rate change, does not know the canvas size, and MUST emit width/height.
import { beforeAll, describe, expect, it } from "vitest";

import { setContract } from "../contract";
import { dropStrictNulls } from "../contract/clamp";
import { resolveCanvas } from "./canvas";

const CURRENT = { width: 1080, height: 1920, fps: 30 };

// Mirrors the real served schema for set_project_settings (un-strictified, as we serve it).
beforeAll(() => {
  setContract({
    version: "test",
    tools: [
      {
        name: "set_project_settings",
        parameters: {
          type: "object",
          properties: {
            fps: { type: "integer", minimum: 1, maximum: 120 },
            size: {
              type: "object",
              properties: {
                aspect_ratio: { type: "string" },
                quality: { type: "string" },
                width: { type: "integer" },
                height: { type: "integer" },
              },
            },
          },
        },
      },
    ],
  });
});

/** What a tool body actually receives for a given raw model call. */
const asHandlerSees = (args: Record<string, unknown>): Record<string, unknown> =>
  dropStrictNulls("set_project_settings", args);

describe("strict-mode null -> canvas (end to end)", () => {
  it("the frame-rate-only call resolves and leaves the canvas untouched", () => {
    // What both models produced flat-per-knob was fps + a GUESSED aspect_ratio, which
    // reshaped the video. Nested, "don't touch the size" is a single size: null.
    const r = resolveCanvas(asHandlerSees({ fps: 24, size: null }), CURRENT);
    expect(r).toEqual({ width: 1080, height: 1920, fps: 24 });
  });

  it("a nested size with the unused knobs nulled still resolves", () => {
    const raw = {
      fps: null,
      size: { aspect_ratio: "16:9", quality: "720p", width: null, height: null },
    };
    const r = resolveCanvas(asHandlerSees(raw), CURRENT);
    expect(r).toEqual({ width: 1280, height: 720, fps: 30 });
  });

  it("aspect-only, everything else nulled: the model never has to know the size", () => {
    const r = resolveCanvas(
      asHandlerSees({
        fps: null,
        size: { aspect_ratio: "16:9", quality: null, width: null, height: null },
      }),
      CURRENT,
    );
    expect(r).toEqual({ width: 1920, height: 1080, fps: 30 });
  });

  it("PRE-FIX WITNESS: 0s instead of nulls are still refused", () => {
    // The guard rail must not have gone permissive just because null is now fine.
    const r = resolveCanvas(
      { fps: 24, size: { aspect_ratio: "16:9", width: 0, height: 0 } },
      CURRENT,
    );
    expect("error" in r).toBe(true);
  });

  it("null and omitted are indistinguishable to the resolver", () => {
    for (const raw of [{ fps: 48, size: null }, { fps: 48 }]) {
      expect(resolveCanvas(asHandlerSees(raw), CURRENT)).toEqual({
        width: 1080,
        height: 1920,
        fps: 48,
      });
    }
  });

  it("an all-null call still refuses (it changes nothing) rather than resolving to zeros", () => {
    const r = resolveCanvas(asHandlerSees({ fps: null, size: null }), CURRENT);
    expect("error" in r).toBe(true);
  });
});
