// Calls that cost money or cannot be taken back, which the default mode asks about first:
// a paid generation, and deleting a library asset.
import { callTools, type Reply } from "../../lib/reply";

export function generateImage(prompt = "a red kite over green hills at dawn"): Reply {
  return callTools(
    [{ name: "generate_image", arguments: { prompt, aspect_ratio: "9:16" } }],
    "I'll generate a picture for the opening.",
  );
}

export function deleteAsset(mediaRef: string): Reply {
  return callTools(
    [{ name: "library_op", arguments: { action: "delete", id: mediaRef } }],
    "I'll remove the unused picture from the library.",
  );
}
