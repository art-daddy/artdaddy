// Lenient decode of a sidecar's stdout/stderr.
//
// With the Tauri shell plugin's `encoding: "raw"`, the bytes come back over IPC
// as a PLAIN number[] (not a Uint8Array, despite the plugin's type), so calling
// TextDecoder.decode() on it directly throws "parameter 1 is not of type
// 'ArrayBuffer'" — which previously surfaced as a bogus "command failed to run"
// on every ffmpeg/ffprobe/yt-dlp call. Normalise any shape (string, number[],
// Uint8Array/ArrayBuffer/view, null) to a string, decoding non-fatally so a
// stray non-utf-8 byte (e.g. a cp1252 smart-quote from yt-dlp on Windows)
// becomes U+FFFD instead of throwing and masking the real error.
const decoder = new TextDecoder("utf-8", { fatal: false });

export function decodeCommandOutput(out: unknown): string {
  if (typeof out === "string") return out;
  if (out == null) return "";
  if (out instanceof Uint8Array || out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
    return decoder.decode(out as BufferSource);
  }
  if (Array.isArray(out)) return decoder.decode(new Uint8Array(out));
  return String(out);
}
