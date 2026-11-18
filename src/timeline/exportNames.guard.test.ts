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
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES } from "../api/exportReason";
import { EXPORT_ENCODERS } from "../api/exportVocabulary";
import { retiredIn } from "../test/retiredNames";
import { exportHelp, type HelpInput } from "./exportHelp";
import { describeEncoder } from "./exportWords";
import { describeLower } from "./lowerWords";
import { quickAvailable } from "./quickAvailable";
import { BANNER_BUTTON_LABELS } from "./routeWords";

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
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
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
  return [...(result.uses.get(file) ?? [])]
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

let cached: Scan | null = null;
const real = (): Scan => {
  if (cached) return cached;
  cached = scan(new Map(shippedFiles().map((file) => [rel(file), readFileSync(file, "utf8")])));
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
  {
    file: "mcp/instructions.ts",
    decl: "ASYNC_JOBS",
    gate: "plain-english",
    why: '"it may be quicker" says what a smaller picture, a lower rate or a lower quality may do; it names no choice, and it is the same sentence as the server\'s own tool text',
    text: "it may be quicker, but never promise how much",
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

  it.skipIf(!process.env.NAMES_GUARD_PRINT)("prints the table when asked", () => {
    const lines = real()
      .findings.map((f) => {
        const row = ROWS.find((r) => f.live && sameRow(r, f));
        return `| ${f.file}:${f.line} | ${f.decl} | ${f.live ? "reachable" : "dead"} | ${row ? row.gate : ""} | ${JSON.stringify(f.text)} |`;
      })
      .sort();
    // eslint-disable-next-line no-console
    console.log(`NAMES-TABLE-BEGIN\n${lines.join("\n")}\nNAMES-TABLE-END ${lines.length}`);
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
    // The Mode row's words are written by describeModeLines and its hint, which only the 0.28.0 settings block and the new view's look call; the look reads one line of the result.
    expect(importersOf(result, "timeline/exportWords.ts", "describeModeLines")).toEqual([
      "components/ExportDialog.tsx",
      "components/useEncoderLook.ts",
    ]);
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
    expect(look).toEqual(["faster"]);
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

const REASONS = ["over_minute", "person", "promise_line", "none"] as const;

describe("the words of the reachable surfaces carry none of the old names", () => {
  it("says what an export runs on in the owner's names, for every encoder and every reason the app records", () => {
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
