// T16 of the UI spec: the words of the Export dialog's Quality / Fast view are written once, in exportChoiceWords.ts, and nowhere else. This guard is anchored to that module itself: it walks every string
// the module exports (`D2_WORDS`, the size and quality names, the dropped clause) and the fixed text its builders embed, counts the quoted literals of the shipped sources (the syntax tree, so comments
// and type positions do not count), and fails where a sentence appears twice, where a D2 component copies one, or where the words file grows a text this guard has not been told about.
// The test of the old help words (exportHelp.guard.test.ts) is a different file and is left as it is; it runs beside this one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as WORDS from "./exportChoiceWords";
import {
  D2_WORDS,
  figureSpoken,
  questionButtons,
  questionWords,
  rateEntry,
  sameAsProjectRate,
  sameAsProjectSize,
  summaryWords,
} from "./exportChoiceWords";
import { FASTER_SETTING_LINE } from "./exportWords";

const SRC = path.resolve(__dirname, "..");
const WORDS_FILE = "timeline/exportChoiceWords.ts";
const rel = (file: string): string => path.relative(SRC, file).replace(/\\/g, "/");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return [full];
  });

/** The shipped sources: not a test, not a smoke or end-to-end run, not a test fixture, not a declaration file. */
const shipped = (): string[] =>
  walk(SRC).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.d\.ts$/.test(file) &&
      !/\.(test|spec|e2e)\.tsx?$/.test(file) &&
      !/[\\/](test|__e2e)[\\/.]/.test(file) &&
      !/__e2e\.ts$/.test(file),
  );

interface Literal {
  file: string;
  line: number;
  kind: "string" | "template" | "jsx";
  text: string;
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const literalCache = new Map<string, Literal[]>();

/** Every quoted literal, template part and piece of JSX text of a file, as the compiler reads it. A type's literal (`"a" | "b"`), an import path and the name of a property are not words. */
function literalsIn(file: string): Literal[] {
  const cached = literalCache.get(file);
  if (cached) return cached;
  const source = parse(file);
  const found: Literal[] = [];
  const add = (node: ts.Node, text: string, kind: Literal["kind"]): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push({ file: rel(file), line, kind, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) {
      const parent = node.parent;
      const notAWord =
        ts.isLiteralTypeNode(parent) ||
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!notAWord) add(node, node.text, "string");
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      add(node, node.text, "template");
    } else if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
      add(node, node.text.replace(/\s+/g, " ").trim(), "jsx");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  literalCache.set(file, found);
  return found;
}

/** The literals of every shipped file that mentions any of the texts (a file that does not cannot carry them, and parsing all of src would be slow for nothing). */
function literalsMentioning(texts: string[]): Literal[] {
  return shipped().flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return texts.some((text) => source.includes(text)) ? literalsIn(file) : [];
  });
}

/** Every string a value holds: itself, or those of a table or a list, at any depth. */
const stringsOf = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value !== null && typeof value === "object"
      ? Object.values(value).flatMap(stringsOf)
      : [];

const unique = <T>(items: T[]): T[] => [...new Set(items)];
const normalised = (text: string): string => text.replace(/\s+/g, " ").trim();
const hasLetter = (text: string): boolean => /[A-Za-z]/.test(text);

// ---- what the words module exports, walked, never listed by hand ----

const EXPORTS = Object.entries(WORDS);
const FUNCTION_EXPORTS = EXPORTS.filter(([, value]) => typeof value === "function").map(
  ([name]) => name,
);
/** Every string of every non-function export: D2_WORDS, RESOLUTION_WORDS, QUALITY_WORDS, CHIP_NOTE_DROPPED_CLAUSES and whatever is added. */
const WALKED = unique(
  EXPORTS.filter(([, value]) => typeof value !== "function").flatMap(([, value]) => stringsOf(value)),
);

/** The builders that write digits and the letter x and no sentence of their own. */
const NUMBER_BUILDERS = ["describeFigure", "figureBrackets", "figureNumber", "formatRate"];
/** The builders that embed fixed text: each is probed below through the builder itself. */
const SENTENCE_BUILDERS = [
  "figureSpoken",
  "questionButtons",
  "questionWords",
  "rateEntry",
  "sameAsProjectRate",
  "sameAsProjectSize",
  "summaryWords",
];

