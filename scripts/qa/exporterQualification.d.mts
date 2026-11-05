// Only what the product's own tests import (src/timeline/exportQuestions.test.ts pins this parser to the words the product prints).
export interface EstimateFacts {
  /** The one confirmation states a time measured from earlier exports on this PC. */
  provided: boolean;
  /** That measured time in minutes (0 for "under a minute"), or null when none is stated. */
  minutes: number | null;
  /** The one confirmation states a time and says it is a rough guess from the size of the video. */
  guessStated: boolean;
}

export function estimateFacts(preflight: unknown): EstimateFacts;
