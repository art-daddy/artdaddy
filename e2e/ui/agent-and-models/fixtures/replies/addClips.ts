// The model places a library asset on the timeline: one clip at frame 0, `duration` frames long.
// A media argument is a library reference (media_...), never a path.
import { callTools, type Reply } from "../../lib/reply";

export function addClips(mediaRef: string, duration = 90, trackId?: string): Reply {
  return callTools([
    {
      name: "add_clips",
      arguments: {
        entries: [
          {
            media_ref: mediaRef,
            timeline_in: 0,
            duration,
            ...(trackId ? { track_id: trackId } : {}),
          },
        ],
      },
    },
  ]);
}
