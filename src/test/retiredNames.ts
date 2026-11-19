// The names and the claims a person must not read any more in the shipped build (see timeline/exportNames.guard.test.ts, which walks the sources for them, and components/ExportDialog.names.test.tsx, which looks at the screen).
// The Export dialog calls its two choices "Quality" and "Fast" and the processor's lighter setting "light compression". Case matters where it separates a name from plain English ("a quick check" is only a check).
// Beside the old names stands a claim the app no longer makes anywhere: that the graphics chip or light compression changes how the picture looks (it can differ, it is softer). The sentence has been written in
// many shapes (a note under a row, a line on the chat card, a held route's words), so the patterns name the family of wording, not one sentence.
export const RETIRED_NAMES: readonly { name: string; pattern: RegExp }[] = [
  { name: "faster setting", pattern: /faster setting/i },
  { name: "faster compression", pattern: /faster compression/i },
  { name: "Full quality", pattern: /full quality/i },
  { name: "Quick", pattern: /\bQuick\b/ },
  { name: "quick export / setting", pattern: /\bquick (?:export|setting)\b/i },
  { name: "quicker", pattern: /\bquicker\b/i },
];

export const RETIRED_CLAIMS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "the picture can differ",
    pattern:
      /\bpictures?\s+(?:can|may|might|could|will|would)\s+(?:differ|look|be\s+(?:\w+\s+)?(?:softer|different|worse|lower))/i,
  },
  { name: "softer", pattern: /\bsofter\b/i },
  { name: "differs slightly", pattern: /\bdiffers?\s+slightly\b/i },
  {
    name: "looks slightly different",
    pattern:
      /\blooks?\s+(?:slightly|a\s+(?:little|bit)|somewhat)\b|\bpictures?\b[^.;·]{0,40}\blooks?\s+different\b/i,
  },
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
