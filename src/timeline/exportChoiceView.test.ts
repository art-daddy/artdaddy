// The oracle tables of the Quality / Fast view's pure model (exportChoiceView.ts). Every expected value below is written out from the UI spec (D2-UI-SPEC.md: table 3.1 the own values and the
// lists, table 3.5 the object that is sent, 3.6 the figure, 3.7 the question) and never computed by the code under test. The facts of a project are { width, height, fps, durationSeconds }.
// The lab's own speed-up table is empty in this build, so every test of the figure and of the question hands in a bundle with rows; the Fast functions are tested as the pure functions they are.
import { describe, expect, it } from "vitest";

import {
  askFor,
  clampOverrides,
  explicitOf,
  figureFor,
  leversShown,
  ownLevers,
  payloadFor,
  projectFacts,
  qualityEntries,
  rateEntries,
  rateOptions,
  resolveChoice,
  routeOf,
  sizeEntries,
  sizeOptions,
  summaryFor,
  type Choice,
  type Levers,
  type Overrides,
} from "./exportChoiceView";
import type { ExportQuality, ExportResolution } from "./exportOptions";
import { QUICK_BUNDLE, type ProjectFacts, type QuickBundle } from "./exportRoute";

const facts = (
  width: number,
  height: number,
  fps: number,
  durationSeconds = 360,
): ProjectFacts => ({ width, height, fps, durationSeconds });

const levers = (
  resolution: ExportResolution,
  fps: number | null,
  quality: ExportQuality = "medium",
): Levers => ({ resolution, fps, quality });

/** The project the app opens with (6 minutes) and a big one (12 minutes of 4K at 60): the two of table 3.5. */
const A = facts(1080, 1920, 30, 360);
const B = facts(3840, 2160, 60, 720);

/** Quality starts on the project as it is, at Medium: the same for every project and for none. */
const QUALITY_OWN = levers("source", null, "medium");

interface Project {
  name: string;
  project: ProjectFacts | null;
  /** What Fast starts on (table 3.1, "Fast shows"). */
  fast: Levers;
  /** The Resolution list's values, in order. */
  sizes: ExportResolution[];
  /** The Frame rate list's values, in order (null is "Same as project"). */
  rates: (number | null)[];
}

/** Table 3.1 of the spec, row by row, then the projects the spec names elsewhere (vertical, odd sides, the odd rates). */
const PROJECTS: Project[] = [
  {
    name: "1080 x 1920 at 30 (the app's default project)",
    project: A,
    fast: levers("720p", null),
    sizes: ["source", "720p", "480p"],
    rates: [null, 25, 24],
  },
  {
    name: "3840 x 2160 at 60",
    project: B,
    fast: levers("1080p", 30),
    sizes: ["source", "1440p", "1080p", "720p", "480p"],
    rates: [null, 50, 30, 25, 24],
  },
  {
    name: "2560 x 1440 at 50",
    project: facts(2560, 1440, 50),
    fast: levers("1080p", 25),
    sizes: ["source", "1080p", "720p", "480p"],
    rates: [null, 30, 25, 24],
  },
  {
    name: "1280 x 720 at 25",
    project: facts(1280, 720, 25),
    fast: levers("480p", null),
    sizes: ["source", "480p"],
    rates: [null, 24],
  },
  {
    name: "854 x 480 at 30",
    project: facts(854, 480, 30),
    fast: levers("source", null),
    sizes: ["source"],
    rates: [null, 25, 24],
  },
  {
    name: "1920 x 1080 at 24",
    project: facts(1920, 1080, 24),
    fast: levers("720p", null),
    sizes: ["source", "720p", "480p"],
    rates: [null],
  },
  {
    name: "7680 x 4320 at 30",
    project: facts(7680, 4320, 30),
    fast: levers("2160p", null),
    sizes: ["source", "2160p", "1440p", "1080p", "720p", "480p"],
    rates: [null, 25, 24],
  },
  {
    name: "no project",
    project: null,
    fast: levers("source", null),
    sizes: ["source"],
    rates: [null],
  },
  {
    name: "1920 x 1080 at 30 (the default project turned on its side: sizes go by the short side)",
    project: facts(1920, 1080, 30),
    fast: levers("720p", null),
    sizes: ["source", "720p", "480p"],
    rates: [null, 25, 24],
  },
  {
    name: "2160 x 3840 at 60 (vertical 4K)",
    project: facts(2160, 3840, 60),
    fast: levers("1080p", 30),
    sizes: ["source", "1440p", "1080p", "720p", "480p"],
    rates: [null, 50, 30, 25, 24],
  },
  {
    name: "4096 x 2160 at 60 (4K cinema: 2160 is not below 2160)",
    project: facts(4096, 2160, 60),
    fast: levers("1080p", 30),
    sizes: ["source", "1440p", "1080p", "720p", "480p"],
    rates: [null, 50, 30, 25, 24],
  },
  {
    name: "1081 x 1921 at 30 (odd: the render works at 1082 x 1922, so 1080p is below it)",
    project: facts(1081, 1921, 30),
    fast: levers("1080p", null),
    sizes: ["source", "1080p", "720p", "480p"],
    rates: [null, 25, 24],
  },
  {
    name: "1079 x 1919 at 30 (odd: the render works at 1080 x 1920, so 1080p is not below it)",
    project: facts(1079, 1919, 30),
    fast: levers("720p", null),
    sizes: ["source", "720p", "480p"],
    rates: [null, 25, 24],
  },
  {
    name: "2 x 2 at 30 (the smallest picture the render makes)",
    project: facts(2, 2, 30),
    fast: levers("source", null),
    sizes: ["source"],
    rates: [null, 25, 24],
  },
  {
    name: "1920 x 1080 at 29.97",
    project: facts(1920, 1080, 29.97),
    fast: levers("720p", null),
    sizes: ["source", "720p", "480p"],
    rates: [null, 25, 24],
  },
  {
    name: "3840 x 2160 at 59.94",
    project: facts(3840, 2160, 59.94),
    fast: levers("1080p", 30),
    sizes: ["source", "1440p", "1080p", "720p", "480p"],
    rates: [null, 50, 30, 25, 24],
  },
  {
    name: "1920 x 1080 at 23.976",
    project: facts(1920, 1080, 23.976),
    fast: levers("720p", null),
    sizes: ["source", "720p", "480p"],
    rates: [null],
  },
  {
    name: "1920 x 1080 at 120",
    project: facts(1920, 1080, 120),
    fast: levers("720p", 30),
    sizes: ["source", "720p", "480p"],
    rates: [null, 60, 50, 30, 25, 24],
  },
];

