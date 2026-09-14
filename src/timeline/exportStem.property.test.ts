// Both failure directions of the export-name sanitizer.
//
// `exportStem` is prompt-injection-reachable: a model-supplied `name` rides
// joinPath(Downloads, name), and joinPath does NOT resolve "..", so a name that keeps a
// separator is an arbitrary file write. That direction was already pinned by examples.
//
// The OTHER direction was not, and a sanitizer only has to be wrong one way to be wrong: a
// filter that strips too much silently renames the user's deliverable. Both are asserted here
// as RULES over generated input rather than as a list of remembered cases, because the cases
// nobody thought of are exactly the ones a hand-written list misses.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { exportStem } from "./render";

const FALLBACK = "project";

// Characters that make a filename unusable or dangerous on the platforms we ship to:
// separators, the Windows-reserved set, control characters, and NUL.
const HOSTILE = /[/\\<>:"|?*\u0000-\u001f]/;

// A high surrogate with no low after it, or a low with no high before it.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("exportStem — nothing injectable survives", () => {
  it("never returns anything that could escape the export directory", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (raw) => {
        const stem = exportStem(raw, FALLBACK);
        expect(stem).not.toMatch(HOSTILE);
        expect(stem.startsWith(".")).toBe(false); // no "..", no hidden files
        expect(stem.split(/[/\\]/).length).toBe(1);
        expect(stem.length).toBeGreaterThan(0); // always a usable name
      }),
      { numRuns: 500 },
    );
  });

  it("keeps a traversal attempt inside the export directory", () => {
    // The concrete attack, spelled out: whatever a model sends, the joined path must still
    // have the export dir as its parent.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("..", ".", "/", "\\", "etc", "evil", "C:", "~"), {
          minLength: 1,
          maxLength: 8,
        }),
        (parts) => {
          const joined = `/home/u/Downloads/${exportStem(parts.join("/"), FALLBACK)}.mp4`;
          expect(joined.split("/").slice(0, -1).join("/")).toBe("/home/u/Downloads");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("strips the bidi and zero-width characters that disguise one name as another", () => {
    // Admitting Unicode admits these with it: rendered left-to-right, "evil<RLO>gpj.mp4"
    // reads as "evilfpm.jpg". They are invisible, so nothing downstream can warn about them.
    for (const sneaky of ["\u202e", "\u202d", "\u200b", "\u2066", "\ufeff", "\u200f"]) {
      expect(exportStem(`evil${sneaky}gpj`, FALLBACK)).toBe("evilgpj");
    }
  });

  it("refuses the names Windows reserves for devices", () => {
    for (const dev of ["CON", "con", "PRN", "aux", "NUL", "COM1", "lpt9"]) {
      expect(exportStem(dev, FALLBACK)).toBe(FALLBACK);
    }
    expect(exportStem("console", FALLBACK)).toBe("console"); // not reserved — only the exact name
  });

  it("returns a name a filesystem will actually accept", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (raw) => {
        const stem = exportStem(raw, FALLBACK);
        expect(stem.endsWith(".")).toBe(false); // Windows cannot create either
        expect(stem.endsWith(" ")).toBe(false);
        expect([...stem].length).toBeLessThanOrEqual(80); // leaves room for " 999.mp4"
      }),
      { numRuns: 500 },
    );
  });

  it("cuts an over-long name between characters, never through one", () => {
    // The length bound has to slice by code POINT. Slicing by UTF-16 unit would leave a lone
    // surrogate, which is not a string any filesystem will take.
    const stem = exportStem("😀".repeat(200), FALLBACK);
    expect([...stem].length).toBe(80);
    expect(UNPAIRED_SURROGATE.test(stem)).toBe(false);
    expect(stem).toBe("😀".repeat(80));
  });
});

describe("exportStem — nothing legitimate is silently dropped", () => {
  // A deliverable named by a human. Losing these characters does not rename the file to
  // something unsafe; it renames it to something WRONG, which the user only discovers in
  // their Downloads folder.
  const scripts = {
    latin: "Final Cut",
    accented: "Café Séance",
    cyrillic: "Видео",
    greek: "Βίντεο",
    cjk: "夏休みの動画",
    korean: "여름영상",
    arabic: "فيديو",
    hebrew: "סרטון",
    devanagari: "वीडियो",
    thai: "วิดีโอ",
    digits: "Take 27",
    punctuation: "rough-cut_v2",
  };

  for (const [name, value] of Object.entries(scripts)) {
    it(`preserves a ${name} name`, () => {
      expect(exportStem(value, FALLBACK)).toBe(value);
    });
  }

  it("preserves any name made of letters, digits and safe punctuation", () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,40}$/u)
          .filter((s) => s.trim() === s && s.length > 0),
        (name) => {
          expect(exportStem(name, FALLBACK)).toBe(name);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("only ever removes characters — it never invents one", () => {
    // A rule that survives a rewrite of the filter: sanitizing is subtractive. If a future
    // version starts transliterating or percent-encoding, this fails loudly instead of
    // quietly changing every user's filenames.
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (raw) => {
        const stem = exportStem(raw, FALLBACK);
        if (stem === FALLBACK) return; // fell back; nothing to compare against
        let i = 0;
        for (const ch of stem) {
          i = raw.indexOf(ch, i);
          expect(i).toBeGreaterThanOrEqual(0);
          i += 1;
        }
      }),
      { numRuns: 500 },
    );
  });

  it("still strips only the trailing extension, whatever the script", () => {
    expect(exportStem("夏休みの動画.mp4", FALLBACK)).toBe("夏休みの動画");
    expect(exportStem("Café.final.mov", FALLBACK)).toBe("Café.final");
  });
});
