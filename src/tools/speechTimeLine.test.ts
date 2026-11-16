// The speech card's words, as rules: what it says about the transcription of the files the assistant is
// waiting for. The text a person reads is what is checked. The exact copy of every state sits in tables, so
// a change of wording is a visible edit there; the rules a rewrite must keep (no time before audio has
// moved, an exact count, nothing that reads as junk) are properties over every state and over numbers that
// should never arrive.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { TRANSCRIPT_FAILURE_REASONS } from "./speechFailure";
import {
  cardView,
  plural,
  type CardInput,
  type CardNote,
  type CardNoteKind,
  type CardView,
  type HeldBy,
} from "./speechTimeLine";
import { approxTime } from "./transcriptWords";

const SLOW = "this PC is slow at this, it can take much longer";

const base: CardInput = {
  done: 3,
  total: 8,
  phase: null,
  waitingForExport: false,
  runningEtaS: null,
  queuedS: 0,
  slow: false,
  download: null,
  ready: null,
  notes: [],
};
const make = (over: Partial<CardInput> = {}): CardInput => ({ ...base, ...over });
const linesOf = (over: Partial<CardInput> = {}): readonly string[] =>
  cardView(make(over))?.lines ?? [];
const spoken = (view: CardView | null): string[] =>
  view ? [...view.lines, ...view.notes.map((n) => n.text)] : [];
const isProgress = (line: string): boolean => line.startsWith("Transcri");

