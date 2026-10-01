// Tool results, job notes and MCP all flatten an error to its message, losing CreditLimitError's
// `code` — so the code rides inside the message, and every surface asks here instead of reading prose.
export const CREDIT_LIMIT = "credit_limit";
const MARK = `[${CREDIT_LIMIT}]`;

/** What a person is shown. True whether the user's credits or the shared budget ran out. */
export const OUT_OF_CREDITS = "Out of credits.";
/** The global kill-switch tripped: this user's own credits are not the problem. */
export const CREDITS_PAUSED = "AI generation is paused for everyone right now.";

export function markOutOfCredits(text: string): string {
  return `${MARK} ${text}`;
}

export function isOutOfCredits(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return text.includes(MARK) || text === OUT_OF_CREDITS || text === CREDITS_PAUSED;
}
