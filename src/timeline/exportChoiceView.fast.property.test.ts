// Properties of the Quality | Fast view's pure model over every project and every value its lists can show: the line under the door (built from the values that are shown), the Frame rate list that offers Fast's own
// rate, and what is sent after the project changed under a pick. The oracle is written here from first principles and calls nothing of the product (no `quickSettings`, no `summaryFor`): the short sides
// of the size presets (2160, 1440, 1080, 720, 480), Fast's ladder (2160, 1080, 720, 480), the cap of 30 frames a second, a rate halved for as long as it stays whole, and the even sides the render works
// at. The first tests hold the oracle to the product on the quantities everything else leans on (what Fast starts on, what the lists offer), so a disagreement shows there and not behind a wrong line.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ownLevers,
  payloadFor,
  qualityEntries,
  rateEntries,
  rateEntriesFor,
  resolveChoice,
  sizeOptions,
  summaryFor,
  type Levers,
  type Overrides,
} from "./exportChoiceView";
import type { ExportQuality, ExportResolution } from "./exportOptions";
import type { ProjectFacts } from "./exportRoute";

// ---- the oracle: first principles, no call into the product ----

/** The size presets a person may pick, largest first, and the short side each one makes. */
const PRESETS: readonly (readonly [ExportResolution, number])[] = [
  ["2160p", 2160],
  ["1440p", 1440],
  ["1080p", 1080],
  ["720p", 720],
  ["480p", 480],
];
/** Fast's ladder, largest first: the sizes it may start on (1440p is a size to pick, never one Fast starts on). */
const FAST_LADDER: readonly (readonly [ExportResolution, number])[] = [
  ["2160p", 2160],
  ["1080p", 1080],
  ["720p", 720],
  ["480p", 480],
];
/** Fast never delivers more frames a second than this; the Frame rate list offers these rates below the project's own. */
const CAP = 30;
const RATE_LADDER = [60, 50, 30, 25, 24];
const QUALITIES: readonly ExportQuality[] = ["high", "medium", "low"];
const QUALITY_NAME: Record<ExportQuality, string> = { high: "High", medium: "Medium", low: "Low" };

/** The side the render works at: cut to a whole number, an odd side goes up to the next even number, never under 2. */
const evenSide = (side: number): number => 2 * Math.max(1, Math.ceil(Math.trunc(side) / 2));
/** The short side of the picture the render makes of a project. */
const shortSide = (f: ProjectFacts): number => Math.min(evenSide(f.width), evenSide(f.height));

/** What the Resolution list offers: the project's own size, then each preset whose short side is below the project's. */
const sizesOffered = (f: ProjectFacts | null): ExportResolution[] => {
  if (f === null) return ["source"];
  const short = shortSide(f);
  return ["source", ...PRESETS.filter(([, side]) => side < short).map(([name]) => name)];
};

/** The size one rung down: the largest rung of Fast's ladder below the project's short side, or null where there is none. */
const rungBelow = (f: ProjectFacts | null): ExportResolution | null => {
  if (f === null) return null;
  const short = shortSide(f);
  return FAST_LADDER.find(([, side]) => side < short)?.[0] ?? null;
};

/** The rate Fast delivers: the project's rate cut to a whole number, halved for as long as it is above 30 and stays whole, else 30; null where the rate is 30 or less already. */
const fastRate = (fps: number): number | null => {
  let rate = Math.trunc(fps);
  if (rate <= CAP) return null;
  while (rate > CAP) {
    if (rate % 2 !== 0) return CAP;
    rate /= 2;
  }
  return rate;
};

/** What Fast starts on. */
const fastOwn = (f: ProjectFacts | null): Levers => ({
  resolution: rungBelow(f) ?? "source",
  fps: f === null ? null : fastRate(f.fps),
  quality: "medium",
});

/** What the Frame rate list offers: the project's own rate, the ladder's rates below it and, where Fast is offered and has a lower rate, Fast's own; highest first. */
const ratesOffered = (f: ProjectFacts | null, fastOffered: boolean): (number | null)[] => {
  if (f === null) return [null];
  const project = f.fps;
  const rates = new Set(RATE_LADDER.filter((rate) => rate < project));
  const own = fastRate(project);
  if (fastOffered && own !== null) rates.add(own);
  return [null, ...[...rates].sort((a, b) => b - a)];
};

