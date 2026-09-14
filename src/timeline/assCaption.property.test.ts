// ASS-syntax fuzz: throw RANDOM caption styling / animation / multi-run content at the real caption
// pipeline (buildRenderCommand -> render.ts text branch -> assCaption.buildBandAss) and assert the
// emitted .ass is STRUCTURALLY well-formed for every input. The fixed-example assCaption.test.ts pins
// specific tags; this challenges the FAILURE direction — a junk style that yields an unbalanced override
// block, a malformed colour, a broken timecode, or a wrong Style-field count would burn nothing (or
// something wrong) at export, and a string-equality unit test would never try the offending combo.
//
// The rawAss escape hatch is deliberately NOT fuzzed: it passes the author's override string VERBATIM
// (opt-in full control), so a malformed rawAss producing malformed ASS is by design, not a bug.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const HEX = fc.constantFrom(
  "#ffffff",
  "#000000",
  "#ff0000",
  "#00ff88",
  "white",
  "black",
  "rebeccapurple",
  "#abc",
);
const FONT = fc.constantFrom(
  "Anton",
  "Bebas Neue",
  "Oswald",
  "Playfair Display",
  "Poppins",
  "Impact",
  "comic sans",
);
const styleGen = fc.record(
  {
    font: FONT,
    size: fc.integer({ min: 8, max: 220 }),
    color: HEX,
    bold: fc.boolean(),
    italic: fc.boolean(),
    underline: fc.boolean(),
    strike: fc.boolean(),
    weight: fc.integer({ min: 0, max: 1000 }),
    case: fc.constantFrom("none", "upper", "lower"),
    spacing: fc.integer({ min: 0, max: 30 }),
    preset: fc.constantFrom("clean-white", "boxed", "punchy", "headline", "editorial", "minimal"),
    outline: fc.record({ color: HEX, width: fc.integer({ min: 0, max: 14 }) }),
    shadow: fc.record({ color: HEX, depth: fc.integer({ min: 0, max: 10 }) }),
    box: fc.record({
      color: HEX,
      opacity: fc.double({ min: 0, max: 1, noNaN: true }),
      padding: fc.integer({ min: 0, max: 48 }),
    }),
  },
  { requiredKeys: [] },
);
const animGen = fc.record(
  {
    build: fc.constantFrom(
      "none",
      "whole-line",
      "phrase-chunks",
      "word-highlight",
      "word-by-word",
      "append",
      "typewriter",
    ),
    entrance: fc.constantFrom("none", "fade", "pop", "slide-up", "slide-left"),
    exit: fc.constantFrom("none", "fade"),
    entrance_ms: fc.integer({ min: 0, max: 1200 }),
    exit_ms: fc.integer({ min: 0, max: 1200 }),
    timing: fc.constantFrom("even", "explicit", "transcript"),
    emphasis: fc.record(
      {
        kind: fc.constantFrom("none", "pop", "color", "highlight", "box-invert"),
        color: HEX,
        scale: fc.double({ min: 0.5, max: 2.2, noNaN: true }),
      },
      { requiredKeys: ["kind"] },
    ),
  },
  { requiredKeys: [] },
);
const contentItem = fc.record(
  {
    text: fc.constantFrom("hero", "word", "phrase", "the quick", "brown fox"),
    style: styleGen,
    emphasis: fc.boolean(),
    t_in: fc.double({ min: 0, max: 3, noNaN: true }),
    t_out: fc.double({ min: 0, max: 3, noNaN: true }),
  },
  { requiredKeys: ["text"] },
);
const contentGen = fc.oneof(
  fc.constantFrom("Title", "Lower third", "Subscribe & hit the bell"),
  fc.array(contentItem, { minLength: 1, maxLength: 4 }),
);

/** A frames-view timeline: a base video clip + one fuzzed styled caption over it. */
function tlWith(style: Any, animation: Any, content: Any, tin: number, len: number): Timeline {
  const caption: Any = {
    id: "tc",
    kind: "text",
    timeline_in: tin,
    timeline_out: tin + len,
    content,
  };
  if (style) caption.style = style;
  if (animation) caption.animation = animation;
  return {
    units: "frames",
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      {
        id: "v",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "vc",
            kind: "video",
            media_ref: "v.mp4",
            source_in: 0,
            source_out: 90,
            timeline_in: 0,
            timeline_out: 90,
          },
        ],
      },
      { id: "t", kind: "text", z: 1, clips: [caption] },
    ],
  } as Timeline;
}

/** Assert one .ass document is structurally valid regardless of the styling that produced it. */
function assertWellFormedAss(ass: string): void {
  expect(ass).not.toMatch(/NaN|Infinity|undefined/); // no numeric/field garbage reached a tag
  expect(ass).not.toMatch(/&H(?![0-9A-Fa-f])/); // every colour literal starts with hex (never a malformed &H)
  // Balanced, non-negative override braces across the whole file (escaped \{ \} in caption TEXT stripped
  // first — those are literal glyphs, not override delimiters).
  const stripped = ass.replace(/\\[{}]/g, "");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
  }
  expect(depth).toBe(0);
  for (const line of ass.split("\n")) {
    if (line.startsWith("Style: ")) {
      // Name + 22 body fields = 23 (matches the [V4+ Styles] Format row); none of our fields carry a comma.
      expect(line.split(",")).toHaveLength(23);
    } else if (line.startsWith("Dialogue: ")) {
      // Fixed field layout up to the Text field, with valid H:MM:SS.cc start/end timecodes.
      expect(line).toMatch(
        /^Dialogue: 0,\d+:\d\d:\d\d\.\d\d,\d+:\d\d:\d\d\.\d\d,[^,]*,,\d+,\d+,0,,/,
      );
      const s = line.replace(/\\[{}]/g, "");
      let d = 0;
      for (const ch of s) d += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      expect(d).toBe(0); // an override block never spans a Dialogue line boundary
    }
  }
}

describe("assCaption ASS syntax (property-based)", () => {
  it("every fuzzed caption style/animation/run set burns a structurally valid .ass", () => {
    fc.assert(
      fc.property(
        fc.option(styleGen, { nil: undefined }),
        fc.option(animGen, { nil: undefined }),
        contentGen,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 2, max: 30 }),
        (style, animation, content, tin, len) => {
          const plan = buildRenderCommand(tlWith(style, animation, content, tin, len), "/o.mp4");
          expect(plan.assFiles.length).toBeGreaterThanOrEqual(1); // the caption actually produced ASS
          for (const f of plan.assFiles) assertWellFormedAss(f.content);
        },
      ),
      { numRuns: 250 },
    );
  });
});