describe("projectFacts: what the dialog can read of a project", () => {
  it("takes a width, a height and a rate that are numbers above 0, and the length it is given", () => {
    expect(projectFacts({ width: 1080, height: 1920, fps: 30 }, 360)).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 360,
    });
    expect(projectFacts({ width: 854, height: 480, fps: 29.97 }, 0)).toEqual({
      width: 854,
      height: 480,
      fps: 29.97,
      durationSeconds: 0,
    });
  });

  const unreadable: [
    string,
    { width?: unknown; height?: unknown; fps?: unknown } | null | undefined,
  ][] = [
    ["no canvas", null],
    ["an undefined canvas", undefined],
    ["a width of 0", { width: 0, height: 1080, fps: 30 }],
    ["a negative height", { width: 1920, height: -1080, fps: 30 }],
    ["a width that is not a number", { width: "1920", height: 1080, fps: 30 }],
    ["a NaN height", { width: 1920, height: Number.NaN, fps: 30 }],
    ["an infinite width", { width: Number.POSITIVE_INFINITY, height: 1080, fps: 30 }],
    ["no rate", { width: 1920, height: 1080 }],
    ["a rate of 0", { width: 1920, height: 1080, fps: 0 }],
  ];

  it.each(unreadable)("%s is unreadable: null", (_name, canvas) => {
    expect(projectFacts(canvas, 360)).toBeNull();
  });

  it("reads a length that is not a number of at least 0 as 0", () => {
    const canvas = { width: 1920, height: 1080, fps: 30 };
    for (const length of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "360", null])
      expect(projectFacts(canvas, length)?.durationSeconds).toBe(0);
  });
});

describe("the two choices' own values (table 3.1)", () => {
  it.each(PROJECTS)("Quality starts on Same as project, Same as project, Medium: $name", (row) => {
    expect(ownLevers("quality", row.project)).toEqual(QUALITY_OWN);
  });

  it.each(PROJECTS)("Fast starts on what the export tool composes: $name", (row) => {
    expect(ownLevers("fast", row.project)).toEqual(row.fast);
  });

  it("never starts Fast on a rate at or above the project's", () => {
    for (const project of PROJECTS) {
      const own = ownLevers("fast", project.project);
      if (project.project !== null && own.fps !== null)
        expect(own.fps).toBeLessThan(project.project.fps);
    }
  });

  it.each([
    [72, 18],
    [32, 16],
    [48, 24],
    [90, 30],
    [100, 25],
    [31, 30],
    [45, 30],
    [50, 25],
  ])("a project at %s fps: Fast's own rate is %s", (fps, expected) => {
    expect(ownLevers("fast", facts(1920, 1080, fps)).fps).toBe(expected);
  });

  it("leaves a rate at or under the cap alone, and never writes one for a rate it cannot lower", () => {
    for (const fps of [24, 25, 29.97, 30])
      expect(ownLevers("fast", facts(1920, 1080, fps)).fps).toBeNull();
  });

  it("reads the bundle, not constants: another ladder, cap and quality give other own values", () => {
    const other: QuickBundle = {
      ...QUICK_BUNDLE,
      ladder: ["1080p", "480p"],
      maxFps: 24,
      quality: "low",
    };
    // 3840 x 2160 at 50: the largest rung of [1080p, 480p] below 2160 is 1080p; 50 halves to 25, still above 24, and 25 does not halve to a whole number: the cap, 24
    expect(ownLevers("fast", facts(3840, 2160, 50), other)).toEqual(levers("1080p", 24, "low"));
    // 1280 x 720: no 720p rung to go to, 480p is the only one below
    expect(ownLevers("fast", facts(1280, 720, 24), other)).toEqual(levers("480p", null, "low"));
    // 1920 x 1080 with a ladder that has nothing below 1080: the size stays
    expect(
      ownLevers("fast", facts(1920, 1080, 24), { ...other, ladder: ["2160p"], maxFps: 30 }),
    ).toEqual(levers("source", null, "low"));
    // Quality never reads the bundle
    expect(ownLevers("quality", facts(3840, 2160, 50), other)).toEqual(QUALITY_OWN);
  });
});

