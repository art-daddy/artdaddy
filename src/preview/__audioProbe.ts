// Real-browser audio probe. Bundled by scripts/audiolane/run.mjs and evaluated in headless
// Chromium; there is no reason to import this from app code.
//
// Two probes, covering the two halves of the engine:
//   __audioProbe  — the metering GRAPH (createMeterTap) against synthesized channel layouts.
//   __audioRender — the whole PreviewAudio engine (decode, scheduling, volume curves, fades,
//                   per-track buses, master mix) rendered offline, measured on the buffer that
//                   WOULD have gone to the output device.
//
// jsdom/happy-dom have no Web Audio at all, and the hand-written fake in audioEngine.test.ts
// cannot model channel counts — which is precisely how a dead right meter shipped for every mono
// file with a green suite.
import { createMeterTap, PreviewAudio, readTapPeaks } from "./audioEngine";
import type { StereoPeaks } from "./audioEngine";
import type { Timeline } from "../timeline/model";
import type { ProjectStoreAccess } from "../tools/store";

const SR = 48000;
const SECONDS = 0.25;

/** Fill one channel with a 440Hz tone at `amp`. Synthesized, never a committed fixture: a
 *  fixture I make by hand can encode the same misreading as the code under test. */
function tone(data: Float32Array, amp: number): void {
  for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
}

/** Play `amps.length` channels of tone through the real tap and read both analysers. */
async function measure(amps: readonly number[]): Promise<StereoPeaks> {
  const frames = Math.round(SR * SECONDS);
  const ctx = new OfflineAudioContext(2, frames, SR);
  const buffer = ctx.createBuffer(amps.length, frames, SR);
  amps.forEach((amp, ch) => tone(buffer.getChannelData(ch), amp));

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // The production tap always hangs off a GainNode (the master, or a track bus).
  const input = ctx.createGain();
  source.connect(input);
  input.connect(ctx.destination);
  const tap = createMeterTap(ctx, input);
  source.start();
  await ctx.startRendering();
  return readTapPeaks(tap);
}

export interface AudioProbeResult {
  mono: StereoPeaks;
  stereo: StereoPeaks;
  hardLeft: StereoPeaks;
  hardRight: StereoPeaks;
  silence: StereoPeaks;
  fiveOne: StereoPeaks;
}

async function run(): Promise<AudioProbeResult> {
  return {
    mono: await measure([0.5]),
    stereo: await measure([0.5, 0.25]),
    hardLeft: await measure([0.5, 0]),
    hardRight: await measure([0, 0.5]),
    silence: await measure([0, 0]),
    // More channels than the meter shows: it must still read the front pair, not throw or zero.
    fiveOne: await measure([0.5, 0.5, 0.3, 0.1, 0.2, 0.2]),
  };
}

declare global {
  interface Window {
    __audioProbe?: () => Promise<AudioProbeResult>;
    __audioRender?: (urls: MediaUrls) => Promise<RenderProbeResult>;
  }
}

window.__audioProbe = run;

// ---------------------------------------------------------------------------
// The whole engine, rendered offline.
// ---------------------------------------------------------------------------

export interface MediaUrls {
  /** 3s of 440Hz at amplitude 0.5, ONE channel. */
  mono: string;
  /** 3s stereo, left 440Hz at 0.5 and right 660Hz at 0.125 — deliberately asymmetric. */
  stereo: string;
}

export interface RenderProbeResult {
  /** Peak per WINDOW_SEC window, per output channel. Index 0 starts at render time 0. */
  left: number[];
  right: number[];
  windowSec: number;
  /** The lead PreviewAudio.play() adds before the first scheduled source. */
  leadSec: number;
}

const WINDOW_SEC = 0.1;
const LEAD_SEC = 0.02; // PreviewAudio.play(): startedAt = currentTime + 0.02
const FPS = 30;
const RENDER_SEC = 6.5;

const f = (sec: number) => Math.round(sec * FPS);

