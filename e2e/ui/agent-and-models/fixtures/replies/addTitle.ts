// The model puts a title on the timeline (add_text_clips): an edit that needs no media.
import { callTools, type Reply } from "../../lib/reply";

export function addTitle(text = "Summer in the hills", duration = 90): Reply {
  return callTools(
    [
      {
        name: "add_text_clips",
        arguments: { entries: [{ timeline_in: 0, duration, content: text }] },
      },
    ],
    "Adding the title now.",
  );
}
