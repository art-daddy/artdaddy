// How caption words go back together into the line a viewer reads. Pure.
//
// Chinese and Japanese are written with no space between words. Their transcript words are cut by a
// word-breaker (UJ-004), and every place that showed a caption put " " between its words, so a
// Japanese caption read "藤村 の り を". This is the one rule for that, for every renderer and reader
// of caption words: the export, the preview, the caption chunker and the clip's text.

/** A character of a script written without spaces between words: Chinese and Japanese, with their
 *  punctuation and full-width forms (。、「」，！？ー・). Thai, Lao, Khmer and Myanmar have no word
 *  spaces either, but whisper hands them over in the space-separated phrases they are written in, so
 *  those keep their spaces. */
export const UNSPACED_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\u30a0-\u30ff\uff00-\uffef]/u;

/** The last whole character of `s` (a surrogate pair counts as one). */
function lastChar(s: string): string {
  const low = s.charCodeAt(s.length - 1);
  return low >= 0xdc00 && low <= 0xdfff && s.length >= 2 ? s.slice(-2) : s.slice(-1);
}

/** The first whole character of `s`. */
function firstChar(s: string): string {
  const cp = s.codePointAt(0);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** What separates two adjacent words: nothing where either side is Chinese or Japanese, or where a
 *  line break already does (a word that starts a new line carries it, see `lineStarts`); else a space. */
export function wordGap(left: string, right: string): string {
  if (left.endsWith("\n") || right.startsWith("\n")) return "";
  return UNSPACED_CHAR.test(lastChar(left)) || UNSPACED_CHAR.test(firstChar(right)) ? "" : " ";
}

/** `items` drawn by `render`, separated as their `text` reads ("Hallo Albi", "藤村のりを"). The gap is
 *  judged on the plain words, never on what `render` makes of them (escaping, markup). */
export function joinMapped<T>(
  items: readonly T[],
  text: (item: T) => string,
  render: (item: T) => string,
): string {
  let line = "";
  for (let i = 0; i < items.length; i++)
    line += (i ? wordGap(text(items[i - 1]), text(items[i])) : "") + render(items[i]);
  return line;
}

/** Words into the line they are read as. `join(" ")` exactly for words with no Chinese or Japanese. */
export function joinWords(words: readonly string[]): string {
  return joinMapped(
    words,
    (w) => w,
    (w) => w,
  );
}

let segmenter: Intl.Segmenter | null | undefined;

/** Where the words of `text` are, by a dictionary word-breaker (it goes by the characters' script, so
 *  no locale is needed). Punctuation belongs to the word before it, or the word after at the start, so
 *  "した。" stays one word and no line can begin with "。". Null when the runtime has no word-breaker. */
export function wordSpans(text: string): Array<{ start: number; end: number }> | null {
  segmenter ??=
    typeof Intl === "object" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  if (!segmenter) return null;
  const spans: Array<{ start: number; end: number }> = [];
  let lead: number | null = null;
  for (const s of segmenter.segment(text)) {
    const start = s.index;
    const end = start + s.segment.length;
    if (!s.segment.trim()) continue;
    if (s.isWordLike) {
      spans.push({ start: lead ?? start, end });
      lead = null;
    } else if (spans.length) spans[spans.length - 1].end = end;
    else lead ??= start;
  }
  if (lead !== null) spans.push({ start: lead, end: text.length }); // punctuation and nothing else
  return spans;
}

/** Neither renderer can break a line inside Chinese or Japanese (both break at spaces only), so a long
 *  one ran off both edges of the frame (UJ-029). This decides those breaks once, for both: "\n" goes
 *  between words wherever the line, as `measure` draws it, would be wider than `maxWidthPx`. Text with
 *  no Chinese or Japanese is returned as it is, for the renderers to wrap at spaces as before. */
export function breakUnspaced(
  text: string,
  measure: (line: string) => number,
  maxWidthPx: number,
): string {
  if (!UNSPACED_CHAR.test(text)) return text;
  return text
    .split("\n")
    .map((para) => {
      const spans = UNSPACED_CHAR.test(para) && measure(para) > maxWidthPx ? wordSpans(para) : null;
      if (!spans || spans.length < 2) return para;
      const words = spans.map(({ start, end }, i) => ({
        gap: i ? para.slice(spans[i - 1].end, start) : para.slice(0, start),
        word: para.slice(start, end),
      }));
      let line = words[0].gap + words[0].word;
      const lines: string[] = [];
      for (const { gap, word } of words.slice(1)) {
        if (measure(line + gap + word) > maxWidthPx) {
          lines.push(line);
          line = word;
        } else line += gap + word;
      }
      lines.push(line + para.slice(spans[spans.length - 1].end));
      return lines.join("\n");
    })
    .join("\n");
}

/** `words` with "\n" put in front of each one that starts a new line when they are drawn joined
 *  (joinWords) in a line `maxWidthPx` wide, so every renderer that joins them draws the same lines.
 *  Only a line holding Chinese or Japanese is broken here; others are left as they are. */
export function breakWords(
  words: readonly string[],
  measure: (line: string) => number,
  maxWidthPx: number,
): string[] {
  const joined = joinWords(words);
  if (!UNSPACED_CHAR.test(joined) || measure(joined) <= maxWidthPx) return [...words];
  const out = [words[0]];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = line + wordGap(words[i - 1], words[i]) + words[i];
    if (measure(next) > maxWidthPx) {
      out.push(`\n${words[i]}`);
      line = words[i];
    } else {
      out.push(words[i]);
      line = next;
    }
  }
  return out;
}
