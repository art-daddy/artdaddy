// The model asks for a new track (an ordinary, reversible edit that runs without asking).
import { callTools, type Reply } from "../../lib/reply";

export function addTrack(
  kind: "video" | "audio" | "text" = "video",
  prose = "I'll add a track for it first.",
): Reply {
  return callTools([{ name: "add_track", arguments: { kind } }], prose);
}