/** The shapes of what approxTime says; the download's own "about 3 min left" is none of them. */
const TIME = /less than a minute|about [0-9.e+]+ (?:minutes?|hours?)/;
const JUNK = /NaN|Infinity|undefined|null|\[object|-\d/;

type Row = [name: string, over: Partial<CardInput>, lines: string[]];

const PROGRESS: Row[] = [
  ["the count alone while the phase is not known", { phase: null }, ["Transcribing 3 of 8 files"]],
  ["one file", { done: 0, total: 1 }, ["Transcribing 0 of 1 file"]],
  ["waiting, but not for an export", { phase: "waiting" }, ["Transcribing 3 of 8 files"]],
  [
    "waiting for an export to finish",
    { phase: "waiting", waitingForExport: true },
    ["Transcription is waiting for the export to finish · 3 of 8 files"],
  ],
  [
    "waiting for an export to finish, one file",
    { done: 0, total: 1, phase: "waiting", waitingForExport: true },
    ["Transcription is waiting for the export to finish · 0 of 1 file"],
  ],
  ["starting", { phase: "starting" }, ["Transcribing 3 of 8 files · starting…"]],
  [
    "running before the first words",
    { phase: "running", runningEtaS: null },
    ["Transcribing 3 of 8 files · starting…"],
  ],
  [
    "running, less than a minute left",
    { phase: "running", runningEtaS: 20 },
    ["Transcribing 3 of 8 files · less than a minute"],
  ],
  [
    "running, minutes left",
    { phase: "running", runningEtaS: 180 },
    ["Transcribing 3 of 8 files · about 3 minutes"],
  ],
  [
    "running, the other files added to the time",
    { phase: "running", runningEtaS: 100, queuedS: 20 },
    ["Transcribing 3 of 8 files · about 2 minutes"],
  ],
  [
    "running, hours left",
    { phase: "running", runningEtaS: 60, queuedS: 3600 },
    ["Transcribing 3 of 8 files · about 1 hour"],
  ],
  [
    "running on a PC that is slower than real time",
    { phase: "running", runningEtaS: 180, slow: true },
    [`Transcribing 3 of 8 files · about 3 minutes · ${SLOW}`],
  ],
];

const DOWNLOAD: Row[] = [
  [
    "downloading, with the time left",
    { download: { pct: 40, etaS: 125 } },
    [
      "Downloading the speech model (one time): 40%, about 3 min left",
      "Then 5 files to transcribe.",
    ],
  ],
  [
    "downloading, the time not known",
    { download: { pct: 7, etaS: null } },
    ["Downloading the speech model (one time): 7%", "Then 5 files to transcribe."],
  ],
  [
    "downloading, one file to come",
    { done: 7, total: 8, download: { pct: 100, etaS: 30 } },
    [
      "Downloading the speech model (one time): 100%, about 30 s left",
      "Then 1 file to transcribe.",
    ],
  ],
  [
    "downloading, hours left and nothing to transcribe",
    { done: 8, total: 8, download: { pct: 55, etaS: 7200 } },
    ["Downloading the speech model (one time): 55%, about 2 h left"],
  ],
  [
    "downloading hides the progress of a running job",
    {
      phase: "running",
      runningEtaS: 100,
      queuedS: 20,
      slow: true,
      download: { pct: 10, etaS: null },
    },
    ["Downloading the speech model (one time): 10%", "Then 5 files to transcribe."],
  ],
  [
    "downloading hides the wait for an export",
    { phase: "waiting", waitingForExport: true, download: { pct: 10, etaS: null } },
    ["Downloading the speech model (one time): 10%", "Then 5 files to transcribe."],
  ],
  // A second model file (another one is already on this PC) is not a one-time thing that happens at the first start.
  [
    "downloading a second model file, with the time left",
    { download: { pct: 40, etaS: 125, again: true } },
    ["Downloading another speech model: 40%, about 3 min left", "Then 5 files to transcribe."],
  ],
  [
    "downloading a second model file, nothing to transcribe",
    { done: 8, total: 8, download: { pct: 7, etaS: null, again: true } },
    ["Downloading another speech model: 7%"],
  ],
  [
    "a flag that is not exactly true is the first download",
    { download: { pct: 7, etaS: null, again: "yes" as unknown as boolean } },
    ["Downloading the speech model (one time): 7%", "Then 5 files to transcribe."],
  ],
];

/** The sentence after "Words are ready for N files." for each reason the assistant is not carrying on. */
const HELD_COPY: Record<NonNullable<HeldBy>, string> = {
  typing: "The assistant carries on when you send or clear your message.",
  capped: "Ask the assistant to carry on.",
  credits: "You are out of credits, so the assistant cannot carry on yet.",
  idle: "It has been a while, so ask the assistant to continue.",
};

const READY: Row[] = [
  [
    "words ready, the assistant about to carry on",
    { done: 8, total: 8, ready: { files: 2, held: null } },
    ["Words are ready for 2 files."],
  ],
  [
    "words ready for one file, the person typing",
    { done: 8, total: 8, ready: { files: 1, held: "typing" } },
    ["Words are ready for 1 file. The assistant carries on when you send or clear your message."],
  ],
  [
    "words ready, the assistant is capped",
    { done: 8, total: 8, ready: { files: 3, held: "capped" } },
    ["Words are ready for 3 files. Ask the assistant to carry on."],
  ],
  [
    "words ready, out of credits",
    { done: 8, total: 8, ready: { files: 3, held: "credits" } },
    ["Words are ready for 3 files. You are out of credits, so the assistant cannot carry on yet."],
  ],
  [
    "words ready after a long break: the person is told to ask, and nothing promises a wake",
    { done: 4, total: 4, ready: { files: 4, held: "idle" } },
    ["Words are ready for 4 files. It has been a while, so ask the assistant to continue."],
  ],
  [
    "lines come in order: download, what follows it, then what is ready",
    { download: { pct: 50, etaS: null }, ready: { files: 3, held: "capped" } },
    [
      "Downloading the speech model (one time): 50%",
      "Then 5 files to transcribe.",
      "Words are ready for 3 files. Ask the assistant to carry on.",
    ],
  ],
  [
    "lines come in order: progress, then what is ready",
    { phase: "running", runningEtaS: 180, ready: { files: 2, held: null } },
    ["Transcribing 3 of 8 files · about 3 minutes", "Words are ready for 2 files."],
  ],
];

describe("the exact words of every state", () => {
  it.each([...PROGRESS, ...DOWNLOAD, ...READY])("%s", (_name, over, expected) => {
    expect(linesOf(over)).toEqual(expected);
  });

  it("says each reason held back in its own words, and nothing more when the assistant is about to carry on", () => {
    for (const [held, sentence] of Object.entries(HELD_COPY))
      expect(linesOf({ done: 8, total: 8, ready: { files: 2, held: held as HeldBy } })).toEqual([
        `Words are ready for 2 files. ${sentence}`,
      ]);
  });

  it("never says that the assistant carries on by itself after a long break, whoever is typing or capped", () => {
    const line = linesOf({ done: 4, total: 4, ready: { files: 4, held: "idle" } }).join(" ");
    expect(line).not.toMatch(/carries on|carry on by itself|about to|will continue|when you send/i);
    expect(line).toMatch(/ask the assistant to continue/i);
  });
});

/** What a note says for one file and for three, by kind: a kind added to the type needs its row here. */
const NOTE_COPY: Record<CardNoteKind, { one: string; three: string }> = {
  engine_failed: {
    one: "The speech engine failed on 1 file.",
    three: "The speech engine failed on 3 files.",
  },
  audio_extraction_failed: {
    one: "The sound of 1 file could not be read.",
    three: "The sound of 3 files could not be read.",
  },
  engine_unavailable: {
    one: "Speech cannot run on this computer.",
    three: "Speech cannot run on this computer.",
  },
  language_rejected: {
    one: "The language was not accepted for 1 file.",
    three: "The language was not accepted for 3 files.",
  },
  expired: {
    one: "The words for 1 file are still not ready after 30 minutes. Ask the assistant to try again later.",
    three:
      "The words for 3 files are still not ready after 30 minutes. Ask the assistant to try again later.",
  },
};
const KINDS = Object.keys(NOTE_COPY) as CardNoteKind[];
const note = (id: string, kind: CardNoteKind, count: number): CardNote => ({ id, kind, count });
const noteView = (notes: CardNote[]): CardView | null =>
  cardView(make({ done: 8, total: 8, notes }));

describe("the notes", () => {
  it.each(
    KINDS.flatMap(
      (kind) =>
        [
          [kind, 1],
          [kind, 3],
        ] as Array<[CardNoteKind, 1 | 3]>,
    ),
  )("%s for %i", (kind, count) => {
    expect(noteView([note("a", kind, count)])).toEqual({
      lines: [],
      notes: [{ id: "a", text: count === 1 ? NOTE_COPY[kind].one : NOTE_COPY[kind].three }],
    });
  });

  it("has words for every reason a transcription can fail with, except the two that are spoken for elsewhere", () => {
    // The download line speaks for the model; the speech chip shows the person's own Cancel.
    const silent: readonly string[] = ["model_unavailable", "cancelled"];
    const texts = new Set<string>();
    for (const reason of TRANSCRIPT_FAILURE_REASONS) {
      const view = noteView([note("n", reason as CardNoteKind, 2)]);
      if (silent.includes(reason)) {
        expect(view).toBeNull();
        continue;
      }
      expect(view?.notes).toHaveLength(1);
      expect(view?.notes[0].text.length).toBeGreaterThan(10);
      texts.add(view?.notes[0].text ?? "");
    }
    expect(texts.size).toBe(TRANSCRIPT_FAILURE_REASONS.length - silent.length);
    expect(new Set(KINDS.map((k) => NOTE_COPY[k].three)).size).toBe(KINDS.length);
  });

  it("keeps two notes of one kind apart when they have different ids", () => {
    expect(noteView([note("a", "engine_failed", 1), note("b", "engine_failed", 2)])?.notes).toEqual(
      [
        { id: "a", text: "The speech engine failed on 1 file." },
        { id: "b", text: "The speech engine failed on 2 files." },
      ],
    );
  });

  it("puts the notes beside the lines, each with the id it was given, and the lines in their own order", () => {
    const view = cardView(
      make({
        phase: "running",
        runningEtaS: 180,
        slow: true,
        ready: { files: 2, held: "typing" },
        notes: [note("a", "engine_failed", 1), note("b", "expired", 2)],
      }),
    );
    expect(view).toEqual({
      lines: [
        `Transcribing 3 of 8 files · about 3 minutes · ${SLOW}`,
        "Words are ready for 2 files. The assistant carries on when you send or clear your message.",
      ],
      notes: [
        { id: "a", text: NOTE_COPY.engine_failed.one },
        {
          id: "b",
          text: "The words for 2 files are still not ready after 30 minutes. Ask the assistant to try again later.",
        },
      ],
    });
  });

  it("keeps the notes in the order given and leaves out a note of no files, whatever else is on the card", () => {
    const noteList = fc
      .array(
        fc.record({ kind: fc.constantFrom(...KINDS), count: fc.integer({ min: -2, max: 4 }) }),
        { maxLength: 8 },
      )
      .map((items) => items.map((item, i) => note(`n${i}`, item.kind, item.count)));
    fc.assert(
      fc.property(noteList, (notes) => {
        const view = noteView(notes);
        const kept = notes.filter((n) => n.count >= 1);
        expect(view?.notes.map((n) => n.id) ?? []).toEqual(kept.map((n) => n.id));
        view?.notes.forEach((n, i) => {
          const { kind, count } = kept[i];
          if (kind === "engine_unavailable") expect(n.text).toBe(NOTE_COPY[kind].one);
          else expect(n.text).toContain(plural(count, "file", "files"));
        });
        expect(view === null).toBe(kept.length === 0);
      }),
    );
  });

  it("never puts a note among the lines", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ kind: fc.constantFrom(...KINDS), count: fc.integer({ min: 0, max: 3 }) }),
        ),
        (items) => {
          const notes = items.map((item, i) => note(`n${i}`, item.kind, item.count));
          const input = make({
            phase: "running",
            runningEtaS: 90,
            ready: { files: 1, held: null },
          });
          expect(cardView({ ...input, notes })?.lines).toEqual(cardView(input)?.lines);
        },
      ),
    );
  });

  it("is not made to say words for a kind it does not know, a kind that only the table inherits, or a note that is not one", () => {
    for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty", "", "Expired"])
      expect(noteView([note("a", kind as CardNoteKind, 2)])).toBeNull();
    const junk = [null, 7, "engine_failed", [], undefined] as unknown as CardNote[];
    expect(noteView(junk)).toBeNull();
    expect(
      cardView({ ...make({ done: 8, total: 8 }), notes: null as unknown as CardNote[] }),
    ).toBeNull();
  });
});

