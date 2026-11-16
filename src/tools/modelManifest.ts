// The speech model, in one table: which file it is, how many bytes it has, its SHA-256, the revision
// it is pinned to and the decoding variant the accuracy gate measured for it (speechGate.json).
// Nothing else states any of these.
//
// The model can be fetched from more than one place. Two are compiled in: the primary one and a second one that
// ArtDaddy runs (secondPlaces), which the app asks when the primary fails. A remote answer may add a few more, and
// acceptModelSources decides which of them are acceptable: a place only says WHERE to ask. Whether what arrives is the
// model is decided by `bytes` and `sha256` here, never by where it came from. The list bounds the places that are
// NAMED: a place that answers with a redirect to another host is followed by the browser's own fetch (the real
// download of the primary does this too, to its content network), which a web view cannot be told not to do; what
// that host sends is still only accepted if it is exactly these bytes.
import type { SpeechBackend } from "./speechPace";
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
  /** The engine paths this file may be launched on: "gpu" is the graphics chip, "cpu" is the launch with `-ng`. Absent
   *  means both, which is what every file was before one was measured on the processor alone; a file is restricted only
   *  when speechGate.json holds measurements for its variant on the paths it names and on no other. Read it through
   *  {@link backendsOf}. */
  backends?: readonly SpeechBackend[];
}

const EVERY_PATH: readonly SpeechBackend[] = ["gpu", "cpu"];

/** The engine paths `entry` may be launched on. */
export function backendsOf(entry: Pick<ModelEntry, "backends">): readonly SpeechBackend[] {
  return entry.backends ?? EVERY_PATH;
}

export const MODEL_MANIFEST: Readonly<Record<string, ModelEntry>> = {
  small: {
    file: "ggml-small.bin",
    bytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    variant: "f16",
  },
  // `small` squeezed to 8-bit weights: 252 MiB against 465. Measured on the processor only (speech study L5): a launch on
  // the graphics chip is never made with it, and speechModel.ts says which languages may use it there.
  small_q8_0: {
    file: "ggml-small-q8_0.bin",
    bytes: 264_464_607,
    sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    variant: "q8_0",
    backends: ["cpu"],
  },
};

export const DEFAULT_MODEL_KEY = "small";

export const PRIMARY_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve";

/** Where a model is fetched from when nothing else is said: only its file and its pinned revision decide. */
type Pinned = Pick<ModelEntry, "file" | "revision">;

export function primaryUrl(entry: Pinned): string {
  return `${PRIMARY_BASE}/${entry.revision}/${entry.file}`;
}

/** The second place, run by ArtDaddy on its own storage behind its own name: the ONE compiled base. Each file's
 *  address is derived from it and from its entry (see {@link secondPlaces}), never written out a second time. */
export const SECOND_PLACE_BASE = "https://models.artdaddy.app/whisper";

/** The places compiled in after the primary one, in the order to ask them: `<base>/<revision>/<file>` for this entry.
 *  Derived from the entry alone, so a new manifest entry has its second place without anything else being edited. */
export function secondPlaces(entry: Pinned): readonly string[] {
  return [`${SECOND_PLACE_BASE}/${entry.revision}/${entry.file}`];
}

/** The only hosts a place to fetch the model from may be on: each one, and any name under it. The second is
 *  ArtDaddy's own domain, so that a later change of the exact name is an entry of the remote list and not a release. */
export const MODEL_HOSTS: readonly string[] = ["huggingface.co", "artdaddy.app"];

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

/** The last path segment of `place` (its query is not part of the path), or null when it is not an address. */
function lastSegment(place: unknown): string | null {
  if (typeof place !== "string") return null;
  try {
    return new URL(place).pathname.split("/").pop() ?? null;
  } catch {
    return null;
  }
}

/** The places of a remote list that name this model's file: the last path segment of the address is exactly the
 *  file's name. With more than one file in the manifest an address names ONE of them, so it is asked for that file and
 *  never for another, and an address that names none of ours is never asked for a download at all. Only the list is
 *  narrowed: which hosts are acceptable is acceptModelSources' decision, taken where the list arrives, and what any
 *  place sends is still decided by the file's size and SHA-256. Keeps the order given; never throws. */
export function remotePlacesFor(
  entry: Pick<ModelEntry, "file">,
  extra: readonly string[],
): readonly string[] {
  if (typeof entry.file !== "string" || entry.file === "") return [];
  try {
    return extra.filter((place) => lastSegment(place) === entry.file);
  } catch {
    return [];
  }
}
