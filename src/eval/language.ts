// Which language a reply is written in, and whether text a person asked for came out in their
// words: what the eval cases in other languages check by code. A request written entirely in one
// language is answered in it, and a title the person typed in it stays in it, neither translated
// nor transliterated.
//
// Only a reply's own PROSE is judged. Quoted text, code, links, file names and identifiers say
// nothing about the language the agent chose to write in: an English reply that quotes a Russian
// title is still English.
//
// Two kinds of evidence, both coarse on purpose (this grades the language, never the wording):
//  - Script, for the languages with their own: Cyrillic (Russian, Ukrainian) and Greek. Russian and
//    Ukrainian share theirs, so each is told from the other by the letters only it has: Ukrainian
//    і ї є ґ, Russian ы э ъ ё.
//  - Markers, for the languages written in Latin letters: frequent words and the letters that only
//    some of them use. A reply is in such a language when it carries at least two of its markers,
//    more than it carries English ones, and no fewer than it carries of any other language here.
import { kindOf } from "../media/formats";

export const LANGS = ["ru", "uk", "el", "tr", "pl", "id", "es", "pt", "de"] as const;
export type Lang = (typeof LANGS)[number];

export type Verdict = { ok: true } | { ok: false; why: string };

type LatinLang = "tr" | "pl" | "id" | "es" | "pt" | "de";
const LATIN: readonly LatinLang[] = ["tr", "pl", "id", "es", "pt", "de"];

/** The names a reason gives the languages told apart by their markers. */
const NAMES: Record<LatinLang | "en", string> = {
  tr: "Turkish",
  pl: "Polish",
  id: "Indonesian",
  es: "Spanish",
  pt: "Portuguese",
  de: "German",
  en: "English",
};

/** The share of a reply's letters that must be in its language's script. */
export const SCRIPT_SHARE = 0.6;
/** Fewer letters than this in the script is no reply in it. */
export const MIN_SCRIPT_LETTERS = 4;
/** Fewer markers than this is no reply in a Latin-script language. */
export const MIN_MARKERS = 2;
/** Letters count as markers up to this many per language, so one long word cannot outvote words. */
export const MAX_LETTER_MARKERS = 4;

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

/** Frequent words of each language, one list each. A word two languages share counts for both; a
 *  word one of them shares with English counts for none (a, i, in, an, do, to, no, me), since it
 *  tells nothing. */
const WORDS: Record<LatinLang | "en", ReadonlySet<string>> = {
  en: words(`the and is are was were it its it's this that these those of for with you your i've
    i'll i'm have has had now will would can could just from by be been done here there what which
    as if or but not all my we our they them also into then than up out about added made set after
    before each only both over let know want should need so on at seconds second frames`),
  es: words(`el la los las del al y en un una unos unas que por para con se lo le les es está están
    ya pero como más muy también sin sobre hasta desde ahora he ha hemos han hecho listo lista puse
    quité añadí agregué dejé cambié corté eliminé todo todos todas cada segundo segundos de`),
  pt: words(`o os um uma uns umas em na nas nos da das dos ao aos à às e é que para pra pro com não
    já também mais foi foram são está estão você vc agora ficou pronto cada pelo pela seu sua deixei
    coloquei tirei mudei cortei adicionei segundo segundos todos todas isso esse essa aqui só então
    de`),
  de: words(`der die das den dem des ein eine einen einem einer und ist sind war wurde wird nicht ich
    habe hab hat mit auf für zu zum zur im vom beim auch jetzt noch nur schon bitte wie dass oder
    aber von bei nach über unter alle insgesamt sekunden sekunde gerade genau lang lange`),
  pl: words(`w z na się jest są nie że od po jak już teraz oraz dla tak ale czy został została
    zostało zostały wszystkie wszystkich każdy między przez pod nad bez gotowe dodałem dodałam
    ustawiłem ustawiłam zmieniłem zmieniłam przesunąłem przesunęłam sekundy sekund klipu klipy
    klipami tytuł napis`),
  tr: words(`ve bir bu şu için ile de da ama gibi çok daha şimdi artık olarak var yok mi mı mu mü
    oldu ettim tamam tamamdır klibi saniye saniyeye saniyelik başlık videoyu videonun ekledim yaptım
    kısalttım şekilde`),
  id: words(`yang dan di ke dari untuk dengan ini itu sudah udah saya aku kamu anda tidak nggak gak
    akan bisa ada jadi juga atau pada sekarang telah agar supaya lagi karena dalam sebagai sama oke
    sih dong aja detik`),
};

/** Letters only some Latin-script languages use, either case (Indonesian has none). A letter several
 *  share counts for each. Turkish dotless ı and dotted İ do not fold to i or I, so a plain i is
 *  never one. */
const LETTERS: Record<Exclude<LatinLang, "id">, RegExp> = {
  es: /[ñ¿¡áéíóú]/giu,
  pt: /[ãõçêôâàáéíóú]/giu,
  de: /[ßäöü]/giu,
  pl: /[ąęłśźżćńó]/giu,
  tr: /[ığşçöüİ]/giu,
};

const CYRILLIC = /\p{Script=Cyrillic}/gu;
const GREEK = /\p{Script=Greek}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;
const LETTER = /\p{L}/gu;
const UKRAINIAN_ONLY = /[іїєґ]/iu;
const RUSSIAN_ONLY = /[ыэъё]/iu;

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

