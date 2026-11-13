// What the two launch screens say once the server is what they are waiting on. Pure: the clock and the facts in, the words out.
//
// A server that has been idle for a few minutes takes 21 to 26 s to start (8 of 61 launches in the field, UJ-082). The launch screens said nothing about it, and
// from 10 s in one of them said the saved session could not be read. The owner chose a plain line, from 3 s of waiting, in his own words (the mock-up's sheet 1).
// One launch clock for both screens: screen 2 carries on from screen 1's clock and never starts its own 3 seconds.

/** A wait shorter than this needs no line: on a warm start the server answers in well under a second. */
export const WAKING_AFTER_S = 3;
export const WAKING_LABEL = "Waking the server";
export const WAKING_HINT =
  "The first start after a few quiet minutes takes up to 30 seconds. Nothing is wrong.";

/** When this run's JavaScript began: the person's wait began no later than this. */
let launchedAt = Date.now();

export interface WakingLine {
  label: string;
  hint: string;
  /** Seconds since the app started, whole. */
  elapsedS: number;
}

/** The line to show, or null. `waitingOnServer` is what the screen KNOWS: the keychain has answered and the renewal is out, or the build check is out. */
export function wakingLine(input: {
  now: number;
  waitingOnServer: boolean;
  launchedAtMs?: number;
}): WakingLine | null {
  if (!input.waitingOnServer) return null;
  const start = input.launchedAtMs ?? launchedAt;
  const elapsedS = Number.isFinite(input.now - start)
    ? Math.max(0, Math.floor((input.now - start) / 1000))
    : 0;
  if (elapsedS < WAKING_AFTER_S) return null;
  return { label: WAKING_LABEL, hint: WAKING_HINT, elapsedS };
}

/** Tests only: where the launch clock starts. */
export const __testing = {
  setLaunchedAt: (ms: number) => {
    launchedAt = ms;
  },
};
