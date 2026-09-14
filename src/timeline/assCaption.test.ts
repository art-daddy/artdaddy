import { describe, expect, it } from "vitest";

import {
  assColour,
  assEscape,
  assTime,
  buildBandAss,
  unrenderableFlags,
  type CaptionSpec,
} from "./assCaption";
import type { ResolvedRun } from "./renderPlan";

const cap = (over: Partial<CaptionSpec> = {}): CaptionSpec => ({
  text: "Hello",
  rawAss: "",
  font: "Poppins",
  sizePx: 60,
  color: "#ffffff",
  align: "center",
  anchorV: "middle",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  weight: null,
  spacingPx: 0,
  scalePct: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  entranceMotion: null,
  karaoke: null,
  highlightColor: "",
  karaokeReveal: false,
  runs: null,
  emphasisSpec: null,
  outline: null,
  shadow: null,
  box: null,
  cxPx: 960,
  cyPx: 540,
  wPx: 800,
  startSec: 0,
  endSec: 2,
  ...over,
});

describe("assColour — CSS -> ASS &HBBGGRR&", () => {
  it("swaps RGB to the BGR byte order ASS expects", () => {
    expect(assColour("#ff0000")).toBe("&H0000FF&"); // red
    expect(assColour("#00ff00")).toBe("&H00FF00&"); // green
    expect(assColour("#0000ff")).toBe("&HFF0000&"); // blue
  });
  it("expands #rgb shorthand and resolves common names", () => {
    expect(assColour("#abc")).toBe("&HCCBBAA&");
    expect(assColour("white")).toBe("&HFFFFFF&");
    expect(assColour("black")).toBe("&H000000&");
  });
  it("falls back to white for anything unparseable (never a malformed tag)", () => {
    expect(assColour("rebeccapurple-ish")).toBe("&HFFFFFF&");
    expect(assColour("")).toBe("&HFFFFFF&");
    expect(assColour("#12")).toBe("&HFFFFFF&");
  });
});

describe("assTime — seconds -> H:MM:SS.cc", () => {
  it("formats with centisecond precision and carries", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(1.5)).toBe("0:00:01.50");
    expect(assTime(61.234)).toBe("0:01:01.23");
    expect(assTime(3661.999)).toBe("1:01:01.99"); // truncated, never past its own frame
    expect(assTime(-5)).toBe("0:00:00.00"); // clamped
  });

  it("never places a boundary AFTER the frame it belongs to", () => {
    // The regression: a card butted at frame 416 (13.8667s) rounded to 13.87, so frame 416 still
    // showed the outgoing card and the incoming one appeared a frame late. Walk a whole timeline's
    // worth of boundaries at several rates rather than trusting the one frame that was reported.
    const parse = (ts: string): number => {
      const [h, m, rest] = ts.split(":");
      return Number(h) * 3600 + Number(m) * 60 + Number(rest);
    };
    for (const fps of [24, 25, 30, 50, 60]) {
      for (let n = 0; n <= 900; n++) {
        const t = n / fps;
        expect(parse(assTime(t)), `fps ${fps} frame ${n}`).toBeLessThanOrEqual(t + 1e-9);
      }
    }
  });
});

describe("assEscape — injection defence + hard breaks", () => {
  it("escapes braces + guards backslashes so untrusted text renders LITERALLY (no override executes, nothing dropped)", () => {
    const Z = "\u200B"; // zero-width space guarding each user backslash
    // An injection attempt renders as literal text: `{`/`}` -> the escaped literals `\{`/`\}` (verified to
    // draw a literal brace, and no override block can open), and the backslash is ZWSP-guarded so it can't
    // form a command. NOTHING is deleted — braces + backslashes are common in captions.
    expect(assEscape("{\\c&H0000FF&}pwned")).toBe(`\\{\\${Z}c&H0000FF&\\}pwned`);
    expect(assEscape("{\\pos(0,0)}x")).toBe(`\\{\\${Z}pos(0,0)\\}x`);
    expect(assEscape("a{b}c")).toBe("a\\{b\\}c");
    // A literal backslash (e.g. a Windows path) survives intact rather than being stripped.
    expect(assEscape("back\\slash")).toBe(`back\\${Z}slash`);
    expect(assEscape("C:\\new")).toBe(`C:\\${Z}new`);
    // Security invariant: after removing the escaped `\{`/`\}`, no bare brace remains for libass to act on.
    const stripped = assEscape("{\\an7\\c&HFF0000&}HACK").replace(/\\[{}]/g, "");
    expect(stripped.includes("{") || stripped.includes("}")).toBe(false);
  });
  it("turns authored newlines into the ASS hard break \\N", () => {
    expect(assEscape("line1\nline2")).toBe("line1\\Nline2");
    expect(assEscape("a\r\nb")).toBe("a\\Nb");
  });
});