/** The words the legacy files legitimately keep as their own literals. The words file stays their one source for the D2 view (it carries each at least once), and the legacy file carries it too, so
 *  "exactly once in src" cannot hold for them; the D2 components are held to the words file by the scan below (a component may not copy a word of 8 characters or more). Each entry has its reason. */
const LEGACY_KEPT: Record<string, string> = {
  "Export video":
    "ExportDialog.tsx draws the dialog's title itself (S01 'existing') and MenuBar.tsx names its Save As box with it",
  Quality: "the legacy dialog's row label, and one word every export file uses",
  Fast: "the exporter's own words use the same one word",
  Cancel: "the one-word button every dialog names",
  Export: "the one-word button every dialog names",
  Resolution: "the legacy dialog's row label (ExportDialog.tsx), which Q2's tests query",
  resolution: "the legacy select's name (ExportDialog.tsx), which Q2's tests query",
  "Frame rate": "the legacy dialog's row label (ExportDialog.tsx)",
  "frame rate": "the legacy select's name (ExportDialog.tsx)",
  quality: "the legacy select's name (ExportDialog.tsx), and a value that code compares everywhere",
  High: "ExportDialog.tsx lists the same quality names",
  Medium: "ExportDialog.tsx lists the same quality names",
  "2160p (4K)": "ExportDialog.tsx lists the same size names",
  "1440p": "ExportDialog.tsx lists the same size names; exportOptions.ts keys them",
  "1080p": "ExportDialog.tsx lists the same size names; exportOptions.ts keys them",
  "720p": "ExportDialog.tsx lists the same size names; exportOptions.ts keys them",
  "480p": "ExportDialog.tsx lists the same size names; exportOptions.ts keys them",
};
/** The 0.28.0 constant: the words file IMPORTS it and never writes it out, so the one literal is the legacy file's. */
const IMPORTED_FROM: Record<string, string> = {
  [FASTER_SETTING_LINE]: "timeline/exportWords.ts",
};

/** The fixed text the builders embed (sentence pieces): each is probed through its builder, and must be in exactly this many literals, all in the words file. */
const FRAGMENTS: { fragment: string; literals: number; probe: string; builds: string }[] = [
  {
    fragment: " times faster.",
    literals: 1,
    probe: figureSpoken(4),
    builds: "About 4 times faster.",
  },
  {
    fragment: "Same as project (",
    // the size entry and the rate entry each open with it
    literals: 2,
    probe: `${sameAsProjectSize(1080, 1920)} | ${sameAsProjectRate(60)}`,
    builds: "Same as project (1080 x 1920) | Same as project (60 fps)",
  },
  {
    fragment: "Project size and frame rate",
    literals: 1,
    probe: summaryWords("quality", { smallerSize: false, maxFps: 30, quality: "medium" }),
    builds: "Project size and frame rate, Medium quality.",
  },
  {
    fragment: "One size smaller",
    literals: 1,
    probe: summaryWords("fast", { smallerSize: true, maxFps: 30, quality: "medium" }),
    builds: "One size smaller, up to 30 frames a second, Medium quality, faster compression.",
  },
  {
    fragment: "faster compression",
    literals: 1,
    probe: summaryWords("fast", { smallerSize: false, maxFps: 30, quality: "medium" }),
    builds: "Up to 30 frames a second, Medium quality, faster compression.",
  },
  {
    fragment: "This is a big export. Fast would be about ",
    literals: 1,
    probe: questionWords("a", 4),
    builds: "This is a big export. Fast would be about 4x faster.",
  },
];
/** The pieces of a builder that are connectors, not sentences: too short or too common to be guarded by counting (the eval prompts say "frames a second" too), listed so that the scan of the words
 *  file knows every literal it holds. `rateEntry` writes `N fps`; the question's and the figure's `x`; the typeof check and the choice values are code. */
const CONNECTORS = [
  "About ",
  " x ",
  " fps",
  " quality",
  " to ",
  " frames a second",
  " faster.",
  "up",
  "Up",
  "x",
  "number",
  "quality",
  "a",
  "b",
];

