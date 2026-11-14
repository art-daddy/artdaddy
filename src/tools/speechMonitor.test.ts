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
  createSpeechMonitor,
  MIN_AUDIO_S,
  MIN_WALL_S,
  passesLiveCap,
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
        fc.double({ min: 0, max: 5_000, noNaN: true }),
        fc.double({ min: 0, max: 5_000, noNaN: true }),
        fc.integer({ min: 60, max: 1_200 }),
        (elapsed, eta, cap) => {
          fc.pre(Math.abs(elapsed + eta - 2 * cap) > 1e-6);
          expect(passesLiveCap(elapsed, eta, cap)).toBe(elapsed + eta > 2 * cap);
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
