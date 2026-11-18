// A conformance guard: the Fast choice has no figure and no question in this build, and it stays that way until the question's screen is built.
//
// `QUICK_BUNDLE.speedup` feeds two things: the figure after the word Fast (`fastSpeedupLabel`) and the question "Are you sure?" (`needsSlowConfirm`, which asks only when a figure exists). The owner decided, for this
// build (decisions D2 and D3 of the build program): no figure on Fast, because the lab's rule for one (at least 80 % of the typical cells reach 1.5 times on the strong AND the weak lab PCs) is not met, and no
// question, because it would push people towards Fast exactly where Fast adds nothing (4K, 4K at 60, long edits). The question's screen (`SlowExportQuestion`: the focus trap, the answer shield, "Use Fast", the
// Escape rule) is NOT built. So the table is empty, and the two pure functions answer "no figure" and "never ask" for every input. If someone fills one row of the table to light the figure, the question would
// start asking at once through a screen that does not exist; this file fails first and says what has to be built.
//
// The guard retires itself in exactly one way: the question's screen exists AND is drawn by another source file. Then the table may be filled on purpose (and this file is replaced by the question's own tests).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  fastSpeedupLabel,
  needsSlowConfirm,
  QUICK_BUNDLE,
  type ChoiceSettings,
  type ProjectFacts,
  type QuickBundle,
} from "./exportRoute";

const QUESTION_COMPONENT = "SlowExportQuestion";
const COMPONENTS = path.resolve(__dirname, "..", "components");

/** Whether a source text draws the question's screen: it imports the component by its file name. A test file never counts (a test of the screen would exist before the screen is drawn). */
function importsQuestionScreen(text: string): boolean {
  return new RegExp(`from\\s+["']\\./${QUESTION_COMPONENT}["']`).test(text);
}

/** The question's screen exists when its file is in `src/components` and a source file there (not a test) imports it. */
function questionScreenIsDrawn(): boolean {
  const names = readdirSync(COMPONENTS);
  if (!names.includes(`${QUESTION_COMPONENT}.tsx`)) return false;
  return names
    .filter((name) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))
    .some((name) => importsQuestionScreen(readFileSync(path.join(COMPONENTS, name), "utf8")));
}

const WHY =
  "The question UI does not exist yet, so the table that feeds the figure and the question must stay empty (decision D3: no 'Are you sure?' question; decision D2: no speed figure on Fast until the lab's " +
  "rule is met). A row in QUICK_BUNDLE.speedup would light the question (needsSlowConfirm asks as soon as a figure exists) with no screen to ask it on. Build SlowExportQuestion first (spec D2-UI-SPEC section 3.7: " +
  "alertdialog, focus trap, 400 ms answer shield, Cancel / Export / Use Fast, Escape is Cancel) and draw it from ExportSettingsView; then fill the table on purpose and replace this file with the question's own tests.";

const drawn = questionScreenIsDrawn();

describe("while the question's screen is not built, the figure and the question stay off", () => {
  it.skipIf(drawn)("the lab's table is empty", () => {
    expect(QUICK_BUNDLE.speedup, WHY).toHaveLength(0);
  });

  it.skipIf(drawn)("the figure is never claimed, for any project the dialog can hold", () => {
    fc.assert(
      fc.property(facts(), (project) => {
        expect(fastSpeedupLabel(project), WHY).toBeNull();
      }),
      { numRuns: 1500 },
    );
  });

  it.skipIf(drawn)("the question never asks, for any choice, any settings and any project", () => {
    fc.assert(
      fc.property(facts(), choices(), (project, settings) => {
        expect(needsSlowConfirm(settings, project), WHY).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  // The guard must be able to see what it guards: the same big project and the same settings DO ask once a table has a row for the project, so the `false` above is the empty table's doing and not a
  // function that can no longer answer yes.
  it("has teeth: with one row in the table the same inputs would ask, and a figure would be claimed", () => {
    const filled: QuickBundle = {
      ...QUICK_BUNDLE,
      speedup: [{ shortSide: { min: 2160 }, figure: 4 }],
    };
    const big: ProjectFacts = { width: 3840, height: 2160, fps: 60, durationSeconds: 120 };
    const quality: ChoiceSettings = {
      route: "standard",
      resolution: "source",
      fps: null,
      explicit: { size: false, fps: false, quality: false },
    };
    expect(fastSpeedupLabel(big, filled)).toBe(4);
    expect(needsSlowConfirm(quality, big, filled)).toBe(true);
    expect(needsSlowConfirm(quality, big, QUICK_BUNDLE)).toBe(false);
  });

  it("sees whether the screen is drawn: only a non-test file that imports it counts", () => {
    expect(importsQuestionScreen(`import SlowExportQuestion from "./SlowExportQuestion";`)).toBe(
      true,
    );
    expect(importsQuestionScreen(`import X from './SlowExportQuestion'`)).toBe(true);
    expect(importsQuestionScreen(`import X from "./SlowExportQuestionBox";`)).toBe(false);
    expect(importsQuestionScreen(`// SlowExportQuestion is not built`)).toBe(false);
    expect(importsQuestionScreen(`import X from "./ExportQueuePane";`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Inputs: every project the dialog can hold, big ones included (every cut-off of `needsSlowConfirm` is crossed), and settings of both choices, with values the dialog could not send as well.

const side = fc.oneof(
  fc.integer({ min: 1, max: 16_384 }),
  fc.constantFrom(480, 720, 1080, 1440, 2160, 4320, 1081, 2161),
  fc.double({ min: 1, max: 9_000, noNaN: true }),
);
function facts(): fc.Arbitrary<ProjectFacts> {
  return fc.record({
    width: side,
    height: side,
    fps: fc.oneof(
      fc.constantFrom(24, 25, 29.97, 30, 48, 50, 59.94, 60, 120),
      fc.double({ min: 1, max: 240, noNaN: true }),
    ),
    durationSeconds: fc.oneof(
      fc.constantFrom(0, 30, 600, 601, 3600, 86_400),
      fc.double({ min: 0, max: 200_000, noNaN: true }),
    ),
  });
}

function choices(): fc.Arbitrary<ChoiceSettings> {
  return fc.record({
    route: fc.constantFrom<ChoiceSettings["route"]>("quick", "standard"),
    resolution: fc.constantFrom<ChoiceSettings["resolution"]>(
      "source",
      "2160p",
      "1440p",
      "1080p",
      "720p",
      "480p",
    ),
    fps: fc.oneof(
      fc.constant(null),
      fc.constantFrom(24, 25, 30, 50, 60, 120),
      fc.double({ min: 1, max: 240, noNaN: true }),
    ),
    explicit: fc.record({ size: fc.boolean(), fps: fc.boolean(), quality: fc.boolean() }),
  });
}