describe("a time is never said before audio has moved", () => {
  it.each([
    ["a job that is starting", { phase: "starting" }],
    ["a job that waits", { phase: "waiting" }],
    ["a job that waits for an export", { phase: "waiting", waitingForExport: true }],
    ["a phase that is not known", { phase: null }],
  ] as Array<[string, Partial<CardInput>]>)(
    "%s, whatever times and slowness it is given",
    (_name, over) => {
      const view = cardView(make({ ...over, runningEtaS: 120, queuedS: 600, slow: true }));
      for (const line of spoken(view)) {
        expect(line).not.toMatch(TIME);
        expect(line).not.toContain(SLOW);
      }
    },
  );

  it("is only the count when the running job's time is not a time that can be believed", () => {
    for (const eta of [NaN, Infinity, -Infinity, -1, -0.5])
      expect(linesOf({ phase: "running", runningEtaS: eta, queuedS: 60, slow: true })).toEqual([
        "Transcribing 3 of 8 files",
      ]);
  });

  it("says a time of zero as under a minute, and a missing queue as nothing to add", () => {
    expect(linesOf({ phase: "running", runningEtaS: 0, queuedS: 0 })).toEqual([
      "Transcribing 3 of 8 files · less than a minute",
    ]);
    for (const queued of [NaN, -500, Infinity, -Infinity])
      expect(linesOf({ phase: "running", runningEtaS: 180, queuedS: queued })).toEqual([
        "Transcribing 3 of 8 files · about 3 minutes",
      ]);
  });

  it("does not let two huge times add up to nothing", () => {
    const line = linesOf({
      phase: "running",
      runningEtaS: Number.MAX_VALUE,
      queuedS: Number.MAX_VALUE,
    })[0];
    expect(line).not.toContain("less than a minute");
    expect(line).not.toMatch(JUNK);
    expect(line).toMatch(TIME);
  });
});