describe("buildBandAss — one .ass per z-band", () => {
  it("emits a canvas-sized header with balanced wrapping + scaled borders", () => {
    const ass = buildBandAss([cap()], { w: 1920, h: 1080 });
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain("WrapStyle: 0");
    expect(ass).toContain("ScaledBorderAndShadow: yes");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
  });

  it("centres a caption: \\an5 \\pos at the box centre, margins bounding wrap to wPx; look in the named style", () => {
    const ass = buildBandAss([cap({ wPx: 800, cxPx: 960, cyPx: 540 })], { w: 1920, h: 1080 });
    const style = ass.split("\n").find((l) => l.startsWith("Style:"))!;
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    // font / size / primary colour now live in the named [V4+ Styles] row, not inline on the Dialogue.
    expect(style).toContain("Poppins,60,&H00FFFFFF");
    // wrap width 800 over a 1920 canvas -> equal margins of (1920-800)/2 = 560.
    expect(line).toContain(",560,560,0,,");
    expect(line).toContain("\\an5");
    expect(line).toContain("\\pos(960,540)");
    expect(line).toContain("Hello");
    expect(line).not.toContain("\\fn"); // static look no longer inline
    expect(line).not.toContain("\\1c");
  });

  it("anchors left/right at the box EDGE so \\an justifies within the box, not off-centre", () => {
    const left = buildBandAss([cap({ align: "left", cxPx: 960, wPx: 800 })], { w: 1920, h: 1080 });
    const right = buildBandAss([cap({ align: "right", cxPx: 960, wPx: 800 })], {
      w: 1920,
      h: 1080,
    });
    expect(left).toContain("\\an4\\pos(560,540)"); // left edge = 960 - 800/2
    expect(right).toContain("\\an6\\pos(1360,540)"); // right edge = 960 + 800/2
  });

  // The vertical anchor and the horizontal alignment are independent axes of ONE \an number, so
  // walk the whole grid rather than trusting the two cases that happen to be easy.
  it("maps every anchor x alignment pair to the matching \\an cell", () => {
    const expected: Record<string, Record<string, number>> = {
      top: { left: 7, center: 8, right: 9 },
      middle: { left: 4, center: 5, right: 6 },
      bottom: { left: 1, center: 2, right: 3 },
    };
    for (const [anchorV, row] of Object.entries(expected)) {
      for (const [align, an] of Object.entries(row)) {
        const ass = buildBandAss(
          [
            cap({
              align: align as "left" | "center" | "right",
              anchorV: anchorV as "top" | "middle" | "bottom",
            }),
          ],
          { w: 1920, h: 1080 },
        );
        expect(ass, `${anchorV}/${align}`).toContain(`\\an${an}`);
      }
    }
  });

  it("defaults to the middle row when no anchor is given, so existing projects do not move", () => {
    expect(buildBandAss([cap({ align: "center" })], { w: 1920, h: 1080 })).toContain("\\an5");
  });

  it("times each Dialogue from its window", () => {
    const ass = buildBandAss([cap({ startSec: 1.5, endSec: 3.25 })], { w: 1920, h: 1080 });
    expect(ass).toContain("Dialogue: 0,0:00:01.50,0:00:03.25,");
  });

  it("passes a raw_ass caption through VERBATIM (author's escape hatch, no styling wrapper)", () => {
    const raw = "{\\an7\\pos(100,100)\\frz15}Custom look";
    const line = buildBandAss([cap({ rawAss: raw, text: "ignored" })], { w: 1920, h: 1080 })
      .split("\n")
      .find((l) => l.startsWith("Dialogue:"))!;
    expect(line).toBe(`Dialogue: 0,0:00:00.00,0:00:02.00,S0,,0,0,0,,${raw}`);
    expect(line).not.toContain("ignored");
  });

  it("puts multiple captions of one band in one file, in order", () => {
    const ass = buildBandAss(
      [cap({ text: "first" }), cap({ text: "second", startSec: 2, endSec: 4 })],
      { w: 1920, h: 1080 },
    );
    const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain("first");
    expect(dialogues[1]).toContain("second");
  });

  it("puts bold / italic / weight / underline / strike / letter-spacing in the named style (C1)", () => {
    // The named Style row body is: font,size,primary,secondary,outlineC,back,Bold,Italic,Underline,
    // StrikeOut,ScaleX(100),ScaleY(100),Spacing,Angle(0),BorderStyle,Outline,Shadow,Alignment,...
    const styled = buildBandAss(
      [cap({ bold: true, italic: true, underline: true, strike: true, spacingPx: 6 })],
      { w: 1920, h: 1080 },
    );
    const s = styled.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(s).toContain(",-1,-1,-1,-1,100,100,6,"); // Bold/Italic/Underline/StrikeOut = -1, Spacing = 6
    const line = styled.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    expect(line).not.toContain("\\b1"); // no inline marks anymore
    expect(line).not.toContain("\\i1");
    expect(line).not.toContain("\\fsp");
    // A numeric weight lands in the Bold field verbatim (overrides the bold flag).
    const weighted = buildBandAss([cap({ weight: 700 })], { w: 1920, h: 1080 })
      .split("\n")
      .find((l) => l.startsWith("Style:"))!;
    expect(weighted).toContain(",700,0,0,0,100,100,0,");
    // A plain caption -> all flags 0.
    const plain = buildBandAss([cap({})], { w: 1920, h: 1080 })
      .split("\n")
      .find((l) => l.startsWith("Style:"))!;
    expect(plain).toContain(",0,0,0,0,100,100,0,");
  });

  it("puts outline / shadow / box in the named style (BorderStyle is style-only) (C1)", () => {
    const outlined = buildBandAss([cap({ outline: { widthPx: 4, color: "#ff0000" } })], {
      w: 1920,
      h: 1080,
    });
    const os = outlined.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(os).toContain("&H000000FF"); // red outline colour (full ARGB, BGR byte order)
    expect(os).toContain(",1,4,0,"); // BorderStyle=1 (outline), Outline width 4, Shadow 0
    expect(outlined).not.toContain("\\bord"); // not an inline tag anymore

    const shadowed = buildBandAss([cap({ shadow: { depthPx: 3, color: "#000000" } })], {
      w: 1920,
      h: 1080,
    });
    const ss = shadowed.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(ss).toContain(",1,0,3,"); // BorderStyle=1, no outline, Shadow depth 3
    expect(shadowed).not.toContain("\\shad");

    const boxed = buildBandAss([cap({ box: { color: "#0000ff", opacity: 0.5, paddingPx: 12 } })], {
      w: 1920,
      h: 1080,
    });
    const bs = boxed.split("\n").find((l) => l.startsWith("Style:"))!;
    expect(bs).toContain("&H80FF0000"); // blue box fill @50% alpha (BackColour, ARGB BGR order)
    expect(bs).toContain(",3,12,"); // BorderStyle=3 (opaque box), Outline = padding 12
    expect(boxed.split("\n").find((l) => l.startsWith("Dialogue:"))).toContain(",S0,,"); // references the box style
  });
});

