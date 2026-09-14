// SRT / WebVTT parsing into plain timed cues.
//
// Untrusted text from someone else's file, so the two failure directions both matter: nothing
// injectable may survive into the caption (it ends up in an ASS line at export), and nothing
// legitimate may be silently dropped — a caption track missing every line containing "<" is
// worse than a refusal, because it looks like it worked.
//
// Cue times are SOURCE SECONDS, as authored. Mapping to project frames is the caller's job.

export interface SubtitleCue {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export class SubtitleParseError extends Error {}

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm`, and WebVTT's 2-part `MM:SS.mmm`. */
const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;
const CUE_LINE = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}\\s*(.*)$`);

/** Markup we remove: HTML-ish tags (<i>, <v Speaker>) and SSA overrides ({\an8}). The tag rule
 *  requires a letter or slash after "<", so arithmetic like "5 < 6" survives untouched.
 *  The closing brace is OPTIONAL: an unterminated `{\` is still an override opener, and requiring
 *  the `}` let it through to the cue — which the burn-in then has to be the only thing standing
 *  between an imported .srt and libass. */
const TAG = /<\/?[a-zA-Z][^>]*>/g;
const SSA_OVERRIDE = /\{\\[^}]*\}?/g;

function seconds(h: string | undefined, m: string, s: string, frac: string): number {
  const ms = Number(frac.padEnd(3, "0"));
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + ms / 1000;
}

function cleanText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(SSA_OVERRIDE, "")
    .replace(TAG, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export type SubtitleFormat = "srt" | "vtt";

export function subtitleFormat(nameOrPath: string): SubtitleFormat | null {
  const m = /\.([a-z0-9]+)\s*$/i.exec(nameOrPath.trim());
  const ext = m ? m[1].toLowerCase() : "";
  return ext === "srt" ? "srt" : ext === "vtt" || ext === "webvtt" ? "vtt" : null;
}

export function parseSubtitles(raw: string, format: SubtitleFormat): SubtitleCue[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (format === "vtt" && !/^\s*WEBVTT/.test(text)) {
    throw new SubtitleParseError("not a WebVTT file — the WEBVTT header is missing");
  }

  const lines = text.split("\n");
  const cues: SubtitleCue[] = [];
  let i = 0;
  // WebVTT NOTE/STYLE/REGION blocks run to the next blank line and carry no cue.
  const skipBlock = (): void => {
    while (i < lines.length && lines[i].trim() !== "") i++;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (format === "vtt" && /^(NOTE|STYLE|REGION)\b/.test(line.trim())) {
      skipBlock();
      continue;
    }
    if (format === "vtt" && /^\s*WEBVTT/.test(line)) {
      skipBlock();
      continue;
    }

    // A cue is [optional id line] + a timing line + text. Only the timing line identifies it.
    let m = CUE_LINE.exec(line);
    const timingLine = i;
    if (!m) {
      const next = lines[i + 1];
      m = next === undefined ? null : CUE_LINE.exec(next);
      if (!m) {
        throw new SubtitleParseError(`malformed cue timing at line ${i + 1}`);
      }
      i++;
    }
    const start = seconds(m[1], m[2], m[3], m[4]);
    const end = seconds(m[5], m[6], m[7], m[8]);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") body.push(lines[i++]);

    const cleaned = cleanText(body);
    // A cue whose end is not after its start cannot be shown; skipping it silently would be the
    // "looks like it worked" failure, so it is dropped only when it is also empty.
    if (!cleaned) continue;
    if (!(end > start)) {
      throw new SubtitleParseError(
        `cue at line ${timingLine + 1} ends at or before it starts (${start}s -> ${end}s)`,
      );
    }
    cues.push({ text: cleaned, start, end });
  }

  if (!cues.length) throw new SubtitleParseError("the file contains no captions");
  return cues.sort((a, b) => a.start - b.start);
}
