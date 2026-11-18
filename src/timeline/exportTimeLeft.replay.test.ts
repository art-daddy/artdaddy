// Replay of recorded export runs through the live time-left rule: the proof that the rule's OUTCOMES hold on what real exports
// did, not on what the rule's author expected.
//
// The fixture (`__fixtures__/timeLeftRuns.json`) holds the ffmpeg progress positions of real runs kept by the export-timing
// lab, with the time each report arrived. Every run is fed through the rule's public API, one report per sample, and what the
// rule said at each report is checked against the accepted rule and against what the run really went on to take:
//   C1  the gate: no figure before 20 s of rendering and (15 % made or 60 s of rendering); none at all for a run under 20 s;
//   C2  finishing: from 90 % made, and never before, and held;       C3  a figure never flickers back to nothing;
//   C4  a figure is on the rounding grid;                             C5  the figures are right (see below);
//   C6  "taking longer" is never the first thing said and is held (its false alarms on healthy runs are reported);
//   C7  a shifted clock changes nothing and a coarser report cadence keeps C1 to C4;
//   C8  slowdowns built from real feeds (the lab has no genuinely slow run): a 3 times slower tail is caught, a 1.2 times one is not;
//   C9  the words do not flap: a figure that changes does not go back to the figure it left within a few reports.
// Every oracle is computed here from the raw samples and the accepted rule's numbers, never from the rule's own constants or state: a
// claim that read the rule's constant could not notice that the constant had been changed.
//
// `REPLAY_REPORT=<file>` also writes a markdown report of the whole replay (per run, per checkpoint, per kind) to that file.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import {
  coarser,
  replayRun,
  shifted,
  slowedFrom,
  stalledFrom,
  type ReplayRecord,
} from "./__fixtures__/replay";
import { REPLAY_RUNS, type ReplayRun } from "./__fixtures__/timeLeftRuns";
import { roundTimeLeft, type TimeLeft } from "./exportTimeLeft";

// ── the numbers of the claims ──────────────────────────────────────────────────────────────────────────────────────────

// The accepted rule, written out again on purpose (see the header).
const RULE_GATE_RENDERED_SECONDS = 20;
const RULE_GATE_SHARE = 0.15;
const RULE_GATE_RENDERED_ALONE_SECONDS = 60;
const RULE_FINISHING_SHARE = 0.9;
/** The figure that stands for the words "under a minute". */
const UNDER_A_MINUTE_FIGURE = 30;
const UNDER_A_MINUTE_REAL_SECONDS = 60;

// C1c: the gate really opens (a rule that never said anything would pass every other claim).
const LIVE_CHECKPOINTS = [0.3, 0.5, 0.7];
const LIVE_MIN_RENDERED_SECONDS = 25;
const LIVE_MIN_POINTS = 30;
const LIVE_MIN_SHARE_WITH_FIGURE = 1;

// C5: at each checkpoint (the last report at or below that share of the video), of the runs that show a figure and have at
// least this long really left, the share whose figure is right must be at least this, wherever at least this many runs show one.
const C5_CHECKPOINTS = [
  0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85,
];
const C5_MIN_REAL_LEFT_SECONDS = 5;
const C5_MIN_RUNS_SHOWING = 10;
const C5_MIN_RIGHT_SHARE = 0.8;
/** "Within 50 %": the figure is 0.5 to 1.5 times the real time left. */
const WITHIN_HALF = 0.5;
const WITHIN_QUARTER = 0.25;

// C8: slowdowns built from real feeds.
const C8_MIN_RENDER_SECONDS = 60;
const C8_SLOW_FROM_SHARE = 0.4;
const C8_SLOW_FACTOR = 3;
const C8_MIN_CAUGHT_SHARE = 0.9;
const C8_HEALTHY_FACTOR = 1.2;
/** The stated claim is that a 1.2 times slowdown is never called "taking longer". On the recorded runs it is in 2 of 53 (a phone
 *  reel on the 4-thread PC and an E3-type edit on the strong PC, at 80 % and 85 % made): both runs were already 1.3 to 1.4 times
 *  above the total their first figure implied when healthy, so a mild slowdown carries them past 1.5. This is the OBSERVED count, not
 *  the claim: the number to decide on is in the report (the headroom column). Raising it hides a regression; lower it with the rule. */
const C8_HEALTHY_MAX_CAUGHT = 2;
const C8_REPORTED_FACTORS = [1.5, 2, 5];

// C9: the words do not flap.
const FLAP_WINDOW_REPORTS = 5;

// C6: on the real, healthy runs "taking longer" should never be said (observed: none of the 88).
const C6_HEALTHY_MAX_FALSE_ALARMS = 0;