const run = (over: Partial<ResolvedRun> = {}): ResolvedRun => ({
  text: "x",
  font: "Poppins",
  sizePx: 60,
  color: "#ffffff",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  weight: null,
  outline: null,
  emphasis: false,
  ...over,
});

// A flag emoji has no glyph in any bundled face, and its fallback is the LETTERS it is built
// from — so `🇮🇳Fouji🇮🇳` exported as "IN Fouji IN": plausible, wrong, and invisible unless you
// re-read your own video. Dropping beats printing the wrong word.
describe("unrenderable flag emoji", () => {
  it("drops regional indicators instead of letting them print as letters", () => {
    const out = assEscape("🇮🇳Fouji🇮🇳");
    expect(out).toBe("Fouji");
    expect(out).not.toMatch(/IN/);
    expect(unrenderableFlags("🇮🇳Fouji🇮🇳")).toHaveLength(4); // two pairs
  });

  it("leaves ordinary text — including real letters I and N — completely alone", () => {
    expect(assEscape("INDIA in Focus")).toBe("INDIA in Focus");
    expect(unrenderableFlags("INDIA in Focus")).toEqual([]);
  });
});

describe("runs + emphasis (C2)", () => {  it("composes per-run overrides: a recoloured run gets \\1c + {\\r} reset; base-matching runs stay plain", () => {
    const line = buildBandAss(
      [cap({ text: "", runs: [run({ text: "plain" }), run({ text: "hero", color: "#ff0000" })] })],
      { w: 1920, h: 1080 },
    )
      .split("\n")
      .find((l) => l.startsWith("Dialogue:"))!;
    expect(line).toContain("{\\1c&H0000FF&}hero{\\r}"); // run 2 recoloured red (BGR), then reset to the style
    expect(line).toContain("plain");
    expect(line).not.toContain("{\\1c&H0000FF&}plain"); // run 1 matches the base -> no override
  });

  it("emits only the fields that DIFFER from the base (font / size / marks)", () => {
    const line = buildBandAss(
      [
        cap({
          text: "",
          sizePx: 60,
          runs: [run({ text: "a", font: "Anton", sizePx: 90, bold: true })],
        }),
      ],
      { w: 1920, h: 1080 },
    )
      .split("\n")
      .find((l) => l.startsWith("Dialogue:"))!;
    expect(line).toContain("\\fnAnton"); // font differs
    expect(line).toContain("\\fscx150\\fscy150"); // 90/60 -> 150% scale
    expect(line).toContain("\\b1"); // bold differs from the base's false
  });

  it("applies the five emphasis kinds to a hero run", () => {
    const withEmph = (
      kind: "color" | "highlight" | "pop" | "box-invert" | "none",
      color = "#ffd400",
      scalePct = 130,
    ) =>
      buildBandAss(
        [
          cap({
            text: "",
            emphasisSpec: { kind: kind as "color", color, scalePct },
            runs: [run({ text: "hero", emphasis: true })],
          }),
        ],
        { w: 1920, h: 1080 },
      )
        .split("\n")
        .find((l) => l.startsWith("Dialogue:"))!;
    expect(withEmph("color", "#ff0000")).toContain("\\1c&H0000FF&"); // colour recolour
    expect(withEmph("highlight", "#00ff00")).toContain("\\1c&H00FF00&"); // highlight recolour
    expect(withEmph("pop", "#fff", 150)).toContain("\\fscx150\\fscy150"); // pop scale
    const inv = withEmph("box-invert", "#ffd400");
    expect(inv).toContain("\\1c&H000000&"); // box-invert: black text
    expect(inv).toContain("\\3c&H00D4FF&"); // + emph-colour ring (BGR of #ffd400)
  });
});

