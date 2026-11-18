// The WIRING of the live time-left rule, proved on RECORDED REAL feeds through the real store and the real words.
//
// `exportTimeLeft.replay.test.ts` proves the pure rule on 88 recorded runs. This file does not prove the rule again: it proves that what a person
// reads (the chat card's line, the Export dialog's right-hand side) and what the app reports (`shownTimeLeftSeconds`, the figure behind the
// assistant's `time_left_s`) is what the rule says. Every run is played report by report into `useExportJob` on a fake clock (`Date` only: the
// store reads `Date.now()` for each report), and the three readers are called at every report, exactly as the card and the dialog call them.
//
// The rule's answer is the oracle in ONE test (the equivalence: the store feeds the rule the report's own clock and share and nothing else).
// Every other claim is stated from what the consumers say and from the raw samples alone (the gate from the exported constants, the grid, the
// words), so a rule that changed, or a consumer that stopped reading it, cannot pass by agreeing with itself.
//
// The recorded feeds carry no `step`/`steps` (no run was made in parts): the parts rule is proven here on synthetic relabelled feeds only.
// `WIRING_REPORT=<file>` also writes every number this file observed (counts, tables) to that file as JSON.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { liveFeedOf, useExportJob, type ExportLive } from "../store/exportJob";
import { coarser, replayRun, shifted, slowedFrom } from "./__fixtures__/replay";
import { REPLAY_RUNS, fractionOf, type ReplayRun } from "./__fixtures__/timeLeftRuns";
import { describeExportTime } from "./exportOptions";
import {
  GATE_FRACTION,
  GATE_RENDERED_ALONE_SECONDS,
  GATE_RENDERED_SECONDS,
  notePace,
  roundTimeLeft,
  startPace,
  type TimeLeft,
} from "./exportTimeLeft";
import {
  QUIET_SECONDS,
  describeDialogProgress,
  describeLiveStatus,
  describeStageLine,
  describeTimeLeft,
  shownTimeLeftSeconds,
  timeLeftSeconds,
  type DialogProgress,
} from "./exportWords";

// ── the words, written out: a person reads these, so they are pinned here and not read back from the code ───────────────

const FINISHING_WORDS = "Finishing";
const LONGER_WORDS = "taking longer than expected";
/** "under a minute left", "about 4 min left", "about 1 h 15 min left". */
const FIGURE_WORDS = /^(under a minute|about \d+ min|about \d+ h(?: \d+ min)?) left$/;
const isFigureWords = (words: string): boolean => FIGURE_WORDS.test(words);
/** The share made from which the answer is "Finishing": the accepted rule's number, written out on purpose. */
const FINISHING_SHARE = 0.9;
/** The fake clock's second 0 (the moment the export's turn begins). */
const START = 1_700_000_000_000;
const FPS = 30;
const PARTS = 4;

// ── the harness: the real store, driven report by report, read by the real consumers ───────────────────────────────────

type Patch = Parameters<ReturnType<typeof useExportJob.getState>["update"]>[0];
interface Part {
  readonly step: number;
  readonly steps: number;
}

/** What one reading of the consumers says at one moment. */
interface Reading {
  /** The card's whole line. */
  readonly line: string;
  /** The front of the line (stage, percent): everything but the time left. */
  readonly front: string;
  /** The words the card says about the time left: the line after its front. */
  readonly said: string;
  /** The dialog's panel, for the export's own feed. */
  readonly panel: DialogProgress;
  /** What the dialog says from the job's own answer (it has no feed of its own yet). */
  readonly jobSaid: string;
  /** The figure the assistant's list reports (the card's figure in whole seconds), or null. */
  readonly shown: number | null;
  /** What the card said in 0.28.0, from the render's raw pace: `describeExportTime(etaSec) + " left"`. */
  readonly oldSaid: string;
}

/** One report of one feed and what the consumers said right after it. */
interface Beat extends Reading {
  readonly index: number;
  /** When it arrived, ms since the run began. */
  readonly atMs: number;
  /** The share the report carried. */
  readonly fraction: number;
  /** The highest share seen so far (a feed that goes backwards stands still). */
  readonly share: number;
  /** Seconds since the feed's first report. */
  readonly rendered: number;
  /** The part of a render made in parts that the report named. */
  readonly step: number | null;
}

function dialogOf(own: ExportLive | null, now: number): DialogProgress {
  const state = useExportJob.getState();
  return describeDialogProgress(
    {
      own,
      place: null,
      phase: "rendering",
      fraction: state.fraction,
      timeLeft: state.timeLeft,
      speed: state.speed,
    },
    now,
  );
}

function read(id: string): Reading {
  const now = Date.now();
  const feed = liveFeedOf(useExportJob.getState(), id);
  if (!feed) throw new Error(`no feed for ${id}`);
  const line = describeLiveStatus(feed, now);
  const front = describeStageLine(feed, now);
  const said =
    line === front
      ? ""
      : line.startsWith(`${front} · `)
        ? line.slice(front.length + 3)
        : `?? ${line}`;
  const old = timeLeftSeconds(feed, now);
  return {
    line,
    front,
    said,
    panel: dialogOf(feed, now),
    jobSaid: dialogOf(null, now).timeLeft,
    shown: shownTimeLeftSeconds(feed, now),
    oldSaid: old === null || !describeExportTime(old) ? "" : `${describeExportTime(old)} left`,
  };
}

function begin(id: string): void {
  const store = useExportJob.getState();
  store.begin(null);
  store.beginLive(id);
  store.setLiveStage(id, "rendering");
}

function end(...ids: string[]): void {
  const store = useExportJob.getState();
  for (const id of ids) store.endLive(id);
  store.reset();
  vi.useRealTimers();
}

/** The frame count that goes with a position: a function of it, as ffmpeg's is, so a report that repeats the position repeats the frame. */
const frameOf = (run: ReplayRun, fraction: number): number =>
  Math.round(fraction * run.videoSeconds * FPS);

/** The render's own raw figure, as the 0.28.0 card said it: what is left of the video over the pace since the start (start-up counted). */
const rawEta = (run: ReplayRun, atMs: number, outMs: number): number | null =>
  outMs > 0 && atMs > 0 ? ((run.videoSeconds * 1000 - outMs) / outMs) * (atMs / 1000) : null;

const partOf = (best: number): Part => ({
  step: best < (PARTS - 1) / PARTS ? Math.floor(best * PARTS) : PARTS - 1,
  steps: PARTS,
});

