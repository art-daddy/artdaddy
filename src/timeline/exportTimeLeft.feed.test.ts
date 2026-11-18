// The recorded real runs, played through the app's own path: the progress reader and reporter (render.ts), the store (store/exportJob.ts), the words
// (exportWords.ts) and the assistant's export list (exportQueue.ts). The pure rule has its own proof (exportTimeLeft.test.ts, exportTimeLeft.replay.test.ts);
// this file asks a different question: does what a person READS, and what the assistant is TOLD, equal what the rule says for the same feed?
//
// Two artifacts are compared at every report of every run: (1) the answer of the pure rule replayed over the recorded samples on its own, and (2) the answer the
// store holds, the card's line, the dialog's right side and `time_left_s` after the same samples went through the reader, the reporter and the store on a fake
// clock. The words are written out here from the grid (an oracle), not taken from the words function under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveFeedOf, useExportJob } from "../store/exportJob";
import { START, startRun, useKit } from "../test/exportRunKit";
import { REPLAY_RUNS, type ReplayRun } from "./__fixtures__/timeLeftRuns";
import { replayRun, stalledFrom } from "./__fixtures__/replay";
import { listExportOutcomes } from "./exportQueue";
import type { TimeLeft } from "./exportTimeLeft";
import {
  describeDialogProgress,
  describeLiveStatus,
  QUIET_SECONDS,
  shownTimeLeftSeconds,
} from "./exportWords";
import { exportProgressReporter } from "./render";

vi.mock("../api/exportEvents", () => ({ reportExport: vi.fn(async () => undefined) }));

useKit();

/** What a person should read for an answer of the rule, written out from the grid: "under a minute", whole minutes, then hours and minutes. */
function wordsOf(value: TimeLeft): string {
  if (value.kind === "finishing") return "Finishing";
  if (value.kind === "longer") return "taking longer than expected";
  if (value.kind !== "left") return "";
  const s = value.seconds;
  if (s < 45) return "under a minute left";
  if (s < 3600) return `about ${s / 60} min left`;
  const rest = (s % 3600) / 60;
  return rest
    ? `about ${Math.floor(s / 3600)} h ${rest} min left`
    : `about ${Math.floor(s / 3600)} h left`;
}

/** One block of ffmpeg's `-progress` output as the lab recorded it: no picture yet is N/A, the last one says end. */
function chunkOf(run: ReplayRun, i: number): string {
  const [, outMs] = run.samples[i];
  const last = i === run.samples.length - 1;
  const frame = Math.max(0, Math.round((outMs / 1000) * 30));
  const position = outMs > 0 ? `${Math.round(outMs * 1000)}` : "N/A";
  return `frame=${frame}\nfps=30\nout_time_us=${position}\nspeed=${outMs > 0 ? "1.0x" : "N/A"}\nprogress=${last ? "end" : "continue"}\n`;
}

interface Seen {
  readonly at: number;
  readonly pure: TimeLeft;
  readonly stored: TimeLeft;
  readonly card: string;
  readonly dialog: string;
  readonly jobDialog: string;
  readonly seconds: number | null;
  /** The render has not moved for the quiet rule's 60 s, counted from the samples alone. */
  readonly quiet: boolean;
}

/** Plays a run through the reporter and the store on a fake clock, and reads every surface after each report. */
function play(run: ReplayRun, id: string): Seen[] {
  const pure = replayRun(run);
  const store = useExportJob;
  store.getState().reset();
  store.setState({ live: null, finishing: {} });
  vi.setSystemTime(START + run.samples[0][0]);
  store.getState().begin(null);
  store.getState().attach(id);
  store.getState().beginLive(id);
  store.getState().setLiveStage(id, "rendering");
  const read = exportProgressReporter({ duration: run.videoSeconds });
  const seen: Seen[] = [];
  let lastMove = run.samples[0][0];
  let best = -1;
  for (let i = 0; i < run.samples.length; i++) {
    const [at, outMs] = run.samples[i];
    vi.setSystemTime(START + at);
    read(chunkOf(run, i));
    if (outMs > best) {
      best = outMs;
      lastMove = at;
    }
    const state = store.getState();
    const live = liveFeedOf(state, id)!;
    const now = Date.now();
    const view = {
      place: null,
      phase: "rendering" as const,
      fraction: state.fraction,
      timeLeft: state.timeLeft,
      speed: state.speed,
    };
    seen.push({
      at,
      pure: pure[i].value,
      stored: live.timeLeft ?? { kind: "none" },
      card: describeLiveStatus(live, now),
      dialog: describeDialogProgress({ ...view, own: live }, now).timeLeft,
      jobDialog: describeDialogProgress({ ...view, own: null }, now).timeLeft,
      seconds: shownTimeLeftSeconds(live, now),
      quiet: (at - lastMove) / 1000 >= QUIET_SECONDS,
    });
  }
  return seen;
}

