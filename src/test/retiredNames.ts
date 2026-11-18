// The names a person must not read any more in the shipped build (see timeline/exportNames.guard.test.ts, which walks the sources for them, and components/ExportDialog.names.test.tsx, which looks at the screen).
// The Export dialog calls its two choices "Quality" and "Fast" and the processor's lighter setting "light compression". Case matters where it separates a name from plain English ("a quick check" is only a check).
export const RETIRED: readonly { name: string; pattern: RegExp }[] = [
  { name: "faster setting", pattern: /faster setting/i },
  { name: "faster compression", pattern: /faster compression/i },
  { name: "Full quality", pattern: /full quality/i },
  { name: "Quick", pattern: /\bQuick\b/ },
  { name: "quick export / setting", pattern: /\bquick (?:export|setting)\b/i },
  { name: "quicker", pattern: /\bquicker\b/i },
];

/** The retired names a text carries, by name; empty when it carries none. */
export const retiredIn = (text: string): string[] =>
  RETIRED.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
