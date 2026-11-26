// The account is out of credits: the server's admission answers 402 before any model work, with
// the detail its `_require_credits` sends (server/app.py).
import { httpAnswer, type Reply } from "../../lib/reply";

export function outOfCredits(used = 500, limit = 500): Reply {
  return httpAnswer(402, { error: "credit_limit_reached", scope: "user", used, limit });
}
