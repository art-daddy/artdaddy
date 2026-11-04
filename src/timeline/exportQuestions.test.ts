import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isKnownProblem, type ExportPreflightReason as Reason } from "./exportOptions";
import {
  answerButtons,
  asksAboutIt,
  bandOf,
  driveOf,
  planQuestions,
  questionAsText,
  type ExportQuestion,
  type ExportQuestionKind,
  type ExportVia,
  type PreflightPicture,
} from "./exportQuestions";
import { CONFIRM_REASON_BITS } from "./exportTrace";

const GB = 1e9;
const ALL_REASONS = Object.keys(CONFIRM_REASON_BITS) as Reason[];
const VIAS: ExportVia[] = ["menu", "chat", "mcp", "other"];
const KINDS: ExportQuestionKind[] = ["memory", "output_space", "working_space", "notice"];

/** Every combination of findings the pre-start check can raise. */
function everySubset(): Set<Reason>[] {
  const out: Set<Reason>[] = [];
  for (let bits = 0; bits < 1 << ALL_REASONS.length; bits++)
    out.push(new Set(ALL_REASONS.filter((_, i) => bits & (1 << i))));
  return out;
}

/** What the pre-start check asked about before S2 (frozen here from its own wording): a known problem
 *  made it a warning, a slow or long estimate a notice, and either one showed the message. */
const askedBeforeS2 = (reasons: ReadonlySet<Reason>): boolean =>
  [...reasons].some(isKnownProblem) || reasons.has("slow") || reasons.has("long");

/** A picture consistent with its own reasons: a shortage has numbers that really are short. */
function picture(
  reasons: Iterable<Reason>,
  over: Partial<PreflightPicture> = {},
): PreflightPicture {
  const set = new Set(reasons);
  const memoryShort = set.has("memory_shortage");
  const spaceShort = set.has("disk_shortage");
  return {
    via: "chat",
    count: 1,
    reasons: set,
    memoryNeededBytes: memoryShort ? 3.2 * GB : 1 * GB,
    memoryUsableBytes: memoryShort ? 1.9 * GB : 6 * GB,
    spaceNeededBytes: 3.4 * GB,
    destinationFreeBytes: spaceShort ? 1.2 * GB : 90 * GB,
    scratchFreeBytes: spaceShort ? 2 * GB : 90 * GB,
    destinationShort: spaceShort,
    scratchShort: false,
    drive: "D:",
    seconds: 1500,
    secondsGuessed: false,
    executionLimitSeconds: 28_800,
    ...over,
  };
}

/** "about 3.2 GB" back to bytes, for checking what the person reads. */
function bytesOf(text: string): number {
  const match = /about ([\d.]+) (MB|GB)/.exec(text);
  if (!match) throw new Error(`not a size: ${text}`);
  return Number(match[1]) * (match[2] === "GB" ? 1e9 : 1e6);
}

describe("what asks (today's rule, with one decided exception)", () => {
  it("asks exactly when it asked before, for the chat and for an outside assistant", () => {
    for (const reasons of everySubset())
      for (const via of ["chat", "mcp", "other"] as const)
        expect(asksAboutIt(reasons, via), [...reasons].join(",")).toBe(askedBeforeS2(reasons));
  });

  it("does not ask the Export menu about time alone: its dialog has just shown the estimate", () => {
    for (const reasons of everySubset())
      expect(asksAboutIt(reasons, "menu"), [...reasons].join(",")).toBe(
        [...reasons].some(isKnownProblem),
      );
    expect(asksAboutIt(new Set<Reason>(["slow"]), "menu")).toBe(false);
    expect(asksAboutIt(new Set<Reason>(["long"]), "menu")).toBe(false);
    expect(asksAboutIt(new Set<Reason>(["slow", "memory_shortage"]), "menu")).toBe(true);
  });

  it("never asks about a measurement that is missing", () => {
    const unknown = new Set<Reason>(["memory_unknown", "disk_unknown", "time_unknown"]);
    for (const via of VIAS) expect(asksAboutIt(unknown, via)).toBe(false);
  });

  it("is the same decision as the questions it leads to: every asked finding gets a question, nothing else does", () => {
    for (const reasons of everySubset())
      for (const via of VIAS) {
        const questions = planQuestions(picture(reasons, { via }));
        expect(questions.length > 0, `${via}: ${[...reasons].join(",")}`).toBe(
          asksAboutIt(reasons, via),
        );
      }
  });
});