/** A reply's own prose: what is left once quoted text, code, links, file names and identifiers are
 *  taken out, each replaced by a space. A single quote only opens after a space or punctuation and
 *  only closes before one, so an apostrophe inside a word (п'ять, Kapadokya'da, it's) is kept. A
 *  fenced code block is three inline spans, so the inline rule takes it out too, and a link with a
 *  scheme is taken out with the paths (it has a slash). */
export function prose(text: string): string {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/`[^`]*`/g, " ")
    .replace(/\bwww\.\S+/giu, " ")
    .replace(/«[^»]*»/g, " ")
    .replace(/„[^“”"]*[“”"]/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/‘[^’]*’/g, " ")
    .replace(/(?<=^|[\s([{:—–-])'[^'\n]*?'(?=$|[\s.,!?;:)\]}—–-])/gu, " ")
    .replace(/\S*[_\\/]\S*/g, " ")
    .replace(/\S+\.[\p{L}\p{N}]+/gu, (name) => (kindOf(name) ? " " : name));
}

/** How many markers of each Latin-script language, and of English, a stretch of prose carries. */
export function markerScores(text: string): Record<LatinLang | "en", number> {
  const p = prose(text);
  const tokens = p
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
  const said = (lang: LatinLang | "en") => tokens.filter((w) => WORDS[lang].has(w)).length;
  // Indonesian marks "the one" on a noun with a suffix: klipnya, musiknya, videonya.
  const suffixed = tokens.filter((w) => w.length >= 5 && w.endsWith("nya")).length;
  const letters = (lang: Exclude<LatinLang, "id">) =>
    Math.min(MAX_LETTER_MARKERS, count(p, LETTERS[lang]));
  return {
    en: said("en"),
    es: said("es") + letters("es"),
    pt: said("pt") + letters("pt"),
    de: said("de") + letters("de"),
    pl: said("pl") + letters("pl"),
    tr: said("tr") + letters("tr"),
    id: said("id") + suffixed,
  };
}

const fail = (why: string): Verdict => ({ ok: false, why });
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Whether `text` is written in `lang`, judged from its prose. */
export function writtenIn(text: string, lang: Lang): Verdict {
  const p = prose(text);
  const letters = count(p, LETTER);
  if (lang === "ru" || lang === "uk" || lang === "el") {
    const own = count(p, lang === "el" ? GREEK : CYRILLIC);
    const script = lang === "el" ? "Greek" : "Cyrillic";
    if (own < MIN_SCRIPT_LETTERS) return fail(`the reply has no ${script} prose`);
    if (own / letters < SCRIPT_SHARE)
      return fail(`only ${pct(own / letters)} of the reply's letters are ${script}`);
    if (lang === "uk" && RUSSIAN_ONLY.test(p))
      return fail("the reply uses letters Ukrainian does not have (ы э ъ ё): it is Russian");
    if (lang === "uk" && !UKRAINIAN_ONLY.test(p))
      return fail("the reply has none of the letters only Ukrainian uses (і ї є ґ)");
    if (lang === "ru" && UKRAINIAN_ONLY.test(p))
      return fail("the reply uses letters Russian does not have (і ї є ґ): it is not Russian");
    return { ok: true };
  }
  const latin = count(p, LATIN_LETTER);
  if (!letters || latin / letters < SCRIPT_SHARE)
    return fail(`only ${pct(letters ? latin / letters : 0)} of the reply's letters are Latin`);
  const scores = markerScores(text);
  const own = scores[lang];
  if (own < MIN_MARKERS) return fail(`the reply carries ${own} marker(s) of ${NAMES[lang]}`);
  if (scores.en >= own)
    return fail(`the reply reads as English (${scores.en} English markers, ${own} ${NAMES[lang]})`);
  // A tie with another language passes: shared words (que, para, segundos) say both.
  for (const other of LATIN)
    if (scores[other] > own)
      return fail(
        `the reply reads as ${NAMES[other]} (${scores[other]} markers, ${own} ${NAMES[lang]})`,
      );
  return { ok: true };
}

/** Text as a person reads it, for comparing a title with the words they asked for: one form of
 *  each character, one kind of apostrophe and space, and case folded the way `lang` folds it
 *  (Turkish keeps dotted and dotless i apart; no other language here folds case its own way). */
export function readable(text: string, lang?: Lang): string {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase(lang === "tr" ? "tr-TR" : "en-US");
}

/** `text` without its accents and marks, for words a person typed without them (a Polish keyboard
 *  left out, a Greek title in capitals). ł and ı have no decomposed form and are mapped by hand. */
export function unaccented(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .replace(/ı/g, "i")
    .normalize("NFC");
}

/** Whether `text` shows the words `wanted`, as a person reads them. With `accents: false` the marks
 *  are ignored on both sides (the person typed the words without them). */
export function shows(
  text: string,
  wanted: string,
  lang?: Lang,
  opts: { accents?: boolean } = {},
): boolean {
  const norm = (s: string) => {
    const r = readable(s, lang);
    return opts.accents === false ? unaccented(r) : r;
  };
  const want = norm(wanted);
  return want.length > 0 && norm(text).includes(want);
}