interface PlayOptions {
  /** The feed's id in the store. */
  readonly id?: string;
  /** The fake clock's second 0. */
  readonly start?: number;
  /** The raw figure each report carries: it must not matter. */
  readonly eta?: (run: ReplayRun, atMs: number, outMs: number) => number | null;
  /** Relabel the reports as the parts of a render made in 4 parts, the last being the final encode. */
  readonly parts?: boolean;
}

/** Hands the reports of `run` to the store one at a time, setting the fake clock to each one's arrival first, and reads the consumers after each. */
function player(run: ReplayRun, options: PlayOptions = {}): (index: number) => Beat {
  const id = options.id ?? "run";
  const start = options.start ?? START;
  const first = run.samples[0][0];
  let best = 0;
  return (index) => {
    const [atMs, outMs] = run.samples[index];
    const fraction = fractionOf(run, outMs);
    best = Math.max(best, fraction);
    const part = options.parts ? partOf(best) : null;
    vi.setSystemTime(start + atMs);
    const eta = options.eta ? options.eta(run, atMs, outMs) : rawEta(run, atMs, outMs);
    useExportJob.getState().update({
      phase: "rendering",
      fraction,
      frame: frameOf(run, fraction),
      speed: 1,
      etaSec: eta,
      ...(part ?? {}),
    });
    return {
      index,
      atMs,
      fraction,
      share: best,
      rendered: (atMs - first) / 1000,
      step: part ? part.step : null,
      ...read(id),
    };
  };
}

function play(run: ReplayRun, options: PlayOptions = {}): Beat[] {
  vi.useFakeTimers({ now: options.start ?? START, toFake: ["Date"] });
  const id = options.id ?? "run";
  try {
    begin(id);
    const next = player(run, options);
    return run.samples.map((_, index) => next(index));
  } finally {
    end(id);
  }
}

const memo = <T>(make: () => T): (() => T) => {
  let made: { readonly value: T } | null = null;
  return () => {
    if (made === null) made = { value: make() };
    return made.value;
  };
};

interface Played {
  readonly run: ReplayRun;
  readonly beats: Beat[];
  /** What the pure rule says at each of the same reports. */
  readonly pure: readonly TimeLeft[];
}

const PLAYED = memo<Played[]>(() =>
  REPLAY_RUNS.map((run) => ({
    run,
    beats: play(run),
    pure: replayRun(run).map((record) => record.value),
  })),
);

// ── what is known from the raw samples alone ───────────────────────────────────────────────────────────────────────────

const label = (run: { readonly id: string }, b: Beat): string =>
  `${run.id} report ${b.index} (${(b.atMs / 1000).toFixed(1)} s, ${Math.round(b.share * 100)} % made)`;

/** The gate, from the rule's exported constants and the feed's own clock (it starts at the first report): 20 s rendered and (15 % made or 60 s rendered). */
const gateOpen = (b: Beat): boolean =>
  b.rendered >= GATE_RENDERED_SECONDS &&
  (b.share >= GATE_FRACTION || b.rendered >= GATE_RENDERED_ALONE_SECONDS);

/** When each report's predecessors last moved the render (the share made changed): what the card's "No progress" counts from. */
function lastMovedAts(run: ReplayRun): number[] {
  let last = run.samples[0][0];
  let previous: number | null = null;
  return run.samples.map(([atMs, outMs]) => {
    const fraction = fractionOf(run, outMs);
    if (previous === null || fraction !== previous) last = atMs;
    previous = fraction;
    return last;
  });
}

const quietAt = (run: ReplayRun, index: number, moved: readonly number[]): boolean =>
  Math.round((run.samples[index][0] - moved[index]) / 1000) >= QUIET_SECONDS;

/** Where a grid figure sits, counted in steps: 30 is 0, whole minutes to 10 are 1 to 10, 5 minutes to an hour, quarter hours after. */
function gridRank(seconds: number): number {
  if (seconds <= 30) return 0;
  if (seconds <= 600) return seconds / 60;
  if (seconds <= 3600) return 10 + (seconds - 600) / 300;
  return 20 + (seconds - 3600) / 900;
}

const kindOf = (words: string): "none" | "figure" | "finishing" | "longer" =>
  words === ""
    ? "none"
    : words === FINISHING_WORDS
      ? "finishing"
      : words === LONGER_WORDS
        ? "longer"
        : "figure";

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

// ── the rules, each as a list of what breaks it (empty = true) ─────────────────────────────────────────────────────────

/** The card, the dialog (its own feed) and the dialog (the job's answer) say the same words, and the assistant's figure is the card's. */
function agreementViolations(run: { readonly id: string }, beats: readonly Beat[]): string[] {
  const out: string[] = [];
  for (const b of beats) {
    if (b.said.startsWith("?? "))
      out.push(`${label(run, b)}: the card's line is not front + words: ${b.line}`);
    if (b.panel.timeLeft !== b.said)
      out.push(`${label(run, b)}: card "${b.said}", dialog "${b.panel.timeLeft}"`);
    if (b.jobSaid !== b.said)
      out.push(`${label(run, b)}: card "${b.said}", dialog from the job "${b.jobSaid}"`);
    if (b.panel.status !== b.front)
      out.push(`${label(run, b)}: card front "${b.front}", dialog "${b.panel.status}"`);
  }
  return out;
}

/** Nothing before the gate (except "Finishing" from 90 %), and the first thing said is a figure or "Finishing", never "taking longer". */
function gateViolations(run: { readonly id: string }, beats: readonly Beat[]): string[] {
  const out: string[] = [];
  for (const b of beats) {
    if (gateOpen(b) || b.share >= FINISHING_SHARE) continue;
    if (b.said !== "" || b.shown !== null || b.panel.timeLeft !== "" || b.jobSaid !== "")
      out.push(
        `${label(run, b)}: "${b.said}" said before the gate (${b.rendered.toFixed(1)} s rendered)`,
      );
  }
  const first = beats.find((b) => b.said !== "");
  if (first && !(isFigureWords(first.said) || first.said === FINISHING_WORDS))
    out.push(`${label(run, first)}: the first thing said is "${first.said}"`);
  return out;
}

