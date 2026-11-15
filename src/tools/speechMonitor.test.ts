// The running-job monitor (S2-09, 5.1b) as rules that survive a rewrite: what it claims and when, that it
// reads the same text the same way however the text is cut into chunks, that it can never fail or be slowed
// by what it is handed, and that its reading of the engine's log agrees with `whisperFacts.ts` on every
// capture the app keeps. Pure: every time is passed in.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BUFFER_CAP,
  createLiveCheck,
  createSpeechMonitor,
  LIVE_CONFIRM_S,
  LIVE_MIN_AUDIO_S,
  LIVE_MIN_LEFT_S,
  MAX_GAP_S,
  MIN_AUDIO_S,
  MIN_WALL_S,
  passesLiveCap,
  type LiveReading,
  type MonitorSnapshot,
} from "./speechMonitor";
import { backendOfRun } from "./speechPace";
import { whisperRunFacts } from "./whisperFacts";

const stamp = (s: number): string => {
  const total = Math.round(s * 1000);
  const ms = total % 1000;
  const whole = Math.floor(total / 1000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}.${pad(ms, 3)}`;
};
/** One segment line as whisper-cli prints it on stdout. */
const line = (from: number, to: number, text = "hello there"): string =>
  `[${stamp(from)} --> ${stamp(to)}]  ${text}\n`;

const FIXTURES = path.join(__dirname, "__fixtures__", "whisper");

describe("what the monitor claims, and when", () => {
  it("claims nothing before audio moves: no position, no first words, no speed, no time left", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 600 });
    expect(m.snapshot()).toEqual({
      doneS: 0,
      firstWordsAt: null,
      rate: null,
      etaS: null,
      startupS: null,
      backend: null,
      noGpu: false,
    });
    // The engine's own log is not words: it never starts the clock of the first words.
    m.feed(
      "whisper_init_from_file_with_params_no_state: loading model\nsystem_info: n_threads = 8\n",
      5_000,
    );
    expect(m.snapshot().firstWordsAt).toBeNull();
    expect(m.snapshot().etaS).toBeNull();
  });

  it("takes the time of the first segment as the first words, and the end of the latest as how far it got", () => {
    const m = createSpeechMonitor({ launchedAt: 1_000, spanS: 600 });
    m.feed(line(0, 12.5), 21_000);
    expect(m.snapshot()).toMatchObject({ doneS: 12.5, firstWordsAt: 21_000 });
    m.feed(line(12.5, 28.25) + line(28.25, 29.9), 22_000);
    expect(m.snapshot()).toMatchObject({ doneS: 29.9, firstWordsAt: 21_000 });
  });

  it("claims a speed only after at least 30 s of audio and 5 s of wall time since the first words, and a time left only with it", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 300 });
    // The first window arrives together (one burst) 20 s after launch.
    m.feed(line(0, 14) + line(14, 29), 20_000);
    expect(m.snapshot().rate, "one burst is not a speed").toBeNull();
    // 29 more seconds of audio, but only 4 s later: not enough time to read a speed from.
    m.feed(line(29, 58), 24_000);
    expect(m.snapshot().rate).toBeNull();
    expect(m.snapshot().etaS).toBeNull();
    // 30 s of audio since the burst and 10 s of wall time: 1/3 s of work per second of audio.
    m.feed(line(58, 59), 30_000);
    const s = m.snapshot();
    expect(s.rate).toBeCloseTo(10 / 30, 9);
    expect(s.etaS).toBeCloseTo((300 - 59) * (10 / 30), 9);
  });

  it("never claims a speed from less than 30 s of audio, however long it took, nor from less than 5 s of wall time, however much audio", () => {
    const slow = createSpeechMonitor({ launchedAt: 0, spanS: 600 });
    slow.feed(line(0, 10), 10_000);
    slow.feed(line(10, 39.5), 100_000); // 29.5 s of audio since the first burst, 90 s later
    expect(slow.snapshot().rate).toBeNull();
    slow.feed(line(39.5, 40.5), 110_000); // 30.5 s of audio
    expect(slow.snapshot().rate).toBeCloseTo(100 / 30.5, 9);
    const quick = createSpeechMonitor({ launchedAt: 0, spanS: 600 });
    quick.feed(line(0, 10), 10_000);
    quick.feed(line(10, 100), 14_900); // 90 s of audio, 4.9 s later
    expect(quick.snapshot().rate).toBeNull();
    quick.feed(line(100, 101), 15_000);
    expect(quick.snapshot().rate).toBeCloseTo(5 / 91, 9);
  });

  it("reads the start-up as launch to the first words less the work behind them, not as launch to the first words", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: null });
    m.feed(line(0, 30), 25_000); // 30 s of audio were decoded before anything was printed
    m.feed(line(30, 60), 35_000); // 10 s of work for each further 30 s of audio
    const s = m.snapshot();
    expect(s.rate).toBeCloseTo(1 / 3, 9);
    expect(s.startupS, "25 s to the first words, of which 10 s were decoding").toBeCloseTo(15, 9);
    expect(s.etaS, "no length, no time left").toBeNull();
  });

  it("never claims a start-up that cannot be true: none before the speed is known, none that is not positive", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: null });
    m.feed(line(0, 30), 5_000);
    expect(m.snapshot().startupS).toBeNull();
    m.feed(line(30, 60), 15_000); // 10 s per 30 s: the first 30 s alone took 10 s, more than the 5 s to the first words
    expect(m.snapshot().startupS).toBeNull();
  });

  it("is never negative or past its span: no time left once the audio has been read", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 40 });
    m.feed(line(0, 30), 10_000);
    m.feed(line(30, 62), 20_000); // past the span the caller expected
    expect(m.snapshot().etaS).toBe(0);
  });
});

describe("what the engine's log says about the backend", () => {
  it("is read from the lines whisper_backend_init_gpu prints, and from nothing else", () => {
    const using = createSpeechMonitor({ launchedAt: 0, spanS: null });
    using.feed("whisper_backend_init_gpu: using Vulkan0 backend\n", 1);
    expect(using.snapshot()).toMatchObject({ backend: "gpu", noGpu: false });
    const none = createSpeechMonitor({ launchedAt: 0, spanS: null });
    none.feed("whisper_backend_init_gpu: no GPU found\n", 1);
    expect(none.snapshot()).toMatchObject({ backend: "cpu", noGpu: true });
    const failed = createSpeechMonitor({ launchedAt: 0, spanS: null });
    failed.feed(
      "whisper_backend_init_gpu: using Vulkan0 backend\nwhisper_backend_init_gpu: failed to initialize\n",
      1,
    );
    expect(failed.snapshot()).toMatchObject({ backend: "cpu", noGpu: true });
    const quiet = createSpeechMonitor({ launchedAt: 0, spanS: null });
    quiet.feed("ggml_vulkan: Found 1 Vulkan devices:\nmain: processing\n", 1);
    expect(quiet.snapshot()).toMatchObject({ backend: null, noGpu: false });
  });

  // A table walk, not one example: every capture of the engine's log the app keeps.
  const captures = readdirSync(FIXTURES).filter((n) => /stderr\.txt$/.test(n));
  it("has captures to walk", () => expect(captures.length).toBeGreaterThanOrEqual(4));
  it.each(captures)(
    "agrees with whisperFacts on %s, however the log is cut into chunks",
    (name) => {
      const text = readFileSync(path.join(FIXTURES, name), "utf8");
      const want = backendOfRun(whisperRunFacts(text).backend);
      const whole = createSpeechMonitor({ launchedAt: 0, spanS: null });
      whole.feed(text, 1);
      const cut = createSpeechMonitor({ launchedAt: 0, spanS: null });
      for (let i = 0; i < text.length; i += 7) cut.feed(text.slice(i, i + 7), 1);
      expect(whole.snapshot().backend).toBe(want);
      expect(cut.snapshot().backend).toBe(want);
    },
  );
});

/** Segment lines with times that grow, and text that may hold anything a person can say. */
const segments = fc
  .array(
    fc.record({
      gap: fc.double({ min: 0, max: 5, noNaN: true }),
      length: fc.double({ min: 0.2, max: 30, noNaN: true }),
      text: fc.string({ maxLength: 40 }),
    }),
    { minLength: 1, maxLength: 25 },
  )
  .map((list) => {
    let t = 0;
    return list.map((s) => {
      const from = t + s.gap;
      t = from + s.length;
      return line(from, t, s.text.replace(/\n/g, " "));
    });
  });

describe("reading the same text however it arrives", () => {
  it("gives the same answer whether the text comes whole or in any chunks, at the same moment", () => {
    fc.assert(
      fc.property(
        segments,
        fc.array(fc.integer({ min: 1, max: 90 }), { minLength: 1, maxLength: 60 }),
        (lines, cuts) => {
          const text = lines.join("");
          const whole = createSpeechMonitor({ launchedAt: 0, spanS: 900 });
          whole.feed(text, 7_000);
          const chunked = createSpeechMonitor({ launchedAt: 0, spanS: 900 });
          let at = 0;
          for (let i = 0; at < text.length; i++) {
            const size = cuts[i % cuts.length];
            chunked.feed(text.slice(at, at + size), 7_000);
            at += size;
          }
          expect(chunked.snapshot()).toEqual(whole.snapshot());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("finds the same position when the chunks arrive at different moments, and never one the text does not hold", () => {
    fc.assert(
      fc.property(segments, fc.integer({ min: 1, max: 40 }), (lines, size) => {
        const text = lines.join("");
        const last = [...text.matchAll(/--> (\d\d):(\d\d):(\d\d)\.(\d{3})\]/g)].map(
          (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
        );
        const m = createSpeechMonitor({ launchedAt: 0, spanS: null });
        for (let at = 0, n = 0; at < text.length; at += size, n++)
          m.feed(text.slice(at, at + size), 1_000 * (n + 1));
        expect(m.snapshot().doneS).toBeCloseTo(Math.max(0, ...last), 9);
      }),
    );
  });

  it("claims a speed only when the time and the audio it rests on are both enough, at every cut of the text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 2, max: 60 }), fc.integer({ min: 1, max: 40 })), {
          minLength: 2,
          maxLength: 30,
        }),
        (steps) => {
          const m = createSpeechMonitor({ launchedAt: 0, spanS: 10_000 });
          let audio = 0;
          let now = 3_000;
          let firstAudio = 0;
          m.feed(line(0, 30), now);
          audio = 30;
          firstAudio = audio;
          const firstAt = now;
          for (const [wall, more] of steps) {
            now += wall * 1_000;
            m.feed(line(audio, audio + more), now);
            audio += more;
            const s = m.snapshot();
            if (s.rate !== null) {
              expect(audio - firstAudio, "enough audio").toBeGreaterThanOrEqual(MIN_AUDIO_S);
              expect((now - firstAt) / 1000, "enough time").toBeGreaterThanOrEqual(MIN_WALL_S);
              expect(s.rate).toBeCloseTo((now - firstAt) / 1000 / (audio - firstAudio), 9);
            } else expect(s.etaS, "no time left without a speed").toBeNull();
          }
        },
      ),
    );
  });
});

describe("what it can be handed", () => {
  const snapshotOf = (
    feed: (m: ReturnType<typeof createSpeechMonitor>) => void,
  ): MonitorSnapshot => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 100 });
    feed(m);
    return m.snapshot();
  };
  const nothing: MonitorSnapshot = {
    doneS: 0,
    firstWordsAt: null,
    rate: null,
    etaS: null,
    startupS: null,
    backend: null,
    noGpu: false,
  };

  it("changes nothing for any garbage: binary, brackets, lookalikes, empty chunks, wrong types", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "binary", maxLength: 300 }), { maxLength: 20 }),
        (junk) => {
          expect(snapshotOf((m) => junk.forEach((c) => m.feed(c, 1_000)))).toEqual(nothing);
        },
      ),
    );
    const lookalikes = [
      "[00:00:00.000 --> 00:00:xx.000]  no",
      "[0:0:0.0 --> 0:0:0.0] no",
      "[00:61:00.000 --> 00:00:05.000] minutes past 59",
      "[00:00:00.000 -- 00:00:05.000] one dash short",
      "[ 00:00:00.000 --> 00:00:05.000 ] spaces inside",
      "00:00:00.000 --> 00:00:05.000 no brackets",
    ];
    expect(snapshotOf((m) => lookalikes.forEach((c) => m.feed(c, 1_000)))).toEqual(nothing);
    const wrong = createSpeechMonitor({ launchedAt: 0, spanS: 100 });
    for (const bad of [undefined, null, 42, {}, [], Symbol("x")] as unknown[])
      wrong.feed(bad as string, 1_000);
    wrong.feed("[00:00:00.000 --> 00:00:05.000]  ok", Number.NaN);
    expect(wrong.snapshot()).toEqual({ ...nothing });
  });

  it("is not thrown off by a segment that ends before it starts, or text that never closes a bracket", () => {
    expect(snapshotOf((m) => m.feed("[00:00:09.000 --> 00:00:02.000]  backwards\n", 1))).toEqual(
      nothing,
    );
    expect(
      snapshotOf((m) => {
        m.feed("[".repeat(BUFFER_CAP * 2), 1);
        m.feed(line(0, 7), 2);
      }),
    ).toMatchObject({ doneS: 7, firstWordsAt: 2 });
  });

  it("reads a 10 MB flood in bounded work and still finds the words that follow it", () => {
    const flood = "x".repeat(1024 * 1024);
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 100 });
    const began = performance.now();
    for (let i = 0; i < 10; i++) m.feed(flood, 1_000);
    m.feed("y".repeat(10 * 1024 * 1024), 1_000); // and one chunk of 10 MB at once
    m.feed(line(0, 33), 2_000);
    expect(performance.now() - began, "linear in what it is handed").toBeLessThan(5_000);
    expect(m.snapshot()).toMatchObject({ doneS: 33, firstWordsAt: 2_000 });
  });

  it("finds a marker that a flood's chunk boundary cut in two", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: null });
    const marker = line(0, 12);
    m.feed("z".repeat(BUFFER_CAP - 9) + marker.slice(0, 9), 1);
    m.feed(marker.slice(9), 2);
    expect(m.snapshot()).toMatchObject({ doneS: 12, firstWordsAt: 2 });
  });
});

describe("the live check", () => {
  it("passes the cap exactly when the time taken plus the time left is more than twice the cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 1_200 }),
        fc.double({ min: 0.3, max: 3, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (cap, ratio, split) => {
          const total = ratio * 2 * cap;
          fc.pre(Math.abs(total - 2 * cap) > 1e-6);
          expect(passesLiveCap(total * split, total * (1 - split), cap)).toBe(ratio > 1);
        },
      ),
    );
  });

  it("never passes while the speed is not measured, or for anything that is not a number", () => {
    expect(passesLiveCap(10_000, null, 600)).toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity])
      expect([passesLiveCap(bad, 5, 600), passesLiveCap(5, bad, 600)]).toEqual([false, false]);
  });
});

describe("the run's own time, which the live check reads instead of the clock's (F1)", () => {
  it("is the time between outputs, a stretch counted whole up to MAX_GAP_S, and no stretch is cut short", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 600 });
    m.feed(line(0, 30), 25_000); // 25 s from the launch to the first output, the engine's start-up included
    m.feed(line(30, 60), 55_000);
    m.feed(line(60, 90), 55_000 + MAX_GAP_S * 1000); // exactly the most that is trusted
    expect(m.live()).toMatchObject({ bursts: 3, activeS: 25 + 30 + MAX_GAP_S, clamped: false });
  });

  it("counts a stretch longer than MAX_GAP_S for nothing, says so, and reads the speed again from after it", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 3600 });
    m.feed(line(0, 30), 25_000);
    m.feed(line(30, 60), 55_000);
    m.feed(line(60, 90), 55_000 + 1_800_000); // half an hour: a sleep
    const after = m.live();
    expect(after.activeS, "the sleep is not the engine's work").toBeCloseTo(25 + 30, 9);
    expect(after.clamped).toBe(true);
    expect(after, "the speed of the stretch with the gap in it is not read").toMatchObject({
      audioS: 0,
      rate: null,
      etaS: null,
    });
    m.feed(line(90, 120), 55_000 + 1_800_000 + 40_000);
    m.feed(line(120, 150), 55_000 + 1_800_000 + 80_000);
    // 60 s of audio at 40 s of work for each 30: from the burst after the gap, not from the first
    expect(m.live().audioS).toBeCloseTo(60, 9);
    expect(m.live().rate).toBeCloseTo(80 / 60, 9);
    expect(m.live().etaS).toBeCloseTo((3600 - 150) * (80 / 60), 9);
    expect(m.live().clamped, "and it is said for the rest of the run").toBe(true);
  });

  it("counts the stretch from the launch to the first output like any other: a long start-up is not trusted either", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 600 });
    m.feed(line(0, 30), 400_000);
    expect(m.live()).toMatchObject({ activeS: 0, clamped: true });
  });

  it("adds nothing for a clock that has gone back, and takes nothing away", () => {
    const m = createSpeechMonitor({ launchedAt: 1_000_000, spanS: 600 });
    m.feed(line(0, 30), 1_020_000);
    m.feed(line(30, 60), 1_020_000 - 3_600_000); // an hour back
    expect(m.live()).toMatchObject({ activeS: 20, clamped: false });
    m.feed(line(60, 90), 1_020_000 - 3_600_000 + 30_000);
    expect(m.live().activeS).toBeCloseTo(50, 9);
  });

  it("is only ever the same as the clock's time or less, never goes back, and never counts a stretch longer than MAX_GAP_S", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5_000, max: 400_000 }), { minLength: 1, maxLength: 40 }),
        (gaps) => {
          const m = createSpeechMonitor({ launchedAt: 1_000_000, spanS: null });
          let now = 1_000_000;
          let before = 0;
          gaps.forEach((gap, i) => {
            now += gap;
            m.feed(line(i, i + 1), now);
            const live = m.live();
            expect(live.activeS).toBeGreaterThanOrEqual(before);
            expect(live.activeS).toBeLessThanOrEqual((i + 1) * MAX_GAP_S + 1e-9);
            // each output adds its own stretch whole or nothing: never a part of a long one
            const added = live.activeS - before;
            expect(added === 0 || added <= MAX_GAP_S + 1e-9).toBe(true);
            before = live.activeS;
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is exactly the clock's time while no stretch is longer than MAX_GAP_S: the check reads what it read before", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: MAX_GAP_S * 1000 }), { minLength: 1, maxLength: 40 }),
        (gaps) => {
          const m = createSpeechMonitor({ launchedAt: 5_000, spanS: null });
          let now = 5_000;
          gaps.forEach((gap, i) => {
            now += gap;
            m.feed(line(i, i + 1), now);
            expect(m.live().activeS).toBeCloseTo((now - 5_000) / 1000, 9);
            expect(m.live().clamped).toBe(false);
          });
        },
      ),
    );
  });

  it("says nothing before the first output, and never throws for anything it is handed", () => {
    const m = createSpeechMonitor({ launchedAt: 0, spanS: 100 });
    expect(m.live()).toEqual({
      bursts: 0,
      activeS: 0,
      audioS: 0,
      rate: null,
      etaS: null,
      clamped: false,
    });
    m.feed(line(0, 30), Number.NaN);
    m.feed("garbage", 1);
    expect(m.live().bursts).toBe(0);
  });
});

describe("the judge of the live check (F1)", () => {
  const CAP = 600;
  /** A reading that is over twice the cap, 90 s of audio measured and a long way to go; override what a case varies. */
  const over = (over: Partial<LiveReading> = {}): LiveReading => ({
    bursts: 1,
    activeS: 300,
    audioS: LIVE_MIN_AUDIO_S,
    rate: 5,
    etaS: 5_000,
    clamped: false,
    ...over,
  });

  it("stops on the second of two readings over the cap in a row, at least 20 s of active time after the first, and not on the first", () => {
    const check = createLiveCheck(CAP);
    expect(check.observe(over({ bursts: 4, activeS: 300 }))).toBe(false);
    expect(check.observe(over({ bursts: 5, activeS: 300 + LIVE_CONFIRM_S - 0.5 }))).toBe(false);
    expect(check.observe(over({ bursts: 6, activeS: 300 + LIVE_CONFIRM_S }))).toBe(true);
  });

  it("measures the 20 s from the first reading of the row, however many readings come between", () => {
    const check = createLiveCheck(CAP);
    const stops = [0, 5, 10, 15, 19.5, 20].map((later, i) =>
      check.observe(over({ bursts: 10 + i, activeS: 300 + later })),
    );
    expect(stops).toEqual([false, false, false, false, false, true]);
  });

  it.each<[string, Partial<LiveReading>]>([
    ["is not over the cap", { activeS: 100, etaS: 500 }],
    ["has less than 90 s of audio measured", { audioS: LIVE_MIN_AUDIO_S - 0.5 }],
    // over the cap by the sum, and only the minute that must be left says no
    ["has less than a minute left", { activeS: 1_200, etaS: LIVE_MIN_LEFT_S - 0.5 }],
    ["has no speed yet", { rate: null, etaS: null }],
  ])("starts the two again when a reading between them %s", (_name, between) => {
    const check = createLiveCheck(CAP);
    const T = 1_190;
    expect(check.observe(over({ bursts: 4, activeS: T }))).toBe(false);
    expect(check.observe(over({ bursts: 5, activeS: T + 10, ...between }))).toBe(false);
    // 30 s after the first, but the row was broken: this is a first reading again
    expect(check.observe(over({ bursts: 6, activeS: T + 30 }))).toBe(false);
    expect(check.observe(over({ bursts: 7, activeS: T + 50 }))).toBe(true);
  });

  it("is exactly at the limits: 90 s of audio and a minute left count, and the cap is passed only by more than twice it", () => {
    const row = (second: Partial<LiveReading>): boolean => {
      const check = createLiveCheck(CAP);
      check.observe(over({ bursts: 1, activeS: 300, etaS: 5_000 }));
      return check.observe(over({ bursts: 2, activeS: 330, ...second }));
    };
    expect(row({ audioS: LIVE_MIN_AUDIO_S, activeS: 2 * CAP, etaS: LIVE_MIN_LEFT_S })).toBe(true);
    expect(row({ activeS: 2 * CAP - 330, etaS: 330 }), "twice the cap exactly").toBe(false);
    expect(row({ activeS: 2 * CAP - 329, etaS: 330 })).toBe(true);
  });

  it("does not take a reading again for the same burst: the log read after it is not a second reading", () => {
    const check = createLiveCheck(CAP);
    expect(check.observe(over({ bursts: 4, activeS: 300 }))).toBe(false);
    expect(check.observe(over({ bursts: 4, activeS: 400 }))).toBe(false);
    expect(check.observe(over({ bursts: 4, activeS: 500 }))).toBe(false);
  });

  it("forgets what it read when it is reset: the readings from before the switch went off do not count", () => {
    const check = createLiveCheck(CAP);
    check.observe(over({ bursts: 4, activeS: 300 }));
    check.reset();
    expect(check.observe(over({ bursts: 5, activeS: 400 }))).toBe(false);
  });

  it("never throws and never stops for a reading it cannot read", () => {
    fc.assert(
      fc.property(
        fc.record({
          bursts: fc.oneof(fc.integer(), fc.constant(Number.NaN)),
          activeS: fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Infinity)),
          audioS: fc.oneof(fc.double(), fc.constant(Number.NaN)),
          rate: fc.oneof(fc.double(), fc.constant(null)),
          etaS: fc.oneof(fc.double(), fc.constant(null), fc.constant(Number.NaN)),
          clamped: fc.boolean(),
        }),
        (r) => {
          const check = createLiveCheck(CAP);
          expect(() => check.observe(r)).not.toThrow();
          const finite = Number.isFinite(r.etaS ?? Number.NaN) && Number.isFinite(r.activeS);
          if (!finite) expect(check.observe({ ...r, bursts: r.bursts + 1 })).toBe(false);
        },
      ),
    );
  });
});

/** A steady run as the engine prints it: `rate` seconds of work for each second of audio, a start-up of
 *  `startupS` before the first words, and a pause of the given length before each window in `pauses`
 *  (a sleep: it adds time to the clock and none to the work). The monitor and the judge, as the watcher
 *  drives them; the index of the window it was stopped at, or null, and the active time at each window. */
function steadyRun(
  run: { rate: number; startupS: number; spanS: number; pauses: ReadonlyMap<number, number> },
  capS = 600,
): { stoppedAt: number | null; activeAt: number[] } {
  const m = createSpeechMonitor({ launchedAt: 0, spanS: run.spanS });
  const check = createLiveCheck(capS);
  const windows = Math.ceil(run.spanS / 30);
  const activeAt: number[] = [];
  let t = run.startupS * 1000;
  for (let k = 0; k < windows; k++) {
    t += 30 * run.rate * 1000 + (run.pauses.get(k) ?? 0) * 1000;
    m.feed(line(30 * k, Math.min(run.spanS, 30 * (k + 1))), Math.round(t));
    activeAt.push(m.live().activeS);
    if (check.observe(m.live())) return { stoppedAt: k, activeAt };
  }
  return { stoppedAt: null, activeAt };
}

describe("a run as a whole: the check and the monitor together (F1)", () => {
  // Every window is under MAX_GAP_S of work, so no stretch is long unless the PC slept.
  const rates = fc.double({ min: 0.2, max: 3.5, noNaN: true });

  it("never stops a run that fits in twice the cap, whatever pauses it had: a pause adds nothing to what the run is projected to take", () => {
    fc.assert(
      fc.property(
        rates,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 100, max: 40_000 }),
        fc.array(fc.nat(), { maxLength: 3 }),
        fc.array(fc.integer({ min: 121, max: 200_000 }), { maxLength: 3 }),
        (rate, startupS, spanS, where, long) => {
          const windows = Math.ceil(spanS / 30);
          const pauses = new Map<number, number>();
          long.forEach((extra, i) => pauses.set((where[i] ?? 0) % windows, extra));
          // a pause is a stretch longer than MAX_GAP_S: it counts for nothing, so the run is projected to take
          // what it takes (the run's own time is its start-up and its work: no term for the pauses)
          fc.pre(startupS + rate * spanS < 2 * 600 - 1);
          expect(steadyRun({ rate, startupS, spanS, pauses }).stoppedAt).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("does not stop a run at 95% of twice the cap because the PC slept for five minutes in it (a pause counted for any of its length would)", () => {
    // 1.9 s of work for each second of audio, 600 s of audio, 20 s to begin: 1,160 s in all, under twice the cap
    // (1,200 s) by 40 s; the same run with a 120 s pause counted would be projected at 1,280 s
    const run = { rate: 1.9, startupS: 20, spanS: 600 };
    expect(run.startupS + run.rate * run.spanS).toBeLessThan(1200);
    expect(steadyRun({ ...run, pauses: new Map() }).stoppedAt).toBeNull();
    for (const window of [1, 4, 10, 15, 19])
      expect(
        steadyRun({ ...run, pauses: new Map([[window, 300]]) }).stoppedAt,
        `a sleep before window ${window}`,
      ).toBeNull();
  });

  it("stops a run that is over twice the cap, with no pauses, at the first burst 20 s of the run's time after its first reading, and never before", () => {
    fc.assert(
      fc.property(
        rates,
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 900, max: 40_000 }),
        (rate, startupS, spanS) => {
          // over by a margin the first stretch's own cut (a long start-up counts for MAX_GAP_S) cannot hide
          fc.pre(startupS + rate * spanS > 1.1 * 2 * 600 + 60);
          const { stoppedAt, activeAt } = steadyRun({ rate, startupS, spanS, pauses: new Map() });
          // the first reading is the burst with 90 s of audio since the first: the fourth
          const first = 3;
          const expected = activeAt.findIndex(
            (a, k) => k > first && a - activeAt[first] >= LIVE_CONFIRM_S - 1e-6,
          );
          expect(stoppedAt).toBe(expected);
          expect(stoppedAt).not.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("stops the same run just as soon after a pause as before it, but only on readings that do not have the pause in them", () => {
    // 2 s of work for each second of audio: 60 s a window, 20 s to begin, 3,600 s of audio is far over the cap
    const base = steadyRun({ rate: 2, startupS: 20, spanS: 3600, pauses: new Map() });
    const slept = steadyRun({ rate: 2, startupS: 20, spanS: 3600, pauses: new Map([[2, 5_000]]) });
    expect(base.stoppedAt).toBe(4);
    // the pause is in window 2: the speed is read again from window 2, so the first reading is at window 5
    expect(slept.stoppedAt).toBe(6);
  });
});
