// What the agent is told, with a message, about files the person is still importing (UJ-088). Pure: the rows in, the words out.
//
// A message sent while a drop was still importing was told the library was empty (witness 3LuwWwH6RRVj: three 3.2 GB files, Enter 43 ms after the drop, "library: []"), and an agent
// that is told the library is empty says so, or asks for the files again. The owner chose the light behaviour: never hold the message, only say what is coming. One short block that
// rides on EVERY message sent while something imports, and on none otherwise (the message is then exactly what it always was).
import type { ImportingRow } from "../store/importJobs";

/** What every import note starts with. */
export const IMPORT_NOTE_MARK = "[Imports in progress";

/** The most names the note lists; the rest are counted. */
const MAX_NAMES = 8;
/** The longest a name is shown. */
const MAX_NAME = 60;

/** A file name as the model reads it: one line, no brackets (the note itself is bracketed), bounded. */
const clean = (name: string): string => {
  const one = name
    .replace(/[\r\n\t[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > MAX_NAME ? `${one.slice(0, MAX_NAME - 1)}…` : one;
};

const named = (r: ImportingRow): string =>
  r.fraction !== null ? `${clean(r.name)} (${Math.round(r.fraction * 100)}%)` : clean(r.name);

/** The block for a message, or null when nothing is importing. */
export function importNote(rows: readonly ImportingRow[]): string | null {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, MAX_NAMES).map(named);
  const more = rows.length - shown.length;
  const files = `${rows.length} file${rows.length === 1 ? " is" : "s are"}`;
  return (
    `${IMPORT_NOTE_MARK} - read for you by the app just now: the person is importing media into this project, and ${files} not in the library yet: ` +
    `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. ` +
    "An empty or short library right now does NOT mean there is no media. Do not wait for these and do not poll the library: each one appears by itself when it finishes " +
    "(library_op action='list' shows what is still importing). Work with what is already in the library, tell the person which files are still coming in, " +
    "and if the request needs one of them, say it can be done once it lands. Do not import these files again.]"
  );
}