/** Every figure said is on the rounding grid, is the figure behind the words, and the words are its words. */
function gridViolations(run: { readonly id: string }, beats: readonly Beat[]): string[] {
  const out: string[] = [];
  for (const b of beats) {
    if (b.shown !== null) {
      if (!Number.isInteger(b.shown) || b.shown <= 0 || roundTimeLeft(b.shown) !== b.shown)
        out.push(`${label(run, b)}: ${b.shown} s is not on the grid`);
      if (b.said !== `${describeExportTime(b.shown)} left`)
        out.push(`${label(run, b)}: the figure is ${b.shown} s but the words are "${b.said}"`);
      if (!isFigureWords(b.said)) out.push(`${label(run, b)}: "${b.said}" is not a figure's words`);
    } else if (isFigureWords(b.said)) {
      out.push(`${label(run, b)}: "${b.said}" has no figure behind it`);
    }
  }
  return out;
}

/** "Finishing" from 90 % made at every later report, never a number, and never before. */
function finishingViolations(run: { readonly id: string }, beats: readonly Beat[]): string[] {
  const out: string[] = [];
  for (const b of beats) {
    const finishing = b.said === FINISHING_WORDS;
    if (b.share >= FINISHING_SHARE !== finishing)
      out.push(`${label(run, b)}: "${b.said}" ${finishing ? "before" : "after"} 90 % made`);
    if (b.share >= FINISHING_SHARE && (b.shown !== null || b.panel.timeLeft !== FINISHING_WORDS))
      out.push(`${label(run, b)}: a number after 90 % made (shown ${b.shown})`);
  }
  return out;
}

/** Once something has been said the words are never empty again (within a normally moving run). */
function flickerViolations(run: { readonly id: string }, beats: readonly Beat[]): string[] {
  const first = beats.findIndex((b) => b.said !== "");
  if (first < 0) return [];
  const back = beats.findIndex((b, i) => i > first && b.said === "");
  return back < 0 ? [] : [`${label(run, beats[back])}: nothing said after "${beats[first].said}"`];
}

/** "taking longer" is never the first thing said, and once said it is the only thing said until "Finishing". */
function longerViolations(run: { readonly id: string }, beats: readonly Beat[]): string[] {
  const out: string[] = [];
  const at = beats.findIndex((b) => b.said === LONGER_WORDS);
  if (at < 0) return out;
  if (!beats.slice(0, at).some((b) => isFigureWords(b.said)))
    out.push(`${label(run, beats[at])}: "taking longer" before any figure`);
  for (const b of beats.slice(at + 1)) {
    if (b.said !== LONGER_WORDS && b.said !== FINISHING_WORDS)
      out.push(`${label(run, b)}: "${b.said}" after "taking longer"`);
    if (b.shown !== null)
      out.push(`${label(run, b)}: a figure (${b.shown} s) after "taking longer"`);
  }
  return out;
}

const everyRule = (run: { readonly id: string }, beats: readonly Beat[]): string[] => [
  ...agreementViolations(run, beats),
  ...gateViolations(run, beats),
  ...gridViolations(run, beats),
  ...finishingViolations(run, beats),
  ...flickerViolations(run, beats),
  ...longerViolations(run, beats),
];

/** One failing line per violation, at most a few, with the total: a long list is no evidence. */
function expectNone(problems: readonly string[]): void {
  expect({ count: problems.length, first: problems.slice(0, 6) }).toEqual({ count: 0, first: [] });
}

/** Every number this file observes, for the findings document. */
const OBSERVED: Record<string, unknown> = {};

afterEach(() => {
  vi.useRealTimers();
  useExportJob.setState({ live: null, finishing: {} });
  useExportJob.getState().reset();
});

// ── the recorded feeds ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the recorded feeds, as this file needs them", () => {
  it("no run was made in parts: the recorded reports carry no step or steps, so the parts rule is proven on relabelled feeds only", () => {
    const inParts = REPLAY_RUNS.filter(
      (run) => "step" in run || "steps" in run || run.samples.some((sample) => sample.length !== 2),
    );
    OBSERVED.runs = REPLAY_RUNS.length;
    OBSERVED.runsMadeInParts = inParts.length;
    OBSERVED.runsOfStreamedKinds = REPLAY_RUNS.filter((run) =>
      run.kind.includes("streamed"),
    ).length;
    expect(inParts.map((run) => run.id)).toEqual([]);
  });

  it("no run stands still for as long as the card's 'No progress' needs, so every silence below is the test's own", () => {
    const longest = REPLAY_RUNS.map((run) => {
      const moved = lastMovedAts(run);
      return Math.max(...run.samples.map(([atMs], i) => (atMs - moved[i]) / 1000));
    });
    OBSERVED.longestStandStillSeconds = Math.max(...longest);
    expect(Math.max(...longest)).toBeLessThan(QUIET_SECONDS);
  });
});