/** The three rules of the line under the door, each about the shown values and the project and about nothing else. */
const says = {
  projectSizeAndRate: (shown: Levers): boolean =>
    shown.resolution === "source" && shown.fps === null,
  oneSizeSmaller: (f: ProjectFacts, shown: Levers): boolean =>
    rungBelow(f) !== null && shown.resolution === rungBelow(f),
  upTo30: (f: ProjectFacts, shown: Levers): boolean =>
    f.fps > CAP && (shown.fps ?? Math.trunc(f.fps)) <= CAP,
};

/** A word about the encoder, the graphics chip or the compression: the line says none (the app decides the encoder when the export starts). */
const FORBIDDEN = /compression|chip|graphics|processor|faster|quick|full/i;

/** What a person reading the line can tell: its clauses in order, how it starts and ends, a word about the encoder, and every number in it. */
interface LineReading {
  clauses: string[];
  startsWithCapital: boolean;
  oneFinalFullStop: boolean;
  aWordAboutTheEncoder: boolean;
  numbers: string[];
}
const readLine = (line: string): LineReading => ({
  clauses: line
    .slice(0, -1)
    .split(", ")
    .map((clause) =>
      /^project size and frame rate$/i.test(clause)
        ? "own"
        : /^one size smaller$/i.test(clause)
          ? "smaller"
          : /^up to 30 frames a second$/i.test(clause)
            ? "cap"
            : /^(High|Medium|Low) quality$/.test(clause)
              ? clause
              : `other: ${clause}`,
    ),
  startsWithCapital: /^[A-Z]/.test(line),
  oneFinalFullStop: line.endsWith(".") && line.indexOf(".") === line.length - 1,
  aWordAboutTheEncoder: FORBIDDEN.test(line),
  numbers: line.match(/\d+/g) ?? [],
});

/** What the line must read as for these shown values, by the rules above. The clauses come in a fixed order and the shown quality's name is always the last. */
const expectedReading = (f: ProjectFacts, shown: Levers): LineReading => ({
  clauses: [
    ...(says.projectSizeAndRate(shown) ? ["own"] : []),
    ...(says.oneSizeSmaller(f, shown) ? ["smaller"] : []),
    ...(says.upTo30(f, shown) ? ["cap"] : []),
    `${QUALITY_NAME[shown.quality]} quality`,
  ],
  startsWithCapital: true,
  oneFinalFullStop: true,
  aWordAboutTheEncoder: false,
  numbers: says.upTo30(f, shown) ? ["30"] : [],
});

const whereOf = (f: ProjectFacts, shown: Levers): string =>
  `${f.width} x ${f.height} at ${f.fps} fps, shown ${JSON.stringify(shown)}`;

/** Every rule of the line for one project and one set of shown values. */
function checkLine(f: ProjectFacts, shown: Levers): void {
  expect(readLine(summaryFor(shown, f)), whereOf(f, shown)).toEqual(expectedReading(f, shown));
}

/** Every shown value the lists of a dialog that offers Fast can give for a project: each size of the Resolution list, each rate of the Frame rate list (Fast's own among them), each quality. */
const everyShown = (f: ProjectFacts): Levers[] => {
  const rates = rateEntriesFor(f, true).map((entry) => entry.value);
  const qualities = qualityEntries().map((entry) => entry.value);
  return sizeOptions(f).flatMap((resolution) =>
    rates.flatMap((fps) => qualities.map((quality) => ({ resolution, fps, quality }))),
  );
};

// ---- the generators ----

