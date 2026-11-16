// The audio the speech-onset tests are made of: a generator of 16-bit samples that is PURE INTEGER, so that this file and its twin
// in the speech study (L13 helper work\synth.py) make the same samples, sample for sample, on any machine. Nothing here is random in the
// language's sense: a 31-bit LCG (state = state * 1103515245 + 12345 mod 2^31), an integer triangle phase and integer amplitudes. The only
// floating point is turning a level in dBFS or a time in seconds into an integer, once. `onset-reference.json` checks every case by a
// checksum of its samples (fnv1a32), so a disagreement between the two files shows as a failing case, not as a silent drift.
//
// ONE LCG draw is taken for every output sample whatever its kind, so what a segment holds depends only on where it sits in the program.
//
// Segment kinds (n = samples):
//   noise(amp)    uniform noise, v = ((u - 32768) * amp + 16384) >> 15, RMS about amp / sqrt(3)
//   zero          v = 0
//   tone(amp)     a triangle wave: phase = (phase + step) & 65535, tri = |phase - 32768| - 16384, v = (tri * amp + 8192) >> 14
//   voice         bursts of a tone whose gain is modulated by noise (burstMs long), a gapMs pause of noise at gapAmp in every period; gapMs 0 = no pause
// `post` (the whole clip): v = ((v * gainQ8 + 128) >> 8) + dc, then EVERY sample is clamped to +-32767.
// u = state >> 15 is the 16 high bits of the state, which starts at seed mod 2^31.

export const SAT = 32767;
export const DEFAULT_RATE = 16_000;
export const DEFAULT_QUIET_DB = -60;
export const DEFAULT_VOICE_DB = -20;
export const DEFAULT_SEED = 1;
export const BURST_MS = 180;
export const GAP_MS = 60;
export const PITCH_HZ = 140;

const LCG_A = 1_103_515_245;
const LCG_C = 12_345;
const LCG_MASK = 0x7fffffff;

export type Segment =
  | { kind: "noise"; n: number; amp: number }
  | { kind: "zero"; n: number }
  | { kind: "tone"; n: number; amp: number; pitch: number }
  | {
      kind: "voice";
      n: number;
      amp: number;
      gapAmp: number;
      burstMs: number;
      gapMs: number;
      pitch: number;
    };

export interface Post {
  gainQ8?: number;
  dc?: number;
}

export interface Program {
  rate: number;
  seed: number;
  segments: readonly Segment[];
  post?: Post | null;
}

/** An arithmetic shift right that cannot overflow 32 bits (a product can exceed them at full scale): floor division by a power of two. */
function shr(v: number, bits: number): number {
  return Math.floor(v / 2 ** bits);
}

export function noisePeak(db: number): number {
  return Math.floor(Math.sqrt(3) * 32768 * 10 ** (db / 20) + 0.5);
}

export function voiceGain(db: number): number {
  return Math.floor((32768 * 10 ** (db / 20) * 12) / Math.sqrt(7) + 0.5);
}

export function samplesOf(seconds: number, rate: number = DEFAULT_RATE): number {
  return Math.floor(seconds * rate + 0.5);
}

export function msToSamples(ms: number, rate: number): number {
  return Math.floor((ms * rate) / 1000 + 0.5);
}

/** noise at `db` dBFS RMS. */
export const N = (n: number, db: number): Segment => ({ kind: "noise", n, amp: noisePeak(db) });
export const Z = (n: number): Segment => ({ kind: "zero", n });
export const T = (n: number, db: number, pitch: number = PITCH_HZ): Segment => ({
  kind: "tone",
  n,
  amp: noisePeak(db),
  pitch,
});
/** voice at `db` dBFS (burst RMS about that) whose pauses are noise at `gapDb`; `gapMs` 0 makes it a steady voice. */
export const V = (
  n: number,
  db: number,
  gapDb: number = DEFAULT_QUIET_DB,
  burstMs: number = BURST_MS,
  gapMs: number = GAP_MS,
  pitch: number = PITCH_HZ,
): Segment => ({
  kind: "voice",
  n,
  amp: voiceGain(db),
  gapAmp: noisePeak(gapDb),
  burstMs,
  gapMs,
  pitch,
});