describe("karaoke reveal (C3)", () => {
  const revealLines = (words: { word: string; durCs: number }[]): string[] =>
    buildBandAss([cap({ karaoke: words, karaokeReveal: true, startSec: 0, endSec: 1 })], {
      w: 1920,
      h: 1080,
    })
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"));

  it("a reveal shows one word per step, and hides the rest with \\alpha (fill AND outline)", () => {
    // The RULE, not the tag: at step i the first i+1 words are painted normally and everything after
    // them is fully hidden. `\2a` cannot express this — it drops the fill and leaves the outline and
    // shadow drawn, so every future word stayed legible in the export.
    const lines = revealLines([
      { word: "a", durCs: 50 },
      { word: "b", durCs: 50 },
    ]);
    expect(lines).toHaveLength(2);
    // Step 1: "a" visible, "b" behind \alpha.
    expect(lines[0]).toMatch(/}a \{\\alpha&HFF&}b$/);
    // Step 2: both visible, nothing hidden.
    expect(lines[1]).toMatch(/}a b$/);
    expect(lines[1]).not.toContain("\\alpha");
  });

  it("hidden words stay IN the line, so the text does not reflow as it builds", () => {
    // Dropping the unsung words entirely would re-centre the line on every step and make it jitter.
    for (const line of revealLines([
      { word: "one", durCs: 30 },
      { word: "two", durCs: 30 },
      { word: "three", durCs: 40 },
    ])) {
      expect(line.endsWith("one") || line.includes("one")).toBe(true);
      expect(line).toContain("three");
    }
  });

  it("the entrance and fade belong to the caption, not to every step", () => {
    const lines = buildBandAss(
      [
        cap({
          karaoke: [
            { word: "a", durCs: 50 },
            { word: "b", durCs: 50 },
          ],
          karaokeReveal: true,
          startSec: 0,
          endSec: 1,
          fadeInMs: 200,
          fadeOutMs: 300,
          entranceMotion: { kind: "slide-up", ms: 200 },
        }),
      ],
      { w: 1920, h: 1080 },
    )
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"));
    // Slide in once and fade in once, or the caption re-enters on every word.
    expect(lines.filter((l) => l.includes("\\move")).length).toBe(1);
    expect(lines[0]).toContain("\\fad(200,0)");
    expect(lines[lines.length - 1]).toContain("\\fad(0,300)");
  });

  it("word-highlight is the opposite product: ONE line, unsung dimmed in place", () => {
    const dim = buildBandAss([cap({ karaoke: [{ word: "a", durCs: 50 }], karaokeReveal: false })], {
      w: 1920,
      h: 1080,
    })
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"));
    expect(dim).toHaveLength(1);
    expect(dim[0]).toContain("\\2a&H80&"); // unsung dim
    expect(dim[0]).toContain("\\k50");
  });

  it("never emits an empty caption when every word has zero duration", () => {
    const lines = revealLines([
      { word: "a", durCs: 0 },
      { word: "b", durCs: 0 },
    ]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toContain("b");
  });
});
