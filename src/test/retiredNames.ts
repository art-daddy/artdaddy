// The names and the claims a person must not read any more in the shipped build (see timeline/exportNames.guard.test.ts, which walks the sources for them, and components/ExportDialog.names.test.tsx, which looks at the screen).
// The Export dialog calls its two choices "Quality" and "Fast" and the processor's lighter setting "light compression". Case matters where it separates a name from plain English ("a quick check" is only a check).
// Beside the old names stands a claim the app no longer makes anywhere: that the graphics chip or light compression changes how the picture looks (it can differ, it is softer). The sentence has been written in
// many shapes (a note under a row, a line on the chat card, a held route's words), so the patterns name the family of wording, not one sentence. They come in two tiers: the forms that name the picture, which are
// narrow enough to be read in a comment or in the assistant's tool text, and the looser neighbours (a quality that is lower, a detail that is lost), which are read only in the strings a person reads.
export const RETIRED_NAMES: readonly { name: string; pattern: RegExp }[] = [
  { name: "faster setting", pattern: /faster setting/i },
  { name: "faster compression", pattern: /faster compression/i },
  { name: "Full quality", pattern: /full quality/i },
  { name: "Quick", pattern: /\bQuick\b/ },
  { name: "quick export / setting", pattern: /\bquick (?:export|setting)\b/i },
  { name: "quicker", pattern: /\bquicker\b/i },
];

/** The claim in the forms that name the picture: a sentence about the picture, the image or the video that says it can differ, look different or be softer. */
export const PICTURE_CLAIMS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "the picture can differ",
    pattern:
      /\b(?:pictures?|images?|videos?)\s+(?:can|may|might|could|will|would)\s+(?:differ|look|be\s+(?:\w+\s+)?(?:softer|different|worse|lower))/i,
  },
  {
    name: "the picture looks different",
    pattern:
      /\b(?:pictures?|images?|videos?)\s+looks?\s+(?:slightly\s+|a\s+(?:little|bit)\s+|somewhat\s+)?(?:different|softer|worse)\b/i,
  },
  { name: "slightly softer", pattern: /\b(?:slightly|a\s+(?:little|bit)|somewhat)\s+softer\b/i },
  {
    name: "the picture differs",
    pattern: /\b(?:pictures?|images?|videos?)\s+(?:\w+\s+)?differs?\b/i,
  },
];

/** The same family without the subject, and its neighbours (a quality that is lower, a detail that is lost, a picture that is softened or blurred, one that is not the same). */
export const LOOSE_CLAIMS: readonly { name: string; pattern: RegExp }[] = [
  { name: "softer", pattern: /\bsofter\b/i },
  { name: "differs slightly", pattern: /\bdiffers?\s+slightly\b/i },
  {
    name: "looks slightly different",
    pattern:
      /\blooks?\s+(?:slightly|a\s+(?:little|bit)|somewhat)\b|\b(?:slightly|a\s+(?:little|bit)|somewhat)\s+different\b|\bpictures?\b[^.;·!?]{0,40}\blooks?\s+different\b/i,
  },
  {
    name: "softens or blurs",
    pattern: /\b(?:softens?|blurr(?:y|ier)|less\s+(?:sharp|crisp|detail\w*))\b/i,
  },
  {
    name: "lower quality",
    pattern:
      /\bquality\s+(?:(?:may|can|might|could|will|would)\s+(?:be\s+)?|(?:is|are)\s+)(?:slightly\s+|a\s+(?:little|bit)\s+|somewhat\s+)?(?:lower|worse)\b|\bquality\s+(?:may|can|might|could|will|would)\s+differ\w*\b|\b(?:slightly|a\s+(?:little|bit)|somewhat)\s+(?:lower|worse)\s+quality\b/i,
  },
  {
    name: "detail is lost",
    pattern:
      /\bdetail\b[^.;·!?]{0,30}\b(?:lost|reduced)\b|\blos(?:e|es|ing)\s+(?:some\s+)?detail\b/i,
  },
  {
    name: "differences in the picture",
    pattern: /\bdifferences?\b[^.;·!?]{0,30}\b(?:pictures?|images?|videos?|quality)\b/i,
  },
  {
    name: "not the same picture",
    pattern:
      /\b(?:pictures?|images?|videos?|results?|output)\b[^.;·!?]{0,40}\bnot\s+(?:exactly\s+)?(?:the\s+same|identical)\b|\bnot\b[^.;·!?]{0,30}\bpixel[- ]for[- ]pixel\b|\bnot\s+identical\s+to\s+the\s+(?:processor|picture|image|video)/i,
  },
];

export const RETIRED_CLAIMS: readonly { name: string; pattern: RegExp }[] = [
  ...PICTURE_CLAIMS,
  ...LOOSE_CLAIMS,
];

export const RETIRED: readonly { name: string; pattern: RegExp }[] = [
  ...RETIRED_NAMES,
  ...RETIRED_CLAIMS,
];

/** The retired names and claims a text carries, by name; empty when it carries none. */
export const retiredIn = (text: string): string[] =>
  RETIRED.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);

/** The retired claims alone (a text that says the picture differs or is softer), by name. */
export const claimsIn = (text: string): string[] =>
  RETIRED_CLAIMS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);

/** The claims that name the picture, by name: what is read where ordinary English must not be taken for the claim (a comment that quotes it, the assistant's tool text). */
export const pictureClaimsIn = (text: string): string[] =>
  PICTURE_CLAIMS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
