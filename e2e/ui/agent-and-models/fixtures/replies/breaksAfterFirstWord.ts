// The connection dies after the first word: one delta arrives, the line stays open (keepalives
// only) until the test has seen the word and calls `qa.server.release()`, then the socket closes
// with no result frame. The round has already started (and in production cost money), so the app
// must show the failure and never send the round again by itself.
import { stream, type Reply } from "../../lib/reply";

export const FIRST_WORD = "Sure,";

export function breaksAfterFirstWord(): Reply {
  return stream(
    "breaks after the first word",
    { delta: `${FIRST_WORD} ` },
    { hold: true },
    { cut: true },
  );
}
