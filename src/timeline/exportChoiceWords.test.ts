// The builders and the words of the Export dialog's Quality / Fast view (exportChoiceWords.ts). The expected text is the owner's copy, written out from the UI spec's strings table (section 2):
// a word changed in the file, or a builder that drifts from its sentence, fails here. The figure is a typed number from the lab's table; these functions only write it.
import { describe, expect, it } from "vitest";

import {
  CHIP_NOTE_DROPPED_CLAUSES,
  D2_WORDS,
  QUALITY_WORDS,
  RESOLUTION_WORDS,
  describeFigure,
  figureBrackets,
  figureNumber,
  figureSpoken,
  formatRate,
  questionButtons,
  questionWords,
  rateEntry,
  sameAsProjectRate,
  sameAsProjectSize,
  summaryWords,
} from "./exportChoiceWords";
import { FASTER_SETTING_LINE } from "./exportWords";

describe("D2_WORDS: the owner's copy, word for word (the spec's strings table)", () => {
  it("holds exactly these words and no others", () => {
    expect({ ...D2_WORDS }).toEqual({
      title: "Export video",
      choiceQuality: "Quality",
      choiceFast: "Fast",
      choiceGroupName: "export choice",
      figureTip: "Typical speed-up; your PC may differ.",
      resolutionLabel: "Resolution",
      resolutionName: "resolution",
      door: "Advanced settings",
      fasterSetting: "To save time, ArtDaddy will use a faster setting; the picture may be slightly softer.",
      lightCompression: "light compression",
      rateLabel: "Frame rate",
      rateName: "frame rate",
      qualityLabel: "Quality",
      qualityName: "quality",
      chipNotePassed:
        "Auto: used when it saves time. The file is usually larger and the picture can differ slightly.",
      cancel: "Cancel",
      exportAction: "Export",
      questionTitle: "Are you sure?",
      questionQuicker: "This is a big export. Fast would be quicker.",
      questionOwnSettings: "These settings make a big export. Fast's own settings would be quicker.",
      exportAtQuality: "Export at Quality",
      useFast: "Use Fast",
      exportWithThese: "Export with these settings",
      useFastSettings: "Use Fast's settings",
    });
  });

  it("takes the faster-setting sentence from the 0.28.0 constant itself, not a copy", () => {
    expect(D2_WORDS.fasterSetting).toBe(FASTER_SETTING_LINE);
  });

  it("names the sizes and the qualities as the lists show them", () => {
    expect({ ...RESOLUTION_WORDS }).toEqual({
      "2160p": "2160p (4K)",
      "1440p": "1440p",
      "1080p": "1080p",
      "720p": "720p",
      "480p": "480p",
    });
    expect({ ...QUALITY_WORDS }).toEqual({ high: "High", medium: "Medium", low: "Low" });
    expect({ ...CHIP_NOTE_DROPPED_CLAUSES }).toEqual({ passedTest: "It passed ArtDaddy's test" });
  });

  it("is plain text a person can read: ASCII only, straight apostrophes, no stray spaces", () => {
    const all = [
      ...Object.values(D2_WORDS),
      ...Object.values(RESOLUTION_WORDS),
      ...Object.values(QUALITY_WORDS),
      ...Object.values(CHIP_NOTE_DROPPED_CLAUSES),
    ];
    for (const text of all) {
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/ {2}/);
    }
  });

  it("gives the Fast choice's tooltip, its hidden description and its brackets from one figure", () => {
    expect(D2_WORDS.figureTip).toBe("Typical speed-up; your PC may differ.");
    expect(figureBrackets(4)).toBe("(4x)");
    expect(figureSpoken(4)).toBe("About 4 times faster.");
    expect(`${figureSpoken(4)} ${D2_WORDS.figureTip}`).toBe(
      "About 4 times faster. Typical speed-up; your PC may differ.",
    );
  });
});

describe("figureNumber and describeFigure: the figure as the page writes it", () => {
  it.each([
    [4, "4"],
    [2.5, "2.5"],
    [10, "10"],
    [1.5, "1.5"],
    [12.3, "12.3"],
    [3.96, "4"],
    [3.94, "3.9"],
    [4.04, "4"],
    [4.06, "4.1"],
    [1.04, "1"],
    [0.5, "0.5"],
    [100, "100"],
  ])("%s is written %s", (n, text) => {
    expect(figureNumber(n)).toBe(text);
    expect(describeFigure(n)).toBe(`${text}x`);
  });

  it("writes a whole number without a decimal and anything else with one", () => {
    for (const n of [2, 3, 4, 5, 8, 16, 40]) expect(describeFigure(n)).toBe(`${n}x`);
    expect(describeFigure(2.5)).toBe("2.5x");
    expect(describeFigure(2.5)).not.toBe("3x");
    expect(describeFigure(4)).not.toContain(".");
    expect(describeFigure(7.5)).toBe("7.5x");
  });

  it("writes nothing for a figure that is not a finite number", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(figureNumber(n)).toBe("");
      expect(describeFigure(n)).toBe("");
      expect(figureBrackets(n)).toBe("");
    }
    expect(figureNumber("4" as unknown as number)).toBe("");
  });

  it("puts the figure in brackets for the label and spells it for a screen reader", () => {
    expect(figureBrackets(4)).toBe("(4x)");
    expect(figureBrackets(2.5)).toBe("(2.5x)");
    expect(figureBrackets(3.96)).toBe("(4x)");
    expect(figureSpoken(4)).toBe("About 4 times faster.");
    expect(figureSpoken(2.5)).toBe("About 2.5 times faster.");
    expect(figureSpoken(3.96)).toBe("About 4 times faster.");
  });
});

