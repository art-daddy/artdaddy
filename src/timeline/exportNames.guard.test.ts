// The names guard. The Export dialog calls its two choices "Quality" and "Fast" and the processor's lighter setting "light compression". The earlier names ("Full quality", "Quick", "Quick export",
// "a faster setting", "quicker") must not be read by a person in the shipped build. This guard is anchored to the shipped sources, not to a list of sentences:
//   1. It walks every quoted literal, template part and piece of JSX text of every shipped file (the syntax tree, so comments and type positions do not count) and finds those that carry an old name.
//   2. Each sits inside a top-level declaration. A declaration nothing in the build reaches (an export no shipped file imports, that no reachable declaration of its own file mentions) is DEAD: its words are
//      never read, and are only listed. A declaration that can be reached is LIVE and needs a row in ROWS: the gate that keeps its old name from a person, in plain words, and a check that the gate still holds.
//   3. A live old name with no row fails (a new use, or a dead declaration someone has now wired in: give it the new names first). A row that matches nothing fails (the table has drifted from the source).
// The words of the 0.28.0 dialog stay as they are while that dialog is the fallback: its rows say so, and the render test (components/ExportDialog.names.test.tsx) holds that the new view never draws them.
// NAMES_GUARD_PRINT=1 prints every finding, live and dead, as a table.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { EXPORT_REASON_CODES } from "../api/exportReason";
import { EXPORT_ENCODERS, EXPORT_MODE_REASONS } from "../api/exportVocabulary";
import {
  LOOSE_CLAIMS,
  PICTURE_CLAIMS,
  claimsIn,
  pictureClaimsIn,
  retiredIn,
} from "../test/retiredNames";
import { chipAdvice } from "./chipAdvice";
import { CHIP_RESTART_ROW } from "./chipRestart";
import { CHIP_ROW_NOTES, chipRowModel, type ChipRowInput } from "./chipRow";
import { D2_WORDS, RESOLUTION_WORDS, QUALITY_WORDS } from "./exportChoiceWords";
import { exportHelp, type HelpInput } from "./exportHelp";
import { describeEncoder, describeModeLines, type ModeView } from "./exportWords";
import { describeLower } from "./lowerWords";
import { quickAvailable } from "./quickAvailable";
import {
  BANNER_BUTTON_LABELS,
  describeFullRow,
  describeQuickCardLine,
  describeQuickRow,
  describeQuickSelected,
  describeRouteQuestion,
} from "./routeWords";
import { PC_CLASSES, ROUTE_KINDS } from "./exportTypes3c";

// The scans below read and parse every shipped file. Alone that takes a few seconds; a run of the whole suite puts every test file on every core, where it takes several times as long, so the file asks for a longer wall clock.
vi.setConfig({ testTimeout: 120_000 });

const SRC = path.resolve(__dirname, "..");
const posix = (p: string): string => p.replace(/\\/g, "/");
const rel = (file: string): string => posix(path.relative(SRC, file));
const normalised = (text: string): string => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------------------------
// The scanner: pure over a map of file name (relative to src, forward slashes) to source text, so it can be tried on a
// small project of its own below as well as run on the real one.
// ---------------------------------------------------------------------------------------------------------------------

const TOP = "<top-level>";

interface Import {
  spec: string;
  names: string[];
  star: boolean;
}

interface Facts {
  file: string;
  source: ts.SourceFile;
  /** Top-level declarations by name; a declaration with no name of its own (`export default () => ...`) is "default". */
  decls: Map<string, ts.Node>;
  /** The names other modules can import, to the declaration each is. */
  exported: Map<string, string>;
  /** The other top-level declarations each declaration mentions. */
  refs: Map<string, Set<string>>;
  /** The declarations that the file's own statements (those that are not declarations) mention: they run when the module loads. */
  loose: Set<string>;
  imports: Import[];
}

function factsOf(file: string, text: string): Facts {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const decls = new Map<string, ts.Node>();
  const exported = new Map<string, string>();
  const imports: Import[] = [];
  const looseNodes: ts.Node[] = [];
  const declare = (name: string, node: ts.Node, isExported: boolean, byDefault: boolean): void => {
    decls.set(name, node);
    if (byDefault) exported.set("default", name);
    else if (isExported) exported.set(name, name);
  };
  for (const statement of source.statements) {
    const modifiers: readonly ts.Modifier[] = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? [])
      : [];
    const has = (kind: ts.SyntaxKind): boolean => modifiers.some((m) => m.kind === kind);
    const isExported = has(ts.SyntaxKind.ExportKeyword);
    const byDefault = has(ts.SyntaxKind.DefaultKeyword);
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const names: string[] = [];
      let star = false;
      if (clause.name) names.push("default");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) star = true;
      else if (bindings)
        for (const element of bindings.elements)
          if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      imports.push({ spec: statement.moduleSpecifier.text, names, star });
    } else if (ts.isExportDeclaration(statement)) {
      const spec = statement.moduleSpecifier;
      const clause = statement.exportClause;
      if (spec && ts.isStringLiteral(spec)) {
        // A re-export takes the names from the other module as an import does.
        if (clause && ts.isNamedExports(clause))
          imports.push({
            spec: spec.text,
            names: clause.elements.map((element) => (element.propertyName ?? element.name).text),
            star: false,
          });
        else imports.push({ spec: spec.text, names: [], star: true });
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements)
          exported.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      declare(statement.name?.text ?? "default", statement, isExported, byDefault);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          declare(declaration.name.text, declaration, isExported, false);
        else looseNodes.push(declaration);
      }
    } else if (ts.isExportAssignment(statement)) {
      declare("default", statement, true, true);
    } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
      looseNodes.push(statement);
    }
  }

  // A dynamic import takes any name of the module it names.
  const dynamic = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first))
        imports.push({ spec: first.text, names: [], star: true });
    }
    ts.forEachChild(node, dynamic);
  };
  dynamic(source);

  const names = new Set(decls.keys());
  const mentions = (node: ts.Node, except?: string): Set<string> => {
    const found = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && names.has(n.text) && n.text !== except) found.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };
  const refs = new Map<string, Set<string>>();
  for (const [name, node] of decls) refs.set(name, mentions(node, name));
  const loose = new Set<string>();
  for (const node of looseNodes) for (const name of mentions(node)) loose.add(name);
  return { file, source, decls, exported, refs, loose, imports };
}

function resolveModule(from: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ])
    if (known.has(candidate)) return candidate;
  return null;
}

interface Use {
  names: Set<string>;
  star: boolean;
}

