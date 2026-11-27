// A round that starts and then never finishes: a few words, then an open line that carries only
// keepalive comments. The way out is the person's Stop (or the app's own 90 s silence limit, which
// the keepalives keep away, as the real server's do).
import { stream, type Reply } from "../../lib/reply";

export const HANGING_WORDS = "Let me look at every clip first";

export function hangs(): Reply {
  return stream(
    "streams a few words, then hangs",
    ...HANGING_WORDS.split(" ").map((w) => ({ delta: `${w} ` })),
    { hang: true },
  );
}
