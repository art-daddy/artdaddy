// Meter ballistics: how a measured peak becomes the number you see.
//
// Pure and frame-rate independent — every decay is per SECOND and integrated with the real
// elapsed time, so a meter reads the same on a 60Hz display, a 144Hz one, and a dropped frame.
// A meter whose fall-off depended on frame rate would be a different instrument on every machine.
//
// Constants are other NLEs' (AudioMeterChannelState): a -60dB floor, 24 dB/s level decay, a peak
// that holds 1.5s then falls at 18 dB/s.

export const FLOOR_DB = -60;
export const CEILING_DB = 0;
export const LEVEL_DECAY_DB_PER_SEC = 24;
export const PEAK_DECAY_DB_PER_SEC = 18;
export const PEAK_HOLD_SEC = 1.5;
/** Above this the signal is clipping. Samples can exceed 1.0 before the output stage clamps. */
export const CLIP_THRESHOLD = 0.999;

export interface MeterState {
  /** Current displayed level in dBFS, >= FLOOR_DB. */
  db: number;
  /** The held peak marker in dBFS. */
  peakDb: number;
  /** Seconds the peak marker has been held at its current value. */
  heldSec: number;
  /** Latched once the signal hits full scale; the user clears it. */
  clipped: boolean;
}

export const SILENT: MeterState = { db: FLOOR_DB, peakDb: FLOOR_DB, heldSec: 0, clipped: false };

/** Largest absolute sample in a block — the only measurement a peak meter needs. */
export function peakOf(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  return peak;
}

/** Linear amplitude to dBFS, floored. `0` is silence, not -Infinity, so it stays arithmetic. */
export function dbOf(amplitude: number): number {
  if (!(amplitude > 0)) return FLOOR_DB;
  const db = 20 * Math.log10(amplitude);
  return db < FLOOR_DB ? FLOOR_DB : db;
}

/** Where a dB value sits on the meter, 0 (floor) to 1 (full scale). */
export function meterFraction(db: number): number {
  if (db <= FLOOR_DB) return 0;
  if (db >= CEILING_DB) return 1;
  return (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB);
}

/** Advance a meter by `dtSec` having measured `amplitude` (linear peak) over that block.
 *
 *  Rise is INSTANT and fall is timed: that asymmetry is the whole point of a peak meter. A
 *  transient that only exists for one block must still show, or the meter cannot warn you about
 *  the thing it exists to warn you about.
 */
export function stepMeter(prev: MeterState, amplitude: number, dtSec: number): MeterState {
  const dt = dtSec > 0 && Number.isFinite(dtSec) ? dtSec : 0;
  const measured = dbOf(amplitude);

  const decayed = prev.db - LEVEL_DECAY_DB_PER_SEC * dt;
  const db = Math.max(FLOOR_DB, Math.max(measured, decayed));

  let peakDb = prev.peakDb;
  let heldSec = prev.heldSec + dt;
  if (db >= peakDb) {
    peakDb = db;
    heldSec = 0; // a new peak restarts the hold
  } else if (heldSec > PEAK_HOLD_SEC) {
    peakDb = Math.max(FLOOR_DB, Math.max(db, peakDb - PEAK_DECAY_DB_PER_SEC * dt));
  }

  return { db, peakDb, heldSec, clipped: prev.clipped || amplitude >= CLIP_THRESHOLD };
}
