// One reader for a 402 from any paid request, so a call and the upload made for it cannot disagree about what a refusal means.
import { CreditLimitError, markOverLimit } from "./usage";

/** The credit wall as a 402 response body says it: notes it in the balance and returns the error to throw. */
export function creditWallFromBody(text: string, context?: string): CreditLimitError {
  let detail: unknown = text;
  try {
    detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
  } catch {
    /* keep the raw text */
  }
  markOverLimit(detail);
  return new CreditLimitError(detail, context);
}