describe("the download", () => {
  it("says every whole percent as it is, never a rounding slip such as 29 becoming 28", () => {
    for (let pct = 0; pct <= 100; pct++)
      expect(linesOf({ download: { pct, etaS: null } })[0]).toBe(
        `Downloading the speech model (one time): ${pct}%`,
      );
  });

  it.each([
    [-5, 0],
    [150, 100],
    [39.9, 39],
    [100.4, 100],
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
  ])("says a percent of %s as %s", (pct, said) => {
    expect(linesOf({ download: { pct, etaS: null } })[0]).toBe(
      `Downloading the speech model (one time): ${said}%`,
    );
  });

  it("says the time left only when it is a number", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constantFrom(NaN, Infinity, -Infinity),
          fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        ),
        (etaS) => {
          const line = linesOf({ download: { pct: 10, etaS } })[0];
          expect(line.endsWith(" left")).toBe(typeof etaS === "number" && Number.isFinite(etaS));
        },
      ),
    );
  });
});

describe("the ready line", () => {
  it.each([
    [2.9, "Words are ready for 2 files."],
    [1.2, "Words are ready for 1 file."],
    [0, null],
    [-3, null],
    [0.9, null],
    [NaN, null],
    [Infinity, null],
  ] as Array<[number, string | null]>)("for %s files says %s", (files, said) => {
    expect(linesOf({ done: 8, total: 8, ready: { files, held: null } })).toEqual(
      said === null ? [] : [said],
    );
  });

  it("does not take a name the table only inherits for a reason", () => {
    for (const held of ["constructor", "toString", "__proto__", "typing "])
      expect(linesOf({ done: 8, total: 8, ready: { files: 2, held: held as HeldBy } })).toEqual([
        "Words are ready for 2 files.",
      ]);
  });
});

