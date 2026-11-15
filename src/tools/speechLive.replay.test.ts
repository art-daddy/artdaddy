// The real-sidecar proof, P1, replayed with NO engine: a capture of what the shipped whisper-cli printed and when
// (speechLiveCapture.ts, written by speechLive.smoke.e2e.ts) is fed to the app's monitor and live check exactly
// as the app feeds them. Until the real capture is committed the same rules run on a committed FAKE capture and on
// generated ones, so a reader sees the shape and a rule that is wrong fails here, not in the one slot with the
// real engine. Every assertion is on an OUTCOME (a position, a stop time, a pace kept) and the times of a stop
// are worked out below as plain arithmetic from the constants, never by asking the code under test.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags } from "../api/exportFlags";
import { __resetSpeechJobs, useSpeechJobs } from "../store/speechJobs";
import { __resetSpeechSession } from "./speechAdmission";
import {
  FAKE_FIXTURE_OPTIONS,
  STDERR_HEAD_BYTES,
  fakeCapture,
  parseCapture,
  replayMonitor,
  scaleCapture,
  segmentBursts,
  segmentStats,
  serializeCapture,
  validateCapture,
  withGap,
  type ChipSample,
  type FakeRunOptions,
  type MonitorReplay,
  type RunCapture,
  type SpeechLiveCapture,
} from "./speechLiveCapture";
import {
  LIVE_CONFIRM_S,
  LIVE_MIN_AUDIO_S,
  LIVE_MIN_LEFT_S,
  MAX_GAP_S,
  type LiveReading,
} from "./speechMonitor";
import { readPace } from "./speechPace";
import { CAP_S } from "./speechPlan";
import { __resetPlanLog } from "./speechPlanLog";
import { watchSpeechRun, type StopReason } from "./speechRun";
import { __resetWorkGate } from "./workGate";

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "speechLive");
const CAPTURE_FILE = /^speechLive\.capture(\.fake)?\.json$/;

/** The captures committed (the fake one now, the real one once the slot has made it), and the one named by
 *  ARTDADDY_LIVE_CAPTURE_IN: what the smoke test just wrote, to be replayed before it is committed. */
function committedCaptures(): Array<[string, SpeechLiveCapture]> {
  const list: Array<[string, SpeechLiveCapture]> = readdirSync(FIXTURE_DIR)
    .filter((n) => CAPTURE_FILE.test(n))
    .sort()
    .map((n) => [
      n,
      JSON.parse(readFileSync(path.join(FIXTURE_DIR, n), "utf8")) as SpeechLiveCapture,
    ]);
  const extra = process.env.ARTDADDY_LIVE_CAPTURE_IN;
  if (extra)
    list.push([
      `${path.basename(extra)} (ARTDADDY_LIVE_CAPTURE_IN)`,
      JSON.parse(readFileSync(extra, "utf8")) as SpeechLiveCapture,
    ]);
  return list;
}

const GENERATED: Array<[string, SpeechLiveCapture]> = [
  ["generated: a fast PC, 25 min", fakeCapture({ audioS: 1500, rate: 0.3, startupS: 3.2 })],
  [
    "generated: a slower PC, comma form, four segments a window",
    fakeCapture({ audioS: 1800, rate: 0.45, startupS: 6, comma: true, segmentsPerWindow: 4 }),
  ],
];
const CAPTURES = [...committedCaptures(), ...GENERATED];

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  __resetSpeechJobs();
  __resetWorkGate();
});

/** The start-up the monitor measures is launch to the first words less the work behind them; the engine's own
 *  `load time` is the model load alone. The rest is the process starting, the backend libraries loading (the
 *  graphics backend's is 50 MB even when the chip is off), the audio being read, the language being detected:
 *  seconds on a PC. This much is "close": a start-up a quarter of a minute off the load time is no estimate of
 *  it, and the real capture would say so. */
