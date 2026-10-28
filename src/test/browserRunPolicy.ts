// What the real-browser lane does about a test that fails, decided in one place so
// playwright.config.ts, the failing-browser evidence check and the unit tests all read the same rule.
//
// macOS CI runners are virtual machines with no GPU: WebGL2 comes from software rendering and the
// display stack is shared. The lane's failures there are ONE GPU/compositor test going wrong in a run
// where about 115 others pass (a pixel read of 0, WebGL2 missing, a probe that never reports): 19 of
// the 20 failed macOS browser jobs between 2026-10-18 and 10-28 lost one or two tests, and of the 9
// failed jobs somebody re-ran, 8 passed on a later attempt. Windows and Linux runners have not shown
// the pattern, and a local run must show every failure, so only macOS CI retries.

export interface BrowserRunPolicy {
  /** How many more times Playwright runs a test that failed (0 = a failure is final). */
  retries: number;
  /** Final test failures after which Playwright stops the run (0 = never stop early). */
  maxFailures: number;
}

/** A test that fails three times in a row on a fresh page is a real failure, not a stumble. */
export const MACOS_CI_RETRIES = 2;

/** Retries multiply what a broken runner costs: with every test failing, 3 attempts of a 60 s test each is
 *  hours of macOS time. Ten finally-failed tests is a broken lane, so stop there and say so. */
export const MACOS_CI_MAX_FAILURES = 10;

const NO_RETRIES: BrowserRunPolicy = { retries: 0, maxFailures: 0 };

export function browserRunPolicy(
  env: Record<string, string | undefined>,
  platform: string,
): BrowserRunPolicy {
  // The same test of "is this CI" playwright.config.ts already uses for the browser channel.
  if (!env.CI || platform !== "darwin") return NO_RETRIES;
  return { retries: MACOS_CI_RETRIES, maxFailures: MACOS_CI_MAX_FAILURES };
}