/** Sides with weight on the lines of the ladder (each rung and one either side of it, odd and even), and very small ones. */
const EDGE_SIDES = [
  479, 480, 481, 482, 719, 720, 721, 722, 1079, 1080, 1081, 1082, 1439, 1440, 1441, 2159, 2160,
  2161, 2162, 4319, 4320,
];
const side = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 2, max: 9000 }) },
  { weight: 4, arbitrary: fc.constantFrom(...EDGE_SIDES) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 16 }) },
);
/** The canvases of table 3.1, vertical and odd ones among them. */
const SPEC_CANVASES: [number, number][] = [
  [1080, 1920],
  [3840, 2160],
  [2560, 1440],
  [1280, 720],
  [854, 480],
  [1920, 1080],
  [7680, 4320],
  [2160, 3840],
  [4096, 2160],
  [1081, 1921],
  [1079, 1919],
  [2, 2],
];
const canvas = fc.oneof(
  { weight: 4, arbitrary: fc.record({ width: side, height: side }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(...SPEC_CANVASES).map(([width, height]) => ({ width, height })),
  },
);
/** Rates from 24 to 120 whole, the NTSC ones, two just above 30, any in between, and a few below 24. */
const rate = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 24, max: 120 }) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(23.976, 29.97, 30.5, 30.9, 47.952, 59.94, 119.88),
  },
  { weight: 1, arbitrary: fc.double({ min: 24, max: 120, noNaN: true }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 23 }) },
);
const duration = fc.oneof(
  fc.constantFrom(0, 1, 360, 600, 601, 720, 7200),
  fc.integer({ min: 0, max: 7200 }),
);
const project: fc.Arbitrary<ProjectFacts> = fc
  .tuple(canvas, rate, duration)
  .map(([size, fps, durationSeconds]) => ({ ...size, fps, durationSeconds }));
/** Mostly a project, now and then none (the dialog before a project is open). */
const maybeProject: fc.Arbitrary<ProjectFacts | null> = fc.oneof(
  { weight: 12, arbitrary: project },
  { weight: 1, arbitrary: fc.constant(null) },
);
const qualityValue = fc.constantFrom(...QUALITIES);
const resolutionValue = fc.constantFrom<ExportResolution>(
  "source",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
);

describe("the oracle holds the product to what everything below leans on", () => {
  it("starts Fast on the largest rung of its ladder below the short side, on the halved rate and on Medium", () => {
    fc.assert(
      fc.property(maybeProject, (f) => {
        expect(ownLevers("fast", f), JSON.stringify(f)).toEqual(fastOwn(f));
      }),
      { numRuns: 3000 },
    );
  });

  it("offers the project's own size and then the presets whose short side is below it, largest first", () => {
    fc.assert(
      fc.property(maybeProject, (f) => {
        expect(sizeOptions(f), JSON.stringify(f)).toEqual(sizesOffered(f));
      }),
      { numRuns: 3000 },
    );
  });

  it("offers the project's own rate, the ladder's rates below it and, where Fast is offered, Fast's own rate, highest first", () => {
    fc.assert(
      fc.property(maybeProject, (f) => {
        const withFast = rateEntriesFor(f, true).map((entry) => entry.value);
        expect(withFast, JSON.stringify(f)).toEqual(ratesOffered(f, true));
        expect(rateEntriesFor(f, false).map((entry) => entry.value)).toEqual(
          ratesOffered(f, false),
        );
      }),
      { numRuns: 3000 },
    );
  });
});

