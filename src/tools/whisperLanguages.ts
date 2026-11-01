// The languages the speech engine accepts, and the other names a caller may use for them.
//
// whisper-cli does not fail on a language it does not know: it prints its usage text and exits 0
// with no transcript (reproduced with the shipped binary; one user's `fil` made 19 calls fail that
// way, one of them an 81-minute turn). So the engine is only ever handed a code it knows, and a
// caller's other names for a language (ISO 639-3 "jpn", the Filipino "fil", "mandarin") are turned
// into it here, once, for every path that transcribes: the cache key and the argument come from
// the same value, so a transcript made under "jpn" is the one found under "ja".

/** The whisper.cpp release this table was copied from. The engine is pinned to it
 *  (scripts/fetch-sidecars.mjs, the sidecar workflows); a test fails when they disagree, which is
 *  the moment to read the new release's table again. */
export const WHISPER_LANGUAGES_TAG = "v1.9.2";

/** `g_lang` of whisper.cpp's src/whisper.cpp at {@link WHISPER_LANGUAGES_TAG}: code -> English name.
 *  The engine takes either, and only these. */
export const WHISPER_LANGUAGES: Readonly<Record<string, string>> = {
  en: "english",
  zh: "chinese",
  de: "german",
  es: "spanish",
  ru: "russian",
  ko: "korean",
  fr: "french",
  ja: "japanese",
  pt: "portuguese",
  tr: "turkish",
  pl: "polish",
  ca: "catalan",
  nl: "dutch",
  ar: "arabic",
  sv: "swedish",
  it: "italian",
  id: "indonesian",
  hi: "hindi",
  fi: "finnish",
  vi: "vietnamese",
  he: "hebrew",
  uk: "ukrainian",
  el: "greek",
  ms: "malay",
  cs: "czech",
  ro: "romanian",
  da: "danish",
  hu: "hungarian",
  ta: "tamil",
  no: "norwegian",
  th: "thai",
  ur: "urdu",
  hr: "croatian",
  bg: "bulgarian",
  lt: "lithuanian",
  la: "latin",
  mi: "maori",
  ml: "malayalam",
  cy: "welsh",
  sk: "slovak",
  te: "telugu",
  fa: "persian",
  lv: "latvian",
  bn: "bengali",
  sr: "serbian",
  az: "azerbaijani",
  sl: "slovenian",
  kn: "kannada",
  et: "estonian",
  mk: "macedonian",
  br: "breton",
  eu: "basque",
  is: "icelandic",
  hy: "armenian",
  ne: "nepali",
  mn: "mongolian",
  bs: "bosnian",
  kk: "kazakh",
  sq: "albanian",
  sw: "swahili",
  gl: "galician",
  mr: "marathi",
  pa: "punjabi",
  si: "sinhala",
  km: "khmer",
  sn: "shona",
  yo: "yoruba",
  so: "somali",
  af: "afrikaans",
  oc: "occitan",
  ka: "georgian",
  be: "belarusian",
  tg: "tajik",
  sd: "sindhi",
  gu: "gujarati",
  am: "amharic",
  yi: "yiddish",
  lo: "lao",
  uz: "uzbek",
  fo: "faroese",
  ht: "haitian creole",
  ps: "pashto",
  tk: "turkmen",
  nn: "nynorsk",
  mt: "maltese",
  sa: "sanskrit",
  lb: "luxembourgish",
  my: "myanmar",
  bo: "tibetan",
  tl: "tagalog",
  mg: "malagasy",
  as: "assamese",
  tt: "tatar",
  haw: "hawaiian",
  ln: "lingala",
  ha: "hausa",
  ba: "bashkir",
  jw: "javanese",
  su: "sundanese",
  yue: "cantonese",
};

/** Other names for the same languages, as a caller may use them, each to the engine's code: the
 *  ISO 639-3 and 639-2 three-letter codes (both the bibliographic and the terminology one where
 *  they differ), the older two-letter codes ISO retired, the Filipino and Mandarin that the
 *  engine files under Tagalog and Chinese, and the English names people use. */
