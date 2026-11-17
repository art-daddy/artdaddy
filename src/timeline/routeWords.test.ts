import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PC_CLASSES, QUICK_OFFERS } from "./exportTypes3c";
import * as routeWords from "./routeWords";
import {
  ASSISTANT_SLOW_NOTE,
  ASSISTANT_SWITCHED_NOTE,
  BANNER_BUTTON_LABELS,
  KEEP_GOING_LAST_NOTE,
  KEEP_GOING_NOTE,
  SWITCHING_NOTE,
  describeCheckQuestion,
  describeFullRow,
  describePicture,
  describeQuickCardLine,
  describeQuickNotOffered,
  describeQuickRow,
  describeQuickSelected,
  describeQuietBanner,
  describeRouteQuestion,
  describeSlowBanner,
  describeSwitchedToQuick,
  describeTimesFrom,
  type QuickRowInput,
  type RouteQuestionInput,
} from "./routeWords";

const full = {
  seconds: 1260,
  bytes: null,
  picture: "1080p",
  fps: 30,
  quality: "medium" as const,
};
const quickRow: QuickRowInput = {
  seconds: 540,
  bytes: null,
  picture: "720p",
  fps: 30,
  encoder: "chip",
  changedSize: true,
  changedFps: true,
};

describe("the Export dialog's two choices: the owner's copy, with the facts' own numbers", () => {
  it("describes Full quality on the processor's normal setting, on the chip and on the faster setting", () => {
    expect(describeFullRow({ ...full, route: "processor" })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · the smallest file for this quality · about 21 min",
    );
    expect(describeFullRow({ ...full, route: "chip", seconds: 900 })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · uses your graphics chip · the file is usually larger · about 15 min",
    );
    expect(describeFullRow({ ...full, route: "faster", seconds: 600 })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · a faster setting · the picture may be slightly softer · about 10 min",
    );
  });

  it("says the size of a file once this PC has run it, in place of what is usually so", () => {
    expect(describeFullRow({ ...full, route: "chip", seconds: 900, bytes: 600e6 })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · uses your graphics chip · a file of about 600 MB · about 15 min",
    );
    expect(describeFullRow({ ...full, route: "processor", bytes: 480e6 })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · a file of about 480 MB · about 21 min",
    );
    // The faster setting keeps its caveat about the picture next to a measured size: the size does not answer it.
    expect(describeFullRow({ ...full, route: "faster", seconds: 600, bytes: 300e6 })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · a faster setting · the picture may be slightly softer · a file of about 300 MB · about 10 min",
    );
  });

  it("names the tier and the rate as the dialog shows them, and leaves out what it does not know", () => {
    expect(describeFullRow({ ...full, route: "processor", quality: "high", fps: 29.97 })).toContain(
      "(1080p · 29.97 fps · High)",
    );
    expect(describeFullRow({ ...full, route: "processor", quality: "low", fps: null })).toContain(
      "(1080p · Low)",
    );
    expect(describeFullRow({ ...full, route: "processor", seconds: null })).toBe(
      "Your settings above (1080p · 30 fps · Medium) · the smallest file for this quality",
    );
  });

  it("describes Quick: its picture and rate, what it encodes with, a smaller file, and the time", () => {
    expect(describeQuickRow(quickRow)).toBe(
      "720p · 30 fps · graphics chip · a smaller file · about 9 min",
    );
    expect(describeQuickRow({ ...quickRow, encoder: "faster" })).toBe(
      "720p · 30 fps · faster setting · a smaller file · about 9 min",
    );
    expect(describeQuickRow({ ...quickRow, encoder: "processor" })).toBe(
      "720p · 30 fps · a smaller file · about 9 min",
    );
    expect(describeQuickRow({ ...quickRow, bytes: 250e6 })).toBe(
      "720p · 30 fps · graphics chip · a file of about 250 MB · about 9 min",
    );
  });

  it("does not call Quick's file smaller where it made neither the picture nor the rate smaller", () => {
    const kept = { ...quickRow, changedSize: false, changedFps: false };
    expect(describeQuickRow({ ...kept, encoder: "chip" })).toContain("the file is usually larger");
    expect(describeQuickRow({ ...kept, encoder: "chip" })).not.toContain("smaller");
    expect(describeQuickRow({ ...kept, encoder: "faster" })).toContain(
      "the picture may be slightly softer",
    );
    expect(describeQuickRow({ ...kept, encoder: "faster" })).not.toContain("smaller");
    // Either one is enough to make it smaller.
    expect(describeQuickRow({ ...quickRow, changedFps: false })).toContain("a smaller file");
    expect(describeQuickRow({ ...quickRow, changedSize: false })).toContain("a smaller file");
  });

  it("explains why Quick is selected on a slow PC, what it costs and the way back", () => {
    expect(
      describeQuickSelected({ pcClass: "weak", plainTimes: 9, picture: "720p", changedSize: true }),
    ).toBe(
      "Quick is selected because this PC is slower than most (a plain video takes about 9 times its length here). The picture is smaller (720p) and can look slightly softer. Choose Full quality to keep your settings.",
    );
    expect(
      describeQuickSelected({
        pcClass: "unfinished",
        plainTimes: null,
        picture: "720p",
        changedSize: true,
      }),
    ).toBe(
      "Quick is selected because this PC could not finish its speed check, so ArtDaddy treats it as slower than most. The picture is smaller (720p) and can look slightly softer. Choose Full quality to keep your settings.",
    );
  });

  it("does not say the picture is smaller where Quick left it as it was, and says nothing where Quick is not preselected", () => {
    expect(
      describeQuickSelected({
        pcClass: "weak",
        plainTimes: 9,
        picture: "720p",
        changedSize: false,
      }),
    ).toBe(
      "Quick is selected because this PC is slower than most (a plain video takes about 9 times its length here). The picture can look slightly softer. Choose Full quality to keep your settings.",
    );
    // A pace that is not known is left out rather than guessed.
    for (const plainTimes of [null, Number.NaN, 0, -3, Number.POSITIVE_INFINITY])
      expect(
        describeQuickSelected({ pcClass: "weak", plainTimes, picture: "720p", changedSize: true }),
      ).toBe(
        "Quick is selected because this PC is slower than most. The picture is smaller (720p) and can look slightly softer. Choose Full quality to keep your settings.",
      );
    for (const pcClass of PC_CLASSES.filter((c) => c !== "weak" && c !== "unfinished"))
      expect(
        describeQuickSelected({ pcClass, plainTimes: 9, picture: "720p", changedSize: true }),
      ).toBeNull();
    // 8.6 times its length is said as 9: a whole number, never a fraction.
    expect(
      describeQuickSelected({
        pcClass: "weak",
        plainTimes: 8.6,
        picture: "720p",
        changedSize: true,
      }),
    ).toContain("about 9 times");
  });

  it("says why Quick is not on offer and what to lower, where there is something true to say", () => {
    expect(describeQuickNotOffered("small_gain")).toBe(
      "Quick export would not be much faster for this project: most of the time goes to reading and drawing your clips. To go faster, shorten the video or use fewer layers or clips.",
    );
    expect(describeQuickNotOffered("explicit")).toBe(
      "Quick export keeps the size and frame rate you chose, so it would not be much faster here.",
    );
    for (const reason of QUICK_OFFERS.filter((r) => r !== "small_gain" && r !== "explicit"))
      expect(describeQuickNotOffered(reason)).toBeNull();
    expect(describeQuickNotOffered("weird" as never)).toBeNull();
  });

  it("says where the times come from, and what a Quick export is on the card", () => {
    expect(describeTimesFrom("today")).toBe(
      "Times are from a quick check of this PC's speed, made today.",
    );
    expect(describeTimesFrom("")).toBe("Times are from a quick check of this PC's speed.");
    expect(describeQuickCardLine({ picture: "720p", fps: 30, changedSize: true })).toBe(
      "Quick export · 720p · 30 fps · the picture is smaller and may look slightly softer",
    );
    expect(describeQuickCardLine({ picture: "720p", fps: 24, changedSize: false })).toBe(
      "Quick export · 720p · 24 fps · the picture may look slightly softer",
    );
  });

  it("labels a picture by its short side, the way the dialog names a resolution", () => {
    expect(describePicture(1280, 720)).toBe("720p");
    expect(describePicture(1920, 1080)).toBe("1080p");
    expect(describePicture(1080, 1920)).toBe("1080p");
    expect(describePicture(1366, 768)).toBe("768p");
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY])
      expect(describePicture(bad, 1080)).toBe("");
  });
});