describe("the words the card and the dialog say, at every report of 88 real runs", () => {
  it("1 EQUIVALENCE: the card, the dialog and the assistant's figure are the rule's answer for the same reports, at every report of every run", () => {
    const bad: string[] = [];
    let beats = 0;
    let figures = 0;
    for (const { run, beats: played, pure } of PLAYED()) {
      for (const b of played) {
        beats++;
        const answer = pure[b.index];
        const words = describeTimeLeft(answer);
        const figure = answer.kind === "left" ? answer.seconds : null;
        if (words !== "") figures++;
        if (b.said !== words)
          bad.push(`${label(run, b)}: the card says "${b.said}", the rule says "${words}"`);
        if (b.panel.timeLeft !== words)
          bad.push(
            `${label(run, b)}: the dialog says "${b.panel.timeLeft}", the rule says "${words}"`,
          );
        if (b.jobSaid !== words)
          bad.push(
            `${label(run, b)}: the dialog (job) says "${b.jobSaid}", the rule says "${words}"`,
          );
        if (b.shown !== figure)
          bad.push(`${label(run, b)}: the figure is ${b.shown}, the rule's is ${figure}`);
      }
    }
    OBSERVED.reportsPlayed = beats;
    OBSERVED.reportsWithWords = figures;
    expect(beats, "the replay has something to compare").toBeGreaterThan(8000);
    expect(figures, "the rule says something at many reports").toBeGreaterThan(4000);
    expectNone(bad);
  });

  it("2 the card and the dialog say the SAME words at every report, and the dialog's front is the card's", () => {
    expectNone(PLAYED().flatMap(({ run, beats }) => agreementViolations(run, beats)));
  });

  it("3 nothing is said before the gate, and the first thing said is a figure (or Finishing for a run that was 90 % made before the gate)", () => {
    const played = PLAYED();
    expectNone(played.flatMap(({ run, beats }) => gateViolations(run, beats)));
    // The gate really opens: a run that was past it before 90 % made says a figure; one that never was says nothing but "Finishing".
    const noFigure: string[] = [];
    const startsWith = { figure: 0, finishing: 0, nothing: 0 };
    const firstFigure: Array<{
      renderedSeconds: number;
      share: number;
      fromPictureSeconds: number;
    }> = [];
    for (const { run, beats } of played) {
      const pastGate = beats.some((b) => gateOpen(b) && b.share < FINISHING_SHARE);
      const figureAt = beats.findIndex((b) => isFigureWords(b.said));
      const first = beats.find((b) => b.said !== "");
      startsWith[first ? (kindOf(first.said) === "figure" ? "figure" : "finishing") : "nothing"]++;
      if (pastGate && figureAt < 0) noFigure.push(`${run.id}: past the gate and never a figure`);
      if (!pastGate && figureAt >= 0)
        noFigure.push(`${run.id}: a figure although the gate never opened`);
      if (figureAt >= 0) {
        const b = beats[figureAt];
        const picture = run.samples.find((sample) => sample[1] > 0);
        firstFigure.push({
          renderedSeconds: b.rendered,
          share: b.share,
          fromPictureSeconds: (b.atMs - (picture ? picture[0] : run.samples[0][0])) / 1000,
        });
      }
    }
    OBSERVED.firstThingSaid = startsWith;
    OBSERVED.firstFigure = {
      runs: firstFigure.length,
      medianSecondsAfterFirstReport: median(firstFigure.map((f) => f.renderedSeconds)),
      maxSecondsAfterFirstReport: Math.max(...firstFigure.map((f) => f.renderedSeconds)),
      medianShare: median(firstFigure.map((f) => f.share)),
      runsWithFigureUnder20sAfterFirstPicture: firstFigure.filter((f) => f.fromPictureSeconds < 20)
        .length,
      minSecondsAfterFirstPicture: Math.min(...firstFigure.map((f) => f.fromPictureSeconds)),
    };
    expect(noFigure).toEqual([]);
    expect(startsWith.nothing, "every run says something at the end of it").toBe(0);
    expect(startsWith.figure, "most runs begin with a figure").toBeGreaterThan(60);
  });

  it("4 every figure said is on the rounding grid, and its words are describeExportTime(figure) + ' left'", () => {
    const played = PLAYED();
    expectNone(played.flatMap(({ run, beats }) => gridViolations(run, beats)));
    const seen = new Set(played.flatMap(({ beats }) => beats.map((b) => b.shown)));
    expect(seen.has(30), "the 'under a minute' band was said").toBe(true);
    expect(
      [...seen].some((s) => s !== null && s >= 120 && s <= 600),
      "whole minutes were said",
    ).toBe(true);
    OBSERVED.figuresSaid = [...seen].filter((s): s is number => s !== null).sort((a, b) => a - b);
  });

  it("5 from 90 % done the words are 'Finishing' at every report, never a number, and 'Finishing' is never said before 90 %", () => {
    const played = PLAYED();
    expectNone(played.flatMap(({ run, beats }) => finishingViolations(run, beats)));
    // The whole line a person reads at the first 'Finishing' of each run, built by hand from the report: how long it has been going, the stage and the percent.
    const bad: string[] = [];
    for (const { run, beats } of played) {
      const b = beats.find((x) => x.said === FINISHING_WORDS);
      if (!b) {
        bad.push(`${run.id}: never said Finishing`);
        continue;
      }
      const minutes = Math.floor(b.atMs / 60_000);
      const stillWorking = minutes >= 1 ? `Still working · ${minutes} min in · ` : "";
      const expected = `${stillWorking}Rendering and encoding · ${Math.round(b.fraction * 100)}% · Finishing`;
      if (b.line !== expected) bad.push(`${label(run, b)}: "${b.line}", expected "${expected}"`);
    }
    expectNone(bad);
  });

  it("6 once something has been said the words are never empty again: no flicker back to nothing", () => {
    expectNone(PLAYED().flatMap(({ run, beats }) => flickerViolations(run, beats)));
  });

  it("7 the old raw pace is NOT what is said: the words differ from the 0.28.0 words, and the render's own figure changes nothing", () => {
    const played = PLAYED();
    let differing = 0;
    let before = 0;
    const runsThatDiffer = new Set<string>();
    for (const { run, beats } of played)
      for (const b of beats)
        if (b.oldSaid !== b.said) {
          differing++;
          runsThatDiffer.add(run.id);
          if (b.oldSaid !== "" && b.said === "") before++;
        }
    OBSERVED.oldWordsDiffer = {
      reports: differing,
      runs: runsThatDiffer.size,
      oldFigureWhereNowNothing: before,
    };
    expect(
      runsThatDiffer.size,
      "every run is told something else than the raw pace would have said",
    ).toBe(REPLAY_RUNS.length);
    expect(before, "the raw pace said a time at reports where nothing is said now").toBeGreaterThan(
      500,
    );
    // The words of a run do not depend on the raw figure: three wildly different ones give the very words the realistic one gave.
    const bad: string[] = [];
    const wild: Array<[string, NonNullable<PlayOptions["eta"]>]> = [
      ["none", () => null],
      ["1 s", () => 1],
      ["27 h", () => 100_000],
    ];
    for (const { run, beats } of played) {
      for (const [name, eta] of wild) {
        const other = play(run, { eta });
        other.forEach((b, i) => {
          const base = beats[i];
          if (
            b.said !== base.said ||
            b.shown !== base.shown ||
            b.panel.timeLeft !== base.panel.timeLeft ||
            b.jobSaid !== base.jobSaid
          )
            bad.push(
              `${label(run, b)}: with the raw figure ${name} the card says "${b.said}", with the realistic one "${base.said}"`,
            );
        });
      }
    }
    expectNone(bad);
  });

  it("8 FALSE ALARMS: through the consumers, how many of the healthy runs are ever told 'taking longer than expected'", () => {
    const alarms = PLAYED()
      .filter(({ beats }) => beats.some((b) => b.said === LONGER_WORDS))
      .map(({ run, beats }) => {
        const b = beats.find((x) => x.said === LONGER_WORDS) as Beat;
        return `${run.id}@${Math.round(b.share * 100)}%`;
      });
    OBSERVED.falseAlarmRuns = alarms;
    OBSERVED.falseAlarmCount = alarms.length;
    expect(alarms, "healthy runs told 'taking longer than expected'").toEqual([]);
    expectNone(PLAYED().flatMap(({ run, beats }) => longerViolations(run, beats)));
  });
});

// ── a render made in parts (synthetic: the recordings have none) ───────────────────────────────────────────────────────