describe("the Resolution list (table 3.1, rule 3.2)", () => {
  it.each(PROJECTS)("offers the project's own size then only smaller presets: $name", (row) => {
    expect(sizeOptions(row.project)).toEqual(row.sizes);
  });

  it.each(PROJECTS)("Fast's own size is one of the entries: $name", (row) => {
    expect(sizeOptions(row.project)).toContain(row.fast.resolution);
  });

  it("names the entries: the project's own picture first (even sides), then the presets", () => {
    expect(sizeEntries(A)).toEqual([
      { value: "source", label: "Same as project (1080 x 1920)" },
      { value: "720p", label: "720p" },
      { value: "480p", label: "480p" },
    ]);
    expect(sizeEntries(B)).toEqual([
      { value: "source", label: "Same as project (3840 x 2160)" },
      { value: "1440p", label: "1440p" },
      { value: "1080p", label: "1080p" },
      { value: "720p", label: "720p" },
      { value: "480p", label: "480p" },
    ]);
    expect(sizeEntries(facts(7680, 4320, 30)).map((entry) => entry.label)).toEqual([
      "Same as project (7680 x 4320)",
      "2160p (4K)",
      "1440p",
      "1080p",
      "720p",
      "480p",
    ]);
  });

  it("writes an odd canvas as the picture the render makes of it", () => {
    expect(sizeEntries(facts(1081, 1921, 30))[0]).toEqual({
      value: "source",
      label: "Same as project (1082 x 1922)",
    });
    expect(sizeEntries(facts(1079, 1919, 30))[0]?.label).toBe("Same as project (1080 x 1920)");
  });

  it("has one entry, so no row, when there is no project or the project is 480p or smaller", () => {
    expect(sizeEntries(null).map((entry) => entry.value)).toEqual(["source"]);
    expect(sizeEntries(facts(854, 480, 30)).map((entry) => entry.value)).toEqual(["source"]);
    expect(sizeEntries(facts(640, 360, 30)).map((entry) => entry.value)).toEqual(["source"]);
  });
});

describe("the Frame rate list (table 3.1, rule 3.2)", () => {
  it.each(PROJECTS)("offers Same as project then lower rates of the ladder only: $name", (row) => {
    expect(rateOptions(row.project)).toEqual(row.rates);
  });

  it("never offers a rate at or above the project's, for a 24 fps project none at all", () => {
    expect(rateOptions(facts(1920, 1080, 24))).toEqual([null]);
    expect(rateOptions(facts(1920, 1080, 23.976))).toEqual([null]);
    expect(rateOptions(facts(1920, 1080, 25))).toEqual([null, 24]);
    expect(rateOptions(facts(1920, 1080, 25))).not.toContain(25);
    expect(rateOptions(facts(1920, 1080, 30))).not.toContain(30);
    expect(rateOptions(facts(1920, 1080, 30))).not.toContain(60);
  });

  it("adds the extra rate only where it is below the project's rate, at least 1 and not there already, highest first", () => {
    expect(rateOptions(facts(1920, 1080, 72), 18)).toEqual([null, 60, 50, 30, 25, 24, 18]);
    expect(rateOptions(facts(1920, 1080, 32), 16)).toEqual([null, 30, 25, 24, 16]);
    // in the middle of the ladder: kept in order
    expect(rateOptions(facts(1920, 1080, 72), 27)).toEqual([null, 60, 50, 30, 27, 25, 24]);
    // already there: no second copy
    expect(rateOptions(facts(1920, 1080, 50), 25)).toEqual([null, 30, 25, 24]);
    // not below the project's rate
    expect(rateOptions(facts(1920, 1080, 30), 30)).toEqual([null, 25, 24]);
    expect(rateOptions(facts(1920, 1080, 30), 45)).toEqual([null, 25, 24]);
    // below 1, or not a number
    expect(rateOptions(facts(1920, 1080, 30), 0.5)).toEqual([null, 25, 24]);
    expect(rateOptions(facts(1920, 1080, 30), 0)).toEqual([null, 25, 24]);
    expect(rateOptions(facts(1920, 1080, 30), -3)).toEqual([null, 25, 24]);
    expect(rateOptions(facts(1920, 1080, 30), Number.NaN)).toEqual([null, 25, 24]);
    expect(rateOptions(facts(1920, 1080, 30), null)).toEqual([null, 25, 24]);
    // no project: only Same as project, whatever the extra
    expect(rateOptions(null, 18)).toEqual([null]);
  });

  it("holds Fast's own rate for every project of the table when the view passes it", () => {
    for (const row of PROJECTS) {
      const own = ownLevers("fast", row.project).fps;
      if (own !== null) expect(rateOptions(row.project, own)).toContain(own);
    }
  });

  it("names the entries: the project's rate as it is (at most two decimals), then the lower ones", () => {
    expect(rateEntries(B)).toEqual([
      { value: null, label: "Same as project (60 fps)" },
      { value: 50, label: "50 fps" },
      { value: 30, label: "30 fps" },
      { value: 25, label: "25 fps" },
      { value: 24, label: "24 fps" },
    ]);
    expect(rateEntries(facts(1920, 1080, 29.97))[0]?.label).toBe("Same as project (29.97 fps)");
    expect(rateEntries(facts(1920, 1080, 59.94))[0]?.label).toBe("Same as project (59.94 fps)");
    expect(rateEntries(facts(1920, 1080, 23.976))[0]?.label).toBe("Same as project (23.98 fps)");
    expect(rateEntries(facts(1920, 1080, 72), 18).map((entry) => entry.label)).toEqual([
      "Same as project (72 fps)",
      "60 fps",
      "50 fps",
      "30 fps",
      "25 fps",
      "24 fps",
      "18 fps",
    ]);
  });

  it("has one entry, so no row, for a 24 fps project and for none", () => {
    expect(rateEntries(facts(1920, 1080, 24)).map((entry) => entry.value)).toEqual([null]);
    expect(rateEntries(null).map((entry) => entry.value)).toEqual([null]);
  });
});

