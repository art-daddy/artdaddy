// The model reads the timeline `count` times in one round: enough steps to reach the turn's
// automatic pause (40 in the default mode, src/agent/loop.ts CONTINUE_CAPS), with nothing changed.
import { callTools, type Reply } from "../../lib/reply";

export function manyReads(count = 40): Reply {
  return callTools(
    Array.from({ length: count }, () => ({ name: "get_timeline", arguments: {} })),
    "Checking every part of the timeline.",
  );
}
