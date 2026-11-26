// The model gets a tool wrong: a parameter the tool does not have (a hallucinated argument), or a
// tool that does not exist at all. The app must refuse it honestly, change nothing, and carry on.
import { callTools, type Reply } from "../../lib/reply";

export function badArgument(): Reply {
  return callTools([{ name: "add_track", arguments: { kind: "video", colour: "red" } }]);
}

export function unknownTool(): Reply {
  return callTools([{ name: "make_it_pop", arguments: { amount: 11 } }]);
}