describe("the slow banner: the owner's copy", () => {
  it("says it is slower than expected, what was expected, and what Quick would do", () => {
    expect(
      describeSlowBanner({
        leftSeconds: 3360,
        expectedSeconds: 1260,
        quickSeconds: 540,
        quick: "helps",
      }),
    ).toEqual([
      "This PC is slower than expected: about 56 min left",
      "It was expected to take about 21 min.",
      "Quick export would take about 9 min, starting over.",
    ]);
  });

  it("says Quick would not help, and what to do instead", () => {
    expect(
      describeSlowBanner({
        leftSeconds: 6120,
        expectedSeconds: 1260,
        quickSeconds: 4000,
        quick: "no_help",
      }),
    ).toEqual([
      "This PC is slower than expected: about 1 h 42 min left",
      "It was expected to take about 21 min.",
      "Quick export would not be much faster than what is left. To go faster, cancel, use fewer layers or clips, and export again.",
    ]);
  });

  it("says only how to go faster where there is no Quick to speak of, and leaves out an estimate that was never shown", () => {
    expect(
      describeSlowBanner({
        leftSeconds: 3000,
        expectedSeconds: null,
        quickSeconds: null,
        quick: "none",
      }),
    ).toEqual([
      "This PC is slower than expected: about 50 min left",
      "To go faster, cancel, use fewer layers or clips, and export again.",
    ]);
  });

  it("says it has stopped moving, for how long, and what ArtDaddy will do about it", () => {
    expect(
      describeQuietBanner({ quietSeconds: 75, quickSeconds: 540, quick: "helps", idle: true }),
    ).toEqual([
      "This export has stopped moving",
      "No progress for 75 s.",
      "Quick export would take about 9 min, starting over.",
      "ArtDaddy stops it if nothing moves for 3 minutes.",
    ]);
    expect(
      describeQuietBanner({ quietSeconds: 75, quickSeconds: 540, quick: "helps", idle: false }),
    ).toEqual([
      "This export has stopped moving",
      "No progress for 75 s.",
      "Quick export would take about 9 min, starting over.",
    ]);
    // Counted as the card counts a silence: seconds under two minutes, minutes after.
    expect(
      describeQuietBanner({ quietSeconds: 119, quickSeconds: null, quick: "none", idle: false })[1],
    ).toBe("No progress for 119 s.");
    expect(
      describeQuietBanner({ quietSeconds: 300, quickSeconds: null, quick: "none", idle: false })[1],
    ).toBe("No progress for 5 min.");
    // It speaks of Quick only where Quick helps.
    expect(
      describeQuietBanner({ quietSeconds: 75, quickSeconds: 540, quick: "no_help", idle: false }),
    ).toEqual(["This export has stopped moving", "No progress for 75 s."]);
  });

  it("keeps the buttons' labels, the notes after a click and the lines for the assistant and the restarted card as the copy has them", () => {
    expect(BANNER_BUTTON_LABELS).toEqual({
      switch_to_quick: "Switch to Quick export",
      keep_going: "Keep going",
      cancel: "Cancel",
    });
    expect(KEEP_GOING_NOTE).toBe(
      "Keeping going. ArtDaddy will tell you again if it gets much slower.",
    );
    // once the second slow banner has been answered no third can come: the line must not promise one
    expect(KEEP_GOING_LAST_NOTE).toBe(
      "Keeping going. The slow-export notice will not come back for this export.",
    );
    expect(KEEP_GOING_LAST_NOTE).not.toMatch(/will tell you again/);
    expect(SWITCHING_NOTE).toBe("Switching to Quick export. The export starts again.");
    expect(ASSISTANT_SLOW_NOTE).toBe(
      "This export is running slower than expected. Tell the person how long is left and, if quick_available is true, that Switch to Quick export is on the card. Do not cancel it and start another.",
    );
    expect(ASSISTANT_SWITCHED_NOTE).toBe(
      "The person switched this export to Quick export (a smaller picture and a lower frame rate), so it started again. It is the same export (same job_id): do not start another.",
    );
    expect(describeSwitchedToQuick(540)).toBe(
      "Started again as a Quick export because this PC is slower than expected. It will take about 9 min.",
    );
    expect(describeSwitchedToQuick(null)).toBe(
      "Started again as a Quick export because this PC is slower than expected.",
    );
  });
});

