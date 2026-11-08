// Why a file did not come in, and how it came in, as words of the fixed lists in api/editorEvents.ts.
//
// An import that fails used to be reported with the error's own text, and that text names the file ("'Holiday final.mp4' can't be
// used as media: ..."), so a person's file name left the computer inside the reason. A reason is now one word, taken from what
// refused the file and never from its text, and the door a file came in by is one word of a closed list: the label a caller
// supplied (an agent's `import_media` call can pass any provenance at all) is not trusted to be anything but a label.
import type { ImportDoor, ImportReason } from "../api/editorEvents";

/** A file the app refused to bring in, with the word that says why. The message is for the person (it may name the file, as it
 *  always did); only `reason` is ever reported. */
export class ImportRefusal extends Error {
  readonly reason: ImportReason;
  constructor(reason: ImportReason, message: string) {
    super(message);
    this.name = "ImportRefusal";
    this.reason = reason;
  }
}

/** What the operating system says when it refuses a file, by its number or its words (Windows, macOS and Linux spell them
 *  differently): missing, not allowed, no room on the drive, held by another program. */
const OS_REFUSALS: readonly [RegExp, ImportReason][] = [
  [/os error (2|3)\b|no such file|cannot find the (file|path)|ENOENT/i, "file_missing"],
  [/os error (5|13)\b|access is denied|permission denied|EACCES|EPERM/i, "permission"],
  [
    /os error (28|112)\b|not enough (space|room)|no space left|ENOSPC|disk (is )?full/i,
    "disk_full",
  ],
  [/os error (32|33)\b|being used by another process|EBUSY|resource busy/i, "file_in_use"],
];

/** The word for an import that failed: the refusal's own, else what the operating system said, else `other`. Only ever matched
 *  against, never copied: nothing of the message survives. */
export function importReasonOf(error: unknown): ImportReason {
  if (error instanceof ImportRefusal) return error.reason;
  const text = error instanceof Error ? error.message : String(error ?? "");
  for (const [pattern, reason] of OS_REFUSALS) if (pattern.test(text)) return reason;
  return "other";
}

/** How a file came in, as one word. A referenced import outranks any provenance (it is the one whose bytes can vanish from under
 *  the library later); a producer that says what it is (a recording, an export brought back, a generation) is named; any other
 *  provenance is `other`; no provenance is a copy. */
export function importDoor(
  externalPath: string | undefined,
  source: Record<string, unknown> | undefined,
): ImportDoor {
  if (externalPath?.trim()) return "reference";
  const kind = typeof source?.kind === "string" ? source.kind : "";
  if (kind === "recording" || kind === "export" || kind === "generation") return kind;
  return kind ? "other" : "copy";
}