/** For each file, which files take what from it. */
function usesOf(all: ReadonlyMap<string, Facts>): Map<string, Map<string, Use>> {
  const known = new Set(all.keys());
  const out = new Map<string, Map<string, Use>>();
  for (const facts of all.values())
    for (const imported of facts.imports) {
      const target = resolveModule(facts.file, imported.spec, known);
      if (!target) continue;
      const byImporter = out.get(target) ?? new Map<string, Use>();
      const use = byImporter.get(facts.file) ?? { names: new Set<string>(), star: false };
      for (const name of imported.names) use.names.add(name);
      use.star = use.star || imported.star;
      byImporter.set(facts.file, use);
      out.set(target, byImporter);
    }
  return out;
}

/** The declarations of each file that something can reach: what another file imports by name, what the file's own loose statements mention, and whatever those mention in turn. A file nobody imports
 *  is an entry point of the app (or a stray): all of it counts. */
function liveOf(
  all: ReadonlyMap<string, Facts>,
  uses: ReadonlyMap<string, ReadonlyMap<string, Use>>,
): Map<string, Set<string>> {
  const live = new Map<string, Set<string>>();
  for (const facts of all.values()) {
    const importers = uses.get(facts.file);
    const roots = new Set<string>(facts.loose);
    if (!importers || importers.size === 0) for (const name of facts.decls.keys()) roots.add(name);
    else
      for (const use of importers.values()) {
        if (use.star) for (const local of facts.exported.values()) roots.add(local);
        for (const name of use.names) {
          const local = facts.exported.get(name);
          if (local) roots.add(local);
        }
      }
    const seen = new Set<string>();
    const stack = [...roots];
    for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const next of facts.refs.get(name) ?? []) stack.push(next);
    }
    live.set(facts.file, seen);
  }
  return live;
}

/** The top-level declaration a node sits in. */
function enclosingDeclaration(node: ts.Node): string {
  let current: ts.Node = node;
  let declarator: ts.VariableDeclaration | undefined;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isVariableDeclarationList(current.parent) &&
      ts.isVariableStatement(current.parent.parent) &&
      ts.isSourceFile(current.parent.parent.parent)
    )
      declarator = current;
    current = current.parent;
  }
  if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current))
    return current.name?.text ?? "default";
  if (ts.isVariableStatement(current))
    return declarator && ts.isIdentifier(declarator.name) ? declarator.name.text : TOP;
  if (ts.isExportAssignment(current)) return "default";
  return TOP;
}

interface Finding {
  file: string;
  line: number;
  decl: string;
  text: string;
  names: string[];
  live: boolean;
}