const question: RouteQuestionInput = {
  pcClass: "weak",
  plainTimes: 9,
  selected: "quick",
  full: { seconds: 1260, bytes: null, route: "processor" },
  quick: quickRow,
};

describe("the chat card's two questions: the owner's copy", () => {
  it("asks Full quality or Quick on a slow PC, with both times and files, and Quick as the primary button", () => {
    expect(describeRouteQuestion(question)).toEqual({
      code: "b5",
      title: "Export at full quality or Quick?",
      lines: [
        "This PC is slower than most: a plain video takes about 9 times its length here.",
        "Full quality about 21 min, the smallest file · Quick about 9 min, 720p, 30 fps, a smaller file",
        "Quick makes the picture smaller and the frame rate lower. Full quality keeps your settings.",
      ],
      ways: {
        full: "Full quality about 21 min, the smallest file",
        quick: "Quick about 9 min, 720p, 30 fps, a smaller file",
      },
      buttons: [
        { answer: "quick", label: "Quick export", primary: true },
        { answer: "continue", label: "Full quality", primary: false },
        { answer: "cancel", label: "Cancel", primary: false },
      ],
    });
  });

  it("on a PC that is not slow says how long the export is expected to take, and makes Full quality the primary button", () => {
    const view = describeRouteQuestion({ ...question, pcClass: "ok", selected: "standard" });
    expect(view.lines[0]).toBe("This export is expected to take about 21 min.");
    expect(view.buttons).toEqual([
      { answer: "quick", label: "Quick export", primary: false },
      { answer: "continue", label: "Full quality", primary: true },
      { answer: "cancel", label: "Cancel", primary: false },
    ]);
  });

  it("says the file words of the way Full quality will really run", () => {
    const wayOf = (route: "processor" | "chip" | "faster", bytes: number | null = null) =>
      describeRouteQuestion({ ...question, full: { seconds: 900, bytes, route } }).ways.full;
    expect(wayOf("processor")).toBe("Full quality about 15 min, the smallest file");
    expect(wayOf("chip")).toBe("Full quality about 15 min, usually a larger file");
    expect(wayOf("faster")).toBe("Full quality about 15 min, the picture may be slightly softer");
    expect(wayOf("chip", 600e6)).toBe("Full quality about 15 min, a file of about 600 MB");
    expect(wayOf("faster", 300e6)).toBe(
      "Full quality about 15 min, the picture may be slightly softer, a file of about 300 MB",
    );
  });

  it("falls back to the processor's file words for a route that is not one of the three, and for every name that objects inherit", () => {
    const fallback = "Full quality about 15 min, the smallest file";
    const wayOf = (route: unknown) =>
      describeRouteQuestion({
        ...question,
        full: { seconds: 900, bytes: null, route: route as never },
      }).ways.full;
    // a lookup that reads the prototype chain answers these with a function or an object, which is not a fallback
    for (const inherited of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ])
      expect(wayOf(inherited), inherited).toBe(fallback);
    for (const odd of [undefined, null, 7, "", "Processor", "processor ", {}, []])
      expect(wayOf(odd), String(odd)).toBe(fallback);
    expect(wayOf("processor")).toBe(fallback);
    expect(wayOf("chip")).toBe("Full quality about 15 min, usually a larger file");
    expect(wayOf("faster")).toBe("Full quality about 15 min, the picture may be slightly softer");
  });

  it("says why it asks on a PC whose check did not finish, and what Quick changes where it changes only one thing", () => {
    expect(describeRouteQuestion({ ...question, pcClass: "unfinished" }).lines[0]).toBe(
      "This PC could not finish its speed check, so ArtDaddy treats it as slower than most.",
    );
    expect(describeRouteQuestion({ ...question, plainTimes: null }).lines[0]).toBe(
      "This PC is slower than most.",
    );
    const note = (changedSize: boolean, changedFps: boolean) =>
      describeRouteQuestion({
        ...question,
        quick: { ...quickRow, changedSize, changedFps },
      }).lines.at(-1);
    expect(note(true, false)).toBe(
      "Quick makes the picture smaller. Full quality keeps your settings.",
    );
    expect(note(false, true)).toBe(
      "Quick makes the frame rate lower. Full quality keeps your settings.",
    );
    expect(note(false, false)).toBe(
      "Quick keeps your size and frame rate and uses a faster way to encode.",
    );
  });

  it("asks to check this PC first: the card's lines, the dialog's longer ones, the buttons and the quiet link", () => {
    const view = describeCheckQuestion({ what: "10 minutes with 41 stills", roughSeconds: 480 });
    expect(view).toEqual({
      code: "b4",
      title: "Check this PC's speed first?",
      cardLines: [
        "This project is big (10 minutes with 41 stills) and nothing like it has been exported on this PC yet.",
        "Without the check a rough guess: about 8 min, which can be far off",
        "With the check a measured time, in about 10 seconds",
      ],
      dialogLines: [
        "This project is big (10 minutes with 41 stills) and nothing like it has been exported on this PC yet.",
        "A 10-second check tells ArtDaddy how fast this PC is, so the time it shows is not a guess.",
        "Without the check a rough guess: about 8 min, which can be far off",
        "With the check a measured time, in about 10 seconds",
        "Your PC may feel slow for those 10 seconds. Nothing starts until you answer.",
      ],
      buttons: [
        { answer: "cancel", label: "Cancel", primary: false },
        { answer: "continue", label: "Check this PC", primary: true },
      ],
      quietLink: {
        answer: "start_anyway",
        label: "Rather not wait? Start without checking",
        primary: false,
      },
    });
  });

  it("leaves out the guess it cannot give and the project it cannot describe, and still asks", () => {
    const view = describeCheckQuestion({ what: "  ", roughSeconds: null });
    expect(view.cardLines[0]).toBe(
      "This project is big and nothing like it has been exported on this PC yet.",
    );
    expect(view.cardLines[1]).toBe("Without the check a rough guess, which can be far off");
    expect(view.buttons.map((button) => button.label)).toEqual(["Cancel", "Check this PC"]);
  });
});

