// The app's tool catalogue is one the server no longer serves: 426 before any model work.
import { httpAnswer, type Reply } from "../../lib/reply";

export function updateRequired(): Reply {
  return httpAnswer(426, { error: "client_update_required" });
}
