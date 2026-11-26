// The model the person picked is not on the server's allow-list: 400 `model_not_allowed`
// (server/app.py, _admit_chat_model) before any model work.
import { httpAnswer, type Reply } from "../../lib/reply";

export function modelNotAllowed(): Reply {
  return httpAnswer(400, { error: "model_not_allowed" });
}