/** Every disagreement between what the surfaces said and what the pure rule said for the same report. */
function disagreements(run: ReplayRun, seen: Seen[]): string[] {
  const out: string[] = [];
  seen.forEach((s, i) => {
    const expected = s.quiet ? "" : wordsOf(s.pure);
    const where = `${run.id} report ${i} (${(s.at / 1000).toFixed(1)} s)`;
    if (JSON.stringify(s.stored) !== JSON.stringify(s.pure))
      out.push(
        `${where}: the store holds ${JSON.stringify(s.stored)}, the rule said ${JSON.stringify(s.pure)}`,
      );
    const cardOk = expected
      ? s.card.endsWith(` · ${expected}`)
      : !/ left$|Finishing$|taking longer than expected$/.test(s.card);
    if (!cardOk)
      out.push(`${where}: the card says "${s.card}", expected the time part "${expected}"`);
    if (s.dialog !== expected)
      out.push(`${where}: the dialog says "${s.dialog}", expected "${expected}"`);
    if (s.jobDialog !== wordsOf(s.pure))
      out.push(
        `${where}: the dialog's own job says "${s.jobDialog}", expected "${wordsOf(s.pure)}"`,
      );
    const figure = !s.quiet && s.pure.kind === "left" ? s.pure.seconds : null;
    if (s.seconds !== figure)
      out.push(`${where}: the assistant would be told ${s.seconds}, expected ${figure}`);
  });
  return out;
}

beforeEach(() => {
  useExportJob.getState().reset();
});
afterEach(() => {
  useExportJob.getState().reset();
});

/** A spread of the recorded runs: every kind, route and PC profile once, and the slowest and the shortest run. */
const spread = (): ReplayRun[] => {
  const picked = new Map<string, ReplayRun>();
  for (const run of REPLAY_RUNS) {
    const key = `${run.kind}|${run.route}|${run.pc}`;
    if (!picked.has(key)) picked.set(key, run);
  }
  const slowest = [...REPLAY_RUNS].sort((a, b) => b.endMs - a.endMs)[0];
  const shortest = [...REPLAY_RUNS].sort((a, b) => a.endMs - b.endMs)[0];
  return [...new Set([...picked.values(), slowest, shortest])];
};

