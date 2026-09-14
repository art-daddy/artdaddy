// One rAF for every meter on screen.
//
// A meter per lane plus a master is six-plus components all wanting the same 60Hz tick. Each
// running its own loop would read `levels()` six times a frame and re-enter the ballistics six
// times over. One pump reads once, steps every channel with the SAME dt, and hands each
// subscriber its own numbers — so two meters can never disagree about how much time passed.
//
// Subscribers get called with state and are expected to write to the DOM directly. Deliberately
// not React state: 60 setState calls a second across six components is the re-render storm that
// froze the Inspector's sliders (S15).
import { previewAudio } from "./audioEngine";
import { SILENT, stepMeter, type MeterState } from "./meter";

export const MASTER = "\u0000master"; // not a legal track id, so it cannot collide

export interface StereoMeter {
  left: MeterState;
  right: MeterState;
}

const SILENT_PAIR: StereoMeter = { left: SILENT, right: SILENT };

type Listener = (m: StereoMeter) => void;

const listeners = new Map<string, Set<Listener>>();
const state = new Map<string, StereoMeter>();
let raf = 0;
let last = 0;

function tick(now: number): void {
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  const levels = previewAudio()?.levels() ?? { master: [0, 0] as const, tracks: {} };
  for (const [key, subs] of listeners) {
    const peaks = key === MASTER ? levels.master : (levels.tracks[key] ?? [0, 0]);
    const prev = state.get(key) ?? SILENT_PAIR;
    const next: StereoMeter = {
      left: stepMeter(prev.left, peaks[0], dt),
      right: stepMeter(prev.right, peaks[1], dt),
    };
    state.set(key, next);
    for (const cb of subs) cb(next);
  }
  raf = requestAnimationFrame(tick);
}

/** Watch one channel. Returns an unsubscribe; the loop stops when the last one leaves. */
export function subscribeMeter(key: string, cb: Listener): () => void {
  let subs = listeners.get(key);
  if (!subs) listeners.set(key, (subs = new Set()));
  subs.add(cb);
  if (!raf) {
    last = 0; // a restarted pump must not attribute the whole idle gap to one frame
    raf = requestAnimationFrame(tick);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0) {
      listeners.delete(key);
      state.delete(key);
    }
    if (listeners.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** Clear the latched clip indicators — the one thing a meter never does for itself. */
export function clearClipIndicators(): void {
  for (const [key, m] of state)
    state.set(key, {
      left: { ...m.left, clipped: false },
      right: { ...m.right, clipped: false },
    });
}

/** Test seam: forget every subscriber and stop the loop. */
export function resetMeterPump(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
  listeners.clear();
  state.clear();
}