const secondsArb = fc.oneof(
  fc.integer({ min: 0, max: 400_000 }),
  fc.constantFrom(null, Number.NaN, Number.POSITIVE_INFINITY, -1, 44, 45, 3600),
);
const bytesArb = fc.oneof(fc.integer({ min: 0, max: 3e10 }), fc.constantFrom(null, Number.NaN, -1));
const pictureArb = fc.constantFrom("", "720p", "1080p", "480p");
const fpsArb = fc.oneof(
  fc.constantFrom(null, Number.NaN, 0, -1, 24, 25, 29.97, 30, 60),
  fc.integer({ min: 1, max: 120 }),
);
const quickRowArb: fc.Arbitrary<QuickRowInput> = fc.record({
  seconds: secondsArb,
  bytes: bytesArb,
  picture: pictureArb,
  fps: fpsArb,
  encoder: fc.constantFrom("chip" as const, "faster" as const, "processor" as const),
  changedSize: fc.boolean(),
  changedFps: fc.boolean(),
});
const questionArb: fc.Arbitrary<RouteQuestionInput> = fc.record({
  pcClass: fc.constantFrom(...PC_CLASSES),
  plainTimes: fc.oneof(
    fc.double({ min: 0.1, max: 400, noNaN: true }),
    fc.constantFrom(null, Number.NaN, 0),
  ),
  selected: fc.constantFrom("quick" as const, "standard" as const),
  full: fc.record({
    seconds: secondsArb,
    bytes: bytesArb,
    route: fc.constantFrom("processor" as const, "chip" as const, "faster" as const),
  }),
  quick: quickRowArb,
});

