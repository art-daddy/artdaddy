// How long the app took to start, for the launch marker. Starting up is one of the things people leave over (a cold server, a
// slow window, a session that will not restore), and the wait is three waits in a row, so it is measured as three:
//
//   boot_ms  the process starting until the page was there (the window, the web view, the page's first byte)
//   load_ms  the page loading its code, until the app's own code begins to run
//   auth_ms  from there until the session has settled and the launch is reported
//
// Whole milliseconds, kept inside what the server accepts. Numbers only: nothing the person made or named. The process's own
// age comes from the desktop app (`process_age_ms`), asked at the moment the launch is reported; a page that is not the
// desktop app has no such age and reports no reading at all (a missing number is not a fast start).
import { platform } from "../platform";

/** The longest reading the server accepts. */
export const MAX_STARTUP_MS = 3_600_000;

export interface StartupTimings {
  boot_ms: number;
  load_ms: number;
  auth_ms: number;
}

interface Options {
  /** Milliseconds since the page began (`performance.now()`). */
  now?: () => number;
  /** The app process's age in milliseconds, or null when it cannot say. */
  processAge?: () => Promise<number | null>;
}

let begunAt: number | null = null;

/** The app process's age, from the desktop app. Null anywhere else, and on any failure: never throws. */
async function nativeProcessAge(): Promise<number | null> {
  if (platform.name !== "tauri") return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const age = await invoke<number | null>("process_age_ms");
    return typeof age === "number" ? age : null;
  } catch {
    return null;
  }
}

const whole = (milliseconds: number): number =>
  Math.max(0, Math.min(Math.round(milliseconds), MAX_STARTUP_MS));

/** Called as early as the app's own code runs. The first call fixes the start; a later one changes nothing. */
export function beginStartupTiming(now: () => number = () => performance.now()): void {
  if (begunAt === null) begunAt = now();
}

/** The three readings, once the session has settled; null when they cannot be known. Never throws. */
export async function startupTimings(options: Options = {}): Promise<StartupTimings | null> {
  const now = options.now ?? (() => performance.now());
  const processAge = options.processAge ?? nativeProcessAge;
  if (begunAt === null) return null;
  const began = begunAt;
  const asked = now();
  let age: number | null;
  try {
    age = await processAge();
  } catch {
    return null;
  }
  if (age === null || !Number.isFinite(age) || age < 0) return null;
  const answered = now();
  return {
    // The process was `age` old when it answered and the page `answered` old then: the page began that much after the process.
    boot_ms: whole(age - answered),
    load_ms: whole(began),
    auth_ms: whole(asked - began),
  };
}

/** Tests only. */
export function __resetStartupTiming(): void {
  begunAt = null;
}