describe("plural", () => {
  it("says 1 file for one and N files for every other number, zero included", () => {
    expect(plural(1, "file", "files")).toBe("1 file");
    expect(plural(0, "file", "files")).toBe("0 files");
    expect(plural(2, "file", "files")).toBe("2 files");
    expect(plural(1, "minute", "minutes")).toBe("1 minute");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => {
        expect(plural(n, "file", "files")).toBe(n === 1 ? "1 file" : `${n} files`);
      }),
    );
  });

  it("is a whole number and one of the two words, whatever number comes in", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: -1e9, max: 1e9 }),
          fc.constantFrom(NaN, Infinity, -Infinity, -0, Number.MAX_VALUE),
        ),
        (n) => {
          const said = plural(n, "file", "files");
          expect(said).toMatch(/^(?:0|[1-9][0-9]*(?:\.[0-9]+)?(?:e\+[0-9]+)?) files?$/);
          expect(said === "1 file").toBe(said.startsWith("1 "));
        },
      ),
    );
  });
});

const secondsArb = fc.oneof(
  fc.integer({ min: 0, max: 100_000 }),
  fc.double({ min: 0, max: 100_000, noNaN: true }),
);
const phaseArb = fc.constantFrom<CardInput["phase"]>(null, "waiting", "starting", "running");
const heldArb = fc.constantFrom<HeldBy>(null, "typing", "capped", "credits", "idle");

/** A state the app can be in: the export wait is only ever said of a job that waits. The model downloads
 *  in a minority of states, and files are left in most, so most have a progress line to check. */
const coherent: fc.Arbitrary<CardInput> = fc
  .record({
    done: fc.integer({ min: 0, max: 20 }),
    left: fc.oneof(
      { weight: 1, arbitrary: fc.constant(0) },
      { weight: 5, arbitrary: fc.integer({ min: 1, max: 20 }) },
    ),
    phase: phaseArb,
    exportWait: fc.boolean(),
    runningEtaS: fc.oneof(fc.constant(null), secondsArb),
    queuedS: secondsArb,
    slow: fc.boolean(),
    download: fc.oneof(
      { weight: 3, arbitrary: fc.constant(null) },
      {
        weight: 1,
        arbitrary: fc.record({
          pct: fc.integer({ min: 0, max: 100 }),
          etaS: fc.oneof(fc.constant(null), secondsArb),
        }),
      },
    ),
    ready: fc.oneof(
      fc.constant(null),
      fc.record({ files: fc.integer({ min: 0, max: 20 }), held: heldArb }),
    ),
    notes: fc.array(
      fc.record({
        id: fc.string({ maxLength: 6 }),
        kind: fc.constantFrom(...KINDS),
        count: fc.integer({ min: -2, max: 5 }),
      }),
      { maxLength: 4 },
    ),
  })
  .map(({ exportWait, left, ...rest }) => ({
    ...rest,
    total: rest.done + left,
    waitingForExport: rest.phase === "waiting" && exportWait,
  }));