describe("the Quality list", () => {
  it("is High, Medium, Low: names only", () => {
    expect(qualityEntries()).toEqual([
      { value: "high", label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low", label: "Low" },
    ]);
  });
});

describe("clampOverrides: a pick the project no longer holds is dropped", () => {
  const kept: [string, Overrides, ProjectFacts | null][] = [
    ["nothing picked", {}, A],
    ["a smaller size", { resolution: "720p" }, A],
    ["the project's own size picked on purpose", { resolution: "source" }, A],
    ["Same as project picked for the rate", { fps: null }, A],
    ["a lower rate", { fps: 24 }, A],
    ["a rate that is a fraction below the project's", { fps: 29.97 }, A],
    ["the lowest rate there is", { fps: 1 }, A],
    ["a quality", { quality: "high" }, A],
    ["all three", { resolution: "480p", fps: 25, quality: "low" }, A],
    [
      "Same as project for size and rate, with a quality, on no project",
      { resolution: "source", fps: null, quality: "high" },
      null,
    ],
    ["nothing, on no project", {}, null],
  ];

  it.each(kept)(
    "returns the SAME object where nothing is out of range: %s",
    (_name, picks, project) => {
      expect(clampOverrides(picks, project)).toBe(picks);
    },
  );

  it.each([
    ["a size at the project's short side", { resolution: "1080p" }, A, {}],
    ["a size above the project's", { resolution: "2160p" }, A, {}],
    ["a size above a 720p project's", { resolution: "1080p" }, facts(1280, 720, 25), {}],
    ["480p on a 480p project", { resolution: "480p" }, facts(854, 480, 30), {}],
    ["a rate equal to the project's", { fps: 30 }, A, {}],
    ["a rate above the project's", { fps: 60 }, A, {}],
    ["a rate under 1", { fps: 0.99 }, A, {}],
    ["a rate of 0", { fps: 0 }, A, {}],
    ["a negative rate", { fps: -24 }, A, {}],
    ["a rate that is not a number", { fps: Number.NaN }, A, {}],
    ["an infinite rate", { fps: Number.POSITIVE_INFINITY }, A, {}],
    [
      "a quality that is not one of the three",
      { quality: "ultra" as unknown as ExportQuality },
      A,
      {},
    ],
  ] as [string, Overrides, ProjectFacts, Overrides][])(
    "drops %s and gives back a new object",
    (_name, picks, project, expected) => {
      const result = clampOverrides(picks, project);
      expect(result).toEqual(expected);
      expect(result).not.toBe(picks);
    },
  );

  it("keeps what is in range and drops only what is not, without touching the object it was given", () => {
    const picks: Overrides = { resolution: "2160p", fps: 24, quality: "high" };
    const result = clampOverrides(picks, A);
    expect(result).toEqual({ fps: 24, quality: "high" });
    expect(picks).toEqual({ resolution: "2160p", fps: 24, quality: "high" });
    expect(clampOverrides({ resolution: "720p", fps: 60, quality: "low" }, A)).toEqual({
      resolution: "720p",
      quality: "low",
    });
  });

  it("drops a size and a rate the project that shrank no longer holds, as the snap needs", () => {
    // the project was 3840 x 2160 at 60 and is now 1280 x 720 at 25: 1440p and 50 are gone, 480p and 24 stay
    const small = facts(1280, 720, 25);
    expect(clampOverrides({ resolution: "1440p", fps: 50 }, small)).toEqual({});
    expect(clampOverrides({ resolution: "480p", fps: 24 }, small)).toEqual({
      resolution: "480p",
      fps: 24,
    });
  });

  it("with no readable project drops every numeric rate and every size but Same as project, and keeps null and a valid quality", () => {
    expect(clampOverrides({ resolution: "720p", fps: 24, quality: "high" }, null)).toEqual({
      quality: "high",
    });
    expect(clampOverrides({ resolution: "source", fps: null, quality: "low" }, null)).toEqual({
      resolution: "source",
      fps: null,
      quality: "low",
    });
    expect(clampOverrides({ fps: 60 }, null)).toEqual({});
    expect(clampOverrides({ fps: 1 }, null)).toEqual({});
    expect(clampOverrides({ resolution: "480p" }, null)).toEqual({});
  });
});

describe("leversShown: the three values the rows show, and so the three that are sent", () => {
  it("is the choice's own values where nothing was picked", () => {
    for (const row of PROJECTS) {
      expect(leversShown("quality", {}, row.project)).toEqual(QUALITY_OWN);
      expect(leversShown("fast", {}, row.project)).toEqual(row.fast);
    }
  });

  it("replaces exactly the lever that was picked", () => {
    expect(leversShown("quality", { resolution: "720p" }, A)).toEqual(levers("720p", null));
    expect(leversShown("quality", { fps: 24 }, A)).toEqual(levers("source", 24));
    expect(leversShown("quality", { quality: "high" }, A)).toEqual(levers("source", null, "high"));
    expect(leversShown("fast", { resolution: "1440p" }, B)).toEqual(levers("1440p", 30));
    expect(leversShown("fast", { quality: "high" }, B)).toEqual(levers("1080p", 30, "high"));
    expect(leversShown("fast", { fps: 25 }, B)).toEqual(levers("1080p", 25));
  });

  it("shows Same as project for the rate when it was picked on purpose, not Fast's own cap", () => {
    expect(leversShown("fast", { fps: null }, B)).toEqual(levers("1080p", null));
    expect(leversShown("fast", { resolution: "source" }, B)).toEqual(levers("source", 30));
  });

  it("never shows a pick the project does not hold: it shows the choice's own value instead", () => {
    expect(leversShown("fast", { resolution: "2160p" }, A)).toEqual(levers("720p", null));
    expect(leversShown("quality", { resolution: "1080p" }, A)).toEqual(QUALITY_OWN);
    expect(leversShown("quality", { fps: 30 }, A)).toEqual(QUALITY_OWN);
    expect(leversShown("fast", { fps: 60 }, B)).toEqual(levers("1080p", 30));
    expect(leversShown("quality", { resolution: "720p", fps: 24 }, null)).toEqual(QUALITY_OWN);
  });
});

describe("explicitOf: which of the three the person set", () => {
  it("is true for exactly the levers present, and false for the others", () => {
    expect(explicitOf({})).toEqual({ size: false, fps: false, quality: false });
    expect(explicitOf({ resolution: "720p" })).toEqual({ size: true, fps: false, quality: false });
    expect(explicitOf({ fps: 24 })).toEqual({ size: false, fps: true, quality: false });
    expect(explicitOf({ quality: "high" })).toEqual({ size: false, fps: false, quality: true });
  });

  it("counts a Same as project that was picked on purpose (a size of source, a rate of null)", () => {
    expect(explicitOf({ resolution: "source" })).toEqual({
      size: true,
      fps: false,
      quality: false,
    });
    expect(explicitOf({ fps: null })).toEqual({ size: false, fps: true, quality: false });
    expect(explicitOf({ resolution: "source", fps: null, quality: "medium" })).toEqual({
      size: true,
      fps: true,
      quality: true,
    });
  });

  it("does not count a lever that is present but undefined", () => {
    expect(explicitOf({ resolution: undefined, fps: undefined, quality: undefined })).toEqual({
      size: false,
      fps: false,
      quality: false,
    });
  });
});

/** A bundle with the lab's figures in it (the real one has none yet). */
const TABLE: QuickBundle = {
  ...QUICK_BUNDLE,
  speedup: [
    { shortSide: { min: 2160 }, figure: 4 },
    { shortSide: { min: 1080 }, figure: 2.5 },
    { shortSide: { min: 720 }, figure: 1.04 },
  ],
};

describe("figureFor: the figure on the Fast label (3.6)", () => {
  it("is null for every project and every shown value while the table is empty", () => {
    for (const row of PROJECTS)
      for (const choice of ["quality", "fast"] as const)
        for (const shown of [QUALITY_OWN, row.fast, levers("720p", 24, "high")])
          expect(figureFor(choice, shown, row.project)).toBeNull();
  });

  it("is the table's number for the project while the shown size and rate are the choice's own", () => {
    expect(figureFor("fast", levers("1080p", 30), B, TABLE)).toBe(4);
    expect(figureFor("fast", levers("720p", null), A, TABLE)).toBe(2.5);
    expect(figureFor("fast", levers("1080p", 25), facts(2560, 1440, 50), TABLE)).toBe(2.5);
    expect(figureFor("quality", QUALITY_OWN, B, TABLE)).toBe(4);
  });

  it("is still there when only the Quality row was changed", () => {
    expect(figureFor("fast", levers("1080p", 30, "high"), B, TABLE)).toBe(4);
    expect(figureFor("quality", levers("source", null, "low"), B, TABLE)).toBe(4);
  });

  it("is gone once the Resolution list shows another size than the choice's own", () => {
    expect(figureFor("fast", levers("1440p", 30), B, TABLE)).toBeNull();
    expect(figureFor("fast", levers("source", 30), B, TABLE)).toBeNull();
    expect(figureFor("fast", levers("480p", 30), B, TABLE)).toBeNull();
    expect(figureFor("quality", levers("1080p", null), B, TABLE)).toBeNull();
  });

  it("is gone once the Frame rate list shows another rate than the choice's own", () => {
    expect(figureFor("fast", levers("1080p", null), B, TABLE)).toBeNull();
    expect(figureFor("fast", levers("1080p", 25), B, TABLE)).toBeNull();
    expect(figureFor("quality", levers("source", 30), B, TABLE)).toBeNull();
  });

  it("is null where no row covers the project, whatever is shown", () => {
    expect(figureFor("fast", levers("source", null), facts(854, 480, 30), TABLE)).toBeNull();
    expect(figureFor("quality", QUALITY_OWN, facts(854, 480, 30), TABLE)).toBeNull();
    expect(figureFor("quality", QUALITY_OWN, null, TABLE)).toBeNull();
  });

  it("never claims a figure that would be written as 1x, and claims one that reads 1.1x", () => {
    // 1280 x 720: the third row covers it, 1.04 reads 1x
    expect(figureFor("fast", levers("480p", null), facts(1280, 720, 25), TABLE)).toBeNull();
    const only = (figure: number): QuickBundle => ({ ...QUICK_BUNDLE, speedup: [{ figure }] });
    for (const figure of [1.04, 1.0, 1, 0.5, 0, -2, Number.NaN])
      expect(figureFor("quality", QUALITY_OWN, A, only(figure))).toBeNull();
    expect(figureFor("quality", QUALITY_OWN, A, only(1.06))).toBe(1.06);
    expect(figureFor("quality", QUALITY_OWN, A, only(2.5))).toBe(2.5);
  });
});

/** A table with one row that covers every project: the question then depends only on the project being big and the settings being heavier. */
const EVERY: QuickBundle = { ...QUICK_BUNDLE, speedup: [{ figure: 4 }] };

describe("askFor: when pressing Export asks Are you sure? (3.7)", () => {
  const ask = (
    choice: Choice,
    picks: Overrides,
    project: ProjectFacts | null,
    bundle: QuickBundle = EVERY,
  ) => {
    const resolved = resolveChoice(choice, picks, project, bundle);
    return askFor(choice, resolved.shown, resolved.kept, project, bundle);
  };

  it("never asks for an ordinary project: the default project at 6 minutes, with a table", () => {
    expect(ask("quality", {}, A)).toBeNull();
    expect(ask("fast", {}, A)).toBeNull();
    expect(ask("quality", { resolution: "source", fps: null }, A)).toBeNull();
  });

  it("never asks while the table is empty, even for a big project", () => {
    expect(ask("quality", {}, B, QUICK_BUNDLE)).toBeNull();
    expect(ask("fast", { resolution: "1440p" }, B, QUICK_BUNDLE)).toBeNull();
  });

  it("asks question (a) of Quality on a big project, with the figure of the table", () => {
    expect(ask("quality", {}, B)).toEqual({ kind: "a", figure: 4 });
  });

  it("asks (a) without a figure once a size or a rate was changed: the figure would not be true", () => {
    expect(ask("quality", { resolution: "1440p" }, B)).toEqual({ kind: "a", figure: null });
    expect(ask("quality", { fps: 30 }, B)).toEqual({ kind: "a", figure: null });
    // a smaller size with the rate left at 60 is still heavier than Fast's own rate
    expect(ask("quality", { resolution: "480p" }, B)).toEqual({ kind: "a", figure: null });
  });

  it("asks (a) with the figure where only the quality was changed", () => {
    expect(ask("quality", { quality: "high" }, B)).toEqual({ kind: "a", figure: 4 });
  });

  it("does not ask of Quality whose settings are Fast's own size and rate", () => {
    expect(ask("quality", { resolution: "1080p", fps: 30 }, B)).toBeNull();
  });

  it("never asks of Fast on its own settings", () => {
    expect(ask("fast", {}, B)).toBeNull();
    expect(ask("fast", {}, facts(1920, 1080, 50, 60))).toBeNull();
  });

  it("asks question (b), never with a figure, of Fast with a size or a rate above its own", () => {
    expect(ask("fast", { resolution: "1440p" }, B)).toEqual({ kind: "b", figure: null });
    expect(ask("fast", { resolution: "source" }, B)).toEqual({ kind: "b", figure: null });
    expect(ask("fast", { fps: null }, B)).toEqual({ kind: "b", figure: null });
    expect(ask("fast", { resolution: "source", fps: null, quality: "high" }, B)).toEqual({
      kind: "b",
      figure: null,
    });
  });

  it("does not ask of Fast for a lighter size, a lower rate or a quality alone", () => {
    expect(ask("fast", { resolution: "720p" }, B)).toBeNull();
    expect(ask("fast", { fps: 24 }, B)).toBeNull();
    expect(ask("fast", { quality: "high" }, B)).toBeNull();
    expect(ask("fast", { quality: "low" }, B)).toBeNull();
  });

  it("calls a project big by its length (over 600 seconds), its rate (50 or more) or its size (2160 or more)", () => {
    // 1080 x 1920 at 30: Quality is heavier than Fast's 720p, so the length alone decides
    expect(ask("quality", {}, facts(1080, 1920, 30, 600))).toBeNull();
    expect(ask("quality", {}, facts(1080, 1920, 30, 601))).toEqual({ kind: "a", figure: 4 });
    expect(ask("quality", {}, facts(1920, 1080, 49, 60))).toBeNull();
    expect(ask("quality", {}, facts(1920, 1080, 50, 60))).toEqual({ kind: "a", figure: 4 });
    expect(ask("quality", {}, facts(3840, 2160, 30, 60))).toEqual({ kind: "a", figure: 4 });
    expect(ask("quality", {}, facts(3000, 2158, 30, 60))).toBeNull();
    // 2159 is made even by the render (2160), so that canvas is big
    expect(ask("quality", {}, facts(3000, 2159, 30, 60))).toEqual({ kind: "a", figure: 4 });
  });

  it("does not ask for a big project that is already at or below Fast's size and rate", () => {
    expect(ask("quality", {}, facts(854, 480, 30, 700))).toBeNull();
    expect(ask("quality", {}, facts(1280, 720, 25, 700))).toEqual({ kind: "a", figure: 4 });
  });

  it("asks only where a row of the table covers the project, whatever the rule says otherwise", () => {
    const rows: QuickBundle = {
      ...QUICK_BUNDLE,
      speedup: [{ shortSide: { min: 4000 }, figure: 3 }],
    };
    expect(ask("quality", {}, B, rows)).toBeNull();
    expect(ask("quality", {}, facts(7680, 4320, 30), rows)).toEqual({ kind: "a", figure: 3 });
  });

  it("asks nothing of no project", () => {
    expect(ask("quality", {}, null)).toBeNull();
    expect(ask("fast", { resolution: "source" }, null)).toBeNull();
  });
});

describe("payloadFor: what onStart is handed (table 3.5, rows 1 to 13)", () => {
  /** One click: the view's own pipeline, from the picks and the app's look (`mode` is the 0.28.0 value of the Quality choice). */
  const sent = (
    choice: Choice,
    picks: Overrides,
    project: ProjectFacts | null,
    qualityMode: "quality" | null = null,
  ) => {
    const resolved = resolveChoice(choice, picks, project);
    return payloadFor(choice, resolved.shown, resolved.kept, qualityMode);
  };
  const quick = (size: boolean, fps: boolean, quality: boolean) => ({
    route: "quick" as const,
    explicit: { size, fps, quality },
  });

  const ROWS: [string, Choice, Overrides, ProjectFacts, object][] = [
    [
      "1 (A, Quality, nothing)",
      "quality",
      {},
      A,
      { resolution: "source", quality: "medium", fps: null },
    ],
    [
      "2 (A, Quality, Resolution 720p)",
      "quality",
      { resolution: "720p" },
      A,
      { resolution: "720p", quality: "medium", fps: null },
    ],
    [
      "3 (A, Quality High and 24 fps)",
      "quality",
      { quality: "high", fps: 24 },
      A,
      { resolution: "source", quality: "high", fps: 24 },
    ],
    [
      "8 (B, Quality, nothing)",
      "quality",
      {},
      B,
      { resolution: "source", quality: "medium", fps: null },
    ],
    [
      "13 (A, Fast then Quality picked again: the picks were reset)",
      "quality",
      {},
      A,
      { resolution: "source", quality: "medium", fps: null },
    ],
  ];

  it.each(ROWS)(
    "row %s sends the 0.28.0 object, whichever way the app's look went",
    (_name, choice, picks, project, expected) => {
      for (const mode of ["quality", null] as const)
        expect(sent(choice, picks, project, mode)).toStrictEqual({ ...expected, mode });
    },
  );

  const FAST_ROWS: [string, Overrides, ProjectFacts, object][] = [
    [
      "4 (A, Fast, nothing)",
      {},
      A,
      { resolution: "720p", quality: "medium", fps: null, route: quick(false, false, false) },
    ],
    [
      "5 (A, Fast, Resolution Same as project)",
      { resolution: "source" },
      A,
      { resolution: "source", quality: "medium", fps: null, route: quick(true, false, false) },
    ],
    [
      "6 (A, Fast, Resolution 480p)",
      { resolution: "480p" },
      A,
      { resolution: "480p", quality: "medium", fps: null, route: quick(true, false, false) },
    ],
    [
      "7 (A, Fast, Quality High)",
      { quality: "high" },
      A,
      { resolution: "720p", quality: "high", fps: null, route: quick(false, false, true) },
    ],
    [
      "9 (B, Fast, nothing)",
      {},
      B,
      { resolution: "1080p", quality: "medium", fps: 30, route: quick(false, false, false) },
    ],
    [
      "10 (B, Fast, Frame rate Same as project)",
      { fps: null },
      B,
      { resolution: "1080p", quality: "medium", fps: null, route: quick(false, true, false) },
    ],
    [
      "11 (B, Fast, everything Same as project, Quality High)",
      { resolution: "source", fps: null, quality: "high" },
      B,
      { resolution: "source", quality: "high", fps: null, route: quick(true, true, true) },
    ],
    [
      "12 (B, Fast, Resolution 1440p)",
      { resolution: "1440p" },
      B,
      { resolution: "1440p", quality: "medium", fps: 30, route: quick(true, false, false) },
    ],
  ];

  it.each(FAST_ROWS)(
    "row %s sends the shown values, the route and which levers were set, and no mode",
    (_name, picks, project, expected) => {
      // whatever the app's look said for Quality, Fast leaves the encoder to the app
      for (const mode of ["quality", null] as const)
        expect(sent("fast", picks, project, mode)).toStrictEqual({ ...expected, mode: null });
    },
  );

  it("sends Quality with exactly resolution, quality, fps and mode, and no route key at all", () => {
    for (const project of PROJECTS)
      for (const picks of [{}, { resolution: "480p" }, { fps: 24, quality: "low" }] as Overrides[])
        for (const mode of ["quality", null] as const) {
          const object = sent("quality", picks, project.project, mode);
          expect(Object.keys(object).sort()).toEqual(["fps", "mode", "quality", "resolution"]);
          expect("route" in object).toBe(false);
        }
  });

  it("sends the values the rows show, never the raw defaults, and clamps a pick the project does not hold", () => {
    // what is on screen is what is sent: a size that the project does not hold is shown as the choice's own, and so sent
    expect(sent("fast", { resolution: "2160p" }, A)).toStrictEqual({
      resolution: "720p",
      quality: "medium",
      fps: null,
      mode: null,
      route: quick(false, false, false),
    });
    expect(sent("quality", { resolution: "1080p", fps: 60 }, A, null)).toStrictEqual({
      resolution: "source",
      quality: "medium",
      fps: null,
      mode: null,
    });
  });

  it("the route names the explicit levers of the clamped picks, a fresh object each time", () => {
    const first = sent("fast", { quality: "low" }, A);
    const second = sent("fast", { quality: "low" }, A);
    expect(first.route).toEqual(quick(false, false, true));
    expect(first.route).not.toBe(second.route);
    expect(first.route?.explicit).not.toBe(second.route?.explicit);
  });

  it("maps the choices to the export's own route kinds", () => {
    expect(routeOf("fast")).toBe("quick");
    expect(routeOf("quality")).toBe("standard");
  });
});

describe("summaryFor: the line under the door is built from the choice and the bundle", () => {
  it("says the project's own size and rate at Medium for Quality, whatever the project and the bundle", () => {
    const other: QuickBundle = { ...QUICK_BUNDLE, maxFps: 24, quality: "low" };
    for (const row of PROJECTS) {
      expect(summaryFor("quality", row.project)).toBe(
        "Project size and frame rate, Medium quality.",
      );
      expect(summaryFor("quality", row.project, other)).toBe(
        "Project size and frame rate, Medium quality.",
      );
    }
  });

  it("says one size smaller, up to 30 frames a second, Medium and light compression for Fast", () => {
    expect(summaryFor("fast", A)).toBe(
      "One size smaller, up to 30 frames a second, Medium quality, light compression.",
    );
    expect(summaryFor("fast", B)).toBe(
      "One size smaller, up to 30 frames a second, Medium quality, light compression.",
    );
  });

  it("leaves out one size smaller where the project has no smaller size (480p and under, no project)", () => {
    const plain = "Up to 30 frames a second, Medium quality, light compression.";
    expect(summaryFor("fast", facts(854, 480, 30))).toBe(plain);
    expect(summaryFor("fast", facts(640, 360, 25))).toBe(plain);
    expect(summaryFor("fast", null)).toBe(plain);
  });

  it("still says up to 30 for a project that runs at 24: the line is for the choice, not for the values", () => {
    expect(summaryFor("fast", facts(1920, 1080, 24))).toBe(
      "One size smaller, up to 30 frames a second, Medium quality, light compression.",
    );
  });

  it("takes every number from the bundle: another cap, quality and ladder give another line", () => {
    const other: QuickBundle = {
      ...QUICK_BUNDLE,
      ladder: ["2160p", "1080p"],
      maxFps: 24,
      quality: "low",
    };
    // 1280 x 720 has no rung below it in this ladder, 1920 x 1080 has none either (1080p is not below 1080)
    expect(summaryFor("fast", facts(1280, 720, 25), other)).toBe(
      "Up to 24 frames a second, Low quality, light compression.",
    );
    expect(summaryFor("fast", facts(3840, 2160, 60), other)).toBe(
      "One size smaller, up to 24 frames a second, Low quality, light compression.",
    );
    expect(summaryFor("fast", facts(1280, 720, 25))).toBe(
      "One size smaller, up to 30 frames a second, Medium quality, light compression.",
    );
    expect(
      summaryFor("fast", facts(1920, 1080, 30), { ...other, quality: "high", maxFps: 60 }),
    ).toBe("Up to 60 frames a second, High quality, light compression.");
  });
});

describe("resolveChoice: one answer for a draw and for a click", () => {
  it("gives the kept picks, the shown values, the figure and the question of one set of facts", () => {
    const resolved = resolveChoice("fast", { resolution: "2160p", fps: 24 }, A, TABLE);
    expect(resolved.kept).toEqual({ fps: 24 });
    expect(resolved.shown).toEqual(levers("720p", 24));
    // a rate was changed, so the figure is not claimed
    expect(resolved.figure).toBeNull();
    expect(resolved.ask).toBeNull();
  });

  it("claims the figure and asks together for a big project at Quality, from one set of facts", () => {
    const resolved = resolveChoice("quality", {}, B, TABLE);
    expect(resolved.kept).toEqual({});
    expect(resolved.shown).toEqual(QUALITY_OWN);
    expect(resolved.figure).toBe(4);
    expect(resolved.ask).toEqual({ kind: "a", figure: 4 });
  });

  it("follows the project: the same picks give other values once the project shrank", () => {
    const picks: Overrides = { resolution: "1440p", fps: 50 };
    expect(resolveChoice("quality", picks, B).shown).toEqual(levers("1440p", 50));
    const shrunk = resolveChoice("quality", picks, facts(1280, 720, 25));
    expect(shrunk.kept).toEqual({});
    expect(shrunk.shown).toEqual(QUALITY_OWN);
  });
});