export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  // ISO 639-3 / 639-2
  eng: "en",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
  deu: "de",
  ger: "de",
  spa: "es",
  rus: "ru",
  kor: "ko",
  fra: "fr",
  fre: "fr",
  jpn: "ja",
  por: "pt",
  tur: "tr",
  pol: "pl",
  cat: "ca",
  nld: "nl",
  dut: "nl",
  ara: "ar",
  swe: "sv",
  ita: "it",
  ind: "id",
  hin: "hi",
  fin: "fi",
  vie: "vi",
  heb: "he",
  ukr: "uk",
  ell: "el",
  gre: "el",
  msa: "ms",
  may: "ms",
  zsm: "ms",
  ces: "cs",
  cze: "cs",
  ron: "ro",
  rum: "ro",
  dan: "da",
  hun: "hu",
  tam: "ta",
  nor: "no",
  nob: "no",
  tha: "th",
  urd: "ur",
  hrv: "hr",
  bul: "bg",
  lit: "lt",
  lat: "la",
  mri: "mi",
  mao: "mi",
  mal: "ml",
  cym: "cy",
  wel: "cy",
  slk: "sk",
  slo: "sk",
  tel: "te",
  fas: "fa",
  per: "fa",
  pes: "fa",
  lav: "lv",
  ben: "bn",
  srp: "sr",
  aze: "az",
  slv: "sl",
  kan: "kn",
  est: "et",
  mkd: "mk",
  mac: "mk",
  bre: "br",
  eus: "eu",
  baq: "eu",
  isl: "is",
  ice: "is",
  hye: "hy",
  arm: "hy",
  nep: "ne",
  mon: "mn",
  bos: "bs",
  kaz: "kk",
  sqi: "sq",
  alb: "sq",
  swa: "sw",
  glg: "gl",
  mar: "mr",
  pan: "pa",
  sin: "si",
  khm: "km",
  sna: "sn",
  yor: "yo",
  som: "so",
  afr: "af",
  oci: "oc",
  kat: "ka",
  geo: "ka",
  bel: "be",
  tgk: "tg",
  snd: "sd",
  guj: "gu",
  amh: "am",
  yid: "yi",
  uzb: "uz",
  fao: "fo",
  hat: "ht",
  pus: "ps",
  tuk: "tk",
  nno: "nn",
  mlt: "mt",
  san: "sa",
  ltz: "lb",
  mya: "my",
  bur: "my",
  bod: "bo",
  tib: "bo",
  tgl: "tl",
  fil: "tl",
  mlg: "mg",
  asm: "as",
  tat: "tt",
  lin: "ln",
  hau: "ha",
  bak: "ba",
  jav: "jw",
  sun: "su",
  // two-letter codes ISO retired or split
  iw: "he",
  in: "id",
  ji: "yi",
  jv: "jw",
  mo: "ro",
  nb: "no",
  // the engine files these under another language's name
  filipino: "tl",
  mandarin: "zh",
  castilian: "es",
  flemish: "nl",
  valencian: "ca",
  moldavian: "ro",
  moldovan: "ro",
  pushto: "ps",
  letzeburgesch: "lb",
  burmese: "my",
  panjabi: "pa",
  sinhalese: "si",
  haitian: "ht",
};

const CODES: ReadonlySet<string> = new Set(Object.keys(WHISPER_LANGUAGES));
// Maps, not objects: a caller's "constructor" or "__proto__" must be an unknown language, not a
// property every object inherits.
const ALIAS_TO_CODE: ReadonlyMap<string, string> = new Map(Object.entries(LANGUAGE_ALIASES));
const NAME_TO_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(WHISPER_LANGUAGES).map(([code, name]) => [name, code]),
);

/** Only a string names a language; anything else (a number, an object a model invented) names none. */
const normalizeText = (raw: unknown): string =>
  typeof raw === "string" ? raw.trim().toLowerCase() : "";

/** The engine's code for what the caller named, or "" for nothing named ("", "auto") and for
 *  anything the engine does not know. A regional tag names the same language ("en-US", "pt_BR",
 *  "zh-Hant" -> "en", "pt", "zh"). Whatever this returns, the engine accepts: "" means detect. */
export function whisperCode(raw: unknown): string {
  const s = normalizeText(raw);
  if (!s || s === "auto") return "";
  for (const candidate of [s, s.split(/[-_]/)[0]]) {
    if (CODES.has(candidate)) return candidate;
    const aliased = ALIAS_TO_CODE.get(candidate) ?? NAME_TO_CODE.get(candidate);
    if (aliased) return aliased;
  }
  return "";
}

/** What to tell the model when it named a language the engine does not know, which is then
 *  detected from the audio; null when nothing is wrong. */
export function languageProblem(raw: unknown): string | null {
  const s = normalizeText(raw);
  if (!s || s === "auto" || whisperCode(raw) !== "") return null;
  return (
    `The language "${s.slice(0, 40)}" is not one the speech engine knows, so the language was ` +
    `detected from the audio instead. Pass a short code such as "en", "es", "hi" or "tl" (Filipino).`
  );
}