describe("which question, in which order", () => {
  const ORDER = new Map(KINDS.map((kind, index) => [kind, index]));
  const pictures = fc.record({
    reasons: fc.subarray(ALL_REASONS),
    via: fc.constantFrom(...VIAS),
    destinationShort: fc.boolean(),
    scratchShort: fc.boolean(),
    count: fc.integer({ min: 1, max: 50 }),
    drive: fc.constantFrom<string | null>("C:", "D:", null),
  });
  const waivers = fc.subarray(KINDS);

  it("asks memory, then the exported file's space, then the working space, then the rest, each at most once", () => {
    fc.assert(
      fc.property(pictures, waivers, (p, waived) => {
        const kinds = planQuestions(
          picture(p.reasons, {
            via: p.via,
            destinationShort: p.destinationShort,
            scratchShort: p.scratchShort,
            count: p.count,
            drive: p.drive,
          }),
          new Set(waived),
        ).map((q) => q.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        const ranks = kinds.map((kind) => ORDER.get(kind)!);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      }),
      { numRuns: 400 },
    );
  });

  it("leaves out a kind the person already waived, and nothing else", () => {
    fc.assert(
      fc.property(pictures, waivers, (p, waived) => {
        const base = picture(p.reasons, {
          via: p.via,
          destinationShort: p.destinationShort,
          scratchShort: p.scratchShort,
        });
        const all = planQuestions(base).map((q) => q.kind);
        const rest = planQuestions(base, new Set(waived)).map((q) => q.kind);
        expect(rest).toEqual(all.filter((kind) => !waived.includes(kind)));
      }),
      { numRuns: 400 },
    );
  });

  it("names the drive that is short: only the working space short asks about the working space", () => {
    const only = (over: Partial<PreflightPicture>) =>
      planQuestions(picture(["disk_shortage"], over)).map((q) => q.kind);
    expect(only({ destinationShort: false, scratchShort: true })).toEqual(["working_space"]);
    expect(only({ destinationShort: true, scratchShort: false })).toEqual(["output_space"]);
    expect(only({ destinationShort: true, scratchShort: true })).toEqual([
      "output_space",
      "working_space",
    ]);
    // The check could not say which: the exported file's drive is the one the person can act on.
    expect(only({ destinationShort: false, scratchShort: false })).toEqual(["output_space"]);
  });

  it("puts everything that is not memory or space into ONE notice", () => {
    const questions = planQuestions(
      picture(["outside_promise", "execution_limit", "temporary_limit", "long", "slow"]),
    );
    expect(questions.map((q) => q.kind)).toEqual(["notice"]);
    expect(questions[0].lines).toHaveLength(5);
  });

  it("leaves slow and long out of the Export menu's notice but keeps the real problems in it", () => {
    const [notice] = planQuestions(picture(["outside_promise", "long", "slow"], { via: "menu" }));
    expect(notice.lines).toHaveLength(1);
    expect(notice.bands).toEqual({ n: 1, m: CONFIRM_REASON_BITS.outside_promise });
  });

  it("carries the trace what the screen showed: how many findings and which (one bit each)", () => {
    const [notice] = planQuestions(picture(["execution_limit", "long"], { via: "mcp" }));
    expect(notice.bands).toEqual({
      n: 2,
      m: CONFIRM_REASON_BITS.execution_limit | CONFIRM_REASON_BITS.long,
    });
  });
});

describe("the numbers on the screen", () => {
  it("never contradict the verdict: what is needed is always shown as more than what the PC has", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 36 }),
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        (needed, share) => {
          const has = Math.floor(needed * share);
          const [memory] = planQuestions(
            picture(["memory_shortage"], { memoryNeededBytes: needed, memoryUsableBytes: has }),
          );
          expect(bytesOf(memory.facts[0].value)).toBeGreaterThan(bytesOf(memory.facts[1].value));
          const [space] = planQuestions(
            picture(["disk_shortage"], { spaceNeededBytes: needed, destinationFreeBytes: has }),
          );
          expect(bytesOf(space.facts[0].value)).toBeGreaterThan(bytesOf(space.facts[1].value));
        },
      ),
      { numRuns: 600 },
    );
  });

  it("says unknown rather than a made-up number", () => {
    const [memory] = planQuestions(
      picture(["memory_shortage"], { memoryNeededBytes: null, memoryUsableBytes: Number.NaN }),
    );
    expect(memory.facts.map((fact) => fact.value)).toEqual(["unknown", "unknown"]);
  });

  it("names the drive the exported file is going to, and only that", () => {
    const [on] = planQuestions(picture(["disk_shortage"], { drive: "E:" }));
    expect(JSON.stringify(on)).toContain("E:");
    const [off] = planQuestions(picture(["disk_shortage"], { drive: null }));
    expect(JSON.stringify(off)).not.toMatch(/[A-Z]:/);
  });

  it("speaks of all the files together when the request holds several", () => {
    const [one] = planQuestions(picture(["disk_shortage"], { count: 1 }));
    const [many] = planQuestions(picture(["disk_shortage"], { count: 3 }));
    expect(one.lines.join(" ")).not.toContain("together");
    expect(many.lines.join(" ")).toContain("together");
  });

  it("names how long the longest allowed export is, when it knows", () => {
    const [known] = planQuestions(picture(["execution_limit"], { executionLimitSeconds: 28_800 }));
    expect(known.lines.join(" ")).toContain("about 8 h");
    const [unknown] = planQuestions(picture(["execution_limit"], { executionLimitSeconds: null }));
    expect(unknown.lines.join(" ")).not.toMatch(/\(\)|null|NaN/);
  });

  it("says a time is a rough guess when it is one, and does not claim a measurement it has not got", () => {
    const [guess] = planQuestions(picture(["long"], { secondsGuessed: true, seconds: 6200 }));
    expect(guess.facts[0].value).toContain("rough guess");
    expect(guess.facts[0].value).toContain("about 1 h 43 min");
    const [measured] = planQuestions(picture(["long"], { secondsGuessed: false, seconds: 6200 }));
    expect(measured.facts[0].value).not.toContain("rough guess");
    const [none] = planQuestions(picture(["long"], { seconds: null }));
    expect(none.facts).toEqual([]);
  });
});