const START_UP_SLACK_S = 10;
/** A kill ends the process "within a few seconds". */
const KILL_LIMIT_MS = 5_000;
/** The rate the monitor claims must be within this of what the engine's own total says (P1, 4). */
const RATE_TOLERANCE = 0.2;
const DOUBLE_CAP_S = 2 * CAP_S;
/** The largest projection the tests scale a capture to; a run is scalable to it when no window of it, scaled, passes
 *  MAX_GAP_S. A capture of N even windows scales a window to WORST_PROJECTION_S / N. */
const WORST_PROJECTION_S = 1.5 * DOUBLE_CAP_S;
const WINDOWS_NEEDED = 20;

/** How long the run took, for choosing a k: the time to the end of a run nobody stopped. */
const wallS = (c: RunCapture): number => c.exit.wallMs / 1000;

/** The stretches the live check counts: the time from launch to the first output and between outputs, each in
 *  ms. Worked out from the capture's own times, not from the monitor. */
function stretchesMs(c: RunCapture): number[] {
  const times = segmentBursts(c.chunks).map((b) => b.tMs);
  return times.map((t, i) => t - (i === 0 ? 0 : times[i - 1]));
}

/** The same in windows: the engine writes a window's segments one after the other, each flushed as its own write,
 *  so they arrive within a few milliseconds of each other. Outputs less than 50 ms apart are one window's (a real
 *  window is seconds from the next: a 30 s window decoded at 3 s of work per second of audio takes a minute and a half). */
function windowStretchesMs(c: RunCapture): number[] {
  const kept: number[] = [];
  for (const b of segmentBursts(c.chunks))
    if (kept.length === 0 || b.tMs - kept[kept.length - 1] >= 50) kept.push(b.tMs);
  return kept.map((t, i) => t - (i === 0 ? 0 : kept[i - 1]));
}

/** The run's active time at its last output, by the rule the check is built on: a stretch counts for at most
 *  MAX_GAP_S (a sleep or a stall is not the engine's work). Plain arithmetic over the capture's times. */
function handActiveS(c: RunCapture): number {
  return stretchesMs(c).reduce((n, g) => n + Math.min(Math.max(g, 0), MAX_GAP_S * 1000), 0) / 1000;
}

/** The judge of the live check, written again from its rule and not from its code: stop at the first output
 *  whose reading is over, when the reading before it (the output before) was over too, with none that was not
 *  over in between, and the run's active time has gone at least LIVE_CONFIRM_S since the first of that row. A
 *  reading is over when 90 s of audio are measured, a minute is left, and what the run took plus what it
 *  needs passes twice the cap. Returns the index of the output it stops at. */
function judgeAgain(readings: readonly LiveReading[]): number | null {
  let rowStartS: number | null = null;
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const over =
      r.etaS !== null &&
      r.audioS >= LIVE_MIN_AUDIO_S &&
      r.etaS >= LIVE_MIN_LEFT_S &&
      r.activeS + r.etaS > DOUBLE_CAP_S;
    if (!over) {
      rowStartS = null;
      continue;
    }
    if (rowStartS === null) rowStartS = r.activeS;
    else if (r.activeS - rowStartS >= LIVE_CONFIRM_S - 1e-9) return i;
  }
  return null;
}

/** A k that makes the run take `times` as long as it did. */
const kFor = (c: RunCapture, projectedS: number): number => projectedS / wallS(c);

