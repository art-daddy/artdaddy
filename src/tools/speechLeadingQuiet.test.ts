// The voice-start detector (speechLeadingQuiet.ts), held to the speech study's own answers and to the rules the launch gate leans on.
//
// What the expectations come from: `__fixtures__/firstWord/onset-reference.json` was written ONCE by the study's reference detector (a copy proven
// identical to tools/pkwords.py by syntax tree) run on programs of the pure-integer generator in src/test/synthAudio.ts, whose Python twin made the
// same samples (a checksum per case). No expectation below is computed by the module under test, and the table is never regenerated to make a test pass.
//
// What the study's numbers are, with their limits: the table is synthetic audio (noise, tones, a modulated tone as the voice), not speech; the real-clip
// parity (1070 clips, 20 languages and a harder English set) is the opt-in speechLeadingQuiet.real.e2e.ts.

import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fmtBody,
  fnv1a32,
  N,
  pcm16Wav,
  pcmBody,
  quietThenVoice,
  render,
  riff,
  samplesOf,
  synthPcm16,
  T,
  V,
  Z,
  type Chunk,
  type Segment,
} from "../test/synthAudio";
import {
  HeadReader,
  LEADING_QUIET_MS,
  MEASURE_GUARD_MS,
  VOICE_SCAN_S,
  measureVoiceStart,
  pcm16WavSamples,
  speechOnsetMs,
  voiceStartOf,
  voiceStartsLate,
  type VoiceStart,
} from "./speechLeadingQuiet";

interface Reference {
  onset_ms: number | null;
  frames: number;
  floor_db: number | null;
  threshold_db: number | null;
  margin_db: number | null;
}

type SegmentJson =
  | { kind: "noise"; n: number; amp: number; db: number }
  | { kind: "zero"; n: number }
  | { kind: "tone"; n: number; amp: number; db: number; pitch: number }
  | {
      kind: "voice";
      n: number;
      amp: number;
      db: number;
      gapAmp: number;
      gapDb: number;
      burstMs: number;
      gapMs: number;
      pitch: number;
    };

interface CaseJson {
  id: string;
  what: string;
  rate: number;
  seed: number;
  segments: SegmentJson[];
  post: { gainQ8?: number; dc?: number } | null;
  samples: number;
  fnv: string;
  reference: Reference;
  cut: { samples: number; fnv: string; reference: Reference } | null;
}

interface TieJson {
  id: string;
  what: string;
  rate: number;
  frames: { count: number; first: number }[];
  expect: "at" | "none";
  reference: Reference;
  ge_would_answer: number | null;
  tolerance_would_answer: number | null;
}

interface Table {
  scan_seconds: number;
  cases: CaseJson[];
  ties: TieJson[];
  mutants: Record<string, string[]>;
}

const TABLE: Table = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__", "firstWord", "onset-reference.json"), "utf8"),
);

/** Ties on a floor interpolated between two DIFFERENT quiet levels (a second file: the first table is frozen and untouched). */
interface FloorTieJson {
  id: string;
  rate: number;
  frames: { count: number; first: number }[];
  reference: { onset_ms: number | null };
  plain_interpolation_would_answer: number | null;
}

const FLOOR_TIES: { cases: FloorTieJson[] } = JSON.parse(
  readFileSync(
    path.join(__dirname, "__fixtures__", "firstWord", "onset-reference-floor-ties.json"),
    "utf8",
  ),
);

const HOP = 320;
const FRAME_MS = 20;
const NONE: VoiceStart = { kind: "none" };
const UNKNOWN: VoiceStart = { kind: "unknown" };
const at = (ms: number): VoiceStart => ({ kind: "at", ms });
const voiceStartOfReference = (reference: Reference): VoiceStart =>
  reference.onset_ms === null ? NONE : at(reference.onset_ms);