describe("the words", () => {
  const every = (): ExportQuestion[] =>
    everySubset().flatMap((reasons) =>
      VIAS.flatMap((via) =>
        planQuestions(picture(reasons, { via, scratchShort: reasons.has("disk_shortage") })),
      ),
    );

  it("every question has a title, a sentence, advice, a way out and no leftovers of a bug", () => {
    for (const q of every()) {
      const text = JSON.stringify(q);
      expect(q.title.length).toBeGreaterThan(0);
      expect(q.lines.length).toBeGreaterThan(0);
      expect(q.lines.every((line) => line.length > 0)).toBe(true);
      expect(q.advice.length).toBeGreaterThan(0);
      expect(q.nativeAdvice.length).toBeGreaterThan(0);
      expect(q.answers).toContain("cancel");
      expect(q.answers).toContain("continue");
      expect(text).not.toMatch(/NaN|undefined|null|\[object|Infinity/);
    }
  });

  it("says what the PC can give an export right now, not what is free: the limit is the PC's and the app's together", () => {
    const [q] = planQuestions(picture(["memory_shortage"]));
    expect(q.lines).toEqual(["This export needs more memory than your PC can give it right now."]);
  });

  it("offers a quiet Start anyway where the estimate can be wrong, and never on a notice", () => {
    for (const q of every()) {
      expect(q.answers.includes("start_anyway")).toBe(q.kind !== "notice");
      if (q.kind !== "notice") expect(q.startAnywayNote.length).toBeGreaterThan(0);
    }
  });

  it("is a warning exactly when something is known to be wrong", () => {
    for (const q of every()) if (q.kind !== "notice") expect(q.warning).toBe(true);
    const slowOnly = planQuestions(picture(["slow"], { via: "chat" }))[0];
    expect(slowOnly.warning).toBe(false);
    expect(planQuestions(picture(["slow", "outside_promise"]))[0].warning).toBe(true);
  });

  it("carries a path nowhere: a name or a folder can never reach a screen or a report from here", () => {
    for (const q of every()) expect(JSON.stringify(q)).not.toMatch(/[\\/]/);
  });

  it("is told to the trace with codes the report knows", () => {
    for (const q of every()) {
      expect(["b1", "b2", "b3", "confirm"]).toContain(q.code);
      expect(Number.isInteger(q.bands.n) && q.bands.n >= 0).toBe(true);
      expect(Number.isInteger(q.bands.m) && q.bands.m >= 0).toBe(true);
      expect(q.bands.n).toBeLessThanOrEqual(2_147_483_647);
      expect(q.bands.m).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it("reads the same as one native message when there is no dialog to show it in", () => {
    for (const q of every()) {
      const { message, warning } = questionAsText(q);
      expect(warning).toBe(q.warning);
      expect(message).toContain(q.title);
      for (const line of q.lines) expect(message).toContain(line);
      for (const fact of q.facts) {
        expect(message).toContain(fact.value);
        expect(message).toContain(fact.label);
        // A label that ends in a colon (a drive: "Free on C:") is not given a second one.
        expect(message).not.toContain("::");
      }
      expect(message).toContain(q.nativeAdvice);
      expect(message.endsWith(q.warning ? "Continue anyway?" : "Continue?")).toBe(true);
    }
  });

  it("does not promise a second look in a native box, which has no loop and nothing called Continue to press", () => {
    for (const q of every()) {
      const { message } = questionAsText(q);
      expect(message).not.toMatch(/We'll check again|press Continue/);
      if (q.kind !== "notice") expect(q.nativeAdvice).toMatch(/Cancel[\s\S]*export again/);
    }
  });
});

describe("the buttons", () => {
  const every = (): ExportQuestion[] =>
    everySubset().flatMap((reasons) =>
      VIAS.flatMap((via) =>
        planQuestions(picture(reasons, { via, scratchShort: reasons.has("disk_shortage") })),
      ),
    );

  it("are one list for every surface: cancel first, the way on next, the quiet one last", () => {
    for (const q of every()) {
      const buttons = answerButtons(q);
      const order = ["cancel", "continue", "start_anyway"] as const;
      expect(buttons.map((b) => b.answer)).toEqual(order.filter((a) => q.answers.includes(a)));
      expect(buttons.map((b) => b.answer)).toEqual([...q.answers]);
    }
  });

  it("are named the way the native box asks: 'Continue anyway' only where something is known to be wrong in a notice", () => {
    for (const q of every()) {
      const labels = Object.fromEntries(answerButtons(q).map((b) => [b.answer, b.label]));
      expect(labels.cancel).toBe("Cancel");
      expect(labels.continue).toBe(
        q.kind === "notice" && q.warning ? "Continue anyway" : "Continue",
      );
      if (q.answers.includes("start_anyway")) expect(labels.start_anyway).toBe("Start anyway");
    }
  });
});

describe("small helpers", () => {
  it("reads a drive off a Windows path and nothing else", () => {
    expect(driveOf("D:/Videos/a.mp4")).toBe("D:");
    expect(driveOf("c:\\Users\\me\\a.mp4")).toBe("C:");
    expect(driveOf("/Users/me/a.mp4")).toBeNull();
    expect(driveOf("\\\\server\\share\\a.mp4")).toBeNull();
    expect(driveOf("a.mp4")).toBeNull();
    expect(driveOf("")).toBeNull();
    expect(driveOf("D:")).toBeNull();
  });

  it("bands a size in 128 MiB steps, monotone, whole, and zero for anything that is not a size", () => {
    expect(bandOf(null)).toBe(0);
    expect(bandOf(-5)).toBe(0);
    expect(bandOf(Number.NaN)).toBe(0);
    expect(bandOf(128 * 1024 ** 2)).toBe(1);
    expect(bandOf(128 * 1024 ** 2 - 1)).toBe(0);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 50 }),
        fc.integer({ min: 0, max: 2 ** 50 }),
        (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(bandOf(low)).toBeLessThanOrEqual(bandOf(high));
          expect(Number.isInteger(bandOf(high))).toBe(true);
          expect(bandOf(high)).toBeLessThanOrEqual(2_147_483_647);
        },
      ),
    );
  });

  it("does not change what it is given and answers the same twice", () => {
    const p = picture(["memory_shortage", "disk_shortage", "long"]);
    const before = JSON.stringify({ ...p, reasons: [...p.reasons] });
    const first = planQuestions(p);
    const second = planQuestions(p);
    expect(second).toEqual(first);
    expect(JSON.stringify({ ...p, reasons: [...p.reasons] })).toBe(before);
  });
});
