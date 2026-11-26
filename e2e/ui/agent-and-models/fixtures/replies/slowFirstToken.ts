// The model is slow to start: the socket is open and silent for `ms` (the server's keepalive
// comments every 15 s are the only bytes a real slow model sends), then the answer streams.
import { say, type Reply } from "../../lib/reply";

export function slowFirstToken(
  ms = 3000,
  text = "Sorry for the wait. I looked at the project: it has no clips yet.",
): Reply {
  return say(text, { firstTokenMs: ms, gapMs: 30 });
}
