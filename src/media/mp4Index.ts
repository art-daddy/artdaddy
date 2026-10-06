// Whether an MP4/MOV-family file has the index ("moov") every reader needs to open it.
//
// A recording whose recorder died mid-write is media with no index: ftyp, then mdat with a size
// of 0 ("runs to the end of the file"), and nothing after it. ffmpeg cannot open it ("moov atom
// not found"), so neither can the preview, inspect, the transcriber or an export. Pure and
// head-only, like imageDims.ts: the import door has the file's first bytes and its size, never a
// runner, and a guard that only runs where a sidecar exists does not hold the invariant.

const u32 = (b: Uint8Array, o: number): number =>
  b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

/** Top-level boxes an MP4 or QuickTime file can open with. Anything else is not this format,
 *  whatever the file is called, and ffmpeg (which goes by content too) opens it as what it is. */
const FIRST_BOX = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid"]);

/** Why the file can never be opened, or null when it has an index or the head cannot tell.
 *  `head` is the start of the file, `size` its full length in bytes. */
export function missingIndexReason(head: Uint8Array, size: number): string | null {
  for (let at = 0, first = true; at + 8 <= head.length; first = false) {
    const type = String.fromCharCode(head[at + 4], head[at + 5], head[at + 6], head[at + 7]);
    if (first && !FIRST_BOX.has(type)) return null;
    // `meta` at the top is a HEIF/AVIF still: no movie index to look for.
    if (type === "moov" || type === "meta") return null;
    let boxSize = u32(head, at);
    if (boxSize === 1) {
      if (at + 16 > head.length) return null;
      boxSize = u32(head, at + 8) * 2 ** 32 + u32(head, at + 12);
    } else if (boxSize === 0) {
      return NO_INDEX; // this box runs to the end of the file, so nothing can follow it
    }
    if (boxSize < 8) return null; // not a box chain after all
    const end = at + boxSize;
    if (end >= size) return NO_INDEX; // the file ends inside (or right at the end of) this box
    at = end;
  }
  return null; // the next box starts past the head: it may well be the index
}

const NO_INDEX =
  "it has no index (the part an MP4 or MOV needs before anything can play it), so it is unfinished or damaged";