describe("recorded real runs through the reader, the reporter, the store, the card, the dialog and the assistant's list", () => {
  it("says at every report of every recorded run what the pure rule says for the same feed (the store, the card, the dialog's panel, the dialog's own job, time_left_s)", () => {
    expect(REPLAY_RUNS.length).toBeGreaterThanOrEqual(80);
    let reports = 0;
    let figures = 0;
    for (const run of REPLAY_RUNS) {
      const seen = play(run, `e2e-${run.id}`);
      reports += seen.length;
      figures += seen.filter((s) => s.pure.kind === "left").length;
      expect(disagreements(run, seen)).toEqual([]);
    }
    // the check had something to check: a rule that said nothing would agree with everything
    expect(reports).toBeGreaterThan(15_000);
    expect(figures).toBeGreaterThan(1_000);
  });

  it("says no time on the card before the gate and 'Finishing' only from 90 %, on the real feeds, counted from the samples and not from the rule", () => {
    for (const run of spread()) {
      const seen = play(run, `gate-${run.id}`);
      const t0 = run.samples[0][0];
      let finishing = false;
      let timeSaid = 0;
      let highest = 0;
      seen.forEach((s, i) => {
        const fraction = Math.max(0, run.samples[i][1]) / (run.videoSeconds * 1000);
        // a real feed can print a block with no position near its end (N/A, read as 0): what was made stays made
        highest = Math.max(highest, fraction);
        const rendered = (s.at - t0) / 1000;
        const time = / left$/.test(s.card);
        if (time) timeSaid++;
        if (time && !(rendered >= 20 && (highest >= 0.15 || rendered >= 60)))
          throw new Error(
            `${run.id}: a time on the card at ${rendered.toFixed(1)} s and ${(highest * 100).toFixed(0)} %`,
          );
        if (/Finishing$/.test(s.card)) {
          finishing = true;
          if (highest < 0.9)
            throw new Error(`${run.id}: Finishing at ${(highest * 100).toFixed(1)} %`);
        }
        if (finishing && time) throw new Error(`${run.id}: a time on the card after Finishing`);
      });
      if (run.endMs > 40_000) expect(timeSaid, run.id).toBeGreaterThan(0);
    }
  });

  it("a render that stands still for 70 s says no time on the card, the dialog or the assistant's list while it stands, and says one again when it moves", () => {
    let hidden = 0;
    let returned = 0;
    for (const run of REPLAY_RUNS.filter((r) => r.endMs > 90_000).slice(0, 25)) {
      const stalled = stalledFrom(run, 0.5, 70);
      const seen = play(stalled, `stall-${run.id}`);
      expect(disagreements(stalled, seen)).toEqual([]);
      seen.forEach((s, i) => {
        if (s.quiet && wordsOf(s.pure)) {
          hidden++;
          expect(s.seconds).toBeNull();
          expect(s.dialog).toBe("");
          expect(s.card).not.toMatch(/ left$|Finishing$|taking longer than expected$/);
        }
        if (i > 0 && seen[i - 1].quiet && !s.quiet && wordsOf(s.pure)) {
          returned++;
          expect(s.card.endsWith(` · ${wordsOf(s.pure)}`)).toBe(true);
        }
      });
    }
    // the stall really was longer than the quiet rule, and the words did come back
    expect(hidden).toBeGreaterThan(0);
    expect(returned).toBeGreaterThan(0);
  });

  it("an attempt restarted after 95 % does not say 'Finishing' (nor a held 'taking longer') in its first seconds: each attempt has its own memory", () => {
    const run = REPLAY_RUNS.find((r) => r.endMs > 120_000)!;
    const first = play(run, "attempt-1");
    expect(first.some((s) => /Finishing$/.test(s.card))).toBe(true);
    // the app starts the export again as another attempt: a new live feed under a new job id, the clock where it was
    const origin = START + run.samples[run.samples.length - 1][0] + 5_000;
    vi.setSystemTime(origin);
    useExportJob.getState().beginLive("attempt-2");
    useExportJob.getState().setLiveStage("attempt-2", "rendering");
    const live = liveFeedOf(useExportJob.getState(), "attempt-2")!;
    expect(live.timeLeft).toEqual({ kind: "none" });
    expect(describeLiveStatus(live, Date.now())).not.toMatch(/Finishing| left$|taking longer/);
    const read = exportProgressReporter({ duration: run.videoSeconds });
    for (let i = 1; i <= 40; i++) {
      vi.setSystemTime(origin + i * 500);
      const outMs = i * 25;
      read(
        `frame=${Math.max(1, Math.round(outMs / 33))}\nfps=30\nout_time_us=${outMs * 1000}\nspeed=0.05x\nprogress=continue\n`,
      );
    }
    const second = liveFeedOf(useExportJob.getState(), "attempt-2")!;
    expect(describeLiveStatus(second, Date.now())).not.toMatch(/Finishing| left$|taking longer/);
    expect(shownTimeLeftSeconds(second, Date.now())).toBeNull();
  });

  it("says no time once the render is over (the file is being checked or saved), though the last answer was a figure, and says nothing of the time in the dialog either", () => {
    const run = REPLAY_RUNS.find((r) => r.endMs > 100_000 && r.route === "x264")!;
    const pure = replayRun(run);
    const upTo = pure.findIndex((r) => r.value.kind === "left" && r.fraction > 0.5);
    expect(upTo).toBeGreaterThan(0);
    const partial: ReplayRun = { ...run, samples: run.samples.slice(0, upTo + 1) };
    const seen = play(partial, "after-render");
    expect(seen[seen.length - 1].card).toMatch(/ left$/);
    for (const stage of ["checking", "saving"] as const) {
      useExportJob.getState().setLiveStage("after-render", stage);
      const live = liveFeedOf(useExportJob.getState(), "after-render")!;
      const now = Date.now();
      expect(describeLiveStatus(live, now)).not.toMatch(/ left$|Finishing$|taking longer/);
      expect(shownTimeLeftSeconds(live, now)).toBeNull();
      expect(
        describeDialogProgress(
          {
            own: live,
            place: null,
            phase: "rendering",
            fraction: 0.6,
            timeLeft: live.timeLeft!,
            speed: 1,
          },
          now,
        ).timeLeft,
      ).toBe("");
    }
  });

  it("a render made in parts (the streamed engine's feed through the real sequence reader) says no time in its parts, and ends in 'Finishing'", () => {
    // three producers of 30 s of video each, then the final encode of the whole 90 s: the share is made over 90 + 90 s of work
    const parts = [30, 30, 30];
    const total = 90;
    const reader = exportProgressReporter({ duration: total, stepDurations: [...parts, total] });
    useExportJob.getState().beginLive("streamed");
    useExportJob.getState().setLiveStage("streamed", "rendering");
    let t = 0;
    const said: string[] = [];
    const feed = (step: number, outSeconds: number): void => {
      t += 1000;
      vi.setSystemTime(START + t);
      reader(`artdaddy_step=${step}\n`);
      reader(
        `frame=${Math.round(outSeconds * 30)}\nfps=30\nout_time_us=${Math.round(outSeconds * 1e6)}\nspeed=1.0x\nprogress=continue\n`,
      );
      said.push(describeLiveStatus(liveFeedOf(useExportJob.getState(), "streamed")!, Date.now()));
    };
    for (let part = 0; part < parts.length; part++)
      for (let s = 1; s <= parts[part]; s++) feed(part, s);
    // 90 s of production went by at one second per second: a pace a per-part reading would turn into a figure
    expect(said.some((line) => / left$|Finishing$|taking longer/.test(line))).toBe(false);
    expect(said[said.length - 1]).toMatch(/Rendering part 3 of 3/);
    for (let s = 1; s <= total; s += 3) feed(parts.length, s);
    expect(said[said.length - 1]).toMatch(/Finishing$/);
  });
});

