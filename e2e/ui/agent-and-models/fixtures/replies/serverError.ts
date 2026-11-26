// The server failed before it started the round: a 500 with its typed `internal_error` code.
import { httpAnswer, type Reply } from "../../lib/reply";

export function serverError(): Reply {
  return httpAnswer(500, { error: "internal_error" });
}
