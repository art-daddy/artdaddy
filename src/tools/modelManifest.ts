// The speech model, in one table: which file it is, how many bytes it has, its SHA-256, the revision
// it is pinned to and the decoding variant the accuracy gate measured for it (speechGate.json).
// Nothing else states any of these.
//
// The model can be fetched from more than one place. The primary place is compiled in. A remote
// answer may add a few more, and acceptModelSources decides which of them are acceptable: a place
// only says WHERE to ask. Whether what arrives is the model is decided by `bytes` and `sha256`
// here, never by where it came from. The list bounds the places that are NAMED: a place that answers with a redirect
// to another host is followed by the browser's own fetch (the real download of the primary does this too, to its
// content network), which a web view cannot be told not to do; what that host sends is still only accepted if it is
// exactly these bytes.
import type { ModelVariant } from "./speechDecoding";

export interface ModelEntry {
  /** The file's name, on disk and at the host. */
  file: string;
  bytes: number;
  /** Lower-case hex, 64 characters. */
  sha256: string;
  /** The commit of the public repository the bytes are pinned to, never a branch name. */
  revision: string;
  /** The model variant speechGate.json holds measurements for. */
  variant: ModelVariant;
}

export const MODEL_MANIFEST: Readonly<Record<string, ModelEntry>> = {
  small: {
    file: "ggml-small.bin",
    bytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    variant: "f16",
  },
};

export const DEFAULT_MODEL_KEY = "small";

export const PRIMARY_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve";

/** Where a model is fetched from when nothing else is said: only its file and its pinned revision decide. */
type Pinned = Pick<ModelEntry, "file" | "revision">;

export function primaryUrl(entry: Pinned): string {
  return `${PRIMARY_BASE}/${entry.revision}/${entry.file}`;
}

/** The only hosts a place to fetch the model from may be on: each one, and any name under it. */
export const MODEL_HOSTS: readonly string[] = ["huggingface.co"];

export const MAX_EXTRA_SOURCES = 3;
export const MAX_SOURCE_URL_LENGTH = 300;

/** A name the public internet could resolve. Checked on the PARSED host, because the parser is what
 *  turns "2130706433", "0x7f.1" and "127.1" into 127.0.0.1, and what the request would really use. */
function isPublicName(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return false;
  // At least two labels, none empty: that refuses a trailing dot, a leading dot and "a..b", which
  // the parser keeps and no resolver answers.
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return false;
  // Plain ASCII names only: letters, digits and hyphens inside a label, and no internationalised label (xn--). Every
  // host this list may name is one of those, and a program that cannot run the URL parser's name rules can decide
  // the same thing with a pattern.
  if (
    labels.some(
      (label) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) || label.startsWith("xn--"),
    )
  )
    return false;
  // A name whose last label is a number is an IPv4 address; no real top-level domain is one.
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  return host !== "localhost" && !host.endsWith(".localhost");
}

/** `source` itself when it is an acceptable place, else null. Every rule is on what the parser made
 *  of the string, and the string is taken only when it is already written the way the parser writes
 *  it: nothing the parser would quietly clean up (letter case, a default port, dot segments, a space,
 *  a non-ASCII letter) is repaired, so nothing is left to be read two ways. */
function acceptedHref(source: unknown, hosts: readonly string[]): string | null {
  if (typeof source !== "string" || source.length > MAX_SOURCE_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  // `hash` is empty for a bare "#", which the href still carries.
  if (url.href.includes("#")) return null;
  if (url.href.length > MAX_SOURCE_URL_LENGTH) return null;
  const host = url.hostname.toLowerCase();
  if (!isPublicName(host)) return null;
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  // An address that needed cleaning up is refused, not repaired, so that no other program has to
  // reproduce the parser to agree with this one: what is taken is exactly what the parser writes.
  if (url.href !== source) return null;
  return url.href;
}

/** The extra places a remote answer offered, or [] when ANY of them is not acceptable: a list that
 *  is partly wrong is not trusted in part. Never throws, whatever it is given. Accepted places come
 *  back exactly as given, in the order given, each once: an address is accepted only when it is
 *  already written the way the parser writes it. */
export function acceptModelSources(
  raw: unknown,
  hosts: readonly string[] = MODEL_HOSTS,
): readonly string[] {
  try {
    if (!Array.isArray(raw) || raw.length > MAX_EXTRA_SOURCES) return [];
    const allowed = hosts
      .filter((h) => typeof h === "string" && h !== "")
      .map((h) => h.toLowerCase());
    const accepted: string[] = [];
    // An index loop on purpose: a hole in a sparse array reads as undefined and refuses the list,
    // where forEach and map would step over it.
    for (let i = 0; i < raw.length; i++) {
      const href = acceptedHref(raw[i], allowed);
      if (href === null) return [];
      if (!accepted.includes(href)) accepted.push(href);
    }
    return accepted;
  } catch {
    return [];
  }
}

/** Where to ask for this model, in the order to try: the compiled-in place always first, then the
 *  extra ones, each place once. */
export function modelOrigins(entry: Pinned, extra: readonly string[]): readonly string[] {
  return [...new Set([primaryUrl(entry), ...extra])];
}