describe("a render made in 4 parts, the last being the final encode (a real run's reports relabelled)", () => {
  it("9 the card and the dialog say nothing at all while a part before the last is reported, and a figure or Finishing at the final encode once its own gate has passed", () => {
    const bad: string[] = [];
    let runsWithFigureInFinalEncode = 0;
    let longEnough = 0;
    let earlierBeats = 0;
    const kinds = { figure: 0, longer: 0 };
    for (const run of REPLAY_RUNS) {
      const beats = play(run, { parts: true });
      // The oracle for the final encode: the pure rule given the same parts (it is the store that has to hand it the step and steps).
      let state = startPace();
      const pure = beats.map((b) => {
        state = notePace(state, { at: b.atMs, fraction: b.fraction, step: b.step, steps: PARTS });
        return state.value;
      });
      const finalStart = beats.find((b) => b.step === PARTS - 1);
      for (const b of beats) {
        const answer = describeTimeLeft(pure[b.index]);
        if (b.step !== null && b.step < PARTS - 1) {
          earlierBeats++;
          if (b.said !== "" || b.panel.timeLeft !== "" || b.jobSaid !== "" || b.shown !== null)
            bad.push(`${label(run, b)}: something is said at part ${b.step + 1}: "${b.said}"`);
          if (!b.front.includes(`Rendering part ${b.step + 1} of ${PARTS - 1}`))
            bad.push(`${label(run, b)}: the card does not name the part: "${b.front}"`);
          continue;
        }
        if (!b.front.includes("Encoding"))
          bad.push(`${label(run, b)}: the final encode is not named: "${b.front}"`);
        if (b.said !== answer || b.panel.timeLeft !== answer || b.jobSaid !== answer)
          bad.push(
            `${label(run, b)}: card "${b.said}", dialog "${b.panel.timeLeft}", job "${b.jobSaid}", the rule says "${answer}"`,
          );
        // From the raw reports: the final encode has its own clock and gate; its share is far past 15 %, so 20 s of it open the gate.
        const own = finalStart ? (b.atMs - finalStart.atMs) / 1000 : 0;
        if (own < GATE_RENDERED_SECONDS && b.share < FINISHING_SHARE && b.said !== "")
          bad.push(`${label(run, b)}: "${b.said}" ${own.toFixed(1)} s into the final encode`);
        if (b.share >= FINISHING_SHARE && b.said !== FINISHING_WORDS)
          bad.push(`${label(run, b)}: "${b.said}" at ${Math.round(b.share * 100)} % made`);
        if (b.shown !== null && roundTimeLeft(b.shown) !== b.shown)
          bad.push(`${label(run, b)}: ${b.shown} s is not on the grid`);
      }
      const final = beats.filter((b) => b.step === PARTS - 1 && b.share < FINISHING_SHARE);
      if (
        finalStart &&
        final.some((b) => (b.atMs - finalStart.atMs) / 1000 >= GATE_RENDERED_SECONDS + 5)
      ) {
        longEnough++;
        const said = final.find((b) => b.said !== "");
        if (said) {
          runsWithFigureInFinalEncode++;
          kinds[kindOf(said.said) === "longer" ? "longer" : "figure"]++;
        } else
          bad.push(`${run.id}: a final encode of 25 s or more before 90 % never said a figure`);
      }
    }
    OBSERVED.parts = {
      earlierBeats,
      runsWhoseFinalEncodeLastedOver25s: longEnough,
      runsWithFigureInFinalEncode,
      firstSaidKinds: kinds,
    };
    expectNone(bad);
    expect(earlierBeats, "the relabelled feeds have parts before the last").toBeGreaterThan(3000);
    // A final encode is a quarter of the run: only the longest recorded runs leave it 25 s before 90 % (9 of 88 observed).
    expect(
      longEnough,
      "enough runs have a final encode long enough to open its gate",
    ).toBeGreaterThanOrEqual(5);
  });

  it("9b at a part before the last nothing is said even when a figure is stored for the feed, and at the final encode the stored figure is said again", () => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    try {
      const { run, beats } = PLAYED().find(({ beats }) =>
        beats.some((b) => b.share >= 0.4 && isFigureWords(b.said)),
      ) as Played;
      const at = beats.findIndex((b) => b.share >= 0.4 && isFigureWords(b.said));
      begin("run");
      const next = player(run);
      let last = next(0);
      for (let i = 1; i <= at; i++) last = next(i);
      expect(isFigureWords(last.said), "a figure is said before any part is named").toBe(true);
      // The feed's own answer is a figure; only its part changes (whatever put the figure there, an earlier part has no time left to say).
      const inPart = (step: number): void =>
        useExportJob.setState((s) => ({
          live: s.live ? { ...s.live, step, steps: PARTS } : null,
        }));
      for (const step of [0, 1, 2]) {
        inPart(step);
        const b = read("run");
        expect([b.said, b.panel.timeLeft, b.shown], `at part ${step + 1}`).toEqual(["", "", null]);
      }
      inPart(PARTS - 1);
      const final = read("run");
      expect([final.said, final.panel.timeLeft, final.shown]).toEqual([
        last.said,
        last.said,
        last.shown,
      ]);
    } finally {
      end("run");
    }
  });
});

// ── a frozen export ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Tick {
  readonly silence: number;
  readonly reading: Reading;
}

/** A run that goes quiet right after report `pivot`: nothing at all is reported for `silenceMs`, the card's clock redraws every 10 s, and the rest follows. */
function playFrozen(source: ReplayRun, pivot: number, silenceMs: number) {
  const frozen: ReplayRun = {
    ...source,
    endMs: source.endMs + silenceMs,
    samples: [
      ...source.samples.slice(0, pivot + 1),
      ...source.samples.slice(pivot + 1).map(([t, o]) => [t + silenceMs, o] as const),
    ],
  };
  vi.useFakeTimers({ now: START, toFake: ["Date"] });
  try {
    begin("run");
    const next = player(frozen);
    const beats: Beat[] = [];
    for (let i = 0; i <= pivot; i++) beats.push(next(i));
    const lastAt = START + frozen.samples[pivot][0];
    const ticks: Tick[] = [];
    for (let silence = 10_000; silence <= silenceMs; silence += 10_000) {
      vi.setSystemTime(lastAt + silence);
      ticks.push({ silence, reading: read("run") });
    }
    for (let i = pivot + 1; i < frozen.samples.length; i++) beats.push(next(i));
    return { frozen, beats, ticks };
  } finally {
    end("run");
  }
}

