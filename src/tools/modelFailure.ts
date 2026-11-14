// How a download of the speech model can fail, as a CLOSED list of kinds, and what the person is told
// about each in plain words. The kind is what the code throws, decides on and records; the words are
// what a card shows. The words say what went wrong and promise nothing: the card says separately
// whether the app will try again.

export const MODEL_FAILURE_KINDS = [
  "network",
  "stalled",
  "server_busy",
  "server_refused",
  "size_mismatch",
  "damaged",
  "incomplete",
  "cannot_resume",
  "disk_write",
  "cannot_stream",
  "unknown",
] as const;

export type ModelFailureKind = (typeof MODEL_FAILURE_KINDS)[number];

export const MODEL_FAILURE_WORDS: Readonly<Record<ModelFailureKind, string>> = {
  network: "The connection dropped or the download site could not be reached.",
  stalled: "The download stopped receiving data.",
  server_busy: "The download site is busy.",
  server_refused: "The download site refused the request.",
  size_mismatch: "The file that arrived was not the right size.",
  damaged: "The file that arrived was damaged.",
  incomplete: "The download ended before the whole file arrived.",
  cannot_resume: "The download could not continue from where it stopped.",
  disk_write: "The file could not be saved. About 500 MB of free space is needed.",
  cannot_stream: "This computer cannot download the model.",
  unknown: "The download failed.",
};

/** A listed kind, and nothing else: not an inherited name such as "constructor", not a boxed string. */
export function isModelFailureKind(v: unknown): v is ModelFailureKind {
  return typeof v === "string" && (MODEL_FAILURE_KINDS as readonly string[]).includes(v);
}

/** What an HTTP answer that was not a success means. A busy site is worth waiting for: any 5xx, 408
 *  and 429. Every other number is a site that said no, and asking it again will not change that. */
export function kindOfHttpStatus(status: number): "server_busy" | "server_refused" {
  const worthWaiting =
    Number.isInteger(status) &&
    ((status >= 500 && status <= 599) || status === 408 || status === 429);
  return worthWaiting ? "server_busy" : "server_refused";
}
