// A page that takes a running export over after a reload (adoptExports, exportQueue.ts) is handed what the app process kept of the job's output: up to 64 KiB, some 280 blocks, minutes of a render,
// in one go. Read as they came, those blocks are minutes of progress made in no time: the rule that says the time left took the first of them for its clock start and its floor, so a healthy export
// said "taking longer than expected" from about 32 s after the join until "Finishing", and gave no time left. The page is to join the render where it is.
//
// These tests play the join through the app's own path, on a fake clock: the reader the queue builds for a joined export (joinedProgressReader), the reporter (render.ts), the store
// (store/exportJob.ts) and the words (exportWords.ts). The outcomes are what a person reads, set against the same render watched from its first block and against the truth of the render.
// adoptExports itself, with a 64 KiB tail from the app process, is in exportSupervised.test.ts.
import { describe, expect, it, vi } from "vitest";

import { liveFeedOf, useExportJob } from "../store/exportJob";
import { START, useKit } from "../test/exportRunKit";
import { __resetFacts3c } from "./exportFacts3c";
import { joinedProgressReader } from "./exportQueue";
import { roundTimeLeft } from "./exportTimeLeft";
import { describeLiveStatus, shownTimeLeftSeconds } from "./exportWords";
import { exportProgressReporter } from "./render";

vi.mock("../api/exportEvents", () => ({ reportExport: vi.fn(async () => undefined) }));

useKit(__resetFacts3c);