/** The program of a frozen case, built through the same builders the tests use (so the dB to amplitude step is part of what the checksum checks). */
function samplesOfCase(c: CaseJson): Int16Array {
  const segments: Segment[] = c.segments.map((s) => {
    switch (s.kind) {
      case "noise":
        return N(s.n, s.db);
      case "zero":
        return Z(s.n);
      case "tone":
        return T(s.n, s.db, s.pitch);
      case "voice":
        return V(s.n, s.db, s.gapDb, s.burstMs, s.gapMs, s.pitch);
    }
  });
  return render({ rate: c.rate, seed: c.seed, segments, post: c.post });
}

/** A tie case's samples: every frame is one sample then 319 zeros, the sample in the study's float domain times 32768 (exact: a power of two). */
function samplesOfTie(t: { frames: { count: number; first: number }[] }): Float64Array {
  const frames = t.frames.reduce((sum, f) => sum + f.count, 0);
  const out = new Float64Array(frames * HOP);
  let frame = 0;
  for (const f of t.frames) {
    for (let i = 0; i < f.count; i++) out[frame++ * HOP] = f.first * 32768;
  }
  return out;
}

const concat = (...parts: Int16Array[]): Int16Array => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const caseById = (id: string): CaseJson => {
  const found = TABLE.cases.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id} in the table`);
  return found;
};

const PROPERTY = { numRuns: 120, seed: 20261116 } as const;

describe("the frozen table", () => {
  it("holds what the study froze: 100 programs, 6 exact-threshold ties, the kill map of 30 slips", () => {
    expect(TABLE.cases).toHaveLength(100);
    expect(TABLE.ties).toHaveLength(6);
    expect(Object.keys(TABLE.mutants)).toHaveLength(30);
    expect(TABLE.scan_seconds).toBe(VOICE_SCAN_S);
  });

  it("tells every one of the 30 porting slips from the reference by at least one case it names", () => {
    const known = new Set([...TABLE.cases.map((c) => c.id), ...TABLE.ties.map((t) => t.id)]);
    for (const [slip, ids] of Object.entries(TABLE.mutants)) {
      expect(ids.length, slip).toBeGreaterThan(0);
      for (const id of ids) expect(known.has(id), `${slip} names ${id}`).toBe(true);
    }
  });

  it("has the quiet-then-voice family the rule turns on: 0, 0.5, 0.9, 1.0, 1.02, 1.1, 1.5, 3 and 8 s", () => {
    const onsets = [0, 0.5, 0.9, 1, 1.02, 1.1, 1.5, 3, 8].map(
      (s) => caseById(`quiet-${s}s-then-voice`).reference.onset_ms,
    );
    expect(onsets).toEqual([0, 500, 900, 1000, 1020, 1100, 1500, 3000, 8000]);
  });
});

describe("the generator is the study's: the same samples, case for case", () => {
  it.each(TABLE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const samples = samplesOfCase(c);
    expect(samples.length).toBe(c.samples);
    expect(fnv1a32(samples)).toBe(c.fnv);
    if (c.cut) {
      expect(c.cut.samples).toBe(VOICE_SCAN_S * c.rate);
      expect(fnv1a32(samples.subarray(0, c.cut.samples))).toBe(c.cut.fnv);
    }
  });

  it("makes the amplitudes the study made from the levels (a float rounding that differs would show here first)", () => {
    for (const c of TABLE.cases) {
      for (const s of c.segments) {
        if (s.kind === "noise")
          expect(N(1, s.db), c.id).toEqual({ kind: "noise", n: 1, amp: s.amp });
        if (s.kind === "tone") expect(T(1, s.db, s.pitch), c.id).toMatchObject({ amp: s.amp });
        if (s.kind === "voice") {
          expect(V(1, s.db, s.gapDb), c.id).toMatchObject({ amp: s.amp, gapAmp: s.gapAmp });
        }
      }
    }
  });
});

describe("speechOnsetMs answers what the study's detector answered", () => {
  it.each(TABLE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(speechOnsetMs(samplesOfCase(c), c.rate)).toBe(c.reference.onset_ms);
  });

  it.each(TABLE.ties.map((t) => [t.id, t] as const))("%s", (_id, t) => {
    const answer = speechOnsetMs(samplesOfTie(t), t.rate);
    expect(answer).toBe(t.reference.onset_ms);
    // the table separates `>` from `>=` and from a tolerance: the slips would have answered otherwise on exactly these frames
    if (t.id.endsWith("-eq")) expect(t.ge_would_answer).not.toBeNull();
    if (t.id.endsWith("-up")) expect(t.tolerance_would_answer).toBeNull();
  });

  it.each(FLOOR_TIES.cases.map((t) => [t.id, t] as const))(
    "%s (a floor between two different quiet levels, interpolated as numpy does)",
    (_id, t) => {
      // the other way of interpolating the quietest tenth answers differently on exactly these frames
      expect(t.plain_interpolation_would_answer).not.toBe(t.reference.onset_ms);
      expect(speechOnsetMs(samplesOfTie(t), t.rate)).toBe(t.reference.onset_ms);
    },
  );

  it("is a pure function of the samples (the same twice, and the input is not changed)", () => {
    const samples = samplesOfCase(caseById("quiet-1.02s-then-voice"));
    const copy = Int16Array.from(samples);
    expect(speechOnsetMs(samples)).toBe(speechOnsetMs(samples));
    expect(samples).toEqual(copy);
  });

  it("answers null for fewer than three frames, whatever the rate and whatever is in them", () => {
    for (const rate of [8000, 16000, 44100]) {
      const hop = Math.floor(rate / 50);
      expect(speechOnsetMs(new Int16Array(0), rate)).toBeNull();
      expect(
        speechOnsetMs(
          Int16Array.from({ length: hop * 3 - 1 }, () => 20000),
          rate,
        ),
      ).toBeNull();
    }
    expect(speechOnsetMs(new Int16Array(100_000), 0)).toBeNull();
    expect(speechOnsetMs(new Int16Array(100_000), 10)).toBeNull();
  });
});

describe("the WAV path answers what the reference answers for the first 30 seconds", () => {
  it.each(TABLE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const samples = samplesOfCase(c);
    const wanted = c.rate === 16000 ? voiceStartOfReference((c.cut ?? c).reference) : UNKNOWN;
    expect(voiceStartOf(pcm16Wav(samples, { rate: c.rate }))).toEqual(wanted);
    // a LIST chunk before `data` changes nothing, an odd one included (it is followed by a pad byte the size does not count)
    expect(voiceStartOf(pcm16Wav(samples, { rate: c.rate, list: 26 }))).toEqual(wanted);
    expect(voiceStartOf(pcm16Wav(samples, { rate: c.rate, list: 27 }))).toEqual(wanted);
  });

  it("takes at most the first 30 seconds of the samples", () => {
    const long = synthPcm16({ quietS: 1, voiceS: 59 });
    const wav = pcm16WavSamples(pcm16Wav(long));
    expect(wav?.samples.length).toBe(VOICE_SCAN_S * 16000);
    expect(fnv1a32(wav?.samples ?? [])).toBe(fnv1a32(long.subarray(0, VOICE_SCAN_S * 16000)));
  });
});

describe("a voice that starts at exactly one second is today's", () => {
  it("the rule is strictly more than one second, through the whole chain from the bytes", () => {
    const answer = (seconds: number): VoiceStart =>
      voiceStartOf(pcm16Wav(synthPcm16({ quietS: seconds, voiceS: 3 })));
    expect(answer(0.98)).toEqual(at(980));
    expect(voiceStartsLate(answer(0.98))).toBe(false);
    expect(answer(1)).toEqual(at(1000));
    expect(voiceStartsLate(answer(1))).toBe(false);
    expect(answer(1.02)).toEqual(at(1020));
    expect(voiceStartsLate(answer(1.02))).toBe(true);
  });

  it("LEADING_QUIET_MS is the owner's one second", () => {
    expect(LEADING_QUIET_MS).toBe(1000);
  });

  it("is late exactly when the voice starts after more than LEADING_QUIET_MS, and never for none or unknown", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200_000 }), (ms) => {
        expect(voiceStartsLate(at(ms))).toBe(ms > 1000);
      }),
      PROPERTY,
    );
    for (const ms of [0, 20, 980, 1000]) expect(voiceStartsLate(at(ms))).toBe(false);
    for (const ms of [1001, 1020, 1040, 8000]) expect(voiceStartsLate(at(ms))).toBe(true);
    expect(voiceStartsLate(NONE)).toBe(false);
    expect(voiceStartsLate(UNKNOWN)).toBe(false);
  });
});

describe("what the detector must always do, for any seed and any length", () => {
  it("finds no voice in silence, in steady noise of any level, or in a steady offset", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.integer({ min: -110, max: -1 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: -3000, max: 3000 }),
        (seed, db, frames, dc) => {
          const noise = render({ rate: 16000, seed, segments: [N(frames * HOP, db)] });
          expect(speechOnsetMs(noise)).toBeNull();
          const offset = render({ rate: 16000, seed, segments: [Z(frames * HOP)], post: { dc } });
          expect(speechOnsetMs(offset)).toBeNull();
        },
      ),
      PROPERTY,
    );
  });

  it("puts the voice within one frame of where it starts, for a start at any sample", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (start, seed) => {
          const samples = render({
            rate: 16000,
            seed,
            segments: [N(start, -60), V(samplesOf(2.5), -20)],
          });
          const found = speechOnsetMs(samples);
          const startMs = (start * 1000) / 16000;
          expect(found).not.toBeNull();
          expect(found as number).toBeGreaterThan(startMs - FRAME_MS);
          expect(found as number).toBeLessThan(startMs + FRAME_MS);
          expect((found as number) % FRAME_MS).toBe(0);
        },
      ),
      PROPERTY,
    );
  });

  it("finds a step from digital silence to noise within one frame of the step, at any sample", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5 * HOP, max: 300 * HOP }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.integer({ min: -45, max: -10 }),
        (quiet, spare, seed, db) => {
          // at least a seventh of the frames are silent, so the quietest tenth is silence whatever the length after the step
          const loudFrames = 5 + (spare % (5 * Math.floor(quiet / HOP)));
          const samples = render({
            rate: 16000,
            seed,
            segments: [Z(quiet), N(loudFrames * HOP, db)],
          });
          const found = speechOnsetMs(samples);
          const stepMs = (quiet * 1000) / 16000;
          expect(found).not.toBeNull();
          expect(found as number).toBeGreaterThan(stepMs - FRAME_MS);
          expect(found as number).toBeLessThan(stepMs + FRAME_MS);
        },
      ),
      PROPERTY,
    );
  });

  it("moves the voice by exactly the quiet put in front of it (whole frames of digital silence)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (quietFrames, extraFrames, seed) => {
          const base = render({
            rate: 16000,
            seed,
            segments: [N(quietFrames * HOP, -60), V(samplesOf(2.5), -20)],
          });
          const before = speechOnsetMs(base);
          const after = speechOnsetMs(concat(new Int16Array(extraFrames * HOP), base));
          expect(before).toBe(quietFrames * FRAME_MS);
          expect(after).toBe((quietFrames + extraFrames) * FRAME_MS);
        },
      ),
      PROPERTY,
    );
  });

  it("answers for the first 30 seconds only: nothing appended after them can change it", () => {
    const head = (seed: number, quietS: number): Int16Array =>
      synthPcm16({ quietS, voiceS: VOICE_SCAN_S - quietS, seed });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.constantFrom<Segment["kind"]>("noise", "zero", "tone", "voice"),
        fc.integer({ min: 0, max: 80_000 }),
        (seed, quietS, kind, extra) => {
          const first = head(seed, quietS);
          const tail: Segment =
            kind === "noise"
              ? N(extra, -30)
              : kind === "zero"
                ? Z(extra)
                : kind === "tone"
                  ? T(extra, -10)
                  : V(extra, -5, -60);
          const longer = concat(first, render({ rate: 16000, seed: seed + 1, segments: [tail] }));
          expect(voiceStartOf(pcm16Wav(longer))).toEqual(voiceStartOf(pcm16Wav(first)));
        },
      ),
      { ...PROPERTY, numRuns: 30 },
    );
  });
});

describe("a file that is not the extract's is unknown, never a wrong number, and nothing throws", () => {
  const clean = quietThenVoice({ quietS: 1.5, voiceS: 1.5 });
  const samples = render(clean);
  const wav = pcm16Wav(samples);
  const cleanAnswer = voiceStartOf(wav);

  it("the clean file is the reference's answer (the baseline of the cases below)", () => {
    expect(cleanAnswer).toEqual(at(1500));
  });

  it("answers unknown for any random bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 3000 }), (bytes) => {
        expect(voiceStartOf(bytes)).toEqual(UNKNOWN);
      }),
      { ...PROPERTY, numRuns: 400 },
    );
  });

  it("answers unknown for a null, an undefined and an empty read", () => {
    expect(voiceStartOf(null)).toEqual(UNKNOWN);
    expect(voiceStartOf(undefined)).toEqual(UNKNOWN);
    expect(voiceStartOf(new Uint8Array(0))).toEqual(UNKNOWN);
  });

  it("never answers a number for a file cut anywhere: a cut file is unknown, or the answer for the samples that are there", () => {
    for (let length = 0; length <= 44 + 4; length++) {
      const answer = voiceStartOf(wav.subarray(0, length));
      expect(answer.kind === "unknown" || answer.kind === "none", `${length} bytes`).toBe(true);
    }
    fc.assert(
      fc.property(fc.integer({ min: 44, max: wav.length }), (length) => {
        const here = Math.floor((length - 44) / 2);
        const expected = speechOnsetMs(samples.subarray(0, here));
        expect(voiceStartOf(wav.subarray(0, length))).toEqual(
          expected === null ? NONE : at(expected),
        );
      }),
      PROPERTY,
    );
  });

  it("is not thrown by a single flipped byte anywhere in the header: unknown, or exactly the clean answer (never another number)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 43 }),
        fc.integer({ min: 1, max: 255 }),
        (index, mask) => {
          const mutated = Uint8Array.from(wav);
          mutated[index] ^= mask;
          const answer = voiceStartOf(mutated);
          if (index >= 40) return; // the data size: its answer is the cut file's (the property above)
          expect(
            answer.kind === "unknown" || JSON.stringify(answer) === JSON.stringify(cleanAnswer),
            `byte ${index} ^ ${mask}: ${JSON.stringify(answer)}`,
          ).toBe(true);
        },
      ),
      { ...PROPERTY, numRuns: 500 },
    );
  });

  it("reads the four fields that say what the audio is as the whole truth: tag, channels, rate and bits", () => {
    const cases: Array<[string, Chunk[]]> = [
      ["float samples", [{ id: "fmt ", body: fmtBody({ tag: 3, bits: 32 }) }]],
      ["stereo", [{ id: "fmt ", body: fmtBody({ channels: 2 }) }]],
      ["8 bits", [{ id: "fmt ", body: fmtBody({ bits: 8 }) }]],
      ["24 bits", [{ id: "fmt ", body: fmtBody({ bits: 24 }) }]],
      ["8000 Hz", [{ id: "fmt ", body: fmtBody({ rate: 8000 }) }]],
      ["44100 Hz", [{ id: "fmt ", body: fmtBody({ rate: 44100 }) }]],
      ["extensible format tag", [{ id: "fmt ", body: fmtBody({ tag: 0xfffe }) }]],
      ["format tag 0", [{ id: "fmt ", body: fmtBody({ tag: 0 }) }]],
    ];
    for (const [name, head] of cases) {
      const file = riff([...head, { id: "data", body: pcmBody(samples) }]);
      expect(voiceStartOf(file), name).toEqual(UNKNOWN);
    }
    expect(
      voiceStartOf(
        riff([
          { id: "fmt ", body: fmtBody() },
          { id: "data", body: pcmBody(samples) },
        ]),
      ),
    ).toEqual(cleanAnswer);
  });

  it("is unknown when `fmt ` is missing or comes after `data`", () => {
    const data: Chunk = { id: "data", body: pcmBody(samples) };
    expect(voiceStartOf(riff([data]))).toEqual(UNKNOWN);
    expect(voiceStartOf(riff([data, { id: "fmt ", body: fmtBody() }]))).toEqual(UNKNOWN);
    expect(voiceStartOf(riff([{ id: "fmt ", body: fmtBody() }]))).toEqual(UNKNOWN);
  });

  it("reads nothing from a file whose form is not RIFF/WAVE, however the rest looks", () => {
    for (const [offset, text] of [
      [0, "RIFX"],
      [0, "RF64"],
      [8, "AVI "],
      [8, "WAVX"],
    ] as const) {
      const bytes = Uint8Array.from(wav);
      bytes.set(
        Uint8Array.from(text, (c) => c.charCodeAt(0)),
        offset,
      );
      expect(voiceStartOf(bytes), text).toEqual(UNKNOWN);
    }
  });

  it("hands back null, and does not throw, for a file the samples cannot be read from", () => {
    const fmt: Chunk = { id: "fmt ", body: fmtBody() };
    const data: Chunk = { id: "data", body: pcmBody(samples) };
    expect(pcm16WavSamples(riff([data, fmt]))).toBeNull();
    expect(pcm16WavSamples(riff([fmt]))).toBeNull();
    expect(pcm16WavSamples(wav.subarray(0, 30))).toBeNull();
    expect(pcm16WavSamples(wav.subarray(0, 11))).toBeNull();
    expect(pcm16WavSamples(new Uint8Array(0))).toBeNull();
    expect(pcm16WavSamples(wav)?.rate).toBe(16000);
  });

  it("takes the format fields from inside a `fmt ` chunk only: one too short to hold them is unreadable", () => {
    const body = pcmBody(samples);
    // a chunk id that begins 0x10 0x00 would read as "16 bits" if the reader looked 14 bytes past the start of a 14-byte chunk
    const trap: Chunk = { id: "\u0010\u0000AB", body: new Uint8Array(0) };
    const file = riff([
      { id: "fmt ", body: fmtBody().subarray(0, 14) },
      trap,
      { id: "data", body },
    ]);
    expect(voiceStartOf(file)).toEqual(UNKNOWN);
    expect(pcm16WavSamples(file)).toBeNull();
    // and the pad byte after a 15-byte chunk (a zero) must not complete the 16-bit field of the chunk
    for (let size = 0; size < 16; size++) {
      const short = riff([
        { id: "fmt ", body: fmtBody().subarray(0, size) },
        { id: "data", body },
      ]);
      expect(voiceStartOf(short), `a fmt chunk of ${size} bytes`).toEqual(UNKNOWN);
    }
    expect(
      voiceStartOf(
        riff([
          { id: "fmt ", body: fmtBody() },
          { id: "data", body },
        ]),
      ),
    ).toEqual(cleanAnswer);
  });

  it("is not fooled by sizes that lie: a huge declared chunk, a data size of 0 and of 0xFFFFFFFF", () => {
    const fmt: Chunk = { id: "fmt ", body: fmtBody() };
    const body = pcmBody(samples);
    expect(voiceStartOf(riff([fmt, { id: "data", body, declared: 0xffffffff }]))).toEqual(
      cleanAnswer,
    );
    expect(voiceStartOf(riff([fmt, { id: "data", body, declared: body.length * 4 }]))).toEqual(
      cleanAnswer,
    );
    expect(voiceStartOf(riff([fmt, { id: "data", body, declared: 2 * 16000 }]))).toEqual(NONE);
    expect(voiceStartOf(riff([fmt, { id: "data", body, declared: 0 }])).kind).not.toBe("at");
    expect(
      voiceStartOf(riff([{ id: "JUNK", body: new Uint8Array(4), declared: 0xfffffff0 }, fmt])),
    ).toEqual(UNKNOWN);
    expect(
      voiceStartOf(
        riff([
          { ...fmt, declared: 0xffffffff },
          { id: "data", body },
        ]),
      ),
    ).toEqual(UNKNOWN);
    expect(voiceStartOf(riff([fmt, { id: "data", body }], 0xffffffff))).toEqual(cleanAnswer);
    expect(voiceStartOf(riff([fmt, { id: "data", body }], 0))).toEqual(cleanAnswer);
  });

  it("walks past any chunk before `data`, an odd-sized one (with its pad byte) included", () => {
    const fmt: Chunk = { id: "fmt ", body: fmtBody() };
    const data: Chunk = { id: "data", body: pcmBody(samples) };
    for (const size of [0, 1, 2, 3, 4, 5, 26, 27, 255, 4097]) {
      const other: Chunk = { id: "LIST", body: new Uint8Array(size).fill(0x64) };
      expect(voiceStartOf(riff([other, fmt, data])), `a ${size}-byte chunk before fmt`).toEqual(
        cleanAnswer,
      );
      expect(voiceStartOf(riff([fmt, other, data])), `a ${size}-byte chunk between`).toEqual(
        cleanAnswer,
      );
      expect(voiceStartOf(riff([fmt, other, other, data])), `two ${size}-byte chunks`).toEqual(
        cleanAnswer,
      );
    }
  });

  it("drops a trailing half sample and keeps the rest", () => {
    const half = Uint8Array.from([...pcmBody(samples), 0x55]);
    expect(
      voiceStartOf(
        riff([
          { id: "fmt ", body: fmtBody() },
          { id: "data", body: half },
        ]),
      ),
    ).toEqual(cleanAnswer);
    expect(
      pcm16WavSamples(
        riff([
          { id: "fmt ", body: fmtBody() },
          { id: "data", body: half },
        ]),
      )?.samples.length,
    ).toBe(samples.length);
  });

  it("is unknown, never a throw, for random chunk soup behind a good RIFF/WAVE header", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (soup) => {
        const file = Uint8Array.from([...Array.from(riff([]).subarray(0, 12)), ...soup]);
        const answer = voiceStartOf(file);
        expect(["unknown", "none", "at"]).toContain(answer.kind);
      }),
      { ...PROPERTY, numRuns: 400 },
    );
  });
});

describe("measureVoiceStart: the head read, the guard and what the launch does after a failure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const good = pcm16Wav(synthPcm16({ quietS: 1.02, voiceS: 2 }));

  it("answers from the first bytes of the file", async () => {
    const store: HeadReader = { readHead: async () => good };
    expect(await measureVoiceStart(store, "a.wav")).toEqual(at(1020));
  });

  it("asks the store for the file it was given and for at most 1 MiB (the app's limit), and enough for the 30 seconds it scans", async () => {
    const asks: Array<[string, number]> = [];
    const store: HeadReader = {
      readHead: async (path, max) => {
        asks.push([path, max]);
        return good;
      },
    };
    await measureVoiceStart(store, "dir/extract.wav");
    expect(asks).toHaveLength(1);
    expect(asks[0][0]).toBe("dir/extract.wav");
    expect(asks[0][1]).toBeLessThanOrEqual(1024 * 1024);
    expect(asks[0][1]).toBeGreaterThanOrEqual(VOICE_SCAN_S * 16000 * 2 + 44);
  });

  it("reads what a head read that honours the limit holds: a long chunk before the audio shortens the scan, one longer than the read is unknown", async () => {
    const long = synthPcm16({ quietS: 1.5, voiceS: 40 });
    const honouring = (file: Uint8Array): HeadReader => ({
      readHead: async (_path, max) => file.subarray(0, max),
    });
    const withList = (size: number): Uint8Array => pcm16Wav(long, { list: size });
    expect(await measureVoiceStart(honouring(withList(0)), "a.wav")).toEqual(at(1500));
    expect(await measureVoiceStart(honouring(withList(10_000)), "a.wav")).toEqual(at(1500));
    expect(await measureVoiceStart(honouring(withList(1_100_000)), "a.wav")).toEqual(UNKNOWN);
  });

  it("is unknown, at once, for a store with no ranged read", async () => {
    expect(await measureVoiceStart({}, "a.wav")).toEqual(UNKNOWN);
    expect(await measureVoiceStart({ readHead: 5 } as unknown as HeadReader, "a.wav")).toEqual(
      UNKNOWN,
    );
  });

  it("is unknown when the read throws, rejects or finds nothing, and the call returns", async () => {
    const failing: HeadReader[] = [
      {
        readHead: () => {
          throw new Error("disk gone");
        },
      },
      { readHead: () => Promise.reject(new Error("denied")) },
      { readHead: async () => null },
      { readHead: async () => undefined as unknown as null },
      { readHead: async () => new Uint8Array(0) },
      { readHead: async () => Uint8Array.from([1, 2, 3]) },
    ];
    for (const store of failing)
      expect(await measureVoiceStart(store, "a.wav", 50)).toEqual(UNKNOWN);
  });

  it("gives up at the guard and not before: a read that never comes back is unknown at exactly guardMs", async () => {
    vi.useFakeTimers();
    const store: HeadReader = { readHead: () => new Promise<Uint8Array | null>(() => {}) };
    let result: VoiceStart | undefined;
    void measureVoiceStart(store, "a.wav", 5000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(4999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual(UNKNOWN);
    expect(MEASURE_GUARD_MS).toBe(5000);
  });

  it("uses MEASURE_GUARD_MS when it is not told another", async () => {
    vi.useFakeTimers();
    const store: HeadReader = { readHead: () => new Promise<Uint8Array | null>(() => {}) };
    let result: VoiceStart | undefined;
    void measureVoiceStart(store, "a.wav").then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(MEASURE_GUARD_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual(UNKNOWN);
  });

  it("ignores a read that comes back after the guard", async () => {
    vi.useFakeTimers();
    const store: HeadReader = {
      readHead: () =>
        new Promise<Uint8Array | null>((resolve) => setTimeout(() => resolve(good), 100)),
    };
    let result: VoiceStart | undefined;
    void measureVoiceStart(store, "a.wav", 50).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toEqual(UNKNOWN);
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toEqual(UNKNOWN);
  });

  it("is silent about a read that fails after the guard has answered", async () => {
    vi.useFakeTimers();
    const store: HeadReader = {
      readHead: () =>
        new Promise<Uint8Array | null>((_resolve, reject) =>
          setTimeout(() => reject(new Error("too late")), 100),
        ),
    };
    const answer = measureVoiceStart(store, "a.wav", 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await answer).toEqual(UNKNOWN);
    // an unhandled rejection here would fail the whole run, not only this test
    await vi.advanceTimersByTimeAsync(100);
  });

  it("leaves no timer behind, whichever way the read ends", async () => {
    vi.useFakeTimers();
    const ends: HeadReader[] = [
      { readHead: async () => good },
      { readHead: async () => null },
      { readHead: () => Promise.reject(new Error("x")) },
      {
        readHead: () => {
          throw new Error("x");
        },
      },
      {},
    ];
    for (const store of ends) {
      await measureVoiceStart(store, "a.wav", 5000);
      expect(vi.getTimerCount()).toBe(0);
    }
    const never: HeadReader = { readHead: () => new Promise<Uint8Array | null>(() => {}) };
    const pending = measureVoiceStart(never, "a.wav", 5000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers `none` for a file with no voice in it, and `unknown` is the only other thing a failure is", async () => {
    const silent = pcm16Wav(new Int16Array(16000 * 3));
    expect(await measureVoiceStart({ readHead: async () => silent }, "a.wav")).toEqual(NONE);
  });
});
