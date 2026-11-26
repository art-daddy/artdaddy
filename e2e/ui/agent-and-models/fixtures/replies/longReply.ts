// A long answer: many paragraphs, as the model writes when asked for a plan or an explanation.
// The last line is unique, so a test can check the whole answer arrived and is reachable.
import { say, type Reply } from "../../lib/reply";

export const LONG_REPLY_LAST_LINE = "That is the whole plan: 40 steps, end of answer.";

export function longReplyText(paragraphs = 40): string {
  const body = Array.from(
    { length: paragraphs - 1 },
    (_, i) =>
      `Step ${i + 1}. Trim the opening of clip ${i + 1} so the action starts on the beat, ` +
      `then check the cut against the music and keep the pacing even across the sequence.`,
  );
  return [...body, LONG_REPLY_LAST_LINE].join("\n\n");
}

export function longReply(paragraphs = 40): Reply {
  return say(longReplyText(paragraphs));
}
