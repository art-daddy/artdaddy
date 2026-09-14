import { describe, expect, it } from "vitest";

import {
  OPTIONAL_SECTIONS,
  REQUIRED_SECTIONS,
  SECTION_DISPLAY_NAMES,
  parseStyleMarkdown,
} from "./styleSchema";

// styleSchema is a pure markdown parser: H2 sections are editorial dimensions,
// normalized through a heading-alias table into canonical ids. Exercise it
// directly across well-formed, partial, aliased, malformed and empty input.
const md = (...lines: string[]): string => lines.join("\n");

describe("style-schema exports", () => {
  it("declares the six required dimensions and names every id", () => {
    expect(REQUIRED_SECTIONS).toEqual([
      "identity",
      "pacing",
      "density",
      "composition",
      "captions",
      "sourcing",
    ]);
    expect(OPTIONAL_SECTIONS).toContain("color");
    for (const id of [...REQUIRED_SECTIONS, ...OPTIONAL_SECTIONS]) {
      expect(typeof SECTION_DISPLAY_NAMES[id]).toBe("string");
    }
    // The two ids whose display name intentionally diverges from the id.
    expect(SECTION_DISPLAY_NAMES.captions).toBe("Text");
    expect(SECTION_DISPLAY_NAMES.color).toBe("Color Grade");
  });
});

describe("parseStyleMarkdown", () => {
  it("parses a well-formed doc: all required present, content trimmed, optional tracked", () => {
    const body = md(
      "# Kinetic Clean",
      "",
      "## Identity",
      "Fast, clean, energetic.",
      "",
      "## Pacing",
      "Cut on the beat.",
      "",
      "## Density",
      "One idea per shot.",
      "",
      "## Composition",
      "Centered framing.",
      "",
      "## Captions",
      "Bold sans, bottom third.",
      "",
      "## Sourcing",
      "Stock b-roll.",
      "",
      "## Color Grade",
      "Cool, high contrast.",
    );
    const p = parseStyleMarkdown("kinetic", body);
    expect(p.present_required).toEqual([
      "identity",
      "pacing",
      "density",
      "composition",
      "captions",
      "sourcing",
    ]);
    expect(p.missing_required).toEqual([]);
    expect(p.present_optional).toEqual(["color"]);
    expect(p.sections.identity).toBe("Fast, clean, energetic.");
    expect(p.sections.color).toBe("Cool, high contrast.");
    expect(p.extra_sections).toEqual([]);
  });

  it("reports the missing required dimensions for a partial doc", () => {
    const p = parseStyleMarkdown("x", md("# X", "", "## Identity", "id", "", "## Pacing", "pace"));
    expect(p.present_required).toEqual(["identity", "pacing"]);
    expect(p.missing_required).toEqual(["density", "composition", "captions", "sourcing"]);
    expect(p.present_optional).toEqual([]);
  });

  it("treats an empty body as every required dimension missing", () => {
    const p = parseStyleMarkdown("x", "");
    expect(p.present_required).toEqual([]);
    expect(p.missing_required).toEqual([...REQUIRED_SECTIONS]);
    expect(p.present_optional).toEqual([]);
    expect(p.sections).toEqual({});
    expect(p.extra_sections).toEqual([]);
  });

  it("normalizes heading aliases (&, /, 'and', punctuation, casing, whitespace)", () => {
    const body = md(
      "# Heading",
      "",
      "## Editorial Summary",
      "Fast and clean.",
      "",
      "## Pacing / Rhythm",
      "Cut hard.",
      "",
      "## Density & Restraint",
      "Minimal.",
      "",
      "## Framing",
      "Centered.",
      "",
      "## Captions (Text)!",
      "Bold.",
      "",
      "## Sources",
      "Stock.",
      "",
      "## Transform and Animation",
      "Slide in.",
      "",
      "## Colour",
      "Cool.",
    );
    const p = parseStyleMarkdown("x", body);
    expect(p.missing_required).toEqual([]);
    expect(p.present_required).toEqual([
      "identity",
      "pacing",
      "density",
      "composition",
      "captions",
      "sourcing",
    ]);
    // OPTIONAL_SECTIONS order puts color before transform.
    expect(p.present_optional).toEqual(["color", "transform"]);
    expect(p.sections.identity).toBe("Fast and clean.");
    expect(p.sections.transform).toBe("Slide in.");
    expect(p.sections.color).toBe("Cool.");
  });

  it("routes duplicate canonical + unknown headings to extra_sections", () => {
    const body = md(
      "## Identity",
      "First.",
      "",
      "## Identity",
      "Second.",
      "",
      "## Random Notes",
      "whatever.",
    );
    const p = parseStyleMarkdown("x", body);
    expect(p.sections.identity).toBe("First.");
    expect(p.extra_sections).toContainEqual(["Identity", "Second."]);
    expect(p.extra_sections).toContainEqual(["Random Notes", "whatever."]);
    expect(p.present_required).toEqual(["identity"]);
  });

  it("falls back to the preamble as identity when no Identity heading is present", () => {
    const p = parseStyleMarkdown("x", md("This is the intro preamble.", "", "## Pacing", "Cut."));
    expect(p.sections.identity).toBe("This is the intro preamble.");
    expect(p.present_required).toEqual(["identity", "pacing"]);
  });

  it("strips a leading H1 from the preamble before using it as identity", () => {
    const p = parseStyleMarkdown(
      "x",
      md("# My Style Title", "Intro line.", "", "## Pacing", "Cut."),
    );
    expect(p.sections.identity).toBe("Intro line.");
  });

  it("keeps an explicit Identity heading and ignores the preamble", () => {
    const p = parseStyleMarkdown(
      "x",
      md("# Title", "Preamble here.", "", "## Identity", "Real identity.", "", "## Pacing", "Cut."),
    );
    expect(p.sections.identity).toBe("Real identity.");
  });

  it("leaves identity missing when there is neither an Identity heading nor a preamble", () => {
    const p = parseStyleMarkdown("x", md("## Pacing", "Cut."));
    expect(p.missing_required).toContain("identity");
    expect(p.present_required).toEqual(["pacing"]);
    expect(p.sections.identity).toBeUndefined();
  });
});