describe("the Resolution and Frame rate entries", () => {
  it("writes a frame rate whole as 30 and otherwise with at most two decimals", () => {
    expect(formatRate(30)).toBe("30");
    expect(formatRate(24)).toBe("24");
    expect(formatRate(29.97)).toBe("29.97");
    expect(formatRate(59.94)).toBe("59.94");
    expect(formatRate(23.976)).toBe("23.98");
    expect(formatRate(29.9700001)).toBe("29.97");
    expect(formatRate(12.5)).toBe("12.5");
  });

  it("names the project's own size and rate, and the lower rates", () => {
    expect(sameAsProjectSize(1080, 1920)).toBe("Same as project (1080 x 1920)");
    expect(sameAsProjectSize(3840, 2160)).toBe("Same as project (3840 x 2160)");
    expect(sameAsProjectRate(60)).toBe("Same as project (60 fps)");
    expect(sameAsProjectRate(29.97)).toBe("Same as project (29.97 fps)");
    expect(rateEntry(24)).toBe("24 fps");
    expect(rateEntry(29.97)).toBe("29.97 fps");
  });
});

describe("summaryWords: the line under the door (S11, S12, S13)", () => {
  it("says the project's size and rate and the quality it was given, for Quality", () => {
    expect(summaryWords("quality", { smallerSize: true, maxFps: 30, quality: "medium" })).toBe(
      "Project size and frame rate, Medium quality.",
    );
    expect(summaryWords("quality", { smallerSize: false, maxFps: 24, quality: "high" })).toBe(
      "Project size and frame rate, High quality.",
    );
  });

  it("says one size smaller where there is one, the cap, the quality and the light compression, for Fast", () => {
    expect(summaryWords("fast", { smallerSize: true, maxFps: 30, quality: "medium" })).toBe(
      "One size smaller, up to 30 frames a second, Medium quality, light compression.",
    );
    expect(summaryWords("fast", { smallerSize: false, maxFps: 30, quality: "medium" })).toBe(
      "Up to 30 frames a second, Medium quality, light compression.",
    );
  });

  it("writes the numbers it is given, not 30 and Medium", () => {
    expect(summaryWords("fast", { smallerSize: true, maxFps: 24, quality: "low" })).toBe(
      "One size smaller, up to 24 frames a second, Low quality, light compression.",
    );
    expect(summaryWords("fast", { smallerSize: false, maxFps: 29.97, quality: "high" })).toBe(
      "Up to 29.97 frames a second, High quality, light compression.",
    );
  });
});

describe("questionWords and questionButtons: the question before a heavy export (S21 to S26)", () => {
  it("says how much quicker Fast would be where a figure may be stated (a)", () => {
    expect(questionWords("a", 4)).toBe("This is a big export. Fast would be about 4x faster.");
    expect(questionWords("a", 2.5)).toBe("This is a big export. Fast would be about 2.5x faster.");
    expect(questionWords("a", 3.96)).toBe("This is a big export. Fast would be about 4x faster.");
  });

  it("says only that Fast would be quicker where no figure may be stated (a)", () => {
    expect(questionWords("a", null)).toBe("This is a big export. Fast would be quicker.");
    expect(questionWords("a", Number.NaN)).toBe("This is a big export. Fast would be quicker.");
  });

  it("never states a figure in (b), and never a time", () => {
    const own = "These settings make a big export. Fast's own settings would be quicker.";
    expect(questionWords("b", null)).toBe(own);
    expect(questionWords("b", 4)).toBe(own);
    for (const text of [questionWords("a", 4), questionWords("a", null), questionWords("b", 4)])
      expect(text).not.toMatch(/\d+ ?(min|sec|hour|MB)/i);
  });

  it("lists the three buttons in order: the plain Cancel, the one that exports as it is, the one for Fast", () => {
    expect(questionButtons("a")).toEqual(["Cancel", "Export at Quality", "Use Fast"]);
    expect(questionButtons("b")).toEqual([
      "Cancel",
      "Export with these settings",
      "Use Fast's settings",
    ]);
  });
});