describe("the questions: over every combination", () => {
  it("always has exactly one primary button, the selected way's, and its answers are the ones the question host knows", () => {
    fc.assert(
      fc.property(questionArb, (input) => {
        const view = describeRouteQuestion(input);
        expect(view.buttons.filter((button) => button.primary)).toHaveLength(1);
        expect(view.buttons.find((button) => button.primary)?.answer).toBe(
          input.selected === "quick" ? "quick" : "continue",
        );
        expect(view.buttons.map((button) => button.answer)).toEqual([
          "quick",
          "continue",
          "cancel",
        ]);
        expect(view.ways.full.startsWith("Full quality")).toBe(true);
        expect(view.ways.quick.startsWith("Quick")).toBe(true);
        expect(view.lines).toContain(`${view.ways.full} · ${view.ways.quick}`);
      }),
      { numRuns: 1500 },
    );
  });

  it("says each way's time exactly when it has one, and never a time that is not one", () => {
    fc.assert(
      fc.property(questionArb, (input) => {
        const view = describeRouteQuestion(input);
        const timed = (seconds: number | null) =>
          typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
        expect(/^Full quality (about|under)/.test(view.ways.full)).toBe(timed(input.full.seconds));
        expect(/^Quick (about|under)/.test(view.ways.quick)).toBe(timed(input.quick.seconds));
      }),
      { numRuns: 1500 },
    );
  });

  it("does not throw on input that is not input, and still has a title and the buttons", () => {
    for (const junk of [undefined, null, 0, "x", [], {}, { full: null }]) {
      for (const fn of [describeRouteQuestion, describeCheckQuestion] as const) {
        expect(() => fn(junk as never)).not.toThrow();
        expect(fn(junk as never).title.length).toBeGreaterThan(0);
        expect(fn(junk as never).buttons.length).toBeGreaterThan(0);
      }
    }
    for (const fn of [
      describeFullRow,
      describeQuickRow,
      describeQuickCardLine,
      describeSlowBanner,
      describeQuietBanner,
    ] as const)
      expect(() => fn(undefined as never)).not.toThrow();
    expect(describeQuickSelected(undefined as never)).toBeNull();
    expect(describeSwitchedToQuick(Number.NaN)).toBe(
      "Started again as a Quick export because this PC is slower than expected.",
    );
  });
});