describe("a frozen export: every report stops for 70 s while a figure is on screen", () => {
  it("10 the card and the dialog carry no time left once 60 s have passed and say 'No progress for N s'; when the reports resume the words are back", () => {
    const bad: string[] = [];
    const frozenRuns = [0, 0];
    let silentTicks = 0;
    const figureAgain = [0, 0];
    const longerAgain = [0, 0];
    // Two moments: the first report at 40 % made, and the last one below 80 % (the stop is then a small part of the whole run).
    for (const { run, beats } of PLAYED())
      for (const [which, pivot] of [
        beats.findIndex((b) => b.share >= 0.4),
        beats.map((b) => b.share < 0.8).lastIndexOf(true),
      ].entries()) {
        if (pivot < 0 || !isFigureWords(beats[pivot].said) || beats[pivot].share >= 0.8) continue;
        frozenRuns[which]++;
        const { frozen, beats: all, ticks } = playFrozen(run, pivot, 70_000);
        const moved = lastMovedAts(frozen);
        const lastAt = frozen.samples[pivot][0];
        for (const { silence, reading } of ticks) {
          const quiet = Math.round((lastAt + silence - moved[pivot]) / 1000);
          const at = `${run.id} ${silence / 1000} s after the last report`;
          if (quiet >= QUIET_SECONDS) {
            silentTicks++;
            if (!reading.line.startsWith(`No progress for ${quiet} s · `))
              bad.push(
                `${at}: the card says "${reading.line}", expected No progress for ${quiet} s`,
              );
            if (
              reading.said !== "" ||
              reading.shown !== null ||
              reading.panel.timeLeft !== "" ||
              /left|Finishing|longer/.test(reading.line)
            )
              bad.push(
                `${at}: time left is still said: "${reading.line}" / dialog "${reading.panel.timeLeft}" / ${reading.shown}`,
              );
          } else if (
            reading.said !== all[pivot].said ||
            reading.panel.timeLeft !== all[pivot].said
          ) {
            bad.push(`${at}: before 60 s of silence the words changed: "${reading.said}"`);
          }
        }
        // The reports resume: the words are the rule's again (a figure on the grid, or "taking longer" once the stop made the run late), never nothing and never 'No progress'.
        const pure = replayRun(frozen).map((record) => record.value);
        for (const b of all.slice(pivot + 1)) {
          const quiet = quietAt(frozen, b.index, moved);
          const expected = quiet ? "" : describeTimeLeft(pure[b.index]);
          if (b.said !== expected)
            bad.push(
              `${label(run, b)}: after the stop the card says "${b.said}", expected "${expected}"`,
            );
          if (!quiet && b.panel.timeLeft !== expected)
            bad.push(`${label(run, b)}: after the stop the dialog says "${b.panel.timeLeft}"`);
          if (!quiet && b.said === "")
            bad.push(`${label(run, b)}: nothing said after the reports resumed`);
          if (!quiet && b.line.includes("No progress"))
            bad.push(`${label(run, b)}: still "No progress": ${b.line}`);
        }
        const back = all[pivot + 1];
        if (kindOf(back.said) === "figure") figureAgain[which]++;
        else if (kindOf(back.said) === "longer") longerAgain[which]++;
        bad.push(...gridViolations(run, all.slice(pivot + 1)));
      }
    OBSERVED.frozen = {
      at40Percent: {
        runs: frozenRuns[0],
        figureBack: figureAgain[0],
        takingLonger: longerAgain[0],
      },
      at80Percent: {
        runs: frozenRuns[1],
        figureBack: figureAgain[1],
        takingLonger: longerAgain[1],
      },
      silentReadings: silentTicks,
    };
    expect(frozenRuns[0], "enough runs were frozen with a figure on screen").toBeGreaterThan(40);
    expect(silentTicks, "the silence was long enough to be quiet").toBeGreaterThan(frozenRuns[0]);
    expectNone(bad);
    // A run stopped late for 70 s is still on time enough to be told a figure again (the rest, 'taking longer', is the rule: the stop made it late).
    expect(figureAgain[1], "runs told a figure again when the reports resumed").toBeGreaterThan(0);
  });
});

// ── a restart ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a restart: a new attempt starts the rule afresh, and the old attempt keeps its own words", () => {
  it("11 attempt 1 says 'Finishing' at 95 %; attempt 2 never says it before 90 % of its own and says a figure after its own gate; the old attempt is untouched", () => {
    const bad: string[] = [];
    let attempts = 0;
    for (const { run, pure } of PLAYED()) {
      attempts++;
      vi.useFakeTimers({ now: START, toFake: ["Date"] });
      try {
        begin("attempt1");
        const one = player(run, { id: "attempt1" });
        let said: Beat | null = null;
        for (let i = 0; i < run.samples.length; i++) {
          said = one(i);
          if (said.share >= 0.95) break;
        }
        if (!said || said.said !== FINISHING_WORDS || said.jobSaid !== FINISHING_WORDS)
          bad.push(`${run.id}: attempt 1 at 95 % says "${said?.said}" / "${said?.jobSaid}"`);

        // The supervisor starts the next attempt: a new feed, its rule starts again.
        const origin = Date.now() + 4_000;
        vi.setSystemTime(origin);
        const store = useExportJob.getState();
        store.beginLive("attempt2");
        store.setLiveStage("attempt2", "rendering");
        const old = liveFeedOf(useExportJob.getState(), "attempt1");
        const atBegin = read("attempt2");
        if (atBegin.said !== "" || atBegin.jobSaid !== "")
          bad.push(
            `${run.id}: attempt 2 says "${atBegin.said}" / "${atBegin.jobSaid}" before its first report`,
          );

        const two = player(run, { id: "attempt2", start: origin });
        const beats: Beat[] = [];
        run.samples.forEach((_, i) => {
          const b = two(i);
          beats.push(b);
          // The old attempt is checking its file: its own words, with no time left, whatever attempt 2 and the dialog's job say meanwhile.
          const feed = liveFeedOf(useExportJob.getState(), "attempt1");
          const now = Date.now();
          const line = feed ? describeLiveStatus(feed, now) : "";
          const panel = feed ? dialogOf(feed, now) : null;
          if (!line.endsWith("Checking the file") || panel === null || panel.timeLeft !== "")
            bad.push(
              `${label(run, b)}: the old attempt says "${line}" / dialog "${panel?.timeLeft}"`,
            );
        });
        for (const b of beats) {
          const words = describeTimeLeft(pure[b.index]);
          if (b.said !== words || b.panel.timeLeft !== words || b.jobSaid !== words)
            bad.push(
              `${label(run, b)}: attempt 2 says "${b.said}" / "${b.panel.timeLeft}" / "${b.jobSaid}", a fresh run says "${words}"`,
            );
        }
        bad.push(...everyRule(run, beats));
        const feed = liveFeedOf(useExportJob.getState(), "attempt1");
        if (feed !== old) bad.push(`${run.id}: attempt 2's reports changed the old attempt's feed`);
        // Its own words, from its own memory: put it back to rendering and it still says what it said.
        store.setLiveStage("attempt1", "rendering");
        const again = liveFeedOf(useExportJob.getState(), "attempt1");
        const line = again ? describeLiveStatus(again, Date.now()) : "";
        if (!line.endsWith(` · ${FINISHING_WORDS}`))
          bad.push(`${run.id}: the old attempt, rendering again, says "${line}"`);
      } finally {
        end("attempt1", "attempt2");
      }
    }
    expect(attempts).toBe(REPLAY_RUNS.length);
    expectNone(bad);
  });
});