/** Every literal, template part and piece of JSX text of a file that carries an old name. A type's literal (`"a" | "b"`), an import path and the name of a property are not words. */
function findingsOf(facts: Facts, live: ReadonlySet<string>): Finding[] {
  const found: Finding[] = [];
  const add = (node: ts.Node, text: string): void => {
    const names = retiredIn(text);
    if (names.length === 0) return;
    const decl = enclosingDeclaration(node);
    found.push({
      file: facts.file,
      line: facts.source.getLineAndCharacterOfPosition(node.getStart(facts.source)).line + 1,
      decl,
      text: normalised(text),
      names,
      live: decl === TOP || live.has(decl),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) {
      const parent = node.parent;
      const notAWord =
        ts.isLiteralTypeNode(parent) ||
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!notAWord) add(node, node.text);
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      add(node, node.text);
    } else if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
      add(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(facts.source);
  return found;
}

interface Scan {
  facts: Map<string, Facts>;
  uses: Map<string, Map<string, Use>>;
  findings: Finding[];
}

function scan(sources: ReadonlyMap<string, string>): Scan {
  const facts = new Map<string, Facts>();
  for (const [file, text] of sources) facts.set(file, factsOf(file, text));
  const uses = usesOf(facts);
  const live = liveOf(facts, uses);
  const findings = [...facts.values()].flatMap((f) => findingsOf(f, live.get(f.file) ?? new Set()));
  return { facts, uses, findings };
}

/** The files that import `name` from `file` (a star import or a dynamic import takes every name). */
function importersOf(result: Scan, file: string, name: string): string[] {
  const takers = result.uses.get(file);
  if (!takers) return [];
  return [...takers]
    .filter(([, use]) => use.star || use.names.has(name))
    .map(([importer]) => importer)
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// The scanner tried on a small project of its own: it must tell a reached old name from one nothing reaches, or the guard below says nothing.
// ---------------------------------------------------------------------------------------------------------------------

describe("the scanner tells a reached old name from one nothing reaches", () => {
  const project = new Map<string, string>([
    [
      "words.ts",
      [
        'export const reached = "Full quality";',
        'export const alsoReached = (): string => helper() + "x";',
        'const helper = (): string => "Quick export";',
        'export const unreachedExport = "a faster setting";',
        'const unreachedHelper = "it is quicker";',
        "export const unreachedUser = (): string => unreachedHelper;",
        'export default function defaultOne(): string { return "Quick"; }',
        "export function shown(): string { return `Switch to Quick ${1}`; }",
        'export const quickCheck = "a quick check of the speed";',
        'export const plain = "Quality and Fast";',
      ].join("\n"),
    ],
    [
      "view.tsx",
      [
        'import defaultOne, { reached, alsoReached } from "./words";',
        'import * as everything from "./other";',
        "export const View = () => <p>{reached}{alsoReached()}{defaultOne()}{everything.all}</p>;",
        "export const Label = () => <b>Full quality</b>;",
      ].join("\n"),
    ],
    ["other.ts", 'export const all = "Quick export"; export const two = "Quick export";'],
    ["entry.ts", 'const never = "Full quality";\nconsole.log(never);'],
  ]);
  const result = scan(project);
  const find = (file: string, decl: string): Finding | undefined =>
    result.findings.find((f) => f.file === file && f.decl === decl);

  it("calls an export that another file imports by name live, and the helper it mentions", () => {
    expect(find("words.ts", "reached")?.live).toBe(true);
    expect(find("words.ts", "helper")?.live).toBe(true);
    expect(find("words.ts", "defaultOne")?.live).toBe(true);
  });

  it("calls an export nothing imports dead, and the helper only a dead export mentions", () => {
    expect(find("words.ts", "unreachedExport")?.live).toBe(false);
    expect(find("words.ts", "unreachedHelper")?.names).toEqual(["quicker"]);
    expect(find("words.ts", "unreachedHelper")?.live).toBe(false);
    expect(find("words.ts", "shown")?.live).toBe(false); // exported, and imported by no one
  });

  it("takes a star import as reaching every export of the module", () => {
    expect(find("other.ts", "all")?.live).toBe(true);
    expect(find("other.ts", "two")?.live).toBe(true);
  });

  it("counts a file nobody imports as an entry point, and JSX text and template parts as words", () => {
    expect(find("entry.ts", "never")?.live).toBe(true);
    expect(find("view.tsx", "Label")?.live).toBe(true);
    expect(find("words.ts", "shown")?.names).toEqual(["Quick"]);
  });

  it("does not take plain English or the new names for an old one", () => {
    expect(find("words.ts", "quickCheck")).toBeUndefined();
    expect(find("words.ts", "plain")).toBeUndefined();
    expect(retiredIn("Quality, Fast and light compression")).toEqual([]);
    expect(retiredIn("Using your graphics chip to save time")).toEqual([]);
    for (const old of [
      "a faster setting",
      "Full quality",
      "full quality",
      "Quick export",
      "Quick",
      "on the quick setting",
      "Fast would be quicker",
    ])
      expect(retiredIn(old).length).toBeGreaterThan(0);
  });
});

describe("the patterns find an old name wherever it sits, and nothing that is not one", () => {
  const OLD = [
    "Full quality",
    "full quality",
    "Quick",
    "Quick export",
    "quick export",
    "a faster setting",
    "faster compression",
    "quicker",
    "on the quick setting",
  ];
  // The owner's names and plain English that sits close to the old ones: "a quick check", "to go faster", "Switch to another project".
  const NEW = [
    "Quality",
    "Fast",
    "light compression",
    "graphics chip",
    "Medium",
    "Advanced settings",
    "export",
    "a quick check of this PC",
    "to go faster",
    "makes exports faster",
    "Switch to another project",
    "the settings",
    "Cancel",
  ];
  const text = fc.array(fc.constantFrom(...NEW), { maxLength: 6 }).map((words) => words.join(" "));

  it("finds every old name inside any text made of the others", () => {
    fc.assert(
      fc.property(
        text,
        fc.constantFrom(...OLD),
        text,
        (before, old, after) => retiredIn(`${before} ${old} ${after}`).length > 0,
      ),
    );
  });

  it("finds none in text made only of the new names and plain words", () => {
    fc.assert(fc.property(text, (words) => retiredIn(words).length === 0));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real project
// ---------------------------------------------------------------------------------------------------------------------

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return [full];
  });

/** The shipped sources: not a test, not a smoke or end-to-end run, not a test fixture, not a declaration file. */
const shippedFiles = (): string[] =>
  walk(SRC).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.d\.ts$/.test(file) &&
      !/\.(test|spec|e2e)\.tsx?$/.test(file) &&
      !/[\\/](test|__e2e)[\\/.]/.test(file) &&
      !/__e2e\.ts$/.test(file),
  );

let cachedSources: Map<string, string> | null = null;
/** The text of every shipped file, by name relative to src. */
const realSources = (): Map<string, string> => {
  cachedSources ??= new Map(shippedFiles().map((file) => [rel(file), readFileSync(file, "utf8")]));
  return cachedSources;
};

let cached: Scan | null = null;
const real = (): Scan => {
  cached ??= scan(realSources());
  return cached;
};

/** What keeps an old name that is still in a reachable declaration from a person, and the check that this is still so. */
type Gate =
  | "legacy-dialog"
  | "no-switch-button"
  | "question-not-built"
  | "no-restart-switch"
  | "plain-english";

interface Row {
  file: string;
  decl: string;
  gate: Gate;
  /** In plain words, for whoever reads the table. */
  why: string;
  /** Pins the literal itself, where the declaration holds more than one thing. */
  text?: string;
}

const ROWS: readonly Row[] = [
  {
    file: "components/ExportDialog.tsx",
    decl: "ExportDialog",
    gate: "legacy-dialog",
    why: "the Mode row's radio label, in the 0.28.0 settings block that the dialog draws only when the menu bar does not hand it quickRoute",
    text: "Full quality",
  },
  {
    file: "timeline/exportWords.ts",
    decl: "FAST_HINT",
    gate: "legacy-dialog",
    why: "the hint under the old Mode row (0.28.0 dialog)",
  },
  {
    file: "timeline/exportWords.ts",
    decl: "FASTER_SETTING_LINE",
    gate: "legacy-dialog",
    why: "the 0.28.0 dialog's sentence about the processor's lighter setting; the new view takes its own entry (the render test follows that hand-over)",
  },
  {
    file: "timeline/exportWords.ts",
    decl: "describeModeLines",
    gate: "legacy-dialog",
    why: "the old Mode row's sentences (0.28.0 dialog); the new view reads only the one line about the lighter setting from the same function",
  },
  {
    file: "timeline/lowerWords.ts",
    decl: "describeLower",
    gate: "no-switch-button",
    why: "the sentence that names Quick export is said only where `quick` is true, and the caller passes quickAvailable(), the constant false",
  },
  {
    file: "timeline/routeWords.ts",
    decl: "BANNER_BUTTON_LABELS",
    gate: "no-switch-button",
    why: "the Switch button's label: the slow-export banner draws that button only where quickAvailable() is true and a handler is given",
  },
  {
    file: "timeline/routeWords.ts",
    decl: "describeSlowBanner",
    gate: "no-switch-button",
    why: "the lines that say what Quick export would do are written only where the banner may switch, which needs quickAvailable()",
  },
  {
    file: "timeline/routeWords.ts",
    decl: "describeQuietBanner",
    gate: "no-switch-button",
    why: "the line that says what Quick export would do is written only where the banner may switch, which needs quickAvailable()",
  },
  {
    file: "timeline/routeWords.ts",
    decl: "ASSISTANT_SLOW_NOTE",
    gate: "no-switch-button",
    why: "the note for the assistant while the Switch button exists; the list row picks the other note while quickAvailable() is false",
  },
  {
    file: "timeline/exportQueue.ts",
    decl: "RESTARTED_PHRASE",
    gate: "no-restart-switch",
    why: "the phrase for a restart that a person's Switch started; nothing in the build starts one",
  },
  {
    file: "timeline/exportChoiceWords.ts",
    decl: "D2_WORDS",
    gate: "question-not-built",
    why: 'the two sentences of the question "Are you sure?", which no screen draws in this build',
    text: "quicker",
  },
];

const sameRow = (row: Row, finding: Finding): boolean =>
  row.file === finding.file &&
  row.decl === finding.decl &&
  (row.text === undefined || finding.text.includes(row.text));

const describeFinding = (f: Finding): string =>
  `${f.file}:${f.line} in ${f.decl} [${f.names.join(", ")}] ${JSON.stringify(f.text)}`;

describe("every old name that a person could read is accounted for", () => {
  it("reads the sources the app is built from, so an empty result is not a scanner that sees nothing", () => {
    const { findings, facts } = real();
    expect(facts.size).toBeGreaterThan(300);
    const at = (file: string, decl: string): Finding | undefined =>
      findings.find((f) => f.file === file && f.decl === decl);
    // The old Mode row's words are reached (the 0.28.0 dialog imports them); the held design's row words are not (no one calls them).
    expect(at("timeline/exportWords.ts", "describeModeLines")?.live).toBe(true);
    expect(at("timeline/routeWords.ts", "describeFullRow")?.live).toBe(false);
    expect(at("timeline/routeWords.ts", "describeQuickRow")?.live).toBe(false);
    expect(at("timeline/estimateWords.ts", "describeHeavyProject")?.live).toBe(false);
    // NAMES_GUARD_PRINT=1 prints every finding as a table, from this test (it runs on every run; the table checks nothing).
    if (process.env.NAMES_GUARD_PRINT) {
      const lines = findings
        .map((f) => {
          const row = ROWS.find((r) => f.live && sameRow(r, f));
          return `| ${f.file}:${f.line} | ${f.decl} | ${f.live ? "reachable" : "dead"} | ${row ? row.gate : ""} | ${JSON.stringify(f.text)} |`;
        })
        .sort();
      // eslint-disable-next-line no-console
      console.log(`NAMES-TABLE-BEGIN\n${lines.join("\n")}\nNAMES-TABLE-END ${lines.length}`);
    }
  });

  it("has a row for each old name in a declaration that can be reached, and no row for a name nothing reaches", () => {
    const unaccounted = real()
      .findings.filter((f) => f.live && !ROWS.some((row) => sameRow(row, f)))
      .map(describeFinding);
    expect(
      unaccounted,
      "an old name is in a string a person can read: give it the new names, or add a row with the gate that keeps it from them",
    ).toEqual([]);
  });

  it("has no row that matches nothing any more", () => {
    const stale = ROWS.filter((row) => !real().findings.some((f) => f.live && sameRow(row, f))).map(
      (row) => `${row.file} ${row.decl}${row.text ? ` ${JSON.stringify(row.text)}` : ""}`,
    );
    expect(
      stale,
      "the table names a declaration that no longer holds an old name: remove its row",
    ).toEqual([]);
  });
});

// The other lanes add words in these very files (the Quality / Fast choice and its summary in the dialog's words file, a time left in the exportWords file the card reads). The guard fails only on the retired names: a new
// sentence made of the owner's names is no business of it, and an old name added in the same place is found and named.
describe("the guard fails only on the old names, wherever new words are added", () => {
  const unaccounted = (result: Scan): string[] =>
    result.findings
      .filter((f) => f.live && !ROWS.some((row) => sameRow(row, f)))
      .map(describeFinding);

  /** The real project as it would be if `words` were added to the exportWords file and the export card read them (so they are reached). */
  const withWords = (words: readonly string[]): Map<string, string> => {
    const names = words.map((_, index) => `ADDED_WORDS_${index}`);
    const edited = new Map(realSources());
    edited.set(
      "timeline/exportWords.ts",
      [
        edited.get("timeline/exportWords.ts") ?? "",
        ...words.map((text, index) => `export const ${names[index]} = ${JSON.stringify(text)};`),
      ].join("\n"),
    );
    edited.set(
      "components/ExportCard.tsx",
      [
        `import { ${names.join(", ")} } from "../timeline/exportWords";`,
        edited.get("components/ExportCard.tsx") ?? "",
        `export const addedWords = [${names.join(", ")}];`,
      ].join("\n"),
    );
    return edited;
  };

  const NEW_WORDS = [
    "Quality",
    "Fast",
    "About 3 min left",
    "Finishing",
    "This is taking longer than expected",
    "One size smaller, up to 30 frames a second, Medium quality, light compression.",
    "To save time, ArtDaddy will use light compression.",
    "Up to 30 frames a second, Medium quality, graphics chip.",
    "Using light compression to save time",
    "Auto: used on this PC. The file is usually larger.",
    "Without the graphics chip, exports are usually slower.",
  ];

  it("takes new sentences made of the owner's names, and of a time left, without a word", () => {
    expect(unaccounted(scan(withWords(NEW_WORDS)))).toEqual([]);
  });

  it("finds an old name added in the same places, among the new sentences, and names it", () => {
    const old = [
      "Fast would be quicker",
      "Using a faster setting to save time",
      "Choose Full quality for the smallest file",
      "Quick export would take about 3 min",
      "To save time, ArtDaddy will use light compression; the picture may be slightly softer.",
      "Using your graphics chip · the file is larger and the picture can differ slightly",
    ];
    const found = unaccounted(scan(withWords([...NEW_WORDS, ...old])));
    expect(found).toHaveLength(old.length);
    old.forEach((text, index) => {
      const hit = found.find((line) => line.includes(`ADDED_WORDS_${NEW_WORDS.length + index} `));
      expect(hit, text).toContain(JSON.stringify(text));
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The claims: nothing a person can read says that the graphics chip or light compression changes the picture
// ---------------------------------------------------------------------------------------------------------------------
// The claim was taken out of everything a person reads (2026-11-19: "the picture can differ slightly", "the picture may be slightly softer", and every wording of them: the dialog, the chat card, the
// assistant's text). The scan above already finds a claim in a string that something reaches (a claim is a retired name). The checks here are stricter, because a claim that nothing reaches today is one wiring
// away from a person: no string of any shipped file may carry it, reached or not, nor a sentence that a `+` or a `.join` assembles out of literals, nor a comment that quotes it, nor the assistant's tool text; and the
// real words functions are run over every input they take, so a sentence made by code is held as well as one that is written out. The patterns come in two tiers (src/test/retiredNames.ts): the strings a person
// reads are held to both, a comment and the tool text only to the forms that name the picture, so that ordinary English elsewhere ("a softer tone") is never taken for the claim.

const BREAK = "\u0001";

interface Assembled {
  line: number;
  decl: string;
  text: string;
  pieces: string[];
}

/** The array a `.join` is called on: `["the picture", "may differ"].join(" ")` is read like a chain of `+` with the separator between the parts. */
const joinedArray = (node: ts.Node): ts.ArrayLiteralExpression | null =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "join" &&
  ts.isArrayLiteralExpression(node.expression.expression)
    ? node.expression.expression
    : null;

/** The sentences that a chain of `+`, or a `.join` of literals, assembles ("the picture " + "may differ"), read whole. A part that is not a literal reads as a break, so the words on either side of it never join. */
function assembledOf(facts: Facts): Assembled[] {
  const found: Assembled[] = [];
  const inChain = new Set<ts.Node>();
  const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const piecesOf = (node: ts.Expression): string[] => {
    let inner = node;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return [inner.text];
    if (ts.isTemplateExpression(inner))
      return [
        inner.head.text,
        ...inner.templateSpans.flatMap((span) => [BREAK, span.literal.text]),
      ];
    if (isPlus(inner)) {
      inChain.add(inner);
      return [...piecesOf(inner.left), ...piecesOf(inner.right)];
    }
    return [BREAK];
  };
  const add = (node: ts.Node, pieces: string[]): void => {
    found.push({
      line: facts.source.getLineAndCharacterOfPosition(node.getStart(facts.source)).line + 1,
      decl: enclosingDeclaration(node),
      text: pieces.join(""),
      pieces,
    });
  };
  const visit = (node: ts.Node): void => {
    const array = joinedArray(node);
    if (array !== null && ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const separator =
        first === undefined
          ? ","
          : ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)
            ? first.text
            : BREAK;
      add(
        node,
        array.elements.flatMap((element, index) => [
          ...(index > 0 ? [separator] : []),
          ...piecesOf(element),
        ]),
      );
    } else if (isPlus(node) && !inChain.has(node)) {
      add(node, piecesOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(facts.source);
  return found;
}

/** The joined sentences that carry a claim no single piece of them carries: the ones the scan of single literals cannot see. Each stretch between two breaks is read on its own, so words a variable keeps apart never join. */
const assembledClaims = (facts: Facts): Assembled[] =>
  assembledOf(facts).filter(({ text, pieces }) =>
    text
      .split(BREAK)
      .flatMap(claimsIn)
      .some((name) => !pieces.some((piece) => claimsIn(piece).includes(name))),
  );

describe("no claim that the picture differs is made anywhere in the shipped build", () => {
  const claimed = (result: Scan): string[] =>
    result.findings.filter((f) => claimsIn(f.text).length > 0).map(describeFinding);
  const assembled = (result: Scan): string[] =>
    [...result.facts.values()].flatMap((facts) =>
      assembledClaims(facts).map(
        (a) =>
          `${facts.file}:${a.line} in ${a.decl} ${JSON.stringify(a.text.split(BREAK).join("…"))}`,
      ),
    );

  it("finds a claim in a string, a template part, JSX text and a sentence joined from pieces, reached or not, and not a plain sentence, nor words a variable keeps apart", () => {
    const project = new Map<string, string>([
      [
        "claims.ts",
        [
          'export const plain = "The picture can differ slightly.";',
          'export const joined = "The file is larger and the picture " + "may be " + "different.";',
          'export const arrayJoined = ["The file is larger and the picture", "may be", "different."].join(" ");',
          "export const template = `Using ${what} · the file is larger and the picture can look slightly softer`;",
          'const hidden = "the picture can differ";',
          "export const holder = (): string => hidden;",
          'export const apart = "the picture " + word + " may differ";',
          'export const apartJoined = ["the picture", word, "may differ"].join(" ");',
          'export const fine = "The picture is smaller (720p), and " + "the file is usually larger.";',
        ].join("\n"),
      ],
      [
        "view.tsx",
        [
          'import { plain, holder } from "./claims";',
          'import { other } from "./unreached";',
          "export const View = () => <p>{plain}{holder()}{other} The picture may look slightly softer.</p>;",
        ].join("\n"),
      ],
      [
        "unreached.ts",
        'export const other = "fine"; export const nobody = "the picture may be slightly softer";',
      ],
    ]);
    const result = scan(project);
    expect(
      result.findings
        .filter((f) => claimsIn(f.text).length > 0)
        .map((f) => f.decl)
        .sort(),
    ).toEqual(["View", "hidden", "nobody", "plain", "template"]);
    expect(
      [...result.facts.values()]
        .flatMap((facts) => assembledClaims(facts).map((a) => a.decl))
        .sort(),
    ).toEqual(["arrayJoined", "joined"]);
    // reached or not is told apart (the scan above lists the reached ones), yet both are found
    const lives = Object.fromEntries(
      result.findings.filter((f) => claimsIn(f.text).length > 0).map((f) => [f.decl, f.live]),
    );
    expect(lives).toMatchObject({ plain: true, hidden: true, nobody: false });
  });

  it("finds none in the real sources: no string of any shipped file says it, reached or not, and none is joined from pieces", () => {
    const result = real();
    expect(result.facts.size).toBeGreaterThan(300);
    expect(
      claimed(result),
      "a string says the picture differs or is softer (the chip or light compression): take the sentence out, reached or not",
    ).toEqual([]);
    expect(
      assembled(result),
      "a sentence joined from pieces says the picture differs or is softer",
    ).toEqual([]);
  });

  /** Where a text says one of the claims that name the picture, as file:line and the words on that line. A line is read without its comment marks, and with the next one, so that a claim broken over two lines is found (at its first line). */
  const quotedClaims = (sources: ReadonlyMap<string, string>): string[] =>
    [...sources].flatMap(([file, text]) => {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:\/\*+|\*+\/?|\/\/+)\s?/, ""));
      const claimAt = (words: string): boolean => pictureClaimsIn(normalised(words)).length > 0;
      const hits: string[] = [];
      lines.forEach((line, index) => {
        const next = lines[index + 1] ?? "";
        if (claimAt(line) || (!claimAt(next) && claimAt(`${line} ${next}`)))
          hits.push(`${file}:${index + 1} ${JSON.stringify(normalised(line).slice(0, 120))}`);
      });
      return hits;
    });

  it("finds none in any comment either: a comment that quotes the claim is a second copy of it, and ordinary English that only shares a word with it is left alone", () => {
    expect(
      quotedClaims(realSources()),
      "a comment quotes the claim that the picture differs or is softer: reword it",
    ).toEqual([]);
    // what is read in a comment is narrow: the forms that name the picture, not "a softer tone" or "the thumb looks a little wider"
    expect(
      quotedClaims(
        new Map([
          ["a.ts", "// A softer tone of the accent is used for hover states.\nexport const a = 1;"],
          ["b.ts", "/** at the lowest zoom the thumb looks a little wider than its track */"],
          ["c.ts", "// the picture may be slightly softer\nconst c = 1;"],
          ["d.ts", "/** the picture\n *  can differ slightly */"],
        ]),
      ).map((hit) => hit.split(" ")[0]),
    ).toEqual(["c.ts:1", "d.ts:1"]);
  });

  // The assistant's and the MCP's tool text is the JSON of `contract` (the catalog, the schema and the retained snapshot of an earlier release): read as the strings a person reads are, but only for the forms that name the picture.
  it("finds none in the assistant's tool text: no string of the catalog, the schema or the retained snapshot says the picture differs", () => {
    const files = walk(path.join(SRC, "contract")).filter((file) => file.endsWith(".json"));
    expect(files.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(["catalog.json", "timeline.schema.json", "0.21.5.json"]),
    );
    const strings = (value: unknown, where: string): { where: string; text: string }[] =>
      typeof value === "string"
        ? [{ where, text: value }]
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([key, inner]) => strings(inner, `${where}/${key}`))
          : [];
    const texts = files.flatMap((file) =>
      strings(JSON.parse(readFileSync(file, "utf8")), rel(file)),
    );
    // the walk reads the real text: hundreds of strings, among them the export tool's
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.some(({ text }) => /\bexport\b/i.test(text))).toBe(true);
    expect(
      texts
        .filter(({ text }) => pictureClaimsIn(normalised(text)).length > 0)
        .map(({ where }) => where),
    ).toEqual([]);
  });

  it("finds a claim added to the real sources: in a string that something reaches, in one nothing reaches, and in one joined from pieces", () => {
    const edited = new Map(realSources());
    edited.set(
      "timeline/exportWords.ts",
      [
        edited.get("timeline/exportWords.ts") ?? "",
        'export const ADDED_CLAIM = "the picture can differ slightly";',
        'const ADDED_DEAD = "the picture may be slightly softer";',
        'export const ADDED_JOINED = "the picture " + "may be " + "different";',
      ].join("\n"),
    );
    const result = scan(edited);
    expect(
      result.findings
        .filter((f) => claimsIn(f.text).length > 0)
        .map((f) => f.decl)
        .sort(),
    ).toEqual(["ADDED_CLAIM", "ADDED_DEAD"]);
    expect(assembled(result)).toHaveLength(1);
    expect(assembled(result)[0]).toContain("ADDED_JOINED");
  });

  // The words are taken from the code that makes them, not from a list of sentences: a claim a function builds is as visible to a person as one that is written out.
  const CLAIMS = [
    "the picture can differ slightly",
    "The picture may be slightly softer",
    "The picture can look slightly softer.",
    "the picture is smaller and may look slightly softer",
    "The file will be larger and the picture can differ slightly from Full quality.",
    "Fast looks slightly different",
    "the picture will differ slightly",
    "the picture looks different",
    "the picture might be a little softer",
    // the same claim in other words
    "The quality may be slightly lower.",
    "Slightly lower quality than the processor.",
    "Fast softens the picture.",
    "The image can look different.",
    "The video may look different from Quality.",
    "Not identical to the processor's picture.",
    "A little different from what the processor makes.",
    "Some detail may be lost.",
    "The picture is not exactly the same.",
    "The result may not be pixel for pixel identical.",
    "The output is less crisp.",
    "The result looks blurrier.",
    "Quality can differ a little.",
    "Small differences in the picture are possible.",
  ];
  const PLAIN = [
    "Quality",
    "Fast",
    "light compression",
    "graphics chip",
    "Medium",
    "The picture is smaller (720p).",
    "The file is usually larger.",
    "Without the graphics chip, exports are usually slower.",
    "Using your graphics chip to save time",
    "the file is larger",
    "lower the picture size or frame rate",
    "a smaller picture",
    "Switch to another project",
    "the file is usually larger",
    "Cancel",
    "One size smaller, up to 30 frames a second, Low quality.",
    "Typical speed-up; your PC may differ.",
    "Choose a lower quality for a smaller file.",
    "Small file, visible compression",
  ];
  // Ordinary English that shares a word with the claim: the tier a comment and the tool text are read with leaves it alone, the loose tier of the strings a person reads does not (it would be given a row).
  const ORDINARY = [
    "A softer tone of the accent is used for hover states.",
    "the thumb looks a little wider than its track",
  ];
  const wordsOf = (items: readonly string[]) =>
    fc.array(fc.constantFrom(...items), { maxLength: 6 }).map((words) => words.join(". "));

  it("reads every wording of the claim inside any text made of plain words, and nothing plain as a claim", () => {
    const plain = wordsOf(PLAIN);
    fc.assert(
      fc.property(
        plain,
        fc.constantFrom(...CLAIMS),
        plain,
        (before, claim, after) => claimsIn(`${before} ${claim} ${after}`).length > 0,
      ),
    );
    fc.assert(fc.property(plain, (words) => claimsIn(words).length === 0));
    // what a comment and the tool text are read with does not take ordinary English for the claim, and does take the forms that name the picture
    fc.assert(
      fc.property(wordsOf([...PLAIN, ...ORDINARY]), (words) => pictureClaimsIn(words).length === 0),
    );
    for (const claim of [
      "the picture can differ slightly",
      "The picture may be slightly softer",
      "The picture can look slightly softer.",
      "the picture is smaller and may look slightly softer",
      "the picture looks different",
      "The image can look different.",
    ])
      expect(pictureClaimsIn(claim), claim).not.toEqual([]);
  });

  // A pattern that matched nothing any more would leave its words unread without a test going red: each pattern of a tier is held to a sample that it alone catches in that tier.
  const ALONE: Record<string, string> = {
    "the picture can differ": "The video may be worse.",
    "the picture looks different": "The image looks different.",
    "slightly softer": "Fast is slightly softer.",
    "the picture differs": "The picture differs.",
    softer: "It is softer.",
    "differs slightly": "It differs slightly.",
    "looks slightly different": "It looks a little odd.",
    "softens or blurs": "The result is less crisp.",
    "lower quality": "Quality can differ.",
    "detail is lost": "Some detail may be lost.",
    "differences in the picture": "Small differences in the picture are possible.",
    "not the same picture": "The output is not exactly the same.",
  };
  it.each([
    ["that name the picture", PICTURE_CLAIMS],
    ["of the looser tier", LOOSE_CLAIMS],
  ] as const)(
    "holds each of the patterns %s to a sample that only it catches in its tier",
    (_tier, patterns) => {
      for (const { name, pattern } of patterns) {
        const sample = ALONE[name];
        expect(sample, `a sample for "${name}"`).toBeDefined();
        expect(pattern.test(sample), `"${name}" reads its own sample`).toBe(true);
        for (const other of patterns)
          if (other.name !== name)
            expect(
              other.pattern.test(sample),
              `"${other.name}" reads the sample of "${name}"`,
            ).toBe(false);
      }
    },
  );

  function* chipInputs(): Generator<ChipRowInput> {
    for (const found of [false, true])
      for (const pref of ["auto", "off"] as const)
        for (const testing of [false, true])
          for (const verdict of ["passed", "not_passed", "unknown"] as const)
            for (const setAside of [false, true])
              for (const flagsOn of [false, true])
                for (const quickFlagOn of [false, true])
                  for (const sizeServed of [false, true])
                    yield {
                      found,
                      pref,
                      testing,
                      verdict,
                      setAside,
                      flagsOn,
                      quickFlagOn,
                      sizeServed,
                    };
  }

  const modeLines = (): string[] => {
    const out: string[] = [];
    for (const showRow of [true, false])
      for (const defaultMode of ["quality", "fast"] as const)
        for (const reason of REASONS)
          for (const faster of [true, false])
            for (const seconds of [null, 700])
              for (const picked of [null, "quality", "fast"] as const) {
                const view: ModeView = {
                  showRow,
                  defaultMode,
                  reason,
                  faster,
                  fullSeconds: seconds,
                  fastSeconds: seconds === null ? null : 300,
                };
                const lines = describeModeLines(view, picked);
                for (const text of [lines.hint, lines.note, lines.alternative, lines.faster])
                  if (text !== null) out.push(text);
              }
    return out;
  };

  const heldRouteWords = (): string[] => {
    const out: string[] = [];
    for (const route of ["processor", "chip", "faster"] as const)
      for (const bytes of [null, 300_000_000])
        for (const seconds of [null, 600])
          out.push(
            describeFullRow({
              route,
              seconds,
              bytes,
              picture: "1080p",
              fps: 30,
              quality: "medium",
            }),
          );
    for (const encoder of ["chip", "faster", "processor"] as const)
      for (const changedSize of [false, true])
        for (const changedFps of [false, true])
          for (const bytes of [null, 300_000_000]) {
            const quick = {
              seconds: 300,
              bytes,
              picture: "720p",
              fps: 30,
              encoder,
              changedSize,
              changedFps,
            };
            out.push(
              describeQuickRow(quick),
              describeQuickCardLine({ picture: "720p", fps: 30, changedSize }),
            );
            for (const route of ["processor", "chip", "faster"] as const)
              for (const pcClass of PC_CLASSES)
                for (const selected of ROUTE_KINDS)
                  out.push(
                    ...describeRouteQuestion({
                      pcClass,
                      plainTimes: 9,
                      selected,
                      full: { seconds: 900, bytes: null, route },
                      quick,
                    }).lines,
                  );
          }
    for (const pcClass of PC_CLASSES)
      for (const changedSize of [false, true]) {
        const text = describeQuickSelected({
          pcClass,
          plainTimes: 9,
          picture: "720p",
          changedSize,
        });
        if (text !== null) out.push(text);
      }
    return out;
  };

  /** Each surface's words, by name, with a sentence it must contain (so that a list that came out empty is not a pass). */
  const SURFACES: readonly { name: string; texts: () => string[]; has: string }[] = [
    {
      name: "the Graphics chip row: every note of the row, and every note its model gives",
      texts: () => [
        ...Object.values(CHIP_ROW_NOTES),
        ...[...chipInputs()].flatMap((input) => chipRowModel(input).note ?? []),
      ],
      has: "Auto: used on this PC.",
    },
    {
      name: "the new dialog's own words (every entry of its words file)",
      texts: () => [
        ...Object.values(D2_WORDS),
        ...Object.values(RESOLUTION_WORDS),
        ...Object.values(QUALITY_WORDS),
      ],
      has: "To save time, ArtDaddy will use light compression",
    },
    {
      name: "the old dialog's Mode row and its faster-setting line, over every view and pick",
      texts: modeLines,
      has: "To save time, ArtDaddy will use a faster setting",
    },
    {
      name: "the chat card's line, for every encoder and every reason",
      texts: () =>
        EXPORT_ENCODERS.flatMap((encoder) =>
          REASONS.map((reason) => describeEncoder(encoder, reason)),
        ),
      has: "Using light compression to save time",
    },
    {
      name: "the chip's restart words (on the card and to the assistant)",
      texts: () =>
        Object.values(CHIP_RESTART_ROW.words).filter(
          (words): words is string => typeof words === "string",
        ),
      has: "Started again on the processor",
    },
    {
      name: "the hints under the Graphics chip row (an old NVIDIA driver, Intel graphics that may be switched off)",
      texts: () => [
        chipAdvice({
          adapters: [{ maker: "nvidia", driver: "32.0.15.6094", result: "encode_failed" }],
          processor: null,
        })?.text ?? "",
        chipAdvice({
          adapters: [{ maker: "nvidia", driver: "32.0.16.1012", result: "passed" }],
          processor: "Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz",
        })?.text ?? "",
      ],
      has: "graphics driver",
    },
    {
      name: "the held Quick route's words, over every route, encoder, size change and PC class",
      texts: heldRouteWords,
      has: "Quick export",
    },
  ];

  it.each(SURFACES)("$name: no sentence says the picture differs", ({ texts, has }) => {
    const all = texts();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(
      all.some((text) => text.includes(has)),
      `the list holds "${has}"`,
    ).toBe(true);
    expect(
      all.filter((text) => claimsIn(text).length > 0),
      "a sentence the code writes says the picture differs or is softer",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The gates: what the rows say keeps an old name from a person, held where it can be held
// ---------------------------------------------------------------------------------------------------------------------

/** Every property or attribute reading or writing in a file, by a small question over its syntax tree. */
function eachNode(file: string, visit: (node: ts.Node) => void): void {
  const facts = real().facts.get(file);
  if (!facts) throw new Error(`no such shipped file: ${file}`);
  const walkNode = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walkNode);
  };
  walkNode(facts.source);
}

const allFiles = (): string[] => [...real().facts.keys()];

/** `<name>=...` on a JSX element, with the file and the attribute's value as written. */
function jsxAttributes(name: string): string[] {
  const out: string[] = [];
  for (const file of allFiles())
    eachNode(file, (node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === name)
        out.push(`${file} ${normalised(node.initializer?.getText() ?? "")}`);
    });
  return out.sort();
}

/** Object literal properties `name: "value"` anywhere in the shipped sources. */
function propertyValues(name: string, value: string): string[] {
  const out: string[] = [];
  for (const file of allFiles())
    eachNode(file, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === name &&
        ts.isStringLiteralLike(node.initializer) &&
        node.initializer.text === value
      )
        out.push(file);
    });
  return out.sort();
}

/** Reads of `.name` outside the file that defines it. */
function readsOf(names: readonly string[], except: string): string[] {
  const out: string[] = [];
  for (const file of allFiles())
    if (file !== except)
      eachNode(file, (node) => {
        if (ts.isPropertyAccessExpression(node) && names.includes(node.name.text))
          out.push(`${file} .${node.name.text}`);
      });
  return out.sort();
}

const GATES: Record<Gate, () => void> = {
  "legacy-dialog": () => {
    const result = real();
    // The Mode row's words are written by describeModeLines and its hint, which only the 0.28.0 settings block and the new view's look may call; the look reads one line of the result (or nothing).
    expect(
      importersOf(result, "timeline/exportWords.ts", "describeModeLines").filter(
        (file) => file !== "components/ExportDialog.tsx" && file !== "components/useEncoderLook.ts",
      ),
    ).toEqual([]);
    expect(importersOf(result, "timeline/exportWords.ts", "FAST_HINT")).toEqual([]);
    const look: string[] = [];
    eachNode("components/useEncoderLook.ts", (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "lines"
      )
        look.push(node.name.text);
    });
    expect(look.filter((name) => name !== "faster")).toEqual([]);
    // The 0.28.0 sentence about the lighter setting is the new view's too until the view has its own entry: only the words file of the new view may take it.
    expect(
      importersOf(result, "timeline/exportWords.ts", "FASTER_SETTING_LINE").filter(
        (file) => file !== "timeline/exportChoiceWords.ts",
      ),
    ).toEqual([]);
    // The dialog draws the 0.28.0 settings unless it is handed quickRoute.
    let given: string | undefined;
    eachNode("components/ExportDialog.tsx", (node) => {
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "quickRoute" &&
        ts.isObjectBindingPattern(node.parent)
      )
        given = node.initializer?.getText();
    });
    expect(given).toBe("false");
  },
  "no-switch-button": () => {
    expect(quickAvailable()).toBe(false);
    // The one place a handler could come from: the card and the banner only pass a prop on, and the chat view and the dialog give none.
    expect(jsxAttributes("onSwitchToQuick")).toEqual([
      "components/ExportCard.tsx {onSwitchToQuick}",
      "components/ExportHelpBanner.tsx {onSwitchToQuick ? () => onSwitchToQuick(id) : undefined}",
    ]);
  },
  "question-not-built": () => {
    const result = real();
    for (const name of ["questionWords", "questionButtons"])
      expect(importersOf(result, "timeline/exportChoiceWords.ts", name)).toEqual([]);
    expect(
      readsOf(["questionQuicker", "questionOwnSettings"], "timeline/exportChoiceWords.ts"),
    ).toEqual([]);
  },
  "no-restart-switch": () => {
    expect(propertyValues("restarted", "quick")).toEqual([]);
    expect(propertyValues("kind", "switch")).toEqual([]);
  },
  "plain-english": () => undefined,
};

describe("each gate a row names still holds", () => {
  it.each([...new Set(ROWS.map((row) => row.gate))])("%s", (gate) => {
    GATES[gate]();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// What the build says: the real words functions, driven with what the build can give them
// ---------------------------------------------------------------------------------------------------------------------

const REASONS = ["over_minute", "person", "promise_line", "none", "chip_default"] as const;

describe("the words of the reachable surfaces carry none of the old names", () => {
  it("says what an export runs on in the owner's names, for every encoder and every reason the app records", () => {
    // The list above is every reason the report can carry: a word added to the vocabulary without its sentence checked here fails.
    expect([...REASONS].sort()).toEqual([...EXPORT_MODE_REASONS].sort());
    for (const encoder of EXPORT_ENCODERS)
      for (const reason of REASONS) {
        const line = describeEncoder(encoder, reason);
        expect({ encoder, reason, old: retiredIn(line) }).toEqual({ encoder, reason, old: [] });
        expect({ encoder, reason, light: /light compression/.test(line) }).toEqual({
          encoder,
          reason,
          light: encoder === "x264_fast",
        });
      }
  });

  const slow = (): HelpInput => ({
    elapsedSeconds: 600,
    producedFraction: 0.1,
    renderEtaSeconds: null,
    expectedSeconds: 120,
    expectedBasis: "history",
    quickSeconds: 30,
    quietSeconds: 0,
    verdict: "busy",
    canSwitch: quickAvailable(),
    shown: { slowShown: 0, silencedAtProjection: null, quietShown: false },
    flagOn: true,
  });

  it("says nothing of Quick export in the slow-export banner, whichever way it is asked, and draws no Switch button", () => {
    const stopped: HelpInput = {
      ...slow(),
      quietSeconds: 400,
      verdict: "idle",
      producedFraction: 0.5,
    };
    for (const [name, input] of [
      ["slow", slow()],
      ["stopped", stopped],
    ] as const) {
      const view = exportHelp(input);
      expect({ name, kind: view.kind }).toEqual({ name, kind: name === "slow" ? "slow" : "quiet" });
      const said = [...view.lines, ...view.buttons.map((button) => BANNER_BUTTON_LABELS[button])];
      expect(said.length).toBeGreaterThan(1);
      expect({ name, old: said.flatMap(retiredIn) }).toEqual({ name, old: [] });
      expect(view.buttons).not.toContain("switch_to_quick");
    }
  });

  it("says nothing of Quick export in what to lower after a failure, for every reason a failure can have", () => {
    for (const code of EXPORT_REASON_CODES)
      for (const chipFailed of [false, true]) {
        const line = describeLower({ code, chipFailed, quick: quickAvailable() });
        expect({ code, chipFailed, old: retiredIn(line) }).toEqual({ code, chipFailed, old: [] });
      }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The privacy text names the encoder in the owner's words
// ---------------------------------------------------------------------------------------------------------------------
// The installer shows src-tauri/PRIVACY.txt, and it says which encoder made the video. It calls the processor's lighter setting what the dialog calls it, never by an old name: a person who reads both finds one
// name for one thing.

describe("the privacy text names the encoder the way the app does", () => {
  const PRIVACY = normalised(
    readFileSync(path.resolve(SRC, "..", "src-tauri", "PRIVACY.txt"), "utf8"),
  );

  it("says which encoder made the video: your processor, light compression on your processor, or your graphics chip", () => {
    expect(PRIVACY).toContain(
      "which encoder made the video: your processor, light compression on your processor, or your graphics chip, with the chip's maker (AMD, NVIDIA or Intel)",
    );
  });

  it("carries no retired name and no claim about the picture anywhere, and says the lighter setting once, in the dialog's own name", () => {
    expect(retiredIn(PRIVACY)).toEqual([]);
    const name = "light compression";
    // the dialog says it with this name too (the same two words, from the one words file)
    expect(D2_WORDS.lightCompressionLine).toContain(name);
    expect(PRIVACY.split(name)).toHaveLength(2);
  });
});