const ID = "job-1";
/** Seconds between two reports of ffmpeg's `-progress` output. */
const EVERY = 0.5;
/** The most the app process keeps of a job's output (src-tauri/src/jobs.rs, TAIL_BYTES). */
const TAIL_BYTES = 64 * 1024;
/** The figures a person can be shown, in order, so that "within one step" can be counted. */
const GRID = [...new Set(Array.from({ length: 20_000 }, (_, s) => roundTimeLeft(s)))].sort(
  (a, b) => a - b,
);
function stepsApart(a: number, b: number): number {
  expect(GRID, `${a} is a grid figure`).toContain(a);
  expect(GRID, `${b} is a grid figure`).toContain(b);
  return Math.abs(GRID.indexOf(a) - GRID.indexOf(b));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
/** One block of ffmpeg's `-progress` output with every line it writes (about 230 bytes), for `outSeconds` of output made. */
function blockOf(outSeconds: number, speed: number, end = false): string {
  const us = Math.round(outSeconds * 1_000_000);
  const stamp = `${pad(Math.floor(us / 3_600_000_000))}:${pad(Math.floor(us / 60_000_000) % 60)}:${pad(Math.floor(us / 1_000_000) % 60)}.${pad(us % 1_000_000, 6)}`;
  return [
    `frame=${Math.round(outSeconds * 30)}`,
    "fps=30.00",
    "stream_0_0_q=28.0",
    "bitrate=N/A",
    "total_size=N/A",
    `out_time_us=${us}`,
    `out_time_ms=${us}`,
    `out_time=${stamp}`,
    "dup_frames=0",
    "drop_frames=0",
    `speed=${speed.toFixed(2)}x`,
    `progress=${end ? "end" : "continue"}`,
    "",
  ].join("\n");
}

/** A steady render, as the app process prints it: a report every half second from the first, on the wall clock `w` seconds after the render began. */
interface Render {
  readonly plan: { duration: number; stepDurations?: number[] };
  /** What the app process prints on the job's output at wall second `w`. */
  readonly printed: (w: number) => string;
  /** The part the render is in at `w`. */
  readonly stepAt: (w: number) => number;
  /** The wall second the render ends. */
  readonly ends: number;
}

/** One process: `duration` seconds of output made at `speed` seconds of output per second. */
function plainRender(duration: number, speed: number): Render {
  return {
    plan: { duration },
    printed: (w) => blockOf(Math.min(duration, speed * w), speed, speed * w >= duration - 1e-9),
    stepAt: () => 0,
    ends: duration / speed,
  };
}

/** A render made in parts (a process for each, the app process printing the step line before its first block); the last part is the final encode. */
function partsRender(durations: number[], speed: number): Render {
  const total = durations.reduce((a, b) => a + b, 0);
  const starts = durations.map((_, step) => durations.slice(0, step).reduce((a, b) => a + b, 0));
  const partOf = (w: number) =>
    Math.max(0, starts.filter((start) => start < speed * w - 1e-9).length - 1);
  return {
    plan: { duration: total, stepDurations: durations },
    printed: (w) => {
      const step = partOf(w);
      const out = speed * w - starts[step];
      const first = speed * (w - EVERY) <= starts[step] + 1e-9;
      return (
        (first ? `artdaddy_step=${step}\n` : "") +
        blockOf(out, speed, out >= durations[step] - 1e-9)
      );
    },
    stepAt: partOf,
    ends: total / speed,
  };
}

/** What the app process holds of the job's output at wall second `at`: everything printed so far, cut to the last 64 KiB. */
function keptAt(render: Render, at: number): string {
  let text = "";
  for (let i = 1; i * EVERY <= at + 1e-9; i++) text += render.printed(i * EVERY);
  return text.slice(-TAIL_BYTES);
}

interface Seen {
  readonly at: number;
  readonly words: string;
  readonly seconds: number | null;
}

/** The page is on the export from wall second `from`: 0 is a page that watched it from its first report, anything else a page that took it over then and was handed what the app process kept in one go.
 *  Every report after it comes live, half a second apart, to the render's end; the card's line and `time_left_s` are read after each. */
async function play(render: Render, from: number): Promise<Seen[]> {
  const store = useExportJob;
  store.getState().reset();
  store.setState({ live: null, finishing: {} });
  vi.setSystemTime(START + from * 1000);
  // What finishAdopted does for an export that is running, before it follows its progress.
  store.getState().begin(null);
  store.getState().attach(ID);
  store.getState().beginLive(ID);
  store.getState().setLiveStage(ID, "rendering");
  const seen: Seen[] = [];
  const look = (at: number) => {
    const live = liveFeedOf(store.getState(), ID)!;
    const now = Date.now();
    seen.push({
      at,
      words: describeLiveStatus(live, now),
      seconds: shownTimeLeftSeconds(live, now),
    });
  };
  let read: (chunk: string) => void;
  if (from > 0) {
    read = await joinedProgressReader(render.plan, {
      stdout_tail: keptAt(render, from),
      step: render.stepAt(from),
    });
    look(from);
  } else read = exportProgressReporter(render.plan);
  for (let i = Math.floor(from / EVERY) + 1; i * EVERY <= render.ends + 1e-9; i++) {
    vi.setSystemTime(START + i * EVERY * 1000);
    read(render.printed(i * EVERY));
    look(i * EVERY);
  }
  return seen;
}

describe("an export the page takes over where it is, handed the app process's kept output at one instant", () => {
  const cases = [
    {
      name: "a 5-minute render at normal speed, joined at its half",
      duration: 300,
      speed: 1,
      from: 150,
    },
    {
      name: "a 10-minute render at twice normal speed, joined at its half",
      duration: 600,
      speed: 2,
      from: 150,
    },
    {
      name: "a 30-minute render joined at its half, the kept output holding only the last 140 s of 15 minutes",
      duration: 1800,
      speed: 1,
      from: 900,
    },
    { name: "a 50-minute render joined at a fifth", duration: 3000, speed: 1, from: 600 },
  ];

  it.each(cases)(
    "$name: it never says taking longer, the first figure comes 20 s after the join, and the figures are those of the same render watched from its start",
    async ({ duration, speed, from }) => {
      const render = plainRender(duration, speed);
      expect(
        keptAt(render, from).length,
        "the kept output holds a hundred blocks and more",
      ).toBeGreaterThan(100 * 150);
      const joined = await play(render, from);
      const watched = await play(render, 0);

      expect(joined.filter((s) => s.words.includes("taking longer")).map((s) => s.at)).toEqual([]);
      expect(joined.find((s) => s.seconds !== null)?.at).toBe(from + 20);
      expect(joined.filter((s) => s.at < from + 20 && s.words.includes(" left"))).toEqual([]);

      const watchedAt = new Map(watched.map((s) => [s.at, s]));
      for (const s of joined.filter((r) => r.at >= from + 20)) {
        const same = watchedAt.get(s.at)!;
        expect(
          s.seconds === null,
          `at ${s.at} s a figure or not, as the render watched from its start`,
        ).toBe(same.seconds === null);
        if (s.seconds !== null && same.seconds !== null)
          expect(
            stepsApart(s.seconds, same.seconds),
            `at ${s.at} s: ${s.seconds} against ${same.seconds}`,
          ).toBeLessThanOrEqual(1);
        // And both are the truth, within a step.
        if (s.seconds !== null)
          expect(
            stepsApart(s.seconds, roundTimeLeft(render.ends - s.at)),
            `at ${s.at} s: ${s.seconds} s left against ${render.ends - s.at}`,
          ).toBeLessThanOrEqual(1);
      }
      expect(
        joined.some((s) => s.seconds !== null),
        "there are figures to compare",
      ).toBe(true);
    },
  );

  it("a render made in parts, joined in its last part: the newest block is read as that part, so the figure comes 20 s after the join and is the truth", async () => {
    const render = partsRender([60, 60, 240], 1);
    const from = 200;
    const joined = await play(render, from);
    expect(joined.filter((s) => s.words.includes("taking longer")).map((s) => s.at)).toEqual([]);
    expect(joined.find((s) => s.seconds !== null)?.at).toBe(from + 20);
    for (const s of joined.filter((r) => r.seconds !== null))
      expect(
        stepsApart(s.seconds!, roundTimeLeft(render.ends - s.at)),
        `at ${s.at} s: ${s.seconds} s left`,
      ).toBeLessThanOrEqual(1);
  });

  it("a render made in parts, joined in an earlier part: no time left and no taking longer while it is there", async () => {
    const render = partsRender([60, 60, 240], 1);
    const joined = await play(render, 30);
    const inEarlierParts = joined.filter((s) => s.at <= 120);
    expect(inEarlierParts.length).toBeGreaterThan(100);
    expect(
      inEarlierParts.filter((s) => s.words.includes(" left") || s.words.includes("longer")),
    ).toEqual([]);
  });
});
