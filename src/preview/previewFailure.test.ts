import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { PREVIEW_FAILURES } from "../api/editorEvents";
import { codecFamily, PreviewFailureError, previewFailureOf } from "./previewFailure";

describe("previewFailureOf", () => {
  it("takes the word from the typed error, whatever its message says", () => {
    for (const reason of PREVIEW_FAILURES)
      expect(previewFailureOf(new PreviewFailureError(reason, "C:/Users/me/My Holiday.mp4"))).toBe(
        reason,
      );
  });

  it("the decoder's own 'not supported' answer is `unsupported`", () => {
    expect(previewFailureOf(Object.assign(new Error("x"), { name: "NotSupportedError" }))).toBe(
      "unsupported",
    );
    expect(previewFailureOf({ name: "NotSupportedError" })).toBe("unsupported");
  });

  it("anything else is `other`, and it never throws", () => {
    for (const value of [
      new Error("boom"),
      "text",
      42,
      null,
      undefined,
      {},
      [],
      new DOMException("x", "AbortError"),
    ])
      expect(previewFailureOf(value)).toBe("other");
  });

  it("is always a word of the list, for anything at all", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(PREVIEW_FAILURES).toContain(previewFailureOf(value));
      }),
      { numRuns: 300 },
    );
  });
});

describe("codecFamily", () => {
  it.each([
    ["avc1.64001f", "avc1"],
    ["hev1.1.6.L93.B0", "hev1"],
    ["hvc1.2.4.L120.B0", "hvc1"],
    ["vp09.00.10.08", "vp09"],
    ["av01.0.08M.08", "av01"],
    ["vp8", "vp8"],
    ["AVC1.4D401E", "avc1"],
  ])("%s is the family %s", (codec, family) => {
    expect(codecFamily(codec)).toBe(family);
  });

  it("is nothing for what is not a short name", () => {
    for (const value of [
      "",
      "C:/Users/me/holiday.mp4",
      "a b",
      "x".repeat(20),
      42,
      null,
      undefined,
      "/avc1",
    ])
      expect(codecFamily(value)).toBe("");
  });

  it("is always a short lowercase name or nothing, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(codecFamily(value)).toMatch(/^[a-z0-9]{0,12}$/);
      }),
      { numRuns: 300 },
    );
  });
});