// A promise of the same picture or of a speed multiple is not ours to make (the owner's rule): nothing this module can say may contain one.
const BANNED: RegExp[] = [
  /same pixels?/i,
  /\bidentical\b/i,
  /same quality/i,
  /same picture/i,
  /same look/i,
  /exactly the same/i,
  /bit[- ]?(for[- ]?bit|identical|perfect)/i,
  /byte[- ]for[- ]byte/i,
  /\blossless\b/i,
  /\bno (loss|difference)\b/i,
  /\d\s*(x|×)\s*(faster|quicker|speed)/i,
  /\d+(\.\d+)?\s*times\s+(as\s+)?(fast|faster|quick|quicker|more quickly)/i,
  /\b(twice|double|triple|half)\s+(as\s+)?(fast|the speed)/i,
  /\b(two|three|four|five|ten)\s+times\s+(as\s+)?(fast|faster|quick|quicker)/i,
];
const GARBAGE = /\bNaN\b|\bInfinity\b|\bundefined\b|\bnull\b|\[object|\bobject Object/;

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) strings(item, into);
  return into;
}

describe("nothing here promises the same pixels or a speed multiple, or prints what is not a number", () => {
  // Every function the module exports, with a generator of the inputs it is given: a function added to the module without a row here
  // fails the walk below, so nothing can be said that this test has not scanned.
  const scanned: Record<string, fc.Arbitrary<unknown[]>> = {
    describePicture: fc.tuple(fc.double(), fc.double()),
    describeFullRow: fc.tuple(
      fc.record({
        route: fc.constantFrom("processor", "chip", "faster"),
        seconds: secondsArb,
        bytes: bytesArb,
        picture: pictureArb,
        fps: fpsArb,
        quality: fc.constantFrom("high", "medium", "low"),
      }),
    ),
    describeQuickRow: fc.tuple(quickRowArb),
    describeQuickSelected: fc.tuple(
      fc.record({
        pcClass: fc.constantFrom(...PC_CLASSES),
        plainTimes: fc.oneof(
          fc.double({ min: 0.1, max: 400, noNaN: true }),
          fc.constantFrom(null, Number.NaN),
        ),
        picture: pictureArb,
        changedSize: fc.boolean(),
      }),
    ),
    describeQuickNotOffered: fc.tuple(fc.constantFrom(...QUICK_OFFERS)),
    describeTimesFrom: fc.tuple(fc.constantFrom("", "today", "yesterday", "3 days ago")),
    describeQuickCardLine: fc.tuple(
      fc.record({ picture: pictureArb, fps: fpsArb, changedSize: fc.boolean() }),
    ),
    describeSlowBanner: fc.tuple(
      fc.record({
        leftSeconds: secondsArb,
        expectedSeconds: secondsArb,
        quickSeconds: secondsArb,
        quick: fc.constantFrom("helps", "no_help", "none"),
      }),
    ),
    describeQuietBanner: fc.tuple(
      fc.record({
        quietSeconds: secondsArb,
        quickSeconds: secondsArb,
        quick: fc.constantFrom("helps", "no_help", "none"),
        idle: fc.boolean(),
      }),
    ),
    describeSwitchedToQuick: fc.tuple(secondsArb),
    describeRouteQuestion: fc.tuple(questionArb),
    describeCheckQuestion: fc.tuple(
      fc.record({
        what: fc.constantFrom("", "10 minutes with 41 stills", "  "),
        roughSeconds: secondsArb,
      }),
    ),
  };

  it("holds for everything every function returns, over generated inputs", () => {
    for (const [name, inputs] of Object.entries(scanned)) {
      const fn = (routeWords as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      fc.assert(
        fc.property(inputs, (args) => {
          for (const text of strings(fn(...args))) {
            for (const banned of BANNED) expect(text).not.toMatch(banned);
            expect(text).not.toMatch(GARBAGE);
          }
        }),
        { numRuns: 300 },
      );
    }
  });

  it("holds for every sentence the module keeps as a constant, and every label", () => {
    const constants = [
      ...Object.values(routeWords).filter((value) => typeof value === "string"),
      ...Object.values(BANNER_BUTTON_LABELS),
    ] as string[];
    expect(constants.length).toBeGreaterThan(5);
    for (const value of constants) {
      for (const banned of BANNED) expect(value).not.toMatch(banned);
      expect(value).not.toMatch(GARBAGE);
    }
  });

  it("is a walk of the whole module: every function it exports is one of those scanned", () => {
    const exported = Object.entries(routeWords)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(scanned).sort());
  });

  it("would catch a promise of the kind it forbids, and lets a measurement of this PC's pace through", () => {
    for (const promise of [
      "the same pixels as Full quality",
      "an identical picture",
      "the same quality, faster",
      "3x faster",
      "about 2 times faster than full quality",
      "twice as fast",
      "three times quicker",
    ])
      expect(BANNED.some((banned) => banned.test(promise))).toBe(true);
    expect(
      BANNED.some((banned) => banned.test("a plain video takes about 9 times its length here")),
    ).toBe(false);
  });
});