/** One project exercising every part of the schedule: a MONO clip with real fades, a STEREO clip
 *  at constant half volume, and a clip whose volume is a ramping CURVE. */
function probeTimeline(urls: MediaUrls): Timeline {
  return {
    canvas: { width: 320, height: 240, fps: FPS },
    tracks: [
      {
        id: "a1",
        kind: "audio",
        z: 0,
        clips: [
          {
            id: "c-mono",
            kind: "audio",
            media_ref: urls.mono,
            timeline_in: f(0.5),
            timeline_out: f(2.0),
            source_in: 0,
            source_out: f(1.5),
            fade: { in: f(0.5), out: f(0.5) },
          },
        ],
      },
      {
        id: "a2",
        kind: "audio",
        z: 1,
        clips: [
          {
            id: "c-stereo",
            kind: "audio",
            media_ref: urls.stereo,
            timeline_in: f(2.5),
            timeline_out: f(4.0),
            source_in: 0,
            source_out: f(1.5),
            volume: 0.5,
          },
        ],
      },
      {
        id: "a3",
        kind: "audio",
        z: 2,
        clips: [
          {
            id: "c-curve",
            kind: "audio",
            media_ref: urls.mono,
            timeline_in: f(4.5),
            timeline_out: f(6.0),
            source_in: 0,
            source_out: f(1.5),
            // Silent at the head, full by the tail — a duck-under ramp in reverse.
            volume: [
              { t: 0, v: 0 },
              { t: f(1.5), v: 1 },
            ],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

/** Wait for the fetch + decodeAudioData that `load()` fires and forgets. Counting the REAL calls
 *  beats sleeping on a guess, and beats adding an await hook to production for one test. */
function trackAsync(): { settled: () => Promise<void> } {
  let pending = 0;
  const wrap = <T extends (...a: never[]) => Promise<unknown>>(fn: T): T =>
    function (this: unknown, ...args: never[]) {
      pending++;
      return fn.apply(this, args).finally(() => pending--);
    } as T;

  window.fetch = wrap(window.fetch.bind(window) as never) as typeof window.fetch;
  const proto = OfflineAudioContext.prototype as unknown as {
    decodeAudioData: (...a: never[]) => Promise<AudioBuffer>;
  };
  proto.decodeAudioData = wrap(proto.decodeAudioData);

  return {
    async settled() {
      // Two consecutive idle turns: the fetch resolving is what STARTS the decode.
      for (let idle = 0; idle < 2;) {
        await new Promise((r) => setTimeout(r, 25));
        idle = pending === 0 ? idle + 1 : 0;
      }
    },
  };
}

async function renderProject(urls: MediaUrls): Promise<RenderProbeResult> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * RENDER_SEC), SR);
  // resume() is a realtime autoplay concern with no bearing on the rendered samples; offline it
  // rejects, and PreviewAudio calls it unguarded.
  (ctx as unknown as { resume: () => Promise<void> }).resume = () => Promise.resolve();
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = function () {
    return ctx;
  };

  const async = trackAsync();
  const audio = new PreviewAudio();
  // Every media_ref here is an http URL, which resolveSourceUrl passes through untouched — the
  // store is only present because decode() refuses to run without one.
  audio.setStore({
    projectDir: "probe",
    resolveRef: async () => null,
  } as unknown as ProjectStoreAccess);
  audio.load(probeTimeline(urls));
  await async.settled();
  audio.play(0);
  const rendered = await ctx.startRendering();

  const per = Math.round(SR * WINDOW_SEC);
  const windows = (ch: number): number[] => {
    const data = rendered.getChannelData(ch);
    const out: number[] = [];
    for (let i = 0; i < data.length; i += per) {
      let peak = 0;
      for (let j = i; j < Math.min(i + per, data.length); j++)
        peak = Math.max(peak, Math.abs(data[j]));
      out.push(peak);
    }
    return out;
  };
  return { left: windows(0), right: windows(1), windowSec: WINDOW_SEC, leadSec: LEAD_SEC };
}

window.__audioRender = renderProject;