interface WatcherRun {
  /** Every stop the app was asked for, and when (ms since launch). */
  stops: Array<{ how: StopReason; atMs: number }>;
  /** What the chip's store said after each output. */
  chip: ChipSample[];
  /** The pace this PC kept, as the run left it. */
  pace: ReturnType<typeof readPace>;
  end: ReturnType<ReturnType<typeof watchSpeechRun>["finish"]>;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The product's own watcher (speechRun.ts) driven by a capture, on a clock that reads the capture's times: the
 *  monitor, the live check, the chip's store and the pace the run leaves behind, all as the app has them. The
 *  engine's early log is handed over as the job supervisor holds it. A stop ends the run, as the app's does. */
async function replayWatcher(run: RunCapture, liveStop = true): Promise<WatcherRun> {
  const T0 = Date.UTC(2026, 10, 15, 6, 0, 0);
  let clock = T0;
  const stops: WatcherRun["stops"] = [];
  const watch = watchSpeechRun({
    id: "whisper-replay",
    purpose: "index",
    label: "recording.wav",
    work: [{ source: "recording.wav", language: "", window: null }],
    spanS: run.audioS,
    threads: run.engine.threads,
    liveStop,
    several: false,
    cpuOnly: run.engine.args.includes("-ng"),
    afterCrash: false,
    stop: (how) => stops.push({ how, atMs: clock - T0 }),
    readLog: async () => run.stderrHead,
    now: () => clock,
  });
  const chip: ChipSample[] = [];
  for (const c of run.chunks) {
    clock = T0 + c.tMs;
    watch.onStdout(c.text);
    await settle();
    const job = useSpeechJobs.getState().jobs[0];
    chip.push({
      tMs: c.tMs,
      phase: job.phase,
      firstWordsMs: job.firstWordsAt === null ? null : job.firstWordsAt - (job.startedAt ?? T0),
      doneS: job.doneS,
      rate: job.rate,
      etaS: job.etaS,
    });
    if (stops.length > 0) break;
  }
  const end = watch.finish(stops.length > 0 ? -1 : (run.exit.code ?? 0), stops[0]?.how ?? null);
  return { stops, chip, pace: readPace(), end };
}

/** What a replay says about when it stopped, as the time of the output it stopped at. */
const stoppedAtMs = (r: MonitorReplay): number | null => r.stoppedAt?.tMs ?? null;

describe.each(CAPTURES)("the capture %s", (_name, cap) => {
  const stats = segmentStats(cap.chunks);
  const full = replayMonitor(cap, { liveStop: false });

  it("is a capture the schema accepts, of enough audio for a rate to mean something and for the live stop to be shown", () => {
    expect(validateCapture(cap)).toEqual([]);
    // twenty windows: the live check must be shown a run over twice the cap by scaling this one, and the shortest
    // run that can be scaled that far without a window of it passing MAX_GAP_S has about this many
    expect(cap.audioS).toBeGreaterThanOrEqual(WINDOWS_NEEDED * 30);
    expect(cap.exit.code).toBe(0);
  });

  it("can be scaled to a PC that takes 1.5 times twice the cap and still be read: no stretch of it, the start-up included, scaled, passes MAX_GAP_S", () => {
    const worst = Math.max(...windowStretchesMs(cap));
    const k = kFor(cap, WORST_PROJECTION_S);
    expect(
      (worst * k) / 1000,
      `its longest stretch is ${(worst / 1000).toFixed(1)} s; scaled by ${k.toFixed(1)} it passes MAX_GAP_S: this capture cannot show the live stop (make it longer, or more even)`,
    ).toBeLessThanOrEqual(MAX_GAP_S);
  });

  it("is read live to its last segment, with the bursts the engine printed, and every segment of its final output seen", () => {
    expect(full.final.snapshot.doneS).toBeCloseTo(stats.lastEndS, 2);
    expect(full.final.live.bursts).toBe(stats.bursts);
    if (cap.finalJson) {
      expect(stats.segments, "the segments printed live are the segments of the final file").toBe(
        cap.finalJson.segments,
      );
      expect(stats.lastEndS).toBeCloseTo(cap.finalJson.lastEndS, 1);
    }
  });

  it("is printed as the engine goes, not at the end: bursts across the run, the first before its middle", () => {
    const times = stats.burstTimesMs;
    expect(times.length).toBeGreaterThanOrEqual(Math.floor(cap.audioS / 30 / 2));
    expect(times[0]).toBeLessThan(cap.exit.wallMs / 2);
    // a block-buffered engine prints everything at the end: its bursts fall in the last tenth of the run
    const tenths = new Set(times.map((t) => Math.min(9, Math.floor((10 * t) / cap.exit.wallMs))));
    expect(tenths.size, "the tenths of the run in which something arrived").toBeGreaterThanOrEqual(
      5,
    );
  });

  it("has the first words after the model was loaded, and a measured start-up close to what the engine says", () => {
    expect(full.final.snapshot.firstWordsAt).toBe(stats.burstTimesMs[0]);
    const loadS = (cap.stderrFacts.loadMs ?? 0) / 1000;
    expect(
      stats.burstTimesMs[0] / 1000,
      "words cannot come before the model is there",
    ).toBeGreaterThan(loadS);
    const startupS = full.final.snapshot.startupS;
    if (startupS !== null && cap.stderrFacts.loadMs !== undefined)
      expect(Math.abs(startupS - loadS)).toBeLessThanOrEqual(START_UP_SLACK_S);
  });

  it("has a rate within 20% of what the engine's own total time says, over the audio", () => {
    const totalMs = cap.stderrFacts.totalMs;
    expect(totalMs, "the engine's own timing lines").toBeDefined();
    const engineRate = totalMs! / 1000 / (cap.stderrFacts.audioS ?? cap.audioS);
    const rate = full.final.snapshot.rate;
    expect(rate, "a rate is claimed after this much audio").not.toBeNull();
    expect(Math.abs(rate! - engineRate) / engineRate).toBeLessThanOrEqual(RATE_TOLERANCE);
  });

  it("names the backend from the head of the engine's log alone, and finds the line inside what the supervisor keeps", () => {
    const where = cap.stderrHead.indexOf("whisper_backend_init_gpu");
    expect(where, "the backend line is in the head of the log").toBeGreaterThanOrEqual(0);
    expect(where + 80).toBeLessThan(STDERR_HEAD_BYTES);
    expect(full.final.snapshot.backend).toBe(cap.engine.backend === "cpu" ? "cpu" : "gpu");
    expect(full.final.snapshot.noGpu).toBe(cap.engine.backend === "cpu");
  });

  describe("the live stop on this capture's own cadence", () => {
    it("never stops the run as it was: the PC that made it finished in time", () => {
      expect(wallS(cap), "the capture's own run is inside the cap").toBeLessThan(DOUBLE_CAP_S);
      expect(replayMonitor(cap).stoppedAt).toBeNull();
    });

    it("never stops a PC slower by a k that keeps the projection under twice the cap, over the whole run", () => {
      const slower = scaleCapture(cap, kFor(cap, 0.7 * DOUBLE_CAP_S));
      expect(wallS(slower)).toBeCloseTo(0.7 * DOUBLE_CAP_S, 3);
      expect(replayMonitor(slower).stoppedAt, "stopped a run that fits").toBeNull();
      expect(
        judgeAgain(replayMonitor(slower, { liveStop: false }).steps.map((s) => s.live)),
      ).toBeNull();
    });

    it("stops a PC slower by a k that passes twice the cap, early, and only on what the rule allows", () => {
      const slower = scaleCapture(cap, kFor(cap, 1.15 * DOUBLE_CAP_S));
      const stopped = replayMonitor(slower);
      const at = stopped.stoppedAt;
      expect(at, "a run over twice the cap was never stopped").not.toBeNull();
      const readings = replayMonitor(slower, { liveStop: false }).steps.map((s) => s.live);
      expect(at!.index, "the same output the judge written again stops at").toBe(
        judgeAgain(readings),
      );
      // on this reading: the audio the speed rests on, the time left, and the projection are each enough...
      expect(at!.live.audioS).toBeGreaterThanOrEqual(LIVE_MIN_AUDIO_S);
      expect(at!.live.etaS!).toBeGreaterThanOrEqual(LIVE_MIN_LEFT_S);
      expect(at!.live.activeS + at!.live.etaS!).toBeGreaterThan(DOUBLE_CAP_S);
      // ...and not on the first reading alone: the output before it was over too, 20 s of the run's time back
      const before = readings[at!.index - 1];
      expect(before.activeS + before.etaS!).toBeGreaterThan(DOUBLE_CAP_S);
      expect(before.audioS).toBeGreaterThanOrEqual(LIVE_MIN_AUDIO_S);
      // and well before the end: that is what stopping a run is for
      expect(at!.tMs).toBeLessThan(0.5 * slower.exit.wallMs);
    });

    it("stops exactly where the rule says over a range of k, and never in the band it may not", () => {
      for (const projectedS of [0.3, 0.5, 0.7, 0.9, 1.0, 1.1, 1.15, 1.3, 2, 4].map(
        (x) => x * DOUBLE_CAP_S,
      )) {
        const slower = scaleCapture(cap, kFor(cap, projectedS));
        const live = replayMonitor(slower);
        const readings = replayMonitor(slower, { liveStop: false }).steps.map((s) => s.live);
        expect(
          live.stoppedAt?.index ?? null,
          `at a projection of ${Math.round(projectedS)} s`,
        ).toBe(judgeAgain(readings));
        if (projectedS <= 0.7 * DOUBLE_CAP_S) expect(live.stoppedAt).toBeNull();
        // a PC so slow that every window passes MAX_GAP_S is out of the check's reach (tested below)
        const readable = Math.max(...windowStretchesMs(slower).slice(1)) <= MAX_GAP_S * 1000;
        if (readable && projectedS >= 1.15 * DOUBLE_CAP_S) expect(live.stoppedAt).not.toBeNull();
      }
    });

    it("drives the product's own watcher to the same stop, keeps what the run showed of the PC's pace, and tells the chip", async () => {
      const slower = scaleCapture(cap, kFor(cap, 1.3 * DOUBLE_CAP_S));
      const pure = replayMonitor(slower);
      const ran = await replayWatcher(slower);
      expect(ran.stops).toHaveLength(1);
      expect(ran.stops[0].how).toBe("too_slow");
      expect(ran.stops[0].atMs).toBeCloseTo(stoppedAtMs(pure)!, 2);
      expect(ran.end.liveProjectedS!).toBeGreaterThan(DOUBLE_CAP_S);
      // a stopped run reports no timings of its own: what it showed is kept, on the processor, unless it slept
      expect(ran.pace).toHaveLength(1);
      expect(ran.pace[0][2]).toBe("cpu");
      expect(ran.pace[0][0]).toBeCloseTo(pure.stoppedAt!.snapshot.doneS, 6);
      expect(ran.pace[0][1]).toBeCloseTo(pure.stoppedAt!.live.activeS, 6);
      expect(ran.chip[ran.chip.length - 1].doneS).toBeCloseTo(pure.stoppedAt!.snapshot.doneS, 6);
    });
  });

  describe("a sleep in the middle of the run", () => {
    const burstTimes = stats.burstTimesMs;
    const at = burstTimes[Math.floor(burstTimes.length / 2)];
    const GAP_MS = 5 * 60_000;

    it("is not a stop for a fast run, is counted for MAX_GAP_S of the run's time, and the speed after it is the speed of what came after it", () => {
      const slept = withGap(cap, at, GAP_MS);
      const replay = replayMonitor(slept);
      expect(replay.stoppedAt, "a sleep stopped a run that fits").toBeNull();
      const last = replay.final.live;
      expect(last.clamped).toBe(true);
      // the run's own time: every stretch counted for at most MAX_GAP_S, worked out from the times
      expect(last.activeS).toBeCloseTo(handActiveS(slept), 6);
      expect(last.activeS, "the sleep is not in the run's time past MAX_GAP_S").toBeLessThan(
        slept.exit.wallMs / 1000 - (GAP_MS / 1000 - MAX_GAP_S) + 1e-6,
      );
      // the speed after it: the work between the first output after the sleep and the last, per audio second
      const bursts = segmentBursts(slept.chunks);
      const first = bursts.find((b) => b.tMs > at + GAP_MS - 1)!;
      const lastBurst = bursts[bursts.length - 1];
      const after = (lastBurst.tMs - first.tMs) / 1000 / (lastBurst.endS - first.endS);
      expect(last.rate!).toBeCloseTo(after, 9);
    });

    it("does not make a run that is not over the cap into one that is: a sleep adds at most MAX_GAP_S to what it will take", () => {
      // a run projected at 82% of twice the cap, put to sleep for 5 minutes in its middle: counted whole the
      // sleep would take it past twice the cap (a stop), counted for MAX_GAP_S it stays under
      const base = scaleCapture(cap, kFor(cap, 0.82 * DOUBLE_CAP_S));
      const baseAt = segmentBursts(base.chunks)[Math.floor(stats.bursts * 0.4)].tMs;
      const slept = withGap(base, baseAt, GAP_MS);
      expect(
        wallS(slept),
        "the premise: unclamped, the sleep passes twice the cap",
      ).toBeGreaterThan(DOUBLE_CAP_S);
      expect(wallS(base) + MAX_GAP_S, "the premise: clamped, it does not").toBeLessThan(
        DOUBLE_CAP_S,
      );
      expect(
        replayMonitor(slept).stoppedAt,
        "the sleep was taken for the engine's work",
      ).toBeNull();
    });

    it("keeps no pace from a run that had a gap in it, and does from the same run without one", async () => {
      // a slow run, over twice the cap, put to sleep early and stopped by the check some time after
      const slow = scaleCapture(cap, kFor(cap, WORST_PROJECTION_S));
      const early = segmentBursts(slow.chunks)[1].tMs;
      const plain = await replayWatcher(slow);
      expect(plain.stops).toHaveLength(1);
      expect(plain.pace, "an uninterrupted run shows this PC's pace").toHaveLength(1);
      __resetSpeechJobs();
      localStorage.clear();
      const slept = await replayWatcher(withGap(slow, early, GAP_MS));
      expect(slept.stops, "the run is still stopped for being too slow").toHaveLength(1);
      expect(slept.pace, "a pace with a gap in it could be several times too slow").toEqual([]);
    });
  });

  it("is never stopped by the check on a PC so slow that every window takes more than MAX_GAP_S of work (the named residual: only admission protects such a PC)", () => {
    const shortest = Math.max(1, Math.min(...windowStretchesMs(cap)));
    const k = (MAX_GAP_S * 1000 + 1) / shortest + 1;
    const stalled = scaleCapture(cap, k);
    // the windows are the capture's own (the scaling stretches the milliseconds between one window's segments too)
    expect(shortest * k, "the premise: every window passes MAX_GAP_S").toBeGreaterThan(
      MAX_GAP_S * 1000,
    );
    expect(wallS(stalled), "the premise: the run is far over the cap").toBeGreaterThan(
      DOUBLE_CAP_S,
    );
    const replay = replayMonitor(stalled);
    expect(replay.stoppedAt).toBeNull();
    expect(replay.final.live.clamped).toBe(true);
  });

  it.skipIf(cap.killed === undefined)(
    "has a Cancel that stops the process quickly, leaves no output, is answered as a stop and not a crash, and leaves the monitor consistent",
    () => {
      const killed = cap.killed!;
      const exit = killed.exit;
      expect(exit.killedAtMs, "the run was killed at a known time").toBeDefined();
      expect(exit.stoppedBy, "the result says it was stopped by the person").toBe("person");
      expect(exit.outputFileLeft, "a killed run leaves no output file").toBe(false);
      expect(exit.launches, "no retry of the engine after a stop").toBe(1);
      expect(exit.deathMs!, "the process was gone within a few seconds").toBeLessThanOrEqual(
        KILL_LIMIT_MS,
      );
      expect(exit.wallMs).toBe(exit.killedAtMs! + exit.deathMs!);
      expect(killed.finalJson, "no transcript was made").toBeUndefined();
      // nothing arrives after the process is gone
      const lastChunk = Math.max(0, ...killed.chunks.map((c) => c.tMs));
      expect(lastChunk).toBeLessThanOrEqual(exit.wallMs);
      const replay = replayMonitor(killed);
      expect(replay.stoppedAt, "a Cancel by the person is not the live stop").toBeNull();
      const done = replay.final.snapshot.doneS;
      expect(done).toBeGreaterThanOrEqual(0);
      expect(done).toBeLessThanOrEqual(killed.audioS + 1e-6);
      expect(done).toBeCloseTo(segmentStats(killed.chunks).lastEndS, 2);
    },
  );

  it.skipIf(cap.app === undefined)(
    "shows the chip, through the app's own path, what the replay shows it: the same first words, position, speed and time left after every output",
    async () => {
      const app = cap.app!;
      const replayed = await replayWatcher(app, false);
      expect(replayed.chip).toHaveLength(app.chip.length);
      app.chip.forEach((seen, i) => {
        const again = replayed.chip[i];
        expect(seen.tMs).toBe(again.tMs);
        expect(seen.phase).toBe(again.phase);
        expect(seen.doneS).toBeCloseTo(again.doneS, 6);
        // the clocks the app and the capture read are two reads of one millisecond clock
        expect(seen.firstWordsMs === null).toBe(again.firstWordsMs === null);
        if (seen.firstWordsMs !== null)
          expect(Math.abs(seen.firstWordsMs - again.firstWordsMs!)).toBeLessThan(50);
        expect(seen.rate === null).toBe(again.rate === null);
        if (seen.rate !== null)
          expect(Math.abs(seen.rate - again.rate!) / again.rate!).toBeLessThan(0.02);
        expect(seen.etaS === null).toBe(again.etaS === null);
        if (seen.etaS !== null)
          expect(Math.abs(seen.etaS - again.etaS!) / Math.max(again.etaS!, 1)).toBeLessThan(0.02);
      });
      // what the chip must do on any run: claim nothing until audio moves, never go back, claim a time only with a speed
      const donePath = app.chip.map((s) => s.doneS);
      expect(donePath).toEqual([...donePath].sort((a, b) => a - b));
      for (const s of app.chip) {
        expect(s.phase === "running", `phase at ${s.tMs} ms`).toBe(s.firstWordsMs !== null);
        if (s.etaS !== null) expect(s.rate).not.toBeNull();
      }
    },
  );

  it.skipIf(cap.killed === undefined && cap.app === undefined)(
    "has the app's own run end as the capture says: a finished run is done, a stopped one is a stop",
    () => {
      for (const run of [cap.killed, cap.app]) {
        if (!run) continue;
        if (run.exit.stoppedBy === undefined) expect(run.exit.code).toBe(0);
        else expect(["person", "too_slow"]).toContain(run.exit.stoppedBy);
      }
    },
  );
});

describe("the live stop on a steady run, worked out by hand", () => {
  const WINDOW_S = 30;
  interface Steady {
    name: string;
    run: FakeRunOptions;
    k: number;
  }

  /** The output a steady run is stopped at, from the constants alone. Every window takes `WINDOW_S * rate` of
   *  the run's time; the output after window w arrives at the start-up plus the audio so far at that rate. What
   *  the run takes in all is the same at every output (the start-up plus the audio at the rate), so it is over
   *  the cap at every output or at none. The first reading is the first output with LIVE_MIN_AUDIO_S of audio
   *  measured since the first (the speed is read from the first output on: the fourth), the second is the first
   *  output LIVE_CONFIRM_S of the run's time after it, and a run with LIVE_MIN_LEFT_S or less left is not stopped. */
  function byHand(run: FakeRunOptions, k: number): { window: number; atMs: number } | null {
    const rate = run.rate * k;
    const startupS = (run.startupS ?? 3) * k;
    if (!(startupS + run.audioS * rate > DOUBLE_CAP_S)) return null;
    const first = Math.ceil(LIVE_MIN_AUDIO_S / WINDOW_S);
    const window = first + Math.ceil(LIVE_CONFIRM_S / (WINDOW_S * rate));
    const left = (run.audioS - WINDOW_S * (window + 1)) * rate;
    if (left < LIVE_MIN_LEFT_S) return null;
    return { window, atMs: (startupS + WINDOW_S * (window + 1) * rate) * 1000 };
  }

  const CASES: Steady[] = [
    { name: "a fast PC 3 times slower", run: { audioS: 1500, rate: 0.3, startupS: 3.2 }, k: 3 },
    { name: "a fast PC 4 times slower", run: { audioS: 1500, rate: 0.3, startupS: 3.2 }, k: 4 },
    { name: "a fast PC 8 times slower", run: { audioS: 1500, rate: 0.3, startupS: 3.2 }, k: 8 },
    { name: "just under twice the cap", run: { audioS: 1500, rate: 0.3, startupS: 3.2 }, k: 2.6 },
    { name: "just over twice the cap", run: { audioS: 1500, rate: 0.3, startupS: 3.2 }, k: 2.7 },
    {
      name: "50 minutes at half real time (two windows to confirm)",
      run: { audioS: 3000, rate: 0.5, startupS: 4 },
      k: 1,
    },
    {
      name: "50 minutes at a third of real time",
      run: { audioS: 3000, rate: 0.35, startupS: 4 },
      k: 1,
    },
    {
      name: "a 5 minute file at nearly 4 s per second: slow, but under twice the cap",
      run: { audioS: 300, rate: 3.9, startupS: 2 },
      k: 1,
    },
  ];

  it.each(CASES)(
    "$name: stops at the output the arithmetic gives, or never",
    async ({ run, k }) => {
      const capture = scaleCapture(fakeCapture(run), k);
      const expected = byHand(run, k);
      const replay = replayMonitor(capture);
      if (expected === null) {
        expect(replay.stoppedAt).toBeNull();
        return;
      }
      expect(replay.stoppedAt?.index).toBe(expected.window);
      // the capture's times are whole milliseconds before they are scaled: the hand time is exact to k ms
      expect(Math.abs(replay.stoppedAt!.tMs - expected.atMs)).toBeLessThanOrEqual(k);
      // and the product's own watcher stops at the same moment (its clock is an epoch time: a few nanoseconds of rounding)
      const ran = await replayWatcher(capture);
      expect(ran.stops).toHaveLength(1);
      expect(ran.stops[0].atMs).toBeCloseTo(replay.stoppedAt!.tMs, 2);
    },
  );

  it("is in the table at both sides of the cap: some cases stop and some never do", () => {
    const answers = CASES.map((c) => byHand(c.run, c.k) !== null);
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});

describe("the committed fake capture", () => {
  const file = path.join(FIXTURE_DIR, "speechLive.capture.fake.json");

  it("is what the generator makes for its options, so its shape is the generator's and nobody's hand", () => {
    // git may check the file out with the line endings of the machine; the JSON itself has no raw newline in a value
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    expect(parseCapture(text)).toEqual(fakeCapture(FAKE_FIXTURE_OPTIONS));
    expect(text).toBe(serializeCapture(fakeCapture(FAKE_FIXTURE_OPTIONS)));
  });

  it("is a few kilobytes, with no speech and no path in it", () => {
    const text = readFileSync(file, "utf8");
    expect(text.length).toBeLessThan(40 * 1024);
    expect(validateCapture(JSON.parse(text))).toEqual([]);
  });
});