describe("T16 (1) every D2 text is written once, in the words file", () => {
  it("covers every export of the words module: a string or a table is walked, a function is named here", () => {
    expect(FUNCTION_EXPORTS.sort()).toEqual([...NUMBER_BUILDERS, ...SENTENCE_BUILDERS].sort());
    for (const [name, value] of EXPORTS)
      if (typeof value !== "function") expect({ name, strings: stringsOf(value).length > 0 }).toEqual({ name, strings: true });
    // the walk reaches the tables, not only the top level
    for (const text of Object.values(D2_WORDS)) expect(WALKED).toContain(text);
    expect(WALKED).toContain("2160p (4K)");
    expect(WALKED).toContain("Medium");
    expect(WALKED).toContain("It passed ArtDaddy's test");
  });

  it("names every legacy exemption, and each one is still true: the words file carries the text and so does a legacy file", () => {
    const texts = Object.keys(LEGACY_KEPT);
    const literals = literalsMentioning(texts);
    for (const text of texts) {
      expect(WALKED).toContain(text);
      const where = literals.filter((l) => l.text === text).map((l) => l.file);
      expect({ text, inWordsFile: where.includes(WORDS_FILE) }).toEqual({ text, inWordsFile: true });
      expect({ text, inALegacyFile: where.some((file) => file !== WORDS_FILE) }).toEqual({
        text,
        inALegacyFile: true,
      });
    }
  });

  it("holds each sentence or name of 4 characters or more as ONE quoted literal in src, the words file's, except the named legacy ones", () => {
    const texts = WALKED.filter(
      (text) => text.length >= 4 && !(text in LEGACY_KEPT) && !(text in IMPORTED_FROM),
    );
    // not an empty loop: the sentences of the owner's copy are in it
    expect(texts).toEqual(
      expect.arrayContaining([
        "export choice",
        "Typical speed-up; your PC may differ.",
        "Advanced settings",
        "Are you sure?",
        "This is a big export. Fast would be quicker.",
        "Export at Quality",
        "Use Fast's settings",
      ]),
    );
    const literals = literalsMentioning(texts);
    for (const text of texts) {
      const where = literals.filter((l) => l.text === text).map((l) => l.file);
      expect({ text, where }).toEqual({ text, where: [WORDS_FILE] });
    }
  });

  it("takes the faster-setting sentence from the 0.28.0 file by import, never as a second literal", () => {
    expect(D2_WORDS.fasterSetting).toBe(FASTER_SETTING_LINE);
    const literals = literalsMentioning([FASTER_SETTING_LINE]);
    for (const [text, file] of Object.entries(IMPORTED_FROM))
      expect({ text, where: literals.filter((l) => l.text === text).map((l) => l.file) }).toEqual({
        text,
        where: [file],
      });
    const imports = parse(path.join(SRC, WORDS_FILE)).statements.filter(ts.isImportDeclaration);
    const fromLegacy = imports.find(
      (statement) =>
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "./exportWords",
    );
    expect(fromLegacy?.importClause?.getText()).toContain("FASTER_SETTING_LINE");
  });

  it.each(FRAGMENTS)(
    "holds the fixed text $fragment of a builder in $literals literal(s), all in the words file, and the builder still writes it",
    ({ fragment, literals: count, probe, builds }) => {
      expect(probe).toBe(builds);
      expect(probe).toContain(fragment.trim());
      const found = literalsMentioning([fragment]).filter((l) => l.text.includes(fragment));
      expect({ fragment, files: unique(found.map((l) => l.file)), count: found.length }).toEqual({
        fragment,
        files: [WORDS_FILE],
        count,
      });
    },
  );

  it("builds the buttons of the question from the words, in the order the spec gives", () => {
    expect(questionButtons("a")).toEqual([D2_WORDS.cancel, D2_WORDS.exportAtQuality, D2_WORDS.useFast]);
    expect(questionButtons("b")).toEqual([
      D2_WORDS.cancel,
      D2_WORDS.exportWithThese,
      D2_WORDS.useFastSettings,
    ]);
    expect(rateEntry(24)).toBe("24 fps");
  });

  it("leaves no text in the words file that this guard has not been told about", () => {
    const own = literalsIn(path.join(SRC, WORDS_FILE));
    const known = (text: string): boolean =>
      WALKED.includes(text) ||
      CONNECTORS.includes(text) ||
      FRAGMENTS.some(({ fragment }) => text.includes(fragment));
    const strangers = own
      .filter((literal) => literal.kind !== "jsx" && hasLetter(literal.text) && !known(literal.text))
      .map((literal) => `${literal.file}:${literal.line} ${JSON.stringify(literal.text)}`);
    expect(strangers).toEqual([]);
  });
});

