// A round that starts and then never finishes: a few words, then an open, silent socket. The way
// out is the person's Stop (or the app's own 90 s silence limit).
import { stream, type Reply } from "../../lib/reply";

export const HANGING_WORDS = "Let me look at every clip first";

export function hangs(): Reply {
  return stream(
    "streams a few words, then hangs",
    ...HANGING_WORDS.split(" ").map((w) => ({ delta: `${w} ` })),
    { hang: true },
  );
}