const filesLeft = (input: CardInput): number => input.total - Math.min(input.done, input.total);
const progressShown = (input: CardInput): boolean =>
  input.download === null && filesLeft(input) > 0;

/** The rules about states are the ones worth more samples than the default. */
const RUNS = { numRuns: 300 };

describe("for any state of the work", () => {
  it("shows a time exactly when audio has moved and the model is not downloading, and it is the time the job and the queue need", () => {
    fc.assert(
      fc.property(coherent, (input) => {
        const progress = cardView(input)?.lines.find(isProgress);
        const moved =
          progressShown(input) && input.phase === "running" && input.runningEtaS !== null;
        expect(progress !== undefined && TIME.test(progress)).toBe(moved);
        if (moved && progress)
          expect(progress.split(" · ")[1]).toBe(
            approxTime((input.runningEtaS ?? 0) + input.queuedS),
          );
      }),
      RUNS,
    );
  });

  it('says "starting…" exactly until the first words, with something to transcribe and no download or export wait', () => {
    fc.assert(
      fc.property(coherent, (input) => {
        const starting =
          progressShown(input) &&
          !input.waitingForExport &&
          (input.phase === "starting" || (input.phase === "running" && input.runningEtaS === null));
        expect(spoken(cardView(input)).some((line) => line.includes("starting…"))).toBe(starting);
      }),
      RUNS,
    );
  });

  it("says nothing of time or slowness while the work waits or its phase is not known, whatever times it is given", () => {
    fc.assert(
      fc.property(coherent, (input) => {
        if (input.phase !== null && input.phase !== "waiting") return;
        for (const line of spoken(cardView(input))) {
          expect(line).not.toMatch(TIME);
          expect(line).not.toContain("starting");
          expect(line).not.toContain(SLOW);
        }
      }),
      RUNS,
    );
  });

  it("says that the PC is slow only beside a time", () => {
    fc.assert(
      fc.property(coherent, (input) => {
        const progress = cardView(input)?.lines.find(isProgress);
        const timed = progress !== undefined && TIME.test(progress);
        expect(spoken(cardView(input)).some((line) => line.includes(SLOW))).toBe(
          input.slow && timed,
        );
      }),
      RUNS,
    );
  });

  it("is null exactly when there is nothing to say", () => {
    fc.assert(
      fc.property(
        coherent,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (state, noDownload, nothingLeft, noReady, noNotes) => {
          const input: CardInput = {
            ...state,
            download: noDownload ? null : state.download,
            done: nothingLeft ? state.total : state.done,
            ready: noReady ? null : state.ready,
            notes: noNotes ? [] : state.notes,
          };
          const view = cardView(input);
          const something =
            input.download !== null ||
            filesLeft(input) > 0 ||
            (input.ready !== null && input.ready.files > 0) ||
            input.notes.some((n) => n.count > 0);
          expect(view === null).toBe(!something);
          if (view) expect(view.lines.length + view.notes.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never says both that the model is downloading and how many files are done", () => {
    fc.assert(
      fc.property(coherent, (input) => {
        const lines = cardView(input)?.lines ?? [];
        expect(lines.some(isProgress) && lines.some((l) => l.startsWith("Downloading"))).toBe(
          false,
        );
      }),
      RUNS,
    );
  });

  // The time ladder is approxTime's own: the phrases in the order it says them as the time grows.
  // A phrase is placed on it by what it is, never by reading the minutes out of the text.
  const ladder: string[] = [];
  for (let s = 0; s <= 200_000; s++) {
    const phrase = approxTime(s);
    if (ladder[ladder.length - 1] !== phrase) ladder.push(phrase);
  }
  const rungOf = (runningEtaS: number, queuedS: number): number => {
    const progress = cardView(make({ phase: "running", runningEtaS, queuedS }))?.lines[0] ?? "";
    return ladder.indexOf(progress.split(" · ")[1]);
  };

  it("never gives a shorter phrase for a longer time left, the time of the other files included", () => {
    expect(new Set(ladder).size).toBe(ladder.length);
    const seconds = fc.double({ min: 0, max: 100_000, noNaN: true });
    fc.assert(
      fc.property(seconds, seconds, seconds, seconds, (e1, q1, e2, q2) => {
        const [short, long] = [
          [e1, q1],
          [e2, q2],
        ].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
        const [shortRung, longRung] = [rungOf(short[0], short[1]), rungOf(long[0], long[1])];
        expect(shortRung).toBeGreaterThanOrEqual(0);
        expect(shortRung).toBeLessThanOrEqual(longRung);
      }),
      RUNS,
    );
    expect(rungOf(60, 3600)).toBeGreaterThan(rungOf(60, 0));
  });

  it("counts exactly the whole files it is given, with never more done than there are, whatever numbers come in", () => {
    const wide = fc.oneof(
      fc.double({ min: -1e9, max: 1e9 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.constantFrom(NaN, Infinity, -Infinity, -0),
    );
    const sane = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
    fc.assert(
      fc.property(wide, wide, phaseArb, (done, total, phase) => {
        const progress = cardView(make({ done, total, phase }))?.lines.find(isProgress);
        const [sureTotal, sureDone] = [sane(total), Math.min(sane(done), sane(total))];
        if (sureDone === sureTotal) {
          expect(progress).toBeUndefined();
          return;
        }
        const counted = /(\d+) of (\d+) files?/.exec(progress ?? "");
        expect([Number(counted?.[1]), Number(counted?.[2])]).toEqual([sureDone, sureTotal]);
        expect(progress).toContain(plural(sureTotal, "file", "files"));
      }),
    );
  });

  it("is the same card for the same input, changes nothing it is given, and keeps nothing between calls", () => {
    fc.assert(
      fc.property(coherent, coherent, (a, b) => {
        const input = deepFreeze(structuredClone(a));
        const first = cardView(input);
        const snapshot = structuredClone(first);
        cardView(b);
        expect(cardView(input)).toEqual(snapshot);
        if (first) {
          (first.lines as string[]).push("changed");
          (first.notes as unknown[]).push({});
        }
        expect(cardView(input)).toEqual(snapshot);
        expect(input).toEqual(a);
      }),
    );
  });
});

describe("whatever arrives", () => {
  const anyNumber = fc.oneof(
    fc.double(),
    fc.integer(),
    fc.constantFrom(
      NaN,
      Infinity,
      -Infinity,
      -0,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
    ),
    fc.anything(),
  );
  const messy = fc.record({
    done: anyNumber,
    total: anyNumber,
    phase: fc.oneof(phaseArb, fc.anything()),
    waitingForExport: fc.oneof(fc.boolean(), fc.anything()),
    runningEtaS: fc.oneof(fc.constant(null), anyNumber),
    queuedS: anyNumber,
    slow: fc.oneof(fc.boolean(), fc.anything()),
    download: fc.oneof(
      fc.constant(null),
      fc.record({ pct: anyNumber, etaS: fc.oneof(fc.constant(null), anyNumber) }),
      fc.anything(),
    ),
    ready: fc.oneof(
      fc.constant(null),
      fc.record({ files: anyNumber, held: fc.oneof(heldArb, fc.anything()) }),
      fc.anything(),
    ),
    notes: fc.oneof(
      fc.array(
        fc.record({
          id: fc.string(),
          kind: fc.oneof(fc.constantFrom(...KINDS), fc.anything()),
          count: anyNumber,
        }),
        { maxLength: 6 },
      ),
      fc.anything(),
    ),
  }) as unknown as fc.Arbitrary<CardInput>;

  it("is a card or nothing, never a crash, and never says NaN, Infinity, undefined, null or a negative number", () => {
    fc.assert(
      fc.property(messy, (input) => {
        const view = cardView(input);
        if (view === null) return;
        for (const text of spoken(view)) {
          expect(typeof text).toBe("string");
          expect(text).not.toMatch(JUNK);
          expect(text).not.toMatch(/^ | $| {2}/);
        }
        expect(view.lines.length + view.notes.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it("takes a field that is missing for none: no download, nothing ready, no notes and no time", () => {
    const bare = { done: 3, total: 8 } as unknown as CardInput;
    expect(cardView(bare)?.lines).toEqual(["Transcribing 3 of 8 files"]);
    expect(cardView({ ...bare, phase: "running" })?.lines).toEqual(["Transcribing 3 of 8 files"]);
    expect(cardView({ done: 8, total: 8 } as unknown as CardInput)).toBeNull();
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