/** The component files of the D2 view; those that exist are scanned (helpers write them in parallel, so a missing one is skipped, never failed). */
const D2_COMPONENTS = [
  "components/ExportSettingsView.tsx",
  "components/AdvancedSettings.tsx",
  "components/ChoiceRow.tsx",
  "components/SlowExportQuestion.tsx",
  "components/useEncoderLook.ts",
];
const presentComponents = (): string[] =>
  D2_COMPONENTS.filter((file) => existsSync(path.join(SRC, file)));

/** The D2 words a component must not copy: every string of the words module of 8 characters or more, and the sentence pieces the builders embed. */
const COPY_WATCH = unique([
  ...WALKED.filter((text) => text.length >= 8),
  ...FRAGMENTS.map(({ fragment }) => normalised(fragment)).filter((text) => text.length >= 8),
]);

/** Whether a literal of a component is a copy of a D2 word: it is the word (a name), or it holds the sentence (a word of two or more words). */
const copiesOf = (literal: Literal): string[] => {
  const text = normalised(literal.text);
  return COPY_WATCH.filter((word) => text === word || (word.includes(" ") && text.includes(word)));
};

describe("T16 (2) no D2 component carries a D2 word", () => {
  it("scans at least ChoiceRow.tsx, and the words file is the one that holds the words", () => {
    expect(presentComponents()).toContain("components/ChoiceRow.tsx");
    expect(existsSync(path.join(SRC, WORDS_FILE))).toBe(true);
    // the watch list is the module's own: it has the sentences in it, not an empty or a stale list
    expect(COPY_WATCH).toEqual(
      expect.arrayContaining([
        "Typical speed-up; your PC may differ.",
        "Advanced settings",
        "Resolution",
        "Are you sure?",
        FASTER_SETTING_LINE,
      ]),
    );
  });

  it("holds no copy of a D2 word of 8 characters or more as a string literal, a template or JSX text", () => {
    for (const file of presentComponents()) {
      const copies = literalsIn(path.join(SRC, file))
        .filter((literal) => copiesOf(literal).length > 0)
        .map((literal) => `${literal.file}:${literal.line} ${JSON.stringify(literal.text)}`);
      expect({ file, copies }).toEqual({ file, copies: [] });
    }
  });

  it("draws no words of its own: no JSX text with a letter in it", () => {
    for (const file of presentComponents()) {
      const texts = literalsIn(path.join(SRC, file))
        .filter((literal) => literal.kind === "jsx" && hasLetter(literal.text))
        .map((literal) => `${literal.file}:${literal.line} ${JSON.stringify(literal.text)}`);
      expect({ file, texts }).toEqual({ file, texts: [] });
    }
  });

  it("never imports dialogEstimate: the D2 view says no time and no size", () => {
    for (const file of presentComponents()) {
      const source = parse(path.join(SRC, file));
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && /dialogEstimate/.test(node.getText(source)))
          found.push(node.getText(source));
        if (ts.isIdentifier(node) && node.text === "dialogEstimate") found.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect({ file, found }).toEqual({ file, found: [] });
    }
  });

  it("catches a copy: the scan reads a component literal that is a D2 sentence, a name or a sentence with more around it as a copy, and a code name as none", () => {
    const at = (text: string): Literal => ({ file: "components/X.tsx", line: 1, kind: "string", text });
    expect(copiesOf(at("Typical speed-up; your PC may differ."))).not.toEqual([]);
    expect(copiesOf(at("  Advanced   settings "))).not.toEqual([]);
    expect(copiesOf(at("Resolution"))).not.toEqual([]);
    expect(copiesOf(at("Are you sure?"))).not.toEqual([]);
    expect(copiesOf(at("Hint: Typical speed-up; your PC may differ. (more)"))).not.toEqual([]);
    expect(copiesOf(at("export-choice"))).toEqual([]);
    expect(copiesOf(at("export-advanced"))).toEqual([]);
    expect(copiesOf(at("quality"))).toEqual([]);
    expect(copiesOf(at("flex gap-2 rounded-md border"))).toEqual([]);
  });
});

describe("T16 (3) the old help guard is left alone", () => {
  it("has exportHelp.guard.test.ts beside this file, which this lane does not edit (it runs in the same pass)", () => {
    expect(existsSync(path.join(__dirname, "exportHelp.guard.test.ts"))).toBe(true);
  });
});