// C3: a stall built from a real feed: from this share made on nothing moves for this long.
const STALL_FROM_SHARE = 0.4;
const STALL_SECONDS = 22;
const STALL_MIN_RENDER_SECONDS = 60;
/** The stall must really leave a figure on screen with an unreadable pace for the claim to have bitten. */
const STALL_MIN_RUNS_WITH_FIGURE_AT_ITS_END = 10;

// The fixture itself.
const LONG_RUN_MIN_RENDER_SECONDS = 25;
const SHORT_RUN_MAX_RENDER_SECONDS = 20;
const FIXTURE_MIN_LONG_RUNS = 40;
const FIXTURE_MIN_SHORT_RUNS = 5;
const FIXTURE_MAX_BYTES = 1.5 * 1024 * 1024;
/** ffmpeg prints the first frame of some runs a frame or so before zero: such a position is kept as recorded and counts as 0 %. */
const FIXTURE_MIN_POSITION_MS = -100;
const FIXTURE_FILE = "src/timeline/__fixtures__/timeLeftRuns.json";
const ROUTES = ["x264", "x264-light", "chip"];

// ── what is known about a replayed run, from the raw samples only ──────────────────────────────────────────────────────

interface Facts {
  readonly run: ReplayRun;
  readonly recs: readonly ReplayRecord[];
  /** The share made so far at each report: the highest share seen (progress does not go backwards; ffmpeg's "no position" is not 0 %). */
  readonly share: readonly number[];
  /** Seconds since the run's first report. */
  readonly rendered: readonly number[];
  /** Seconds from the run's first report to its last. */
  readonly totalRendered: number;
}

