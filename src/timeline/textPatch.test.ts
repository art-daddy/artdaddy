// A partial patch that silently erases a field the caller didn't mention is the worst kind of
// bug here: the model has no way to notice, and the user finds out when they watch the export.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mergePatch, normalizeContent } from "./textPatch";

describe("mergePatch", () => {
  it("keeps fields the patch does not mention", () => {
    expect(mergePatch({ font: "Anton", size: 90 }, { size: 120 })).toEqual({
      font: "Anton",
      size: 120,
    });
  });

  it("patches INSIDE a nested object instead of replacing it", () => {
    // The failure this exists for: {outline:{width:0}} wiping the outline colour, which the
    // model never restated because it was never asked to change it.
    expect(
      mergePatch({ outline: { color: "#000000", width: 8 } }, { outline: { width: 0 } }),
    ).toEqual({ outline: { color: "#000000", width: 0 } });
  });

  it("clears a field with an explicit null", () => {
    expect(mergePatch({ box: { color: "#000" }, size: 90 }, { box: null })).toEqual({ size: 90 });
  });

  it("treats undefined as 'not mentioned', not as a clear", () => {
    expect(mergePatch({ size: 90 }, { size: undefined })).toEqual({ size: 90 });
  });

  it("replaces arrays wholesale rather than merging them element-wise", () => {
    // Replacing three runs with two must leave two, not three with the first two changed.
    expect(mergePatch({ runs: [1, 2, 3] }, { runs: [9] })).toEqual({ runs: [9] });
  });

  it("builds the nested object when the base has none", () => {
    expect(mergePatch(undefined, { shadow: { depth: 3 } })).toEqual({ shadow: { depth: 3 } });
  });

  it("does not mutate either input", () => {
    const base = { outline: { color: "#000", width: 4 } };
    const patch = { outline: { width: 9 } };
    mergePatch(base, patch);
    expect(base).toEqual({ outline: { color: "#000", width: 4 } });
    expect(patch).toEqual({ outline: { width: 9 } });
  });

  it("never loses a base key the patch did not name", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.integer(), { maxKeys: 8 }),
        fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.integer(), { maxKeys: 8 }),
        (base, patch) => {
          const out = mergePatch(base, patch);
          for (const k of Object.keys(base)) {
            if (!(k in patch)) expect(out[k]).toEqual(base[k]);
          }
          for (const k of Object.keys(patch)) expect(out[k]).toEqual(patch[k]);
        },
      ),
    );
  });
});

describe("normalizeContent", () => {
  it("turns a bare string into one run, so a title and a caption are the same shape", () => {
    expect(normalizeContent("hello")).toEqual([{ text: "hello" }]);
  });

  it("leaves runs alone", () => {
    expect(normalizeContent([{ text: "a" }, { text: "b" }])).toEqual([
      { text: "a" },
      { text: "b" },
    ]);
  });
});
