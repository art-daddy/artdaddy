// The AI provider's safety filter refused the round. The server turns that into an error round
// with a typed code and its own sentence (server origin/main: vendor_outcome.py, MESSAGES).
import { errorResult, stream, type Reply } from "../../lib/reply";

export const REFUSAL_SENTENCE =
  "The AI provider's safety filter blocked an image in this conversation, so it could not answer. Nothing was charged.";

export function refusal(): Reply {
  return stream("provider refusal (content_policy)", {
    result: errorResult(REFUSAL_SENTENCE, "content_policy"),
  });
}