// ── slowdowns built from real feeds ────────────────────────────────────────────────────────────────────────────────────

const SLOW_FROM = 0.4;
const FACTORS = [1.2, 1.5, 2, 3] as const;

const SLOWED = memo(
  () =>
    new Map(
      FACTORS.map((factor) => [
        factor,
        REPLAY_RUNS.map((run) => ({ run, beats: play(slowedFrom(run, SLOW_FROM, factor)) })),
      ]),
    ),
);

describe("a slow-down built from a real run: 'taking longer than expected'", () => {
  it("12 three times slower from 40 % says 'taking longer than expected' and then never a figure again until Finishing; a healthy run never does", () => {
    const base = PLAYED();
    // A run that was already told a figure when it slowed down is the one a slow-down can be told about.
    const eligible = new Set(
      base
        .filter(({ beats }) => {
          const pivot = beats.findIndex((b) => b.share >= SLOW_FROM);
          return pivot >= 0 && isFigureWords(beats[pivot].said);
        })
        .map(({ run }) => run.id),
    );
    const table: Array<Record<string, unknown>> = [];
    for (const factor of FACTORS) {
      const rows = SLOWED().get(factor) ?? [];
      const told = rows.filter(({ beats }) => beats.some((b) => b.said === LONGER_WORDS));
      const at = told.map(
        ({ beats }) => (beats.find((b) => b.said === LONGER_WORDS) as Beat).share,
      );
      table.push({
        factor,
        told: told.length,
        of: rows.length,
        toldAmongEligible: told.filter(({ run }) => eligible.has(run.id)).length,
        eligible: eligible.size,
        medianShareWhenFirstTold: median(at),
        notToldAmongEligible: rows
          .filter(
            ({ run, beats }) => eligible.has(run.id) && !beats.some((b) => b.said === LONGER_WORDS),
          )
          .map(({ run }) => run.id),
      });
    }
    OBSERVED.slowdownFrom40Percent = table;
    OBSERVED.eligibleForSlowdown = eligible.size;
    // Every slowed feed obeys every rule (the words, the grid, the order, the hold), and 'longer' holds until Finishing.
    for (const factor of FACTORS)
      expectNone((SLOWED().get(factor) ?? []).flatMap(({ run, beats }) => everyRule(run, beats)));
    const three = SLOWED().get(3) ?? [];
    const missed = three.filter(
      ({ run, beats }) => eligible.has(run.id) && !beats.some((b) => b.said === LONGER_WORDS),
    );
    expect(eligible.size, "enough runs had a figure when they slowed down").toBeGreaterThan(35);
    // An OBSERVATION, not a claim: 62 of the 67 runs that had a figure at 40 % are told 'taking longer' when they turn 3 times slower; the 5 that are
    // not are five repeats of one project (T5.STRONG.b1.s1.p03 to p07, see the findings). The count may fall, it must not grow unnoticed.
    expect(
      missed.map(({ run }) => run.id),
      "runs told a figure at 40 % that a 3 times slow-down did not make 'taking longer'",
    ).toHaveLength(5);
    expect(
      (eligible.size - missed.length) / eligible.size,
      "the share of the runs with a figure that a 3 times slow-down is told about",
    ).toBeGreaterThanOrEqual(0.9);
    expect(
      base.filter(({ beats }) => beats.some((b) => b.said === LONGER_WORDS)).length,
      "no slow-down: no run is told 'taking longer'",
    ).toBe(0);
  });
});

// ── the same feed, differently: later in time, and reported half as often ──────────────────────────────────────────────

describe("the same real feed in another clock and at another cadence", () => {
  it("13 a feed shifted in time says the same words at every report, and the whole line does not depend on where the clock began", () => {
    const bad: string[] = [];
    for (const { run, beats } of PLAYED()) {
      // The reports arrive 16 minutes after the export's turn began (a long preparation).
      const late = play(shifted(run, 987_654));
      late.forEach((b, i) => {
        const base = beats[i];
        if (
          b.said !== base.said ||
          b.shown !== base.shown ||
          b.panel.timeLeft !== base.panel.timeLeft
        )
          bad.push(`${label(run, b)}: shifted "${b.said}", original "${base.said}"`);
      });
      // The clock itself begins elsewhere: nothing at all changes.
      const elsewhere = play(run, { start: START + 86_400_000 * 400 });
      elsewhere.forEach((b, i) => {
        if (b.line !== beats[i].line || b.shown !== beats[i].shown)
          bad.push(
            `${label(run, b)}: another clock origin "${b.line}", original "${beats[i].line}"`,
          );
      });
      bad.push(...everyRule(run, late));
    }
    expectNone(bad);
  });

  it("13 a feed reported half as often says its first figure within one grid step of the original's, 'Finishing' at the first report that reaches 90 %, and obeys every rule", () => {
    const bad: string[] = [];
    let compared = 0;
    let same = 0;
    let sameFirst = 0;
    let withinOne = 0;
    for (const { run, beats } of PLAYED()) {
      const coarse = play(coarser(run));
      bad.push(...everyRule(run, coarse));
      const finishing = coarse.find((b) => b.share >= FINISHING_SHARE);
      if (finishing && finishing.said !== FINISHING_WORDS)
        bad.push(`${label(run, finishing)}: the first report at 90 % says "${finishing.said}"`);
      const a = beats.find((b) => b.shown !== null);
      const c = coarse.find((b) => b.shown !== null);
      if (!a !== !c) bad.push(`${run.id}: a figure in one feed and none in the other`);
      else if (a && c && a.shown !== null && c.shown !== null) {
        const apart = Math.abs(gridRank(a.shown) - gridRank(c.shown));
        if (apart <= 1) withinOne++;
        if (apart === 0) sameFirst++;
        if (apart > 1)
          bad.push(`${run.id}: first figure ${a.shown} s, with half the reports ${c.shown} s`);
      }
      // The same moments in both feeds: the kind of words said is the same at nearly every one.
      const byTime = new Map(beats.map((b) => [b.atMs, b]));
      for (const b of coarse) {
        const original = byTime.get(b.atMs);
        if (!original) continue;
        compared++;
        if (kindOf(original.said) === kindOf(b.said)) same++;
      }
    }
    OBSERVED.coarser = {
      runsWithinOneGridStep: withinOne,
      runsWithTheSameFirstFigure: sameFirst,
      momentsCompared: compared,
      momentsWithTheSameKindOfWords: same,
    };
    expect(same / compared, "the kind of words at the same moments").toBeGreaterThan(0.95);
    expectNone(bad);
  });
});

