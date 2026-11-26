// The model answers in plain words, streamed a word at a time (the everyday reply).
import { say, type Reply } from "../../lib/reply";

export function plainText(
  text = "Your timeline is empty, so there is nothing to trim yet. Add a clip and ask again.",
): Reply {
  return say(text, { gapMs: 40 });
}