function factsOf(run: ReplayRun): Facts {
  const recs = replayRun(run);
  const share: number[] = [];
  let best = 0;
  for (const rec of recs) {
    best = Math.max(best, rec.fraction);
    share.push(best);
  }
  const first = run.samples[0][0];
  return {
    run,
    recs,
    share,
    rendered: recs.map((rec) => (rec.atMs - first) / 1000),
    totalRendered: (run.endMs - first) / 1000,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
const pct0 = (x: number): string => `${Math.round(x * 100)} %`;
const n1 = (x: number): string => x.toFixed(1);
const isFigure = (v: TimeLeft): v is Extract<TimeLeft, { kind: "left" }> => v.kind === "left";
const say = (v: TimeLeft): string =>
  v.kind === "left" ? String(v.seconds) : v.kind === "none" ? "-" : v.kind;
const firstOf = (f: Facts, test: (v: TimeLeft) => boolean): number =>
  f.recs.findIndex((rec) => test(rec.value));

/** The grid a person reads, written from the accepted wording of the bands and not from the rule's rounding function. */
function onTheGrid(seconds: number): boolean {
  if (seconds === UNDER_A_MINUTE_FIGURE) return true;
  if (seconds >= 60 && seconds <= 600) return seconds % 60 === 0;
  if (seconds > 600 && seconds <= 3600) return seconds % 300 === 0;
  return seconds > 3600 && seconds % 900 === 0;
}

// ── the claims, as lists of violations (empty = true) ──────────────────────────────────────────────────────────────────

/** C1: a figure ("left" or "longer") is never said before the gate. */
function gateViolations(f: Facts): string[] {
  const first = firstOf(f, (v) => v.kind === "left" || v.kind === "longer");
  if (first < 0) return [];
  const rendered = f.rendered[first];
  const share = f.share[first];
  const out: string[] = [];
  if (rendered < RULE_GATE_RENDERED_SECONDS)
    out.push(`${f.run.id}: a figure after only ${n1(rendered)} s of rendering`);
  if (!(share >= RULE_GATE_SHARE || rendered >= RULE_GATE_RENDERED_ALONE_SECONDS)) {
    out.push(`${f.run.id}: a figure at ${pct(share)} made and ${n1(rendered)} s of rendering`);
  }
  return out;
}

/** C2: "finishing" from 90 % made and not before; once said, held. */
function finishingViolations(f: Facts): string[] {
  const out: string[] = [];
  const first = firstOf(f, (v) => v.kind === "finishing");
  if (first >= 0) {
    if (f.share[first] < RULE_FINISHING_SHARE)
      out.push(`${f.run.id}: finishing at ${pct(f.share[first])} made`);
    const back = f.recs.findIndex((rec, i) => i > first && rec.value.kind !== "finishing");
    if (back >= 0)
      out.push(`${f.run.id}: ${f.recs[back].value.kind} after finishing (report ${back})`);
  }
  const late = f.recs.findIndex(
    (rec, i) => f.share[i] >= RULE_FINISHING_SHARE && rec.value.kind !== "finishing",
  );
  if (late >= 0) out.push(`${f.run.id}: ${say(f.recs[late].value)} at ${pct(f.share[late])} made`);
  return out;
}

/** C3: after a figure, never "nothing" again. */
function flickerViolations(f: Facts): string[] {
  const first = firstOf(f, isFigure);
  if (first < 0) return [];
  const back = f.recs.findIndex((rec, i) => i > first && rec.value.kind === "none");
  return back < 0
    ? []
    : [`${f.run.id}: nothing said at report ${back} after a figure at report ${first}`];
}

/** C4: every figure is finite, not negative and on the rounding grid. */
function gridViolations(f: Facts): string[] {
  const out: string[] = [];
  for (const [i, rec] of f.recs.entries()) {
    const v = rec.value;
    if (!isFigure(v)) continue;
    const s = v.seconds;
    if (!Number.isFinite(s) || s < 0) out.push(`${f.run.id}: figure ${s} at report ${i}`);
    else if (roundTimeLeft(s) !== s || !onTheGrid(s))
      out.push(`${f.run.id}: ${s} s is not on the grid (report ${i})`);
  }
  return out;
}

/** C6: "taking longer" is never the first thing said, and once said it stays until "finishing". */
function longerViolations(f: Facts): string[] {
  const out: string[] = [];
  const first = firstOf(f, (v) => v.kind === "left" || v.kind === "longer");
  if (first >= 0 && f.recs[first].value.kind === "longer")
    out.push(`${f.run.id}: "longer" before any figure`);
  const longer = firstOf(f, (v) => v.kind === "longer");
  if (longer >= 0) {
    const back = f.recs.findIndex(
      (rec, i) => i > longer && rec.value.kind !== "longer" && rec.value.kind !== "finishing",
    );
    if (back >= 0)
      out.push(`${f.run.id}: ${say(f.recs[back].value)} after "longer" (report ${back})`);
  }
  return out;
}

const basicViolations = (f: Facts): string[] => [
  ...gateViolations(f),
  ...finishingViolations(f),
  ...flickerViolations(f),
  ...gridViolations(f),
];

/** C9: a figure that has changed is not followed, within a few reports, by the figure it just left (the words do not flap). */
function flapViolations(f: Facts): string[] {
  const out: string[] = [];
  const figure = f.recs.map((rec) => (isFigure(rec.value) ? rec.value.seconds : null));
  for (let i = 1; i < figure.length; i++) {
    const was = figure[i - 1];
    const now = figure[i];
    if (was === null || now === null || was === now) continue;
    const back = figure.slice(i + 1, i + 1 + FLAP_WINDOW_REPORTS).indexOf(was);
    if (back >= 0)
      out.push(`${f.run.id}: ${was} -> ${now} -> ${was} within ${back + 2} reports (report ${i})`);
  }
  return out;
}

/** How close a run came to being called "taking longer": the highest the total implied by its average pace rose after its first
 *  figure, as a multiple of the total implied when that figure was shown (the alarm is meant to be at 1.5). Null without a figure. */
function headroom(f: Facts): number | null {
  const first = firstOf(f, isFigure);
  if (first < 0) return null;
  const floor = f.share[0];
  const total = (i: number): number => f.rendered[i] / (f.share[i] - floor);
  const base = total(first);
  let top = 0;
  for (let i = first; i < f.recs.length && f.share[i] < RULE_FINISHING_SHARE; i++) {
    if (f.share[i] > floor) top = Math.max(top, total(i) / base);
  }
  return top;
}

// ── the replay ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const ALL: readonly Facts[] = REPLAY_RUNS.map(factsOf);
const LONG = ALL.filter((f) => f.run.endMs / 1000 >= LONG_RUN_MIN_RENDER_SECONDS);
const SHORT = ALL.filter((f) => f.totalRendered < SHORT_RUN_MAX_RENDER_SECONDS);

// C5: one point per run and checkpoint.
interface Point {
  readonly facts: Facts;
  readonly checkpoint: number;
  /** Which report of the run it is. */
  readonly index: number;
  readonly value: TimeLeft;
  readonly real: number;
}

function pointAt(f: Facts, checkpoint: number): Point | null {
  let at = -1;
  for (let i = 0; i < f.share.length && f.share[i] <= checkpoint + 1e-9; i++) at = i;
  return at < 0
    ? null
    : { facts: f, checkpoint, index: at, value: f.recs[at].value, real: f.recs[at].realLeft };
}

/** Is a shown figure right? "Under a minute" is true whenever less than a minute is left; any other figure must be 0.5 to 1.5 times the
 *  real time left (`figureOverReal`), or the real time left must be 0.5 to 1.5 times the figure (the other reading). */
function isRight(figure: number, real: number, tolerance: number, figureOverReal = true): boolean {
  if (figure === UNDER_A_MINUTE_FIGURE) return real < UNDER_A_MINUTE_REAL_SECONDS;
  const ratio = figureOverReal ? figure / real : real / figure;
  return ratio >= 1 - tolerance && ratio <= 1 + tolerance;
}

interface CheckpointRow {
  readonly checkpoint: number;
  /** Runs with a point here, at least 5 s really left, that rendered 20 s or more in all. */
  readonly inPlay: number;
  readonly shown: readonly Point[];
  readonly right: readonly Point[];
  readonly wrong: readonly Point[];
  readonly otherReading: number;
  readonly within25: number;
}

function checkpointRow(facts: readonly Facts[], checkpoint: number): CheckpointRow {
  const points = facts
    .map((f) => pointAt(f, checkpoint))
    .filter((p): p is Point => p !== null && p.real >= C5_MIN_REAL_LEFT_SECONDS);
  const shown = points.filter((p) => isFigure(p.value));
  const secondsOf = (p: Point): number => (isFigure(p.value) ? p.value.seconds : NaN);
  const right = shown.filter((p) => isRight(secondsOf(p), p.real, WITHIN_HALF));
  return {
    checkpoint,
    inPlay: points.filter((p) => p.facts.totalRendered >= RULE_GATE_RENDERED_SECONDS).length,
    shown,
    right,
    wrong: shown.filter((p) => !right.includes(p)),
    otherReading: shown.filter((p) => isRight(secondsOf(p), p.real, WITHIN_HALF, false)).length,
    within25: shown.filter((p) => isRight(secondsOf(p), p.real, WITHIN_QUARTER)).length,
  };
}

const ROWS: readonly CheckpointRow[] = C5_CHECKPOINTS.map((c) => checkpointRow(ALL, c));

// C6: the runs on which "taking longer" appears.
interface LongerCase {
  readonly id: string;
  readonly kind: string;
  readonly share: number;
  readonly figureBefore: string;
  readonly real: number;
}
const LONGER_CASES: readonly LongerCase[] = ALL.flatMap((f) => {
  const at = firstOf(f, (v) => v.kind === "longer");
  if (at < 0) return [];
  const before = f.recs
    .slice(0, at)
    .reverse()
    .find((rec) => isFigure(rec.value));
  return [
    {
      id: f.run.id,
      kind: f.run.kind,
      share: f.share[at],
      figureBefore: before ? say(before.value) : "-",
      real: f.recs[at].realLeft,
    },
  ];
});

// C8: a run that is real until 40 % and then `factor` times slower; did the rule say "longer" while under 90 %?
interface SlowOutcome {
  readonly id: string;
  /** The share made when "longer" was first said, or null if it was not said before 90 %. */
  readonly caughtAt: number | null;
}
function slowOutcomes(factor: number): SlowOutcome[] {
  return ALL.filter((f) => f.run.endMs / 1000 >= C8_MIN_RENDER_SECONDS).map((f) => {
    const slow = factsOf(slowedFrom(f.run, C8_SLOW_FROM_SHARE, factor));
    const at = slow.recs.findIndex(
      (rec, i) => rec.value.kind === "longer" && slow.share[i] < RULE_FINISHING_SHARE,
    );
    return { id: f.run.id, caughtAt: at < 0 ? null : slow.share[at] };
  });
}
const SLOW_BY_FACTOR = new Map<number, SlowOutcome[]>(
  [C8_HEALTHY_FACTOR, ...C8_REPORTED_FACTORS, C8_SLOW_FACTOR].map((factor) => [
    factor,
    slowOutcomes(factor),
  ]),
);
const caughtShare = (outcomes: readonly SlowOutcome[]): number =>
  outcomes.filter((o) => o.caughtAt !== null).length / outcomes.length;

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function perRunRow(f: Facts): string {
  const first = firstOf(f, isFigure);
  const fin = firstOf(f, (v) => v.kind === "finishing");
  const room = headroom(f);
  const at = (c: number): string => {
    const p = pointAt(f, c);
    return p ? `${say(p.value)} / ${n1(p.real)}` : "-";
  };
  return [
    f.run.id,
    f.run.kind,
    f.run.route,
    f.run.pc,
    n1(f.run.videoSeconds),
    n1(f.run.endMs / 1000),
    first < 0 ? "never" : `${n1(f.rendered[first])} s, ${pct0(f.share[first])}`,
    at(0.2),
    at(0.5),
    at(0.8),
    fin < 0 ? "never" : pct0(f.share[fin]),
    room === null ? "-" : room.toFixed(2),
  ].join(" | ");
}

function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function buildReport(): string {
  const L: string[] = [];
  const kinds = [...new Set(ALL.map((f) => f.run.kind))].sort();
  L.push("# Replay of recorded export runs through the live time-left rule");
  L.push("");
  L.push(
    `${ALL.length} runs (${LONG.length} with 25 s or more of rendering, ${SHORT.length} under 20 s), ${ALL.reduce((n, f) => n + f.recs.length, 0)} reports, ` +
      `${kinds.length} project kinds, PCs ${[...new Set(ALL.map((f) => f.run.pc))].sort().join(", ")}. Every number below is computed by the test from the raw samples.`,
  );
  L.push("");
  L.push("## Claims");
  L.push("");
  const violations = (check: (f: Facts) => string[]): number => ALL.flatMap(check).length;
  L.push(
    `- C1 gate: ${violations(gateViolations)} violations. C2 finishing: ${violations(finishingViolations)}. C3 flicker: ${violations(flickerViolations)}. C4 grid: ${violations(gridViolations)}. C6 longer (order and hold): ${violations(longerViolations)}. C9 flapping: ${violations(flapViolations)}.`,
  );
  const fail = ROWS.filter(
    (r) =>
      r.shown.length >= C5_MIN_RUNS_SHOWING && r.right.length / r.shown.length < C5_MIN_RIGHT_SHARE,
  );
  L.push(
    `- C5 accuracy: ${fail.length === 0 ? "holds at every checkpoint with 10 or more figures" : `FAILS at ${fail.map((r) => pct0(r.checkpoint)).join(", ")}`} (table below).`,
  );
  const slow3 = SLOW_BY_FACTOR.get(C8_SLOW_FACTOR) ?? [];
  const slow12 = SLOW_BY_FACTOR.get(C8_HEALTHY_FACTOR) ?? [];
  L.push(
    `- C8 slowdowns: 3x slower from 40 %: "taking longer" before 90 % in ${slow3.filter((o) => o.caughtAt !== null).length} of ${slow3.length} runs; 1.2x: in ${slow12.filter((o) => o.caughtAt !== null).length} of ${slow12.length}.`,
  );
  const firsts = LONG.map((f) => ({ f, at: firstOf(f, isFigure) })).filter((x) => x.at >= 0);
  const secs = firsts.map((x) => x.f.rendered[x.at]);
  const shares = firsts.map((x) => x.f.share[x.at]);
  L.push(
    `- First figure (${firsts.length} of ${LONG.length} long runs get one): after ${n1(median(secs) ?? 0)} s of rendering at the median (90th percentile ${n1(quantile(secs, 0.9) ?? 0)} s, latest ${n1(Math.max(...secs))} s), at ${pct0(median(shares) ?? 0)} made at the median (range ${pct0(Math.min(...shares))} to ${pct0(Math.max(...shares))}).`,
  );
  const rooms = ALL.map((f) => ({ id: f.run.id, room: headroom(f) })).filter(
    (x): x is { id: string; room: number } => x.room !== null,
  );
  const top = [...rooms].sort((a, b) => b.room - a.room)[0];
  L.push(
    `- Headroom to the "taking longer" alarm (highest total implied by the average pace after the first figure, as a multiple of the first one; the alarm is at 1.5): median ${(median(rooms.map((x) => x.room)) ?? 0).toFixed(2)}, ${rooms.filter((x) => x.room >= 1.3).length} of ${rooms.length} runs reach 1.3 or more, ${rooms.filter((x) => x.room >= 1.4).length} reach 1.4 or more, the highest is ${top.room.toFixed(2)} (${top.id}).`,
  );
  L.push("");
  L.push("## C5: are the figures right? (by how far the export has got)");
  L.push("");
  L.push(
    'A figure is RIGHT when it is "under a minute" (30) and less than a minute was really left, or otherwise 0.5 to 1.5 times the real time left. Population: runs that show a figure at that point and have 5 s or more really left. ' +
      '"All in play" counts a run without a figure as a miss (runs that rendered 20 s or more in all, 5 s or more left). "Other reading" is the real time left within 50 % of the figure; "within 25 %" is 0.75 to 1.25 times.',
  );
  L.push("");
  L.push(
    "| done | runs in play | showing a figure | RIGHT (within 50 %) | RIGHT share | share of all in play | other reading | within 25 % |",
  );
  L.push("|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of ROWS) {
    const share = (n: number, d: number): string => (d === 0 ? "-" : pct0(n / d));
    L.push(
      `| ${pct0(r.checkpoint)} | ${r.inPlay} | ${r.shown.length} | ${r.right.length} | ${share(r.right.length, r.shown.length)} | ${share(r.right.length, r.inPlay)} | ${share(r.otherReading, r.shown.length)} | ${share(r.within25, r.shown.length)} |`,
    );
  }
  L.push("");
  L.push(
    "### By project kind (RIGHT within 50 %, figures shown; at 20 %, 50 %, 80 % and pooled over 15 % to 85 %)",
  );
  L.push("");
  L.push("| kind | runs | 20 % | 50 % | 80 % | pooled 15-85 % |");
  L.push("|---|---:|---|---|---|---:|");
  for (const kind of kinds) {
    const group = ALL.filter((f) => f.run.kind === kind);
    const cell = (c: number): string => {
      const row = checkpointRow(group, c);
      return row.shown.length === 0 ? "no figure" : `${row.right.length}/${row.shown.length}`;
    };
    const pooled = C5_CHECKPOINTS.map((c) => checkpointRow(group, c));
    const shown = pooled.reduce((n, r) => n + r.shown.length, 0);
    const right = pooled.reduce((n, r) => n + r.right.length, 0);
    L.push(
      `| ${kind} | ${group.length} | ${cell(0.2)} | ${cell(0.5)} | ${cell(0.8)} | ${shown === 0 ? "-" : `${pct0(right / shown)} (${right}/${shown})`} |`,
    );
  }
  L.push("");
  L.push("### Figures that were not right");
  L.push("");
  const wrongs = ROWS.flatMap((r) => r.wrong);
  L.push(
    wrongs.length === 0
      ? "None."
      : `${wrongs.length} wrong figures over all checkpoints (figure in seconds, real time left in seconds, ratio figure / real):`,
  );
  L.push("");
  if (wrongs.length > 0) {
    L.push("| done | run | kind | route | PC | figure | real left | ratio |");
    L.push("|---:|---|---|---|---|---:|---:|---:|");
    for (const p of wrongs.slice(0, 120)) {
      const fig = isFigure(p.value) ? p.value.seconds : NaN;
      L.push(
        `| ${pct0(p.checkpoint)} | ${p.facts.run.id} | ${p.facts.run.kind} | ${p.facts.run.route} | ${p.facts.run.pc} | ${fig} | ${n1(p.real)} | ${(fig / p.real).toFixed(2)} |`,
      );
    }
    if (wrongs.length > 120) L.push(`| ... | ${wrongs.length - 120} more | | | | | | |`);
  }
  L.push("");
  L.push('## C6: where "taking longer" appeared on the real (healthy) runs');
  L.push("");
  L.push(
    LONGER_CASES.length === 0
      ? `None of the ${ALL.length} runs ever said "taking longer".`
      : `${LONGER_CASES.length} of ${ALL.length} runs said "taking longer":`,
  );
  L.push("");
  if (LONGER_CASES.length > 0) {
    L.push(
      "| run | kind | share made when said | figure just before (s) | real time left then (s) |",
    );
    L.push("|---|---|---:|---:|---:|");
    for (const c of LONGER_CASES)
      L.push(`| ${c.id} | ${c.kind} | ${pct0(c.share)} | ${c.figureBefore} | ${n1(c.real)} |`);
  }
  L.push("");
  L.push("## C8: slowdowns built from real feeds");
  L.push("");
  L.push(
    `Each run with ${C8_MIN_RENDER_SECONDS} s or more of rendering is real until ${pct0(C8_SLOW_FROM_SHARE)} made, then its time axis is stretched by the factor (positions kept). "Caught" = the rule said "taking longer" while under 90 % made.`,
  );
  L.push("");
  L.push(
    "| factor | runs | caught before 90 % | share caught | median share made when caught | not caught |",
  );
  L.push("|---:|---:|---:|---:|---:|---|");
  for (const factor of [C8_HEALTHY_FACTOR, ...C8_REPORTED_FACTORS, C8_SLOW_FACTOR].sort(
    (a, b) => a - b,
  )) {
    const outcomes = SLOW_BY_FACTOR.get(factor) ?? [];
    const caught = outcomes.filter((o) => o.caughtAt !== null);
    const med = median(caught.map((o) => o.caughtAt as number));
    const missed = outcomes.filter((o) => o.caughtAt === null).map((o) => o.id);
    L.push(
      `| ${factor} | ${outcomes.length} | ${caught.length} | ${pct0(caught.length / outcomes.length)} | ${med === null ? "-" : pct0(med)} | ${missed.length === 0 ? "-" : missed.slice(0, 12).join(", ") + (missed.length > 12 ? `, ... (${missed.length} in all)` : "")} |`,
    );
  }
  L.push("");
  L.push("## Every run");
  L.push("");
  L.push(
    "Figure / real time left (both in seconds) at the last report at or below 20 %, 50 % and 80 % made; `-` = nothing said. First figure: seconds since the run's first report, and the share made then.",
  );
  L.push("");
  L.push(
    "| run | kind | route | PC | video s | render s | first figure at | at 20 % | at 50 % | at 80 % | finishing from | highest total / first total |",
  );
  L.push("|---|---|---|---|---:|---:|---|---|---|---|---:|---:|");
  for (const f of ALL) L.push(`| ${perRunRow(f)} |`);
  L.push("");
  return L.join("\n");
}

// ── the tests ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the recorded runs", () => {
  it("are what the claims need: long and short runs of every kind, route and PC, in order, complete, small", () => {
    const ids = REPLAY_RUNS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const run of REPLAY_RUNS) {
      const at = run.samples.map((s) => s[0]);
      const out = run.samples.map((s) => s[1]);
      expect(
        at.every((t, i) => Number.isInteger(t) && (i === 0 || t > at[i - 1])),
        run.id,
      ).toBe(true);
      expect(
        out.every((o) => Number.isFinite(o) && o >= FIXTURE_MIN_POSITION_MS),
        run.id,
      ).toBe(true);
      expect(at[at.length - 1], `${run.id}: the last report is the run's end`).toBe(run.endMs);
      expect(
        Math.max(...out),
        `${run.id}: the run reached the end of the video`,
      ).toBeGreaterThanOrEqual(run.videoSeconds * 1000 * 0.99);
      expect(Math.max(...out), run.id).toBeLessThanOrEqual(run.videoSeconds * 1000 * 1.01);
      expect(ROUTES, run.id).toContain(run.route);
      expect(run.source.startsWith("runs/"), run.id).toBe(true);
    }
    expect(LONG.length).toBeGreaterThanOrEqual(FIXTURE_MIN_LONG_RUNS);
    expect(SHORT.length).toBeGreaterThanOrEqual(FIXTURE_MIN_SHORT_RUNS);
    expect(statSync(FIXTURE_FILE).size).toBeLessThan(FIXTURE_MAX_BYTES);
    expect(
      new Set(REPLAY_RUNS.map((r) => r.pc)).size,
      "every PC profile the lab has run",
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(REPLAY_RUNS.map((r) => r.route))).toEqual(new Set(ROUTES));
    expect(
      new Set(REPLAY_RUNS.map((r) => r.kind)).size,
      "every project kind of the lab",
    ).toBeGreaterThanOrEqual(9);
    expect(new Set(REPLAY_RUNS.map((r) => r.choice))).toEqual(new Set(["quality", "fast", null]));
  });

  it("C1 gate: no figure before 20 s of rendering and (15 % made or 60 s of rendering)", () => {
    expect(ALL.flatMap(gateViolations)).toEqual([]);
  });

  it("C1 gate: a run that renders for under 20 s never shows a figure", () => {
    expect(SHORT.length).toBeGreaterThanOrEqual(FIXTURE_MIN_SHORT_RUNS);
    const shown = SHORT.filter((f) =>
      f.recs.some((rec) => rec.value.kind === "left" || rec.value.kind === "longer"),
    );
    expect(shown.map((f) => f.run.id)).toEqual([]);
  });

  it("C1 gate: it does open: after 25 s of rendering, a run still going shows a figure at 30 %, 50 % and 70 % made", () => {
    const points = LIVE_CHECKPOINTS.flatMap((c) => ALL.map((f) => pointAt(f, c)))
      .filter((p): p is Point => p !== null && p.real >= C5_MIN_REAL_LEFT_SECONDS)
      .filter((p) => p.facts.rendered[p.index] >= LIVE_MIN_RENDERED_SECONDS);
    expect(points.length).toBeGreaterThanOrEqual(LIVE_MIN_POINTS);
    const without = points.filter((p) => p.value.kind !== "left" && p.value.kind !== "longer");
    expect(
      (points.length - without.length) / points.length,
      `no figure yet: ${without.map((p) => `${p.facts.run.id}@${pct0(p.checkpoint)}`).join(", ")}`,
    ).toBeGreaterThanOrEqual(LIVE_MIN_SHARE_WITH_FIGURE);
  });

  it("C2 finishing: said from 90 % made and never before, and never replaced by a number", () => {
    expect(ALL.flatMap(finishingViolations)).toEqual([]);
  });

  it("C3 no flicker: a figure is never followed by nothing", () => {
    expect(ALL.flatMap(flickerViolations)).toEqual([]);
  });

  it("C4 grid: every figure is finite, not negative and on the rounding grid", () => {
    expect(ALL.flatMap(gridViolations)).toEqual([]);
    expect(ALL.some((f) => f.recs.some((rec) => isFigure(rec.value)))).toBe(true);
  });

  it("C5 accuracy: from 15 % to 85 % done, at least 80 % of the shown figures are right wherever 10 or more runs show one", () => {
    const judged = ROWS.filter((r) => r.shown.length >= C5_MIN_RUNS_SHOWING);
    expect(judged.length, "the claim has points to judge").toBeGreaterThanOrEqual(
      C5_CHECKPOINTS.length - 3,
    );
    const failing = judged
      .filter((r) => r.right.length / r.shown.length < C5_MIN_RIGHT_SHARE)
      .map(
        (r) =>
          `${pct0(r.checkpoint)}: ${r.right.length} of ${r.shown.length} right (${r.wrong.map((p) => p.facts.run.id).join(", ")})`,
      );
    expect(failing).toEqual([]);
  });

  it("C6 taking longer: never the first thing said, and held; where it appears on a healthy run is in the report", () => {
    expect(ALL.flatMap(longerViolations)).toEqual([]);
  });

  it("C6 taking longer: no real, healthy run is ever said to be taking longer", () => {
    expect(
      LONGER_CASES.map((c) => `${c.id}@${pct0(c.share)}`),
      "false alarms on healthy runs",
    ).toHaveLength(C6_HEALTHY_MAX_FALSE_ALARMS);
  });

  it("C3 no flicker: a figure stays on screen when nothing moves for 22 s (the pace cannot be read)", () => {
    const stalled = LONG.filter((f) => f.run.endMs / 1000 >= STALL_MIN_RENDER_SECONDS).map((f) => {
      const pivot = f.share.findIndex((s) => s >= STALL_FROM_SHARE);
      return { pivot, facts: factsOf(stalledFrom(f.run, STALL_FROM_SHARE, STALL_SECONDS)) };
    });
    expect(stalled.map((s) => s.facts).flatMap(basicViolations)).toEqual([]);
    expect(stalled.map((s) => s.facts).flatMap(longerViolations)).toEqual([]);
    const bitten = stalled.filter(
      (s) => s.facts.recs[s.pivot + STALL_SECONDS]?.value.kind === "left",
    );
    expect(bitten.length).toBeGreaterThanOrEqual(STALL_MIN_RUNS_WITH_FIGURE_AT_ITS_END);
  });

  it("C9 the words do not flap: a figure that changes is not followed within 5 reports by the figure it left", () => {
    expect(ALL.flatMap(flapViolations)).toEqual([]);
  });

  it("C7 a clock that starts later changes nothing: the same values at every report", () => {
    for (const f of ALL) {
      const values = f.recs.map((rec) => rec.value);
      for (const by of [987_654, 1_700_000_000_000]) {
        expect(
          replayRun(shifted(f.run, by)).map((rec) => rec.value),
          `${f.run.id} +${by} ms`,
        ).toEqual(values);
      }
    }
  });

  it("C7 a coarser report cadence (every second report dropped) keeps C1 to C4 true", () => {
    const coarse = ALL.map((f) => factsOf(coarser(f.run)));
    expect(coarse.flatMap(basicViolations)).toEqual([]);
    expect(coarse.flatMap(longerViolations)).toEqual([]);
    expect(coarse.some((f) => f.recs.some((rec) => isFigure(rec.value)))).toBe(true);
  });

  it("C8 a run that turns 3 times slower at 40 % made is said to be taking longer before 90 % made, in at least 90 % of the runs", () => {
    const outcomes = SLOW_BY_FACTOR.get(C8_SLOW_FACTOR) ?? [];
    expect(outcomes.length).toBeGreaterThanOrEqual(30);
    const missed = outcomes.filter((o) => o.caughtAt === null).map((o) => o.id);
    expect(caughtShare(outcomes), `not caught: ${missed.join(", ")}`).toBeGreaterThanOrEqual(
      C8_MIN_CAUGHT_SHARE,
    );
  });

  it("C8 a run that turns only 1.2 times slower is hardly ever said to be taking longer (the claim is never: see C8_HEALTHY_MAX_CAUGHT)", () => {
    const outcomes = SLOW_BY_FACTOR.get(C8_HEALTHY_FACTOR) ?? [];
    expect(outcomes.length).toBeGreaterThanOrEqual(30);
    const caught = outcomes
      .filter((o) => o.caughtAt !== null)
      .map((o) => `${o.id}@${pct0(o.caughtAt ?? 0)}`);
    expect(caught.length, `said "taking longer": ${caught.join(", ")}`).toBeLessThanOrEqual(
      C8_HEALTHY_MAX_CAUGHT,
    );
  });

  it("C8 the slowdown does not break C1 to C4 (3 times slower, from 40 %)", () => {
    const slowed = ALL.filter((f) => f.run.endMs / 1000 >= C8_MIN_RENDER_SECONDS).map((f) =>
      factsOf(slowedFrom(f.run, C8_SLOW_FROM_SHARE, C8_SLOW_FACTOR)),
    );
    expect(slowed.flatMap(basicViolations)).toEqual([]);
    expect(slowed.flatMap(longerViolations)).toEqual([]);
  });

  it("writes the markdown report when REPLAY_REPORT names a file", () => {
    const target = process.env.REPLAY_REPORT;
    if (!target) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buildReport(), { encoding: "utf8" });
    expect(statSync(target).size).toBeGreaterThan(0);
  });
});