// ── garbage feeds ──────────────────────────────────────────────────────────────────────────────────────────────────────

const GARBAGE_TEXT = /NaN|undefined|null|Infinity|\[object|-\d/;

describe("random feeds: shares that go backwards or repeat, random gaps, garbage numbers", () => {
  const number = fc.oneof(
    { weight: 6, arbitrary: fc.double({ min: -50, max: 5_000, noNaN: true }) },
    { weight: 2, arbitrary: fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, 1e300) },
  );
  const move = fc.oneof(
    { weight: 8, arbitrary: fc.constant("advance" as const) },
    { weight: 2, arbitrary: fc.constant("repeat" as const) },
    { weight: 2, arbitrary: fc.constant("back" as const) },
    { weight: 2, arbitrary: fc.constant("garbage" as const) },
  );
  const reportOf = (withParts: boolean) =>
    fc.record({
      move,
      gain: fc.double({ min: 0, max: 0.08, noNaN: true }),
      back: fc.double({ min: 0, max: 1, noNaN: true }),
      garbage: fc.constantFrom<number | null>(
        Number.NaN,
        Infinity,
        -Infinity,
        -0.5,
        7,
        1e300,
        null,
      ),
      gap: fc.oneof(
        { weight: 7, arbitrary: fc.integer({ min: 0, max: 4_000 }) },
        { weight: 2, arbitrary: fc.integer({ min: 0, max: 150_000 }) },
      ),
      idle: fc.oneof(
        { weight: 12, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 200_000 }) },
      ),
      frame: number,
      speed: number,
      eta: fc.oneof(number, fc.constant(null)),
      parts: !withParts
        ? fc.constant<readonly [number | null, number | null]>([null, null])
        : fc.oneof(
            {
              weight: 6,
              arbitrary: fc.constant<readonly [number | null, number | null]>([null, null]),
            },
            {
              weight: 2,
              arbitrary: fc.tuple(fc.integer({ min: -1, max: 5 }), fc.integer({ min: 0, max: 5 })),
            },
            {
              weight: 1,
              arbitrary: fc.constant<readonly [number | null, number | null]>([1.5, Number.NaN]),
            },
          ),
    });

  it("never print NaN, undefined, null, Infinity or a negative number on the card or in the dialog, and every figure is on the grid", () => {
    const seen = { figure: 0, finishing: 0, longer: 0, quiet: 0 };
    const feeds = (withParts: boolean) =>
      fc.property(
        fc.oneof(
          fc.array(reportOf(withParts), { minLength: 1, maxLength: 8 }),
          // Long feeds, so that the rule's gate opens and its figures, "Finishing" and the silence are all reached.
          fc.array(reportOf(withParts), { minLength: 40, maxLength: 70, size: "max" }),
        ),
        (reports) => {
          vi.useFakeTimers({ now: START, toFake: ["Date"] });
          try {
            begin("run");
            let share = 0;
            for (const r of reports) {
              if (r.move === "advance") share = Math.min(1, share + r.gain);
              else if (r.move === "back") share = share * r.back;
              const fraction = r.move === "garbage" ? r.garbage : share;
              vi.setSystemTime(Date.now() + r.gap);
              useExportJob.getState().update({
                phase: "rendering",
                fraction: fraction as number | null,
                frame: r.frame,
                speed: r.speed,
                etaSec: r.eta,
                step: r.parts[0],
                steps: r.parts[1],
              });
              if (r.idle > 0) vi.setSystemTime(Date.now() + r.idle);
              const b = read("run");
              const pace = [
                b.panel.speed === null ? "" : `${b.panel.speed.toFixed(1)}×`,
                b.panel.timeLeft,
              ]
                .filter(Boolean)
                .join(" · ");
              for (const text of [b.line, b.panel.status, b.panel.timeLeft, pace, b.jobSaid])
                expect(text, `text: ${text}`).not.toMatch(GARBAGE_TEXT);
              for (const n of [b.panel.fraction, b.panel.speed])
                expect(n === null || (Number.isFinite(n) && n >= 0), `panel number ${n}`).toBe(
                  true,
                );
              if (b.shown !== null) {
                expect(roundTimeLeft(b.shown), `figure ${b.shown}`).toBe(b.shown);
                expect(b.said).toBe(`${describeExportTime(b.shown)} left`);
                expect(b.panel.timeLeft).toBe(b.said);
                seen.figure++;
              }
              if (b.said === FINISHING_WORDS) seen.finishing++;
              if (b.said === LONGER_WORDS) seen.longer++;
              if (b.line.includes("No progress")) seen.quiet++;
            }
          } finally {
            end("run");
          }
        },
      );
    fc.assert(feeds(false), { numRuns: 120 });
    // With garbage step and steps too: every change of part starts the rule's clock again, so figures are rarer here.
    fc.assert(feeds(true), { numRuns: 60 });
    OBSERVED.randomFeeds = seen;
    expect(seen.figure, "the random feeds reached figures").toBeGreaterThan(10);
    expect(seen.finishing, "the random feeds reached Finishing").toBeGreaterThan(5);
    expect(seen.quiet, "the random feeds went quiet").toBeGreaterThan(5);
  });
});

describe("the findings file", () => {
  it("writes every observed number to the file WIRING_REPORT names", () => {
    const target = process.env.WIRING_REPORT;
    if (!target) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(OBSERVED, null, 1), { encoding: "utf8" });
    expect(Object.keys(OBSERVED).length).toBeGreaterThan(5);
  });
});