describe("the assistant's export list, on the real feeds", () => {
  it("reports time_left_s only where the card shows a figure, and the figure's own seconds", async () => {
    const run = REPLAY_RUNS.filter((r) => r.endMs > 100_000 && r.route === "x264")[0];
    const pure = replayRun(run);
    const started = await startRun();
    useExportJob.getState().setLiveStage(started.id, "rendering");
    vi.setSystemTime(START + run.samples[0][0]);
    const read = exportProgressReporter({ duration: run.videoSeconds });
    let told = 0;
    let silent = 0;
    let lastMove = run.samples[0][0];
    let best = -1;
    for (let i = 0; i < run.samples.length; i++) {
      const [at, outMs] = run.samples[i];
      vi.setSystemTime(START + at);
      read(chunkOf(run, i));
      if (outMs > best) {
        best = outMs;
        lastMove = at;
      }
      const row = listExportOutcomes().find((r) => r.job_id === started.id)!;
      const value = pure[i].value;
      const quiet = (at - lastMove) / 1000 >= QUIET_SECONDS;
      if (value.kind === "left" && !quiet) {
        expect(row.time_left_s).toBe(value.seconds);
        told++;
      } else {
        expect(Object.prototype.hasOwnProperty.call(row, "time_left_s")).toBe(false);
        silent++;
      }
    }
    expect(told).toBeGreaterThan(20);
    expect(silent).toBeGreaterThan(20);
    await started.end("finish");
  });
});