describe("rateEntriesFor: the Frame rate list of a dialog that offers Fast", () => {
  it("holds Fast's own rate whenever that is a number, and never a rate at or above the project's", () => {
    fc.assert(
      fc.property(project, (f) => {
        const values = rateEntriesFor(f, true).map((entry) => entry.value);
        const own = ownLevers("fast", f).fps;
        if (own !== null) expect(values, JSON.stringify(f)).toContain(own);
        expect(values[0]).toBeNull();
        const numbers = values.slice(1) as number[];
        for (const value of numbers) expect(value, JSON.stringify(f)).toBeLessThan(f.fps);
        // highest first, each once
        expect(numbers, JSON.stringify(f)).toEqual([...new Set(numbers)].sort((a, b) => b - a));
      }),
      { numRuns: 3000 },
    );
  });

  it("is exactly the list of a dialog without Fast where Fast is not offered", () => {
    fc.assert(
      fc.property(maybeProject, (f) => {
        expect(rateEntriesFor(f, false), JSON.stringify(f)).toEqual(rateEntries(f));
      }),
      { numRuns: 3000 },
    );
  });

  it("adds only what Fast offers: the list with Fast holds the list without it, and at most one rate more", () => {
    fc.assert(
      fc.property(project, (f) => {
        const without = rateEntriesFor(f, false).map((entry) => entry.value);
        const withFast = rateEntriesFor(f, true).map((entry) => entry.value);
        expect(withFast, JSON.stringify(f)).toEqual(expect.arrayContaining(without));
        expect(withFast.length - without.length, JSON.stringify(f)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 3000 },
    );
  });

  it("names the project's rate as it is (whole, or at most two decimals) and every other entry as N fps", () => {
    fc.assert(
      fc.property(project, (f) => {
        const entries = rateEntriesFor(f, true);
        const first = /^Same as project \((\d+(?:\.\d{1,2})?) fps\)$/.exec(entries[0]?.label ?? "");
        expect(first, JSON.stringify(f)).not.toBeNull();
        expect(Math.abs(Number(first?.[1]) - f.fps)).toBeLessThanOrEqual(0.005 + 1e-9);
        for (const entry of entries.slice(1)) expect(entry.label).toBe(`${entry.value} fps`);
      }),
      { numRuns: 3000 },
    );
  });
});

describe("summaryFor over every project and every shown value the lists offer", () => {
  it("holds every rule of the line for every size, every rate (Fast's own among them) and every quality of the lists", () => {
    fc.assert(
      fc.property(project, (f) => {
        const all = everyShown(f);
        // not an empty sweep: at least one size, one rate and the three qualities
        expect(all.length).toBeGreaterThanOrEqual(3);
        for (const shown of all) checkLine(f, shown);
      }),
      { numRuns: 400 },
    );
  });

  it("holds the same rules for any size and any whole rate, in the lists or not", () => {
    const anyShown: fc.Arbitrary<Levers> = fc.record({
      resolution: resolutionValue,
      fps: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 120 })),
      quality: qualityValue,
    });
    fc.assert(
      fc.property(project, anyShown, (f, shown) => {
        checkLine(f, shown);
      }),
      { numRuns: 3000 },
    );
  });

  it("says 'Project size and frame rate, Medium quality.' for Quality's own values on every project (bar a rate just above 30, which the whole number cuts to 30)", () => {
    const ordinary = project.filter((f) => !(f.fps > CAP && Math.trunc(f.fps) <= CAP));
    fc.assert(
      fc.property(ordinary, (f) => {
        const own: Levers = { resolution: "source", fps: null, quality: "medium" };
        expect(summaryFor(own, f), JSON.stringify(f)).toBe(
          "Project size and frame rate, Medium quality.",
        );
      }),
      { numRuns: 3000 },
    );
  });

  it("is empty for no project and never empty for one, whatever is shown", () => {
    fc.assert(
      fc.property(
        fc.record({ resolution: resolutionValue, fps: fc.constant(null), quality: qualityValue }),
        project,
        (shown, f) => {
          expect(summaryFor(shown, null)).toBe("");
          expect(summaryFor(shown, f), JSON.stringify(f)).not.toBe("");
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("does not depend on the project's length: it names no time", () => {
    fc.assert(
      fc.property(project, fc.integer({ min: 0, max: 100000 }), (f, seconds) => {
        for (const shown of everyShown(f))
          expect(summaryFor(shown, { ...f, durationSeconds: seconds }), whereOf(f, shown)).toBe(
            summaryFor(shown, f),
          );
      }),
      { numRuns: 100 },
    );
  });

  it("is written for projects of every shape: the generators reach every kind of line", () => {
    // a guard against a generator that stopped producing the cases the properties are about
    const kinds = new Set<string>();
    for (const f of fc.sample(project, { numRuns: 400, seed: 7 }))
      for (const shown of everyShown(f))
        kinds.add(readLine(summaryFor(shown, f)).clauses.join("+"));
    expect([...kinds]).toEqual(
      expect.arrayContaining([
        "own+Medium quality",
        "smaller+Medium quality",
        "cap+Medium quality",
        "smaller+cap+Medium quality",
        "High quality",
        "Low quality",
      ]),
    );
  });
});

describe("what is sent after the project changed under a pick (resolveChoice, payloadFor)", () => {
  /** The picks a person can have made on a project, from the lists it offered (Fast offered): some levers, each one entry of its list. */
  const picksOn = (f: ProjectFacts | null): fc.Arbitrary<Overrides> =>
    fc.record(
      {
        resolution: fc.constantFrom(...sizesOffered(f)),
        fps: fc.constantFrom(...ratesOffered(f, true)),
        quality: qualityValue,
      },
      { requiredKeys: [] },
    );
  const changed = fc
    .tuple(maybeProject, maybeProject)
    .chain(([before, after]) => picksOn(before).map((picks) => ({ before, after, picks })));

  /** What the project holds of a pick, by the rules of the lists: a size in the list, a rate that is the project's own or from 1 up to its rate, any quality of the three. */
  const holds = (picks: Overrides, f: ProjectFacts | null) => ({
    size: picks.resolution !== undefined && sizesOffered(f).includes(picks.resolution),
    fps:
      picks.fps !== undefined &&
      (picks.fps === null || (f !== null && picks.fps >= 1 && picks.fps < f.fps)),
    quality: picks.quality !== undefined,
  });

  it("names as explicit exactly the picks the changed project still holds, and sends Fast's own value for each of the others", () => {
    fc.assert(
      fc.property(changed, ({ after, picks }) => {
        const resolved = resolveChoice("fast", picks, after);
        const kept = holds(picks, after);
        const own = fastOwn(after);
        const sent = payloadFor("fast", resolved.shown, resolved.kept, null);
        const where = JSON.stringify({ after, picks });
        expect(sent.route, where).toEqual({
          route: "quick",
          explicit: { size: kept.size, fps: kept.fps, quality: kept.quality },
        });
        expect(sent.resolution, where).toBe(kept.size ? picks.resolution : own.resolution);
        expect(sent.fps, where).toBe(kept.fps ? picks.fps : own.fps);
        expect(sent.quality, where).toBe(kept.quality ? picks.quality : own.quality);
        expect(sent.mode).toBeNull();
      }),
      { numRuns: 3000 },
    );
  });

  it("sends Quality's own value for each pick the changed project dropped, and no route", () => {
    fc.assert(
      fc.property(changed, fc.constantFrom("quality" as const, null), ({ after, picks }, mode) => {
        const resolved = resolveChoice("quality", picks, after);
        const kept = holds(picks, after);
        const sent = payloadFor("quality", resolved.shown, resolved.kept, mode);
        const where = JSON.stringify({ after, picks });
        expect("route" in sent, where).toBe(false);
        expect(sent.mode).toBe(mode);
        expect(sent.resolution, where).toBe(kept.size ? picks.resolution : "source");
        expect(sent.fps, where).toBe(kept.fps ? picks.fps : null);
        expect(sent.quality, where).toBe(kept.quality ? picks.quality : "medium");
      }),
      { numRuns: 3000 },
    );
  });

  it("sends the same after the snap writes the kept picks back: a second pass over what was kept changes nothing", () => {
    fc.assert(
      fc.property(changed, ({ after, picks }) => {
        const first = resolveChoice("fast", picks, after);
        const again = resolveChoice("fast", first.kept, after);
        expect(
          payloadFor("fast", again.shown, again.kept, null),
          JSON.stringify({ after, picks }),
        ).toStrictEqual(payloadFor("fast", first.shown, first.kept, null));
      }),
      { numRuns: 2000 },
    );
  });

  it("never sends a size at or above the project's, or a rate at or above its rate, as a pick", () => {
    fc.assert(
      fc.property(changed, ({ after, picks }) => {
        const resolved = resolveChoice("fast", picks, after);
        const sent = payloadFor("fast", resolved.shown, resolved.kept, null);
        const where = JSON.stringify({ after, picks });
        expect(sent.route?.explicit, where).toBeDefined();
        if (sent.route?.explicit?.size) expect(sizesOffered(after), where).toContain(sent.resolution);
        if (sent.route?.explicit?.fps && typeof sent.fps === "number") {
          expect(after, where).not.toBeNull();
          expect(sent.fps).toBeLessThan((after as ProjectFacts).fps);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
