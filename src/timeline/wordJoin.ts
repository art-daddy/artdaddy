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

/** What separates two adjacent words: nothing where either side is Chinese or Japanese, else a space. */
export function wordGap(left: string, right: string): string {
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