/** The 16-bit samples of a program. */
export function render(program: Program): Int16Array {
  const { rate, segments } = program;
  let total = 0;
  for (const seg of segments) total += seg.n;
  const raw = new Int32Array(total);
  let state = program.seed & LCG_MASK;
  let at = 0;
  for (const seg of segments) {
    const n = seg.n;
    if (seg.kind === "noise") {
      for (let i = 0; i < n; i++) {
        state = (Math.imul(state, LCG_A) + LCG_C) & LCG_MASK;
        raw[at++] = shr(((state >> 15) - 32768) * seg.amp + 16384, 15);
      }
    } else if (seg.kind === "zero") {
      for (let i = 0; i < n; i++) {
        state = (Math.imul(state, LCG_A) + LCG_C) & LCG_MASK;
        raw[at++] = 0;
      }
    } else if (seg.kind === "tone") {
      const step = Math.floor((65536 * seg.pitch) / rate + 0.5);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        state = (Math.imul(state, LCG_A) + LCG_C) & LCG_MASK;
        phase = (phase + step) & 0xffff;
        raw[at++] = shr((Math.abs(phase - 32768) - 16384) * seg.amp + 8192, 14);
      }
    } else {
      const step = Math.floor((65536 * seg.pitch) / rate + 0.5);
      const burst = msToSamples(seg.burstMs, rate);
      const gap = msToSamples(seg.gapMs, rate);
      const period = burst + gap;
      const lo = seg.amp >> 1;
      const span = seg.amp - lo;
      let phase = 0;
      for (let i = 0; i < n; i++) {
        state = (Math.imul(state, LCG_A) + LCG_C) & LCG_MASK;
        const u = state >> 15;
        phase = (phase + step) & 0xffff;
        if (gap === 0 || i % period < burst) {
          const gain = lo + shr(u * span, 16);
          raw[at++] = shr((Math.abs(phase - 32768) - 16384) * gain + 16384, 15);
        } else {
          raw[at++] = shr((u - 32768) * seg.gapAmp + 16384, 15);
        }
      }
    }
  }
  const gain = program.post?.gainQ8 ?? 256;
  const dc = program.post?.dc ?? 0;
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    let v = raw[i];
    if (gain !== 256) v = shr(v * gain + 128, 8);
    v += dc;
    out[i] = v < -SAT ? -SAT : v > SAT ? SAT : v;
  }
  return out;
}

/** FNV-1a (32 bit) over the little-endian bytes of the samples, as 8 hex digits. */
export function fnv1a32(samples: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] & 0xffff;
    h = Math.imul(h ^ (v & 0xff), 16_777_619) >>> 0;
    h = Math.imul(h ^ (v >> 8), 16_777_619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface QuietThenVoice {
  quietS: number;
  voiceS: number;
  rate?: number;
  quietDb?: number;
  voiceDb?: number;
  seed?: number;
}

/** quietS of noise at quietDb, then voiceS of voice at voiceDb whose pauses are noise at the quiet level (the program behind most cases). */
export function quietThenVoice(spec: QuietThenVoice): Program {
  const rate = spec.rate ?? DEFAULT_RATE;
  const quietDb = spec.quietDb ?? DEFAULT_QUIET_DB;
  return {
    rate,
    seed: spec.seed ?? DEFAULT_SEED,
    segments: [
      N(samplesOf(spec.quietS, rate), quietDb),
      V(samplesOf(spec.voiceS, rate), spec.voiceDb ?? DEFAULT_VOICE_DB, quietDb),
    ],
  };
}

export function synthPcm16(spec: QuietThenVoice): Int16Array {
  return render(quietThenVoice(spec));
}

// ── WAV bytes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Chunk {
  id: string;
  body: Uint8Array;
  /** What the size field says, when it is not the body's length (a lie the reader must survive). */
  declared?: number;
}

export interface WavFormat {
  tag?: number;
  channels?: number;
  rate?: number;
  bits?: number;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** The 16-byte body of a `fmt ` chunk (PCM, mono, 16 kHz, 16 bit unless said otherwise). */
export function fmtBody(format: WavFormat = {}): Uint8Array {
  const tag = format.tag ?? 1;
  const channels = format.channels ?? 1;
  const rate = format.rate ?? DEFAULT_RATE;
  const bits = format.bits ?? 16;
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, tag, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, rate, true);
  view.setUint32(8, rate * channels * (bits >> 3), true);
  view.setUint16(12, channels * (bits >> 3), true);
  view.setUint16(14, bits, true);
  return body;
}

/** The little-endian bytes of the samples (a `data` chunk's body for 16-bit PCM). */
export function pcmBody(samples: ArrayLike<number>): Uint8Array {
  const body = new Uint8Array(samples.length * 2);
  const view = new DataView(body.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(2 * i, samples[i], true);
  return body;
}

/** A RIFF/WAVE file of the chunks as given: each size field is the body's length (or `declared`), an odd body is followed by the pad byte RIFF requires. */
export function riff(chunks: readonly Chunk[], riffSize?: number): Uint8Array {
  let total = 12;
  for (const c of chunks) total += 8 + c.body.length + (c.body.length & 1);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(ascii("RIFF"), 0);
  view.setUint32(4, riffSize ?? total - 8, true);
  out.set(ascii("WAVE"), 8);
  let at = 12;
  for (const c of chunks) {
    out.set(ascii(c.id), at);
    view.setUint32(at + 4, c.declared ?? c.body.length, true);
    out.set(c.body, at + 8);
    at += 8 + c.body.length + (c.body.length & 1);
  }
  return out;
}

export interface Pcm16WavOptions {
  rate?: number;
  /** a LIST chunk (this many body bytes, an odd count gets the pad byte) between `fmt ` and `data`, as an encoder that writes tags does */
  list?: number;
}

/** The 16 kHz mono 16-bit WAV file the app extracts for the engine (the extract's chunks are `fmt ` then `data`; `list` adds a LIST chunk between them). */
export function pcm16Wav(samples: Int16Array, options: Pcm16WavOptions = {}): Uint8Array {
  const chunks: Chunk[] = [{ id: "fmt ", body: fmtBody({ rate: options.rate }) }];
  if (options.list !== undefined) {
    chunks.push({ id: "LIST", body: new Uint8Array(options.list).fill(0x41) });
  }
  chunks.push({ id: "data", body: pcmBody(samples) });
  return riff(chunks);
}
