// The model is never told the name of a file inside the project that it has no tool to read.
//
// It went looking. In a month `read_file` was called 27 times and 19 of them guessed at a file (a
// `timeline.json`, a `transcript.json`, a script, a brief), after tool text that named one ("Author +
// register `timeline_json` first", "referenced by timeline.json") and error text that did
// ("timeline.json not found - author it first"). A name in text the model reads is an invitation, so
// there is none: the project's data has a tool each, and the files behind them are the editor's own.
//
// Two walks. The contract is exact: every description of every tool and parameter, withdrawn or not.
// The source is a heuristic: a string literal with a space in it (a sentence, not a path component)
// that names an internal file, next to an error / message / note / hint key. Each is paired with a
// control that must fail, so neither can pass by looking at nothing.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { toolDefinitions, type ParamSchema } from ".";

/** The editor's own files, by the names the model has guessed or been shown. */
const INTERNAL_NAME =
  /(timeline\.json|timeline_json|library\.json|project\.json|transcript\.json|history\.json|internals\/)/i;

function* descriptions(schema: ParamSchema | undefined, at: string): Generator<[string, string]> {
  if (!schema) return;
  const d = (schema as { description?: unknown }).description;
  if (typeof d === "string") yield [at, d];
  for (const [k, v] of Object.entries(schema.properties ?? {}))
    yield* descriptions(v, `${at}.${k}`);
  if (schema.items) yield* descriptions(schema.items, `${at}[]`);
}

/** Every piece of tool text the contract serves, with where it is. */
function contractText(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const t of toolDefinitions()) {
    if (t.description) out.push([t.name, t.description]);
    out.push(...descriptions(t.parameters, t.name));
    if (t.text_variant) {
      out.push([`${t.name} (text variant)`, t.text_variant.description]);
      out.push(...descriptions(t.text_variant.parameters, `${t.name} (text variant)`));
    }
  }
  return out;
}

describe("tool descriptions name no internal file", () => {
  it("walks every tool, every parameter and every text variant the contract has", () => {
    const text = contractText();
    expect(text.length).toBeGreaterThan(400);
    expect(new Set(text.map(([at]) => at.split(/[ .[]/)[0])).size).toBeGreaterThanOrEqual(60);
  });

  it("none of them does", () => {
    const found = contractText()
      .map(([at, d]) => [at, INTERNAL_NAME.exec(d)?.[0]] as const)
      .filter(([, hit]) => hit)
      .map(([at, hit]) => `${at}: ${hit}`);
    expect(found).toEqual([]);
  });

  // The control: the same walk finds a name when one is there, whichever of the names it is.
  it("would find one", () => {
    const planted = ["export", "Author + register `timeline_json` first."] as const;
    expect(INTERNAL_NAME.exec(planted[1])?.[0]).toBe("timeline_json");
    expect(INTERNAL_NAME.exec("referenced by timeline.json (pass force=true)")?.[0]).toBe(
      "timeline.json",
    );
    expect(INTERNAL_NAME.exec("a file under internals/cache/ffmpeg")?.[0]).toBe("internals/");
    expect(INTERNAL_NAME.exec("get_timeline, get_transcript, library_op")).toBeNull();
  });

  it("knows every file the model has been shown or has guessed at", () => {
    for (const name of [
      "timeline.json",
      "timeline_json",
      "library.json",
      "project.json",
      "transcript.json",
      "history.json",
      "internals/",
    ])
      expect(INTERNAL_NAME.exec(`read ${name.toUpperCase()} for it`)?.[0], name).toBe(
        name.toUpperCase(),
      );
  });
});

/** Error-like words: a key, an Error constructor, a throw. */
const KEY =
  /\b(error|message|note|notes|hint|warning|warnings|reason)\b\s*[:=(]|new (Op)?Error\(|throw new/i;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, "$1");
}

/** `line: text` of every sentence-like string literal that names an internal file, within three
 *  lines of an error-like key. A path component ("project.json" in a joinPath) has no space. */
function sentencesNamingInternalFiles(source: string): string[] {
  const lines = stripComments(source).split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const window = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
    if (!KEY.test(window)) return;
    for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*?)\1/g)) {
      if (/\s/.test(m[2]) && INTERNAL_NAME.test(m[2])) {
        out.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
        break;
      }
    }
  });
  return out;
}

const SRC = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["eval", "test", "node_modules"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|e2e|smoke\.e2e)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("error text names no internal file", () => {
  it("walks the source", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(300);
  });

  it("none of it does", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const hit of sentencesNamingInternalFiles(readFileSync(file, "utf8")))
        found.push(`${path.relative(SRC, file).replace(/\\/g, "/")}:${hit}`);
    }
    expect(found).toEqual([]);
  });

  // The controls: the scan finds what the old code said, and passes what is fine.
  it("would find the old wording", () => {
    for (const bad of [
      "return { ok: false, error: `timeline.json not found - author it first (${String(e)})` };",
      'throw new Error("could not create timeline.json - the project was closed");',
      "throw new Error(\n  `timeline.json is malformed; refusing to overwrite it - ${why}`,\n);",
      'return { ok: false, error: "timeline.json is not a timeline object; bootstrap the timeline first." };',
    ])
      expect(sentencesNamingInternalFiles(bad), bad).toHaveLength(1);
  });

  it("passes a path component, a comment and a sentence that names none", () => {
    for (const fine of [
      'const p = joinPath(dir, INTERNAL_DIR, "timeline.json"); // throw new Error("x")',
      "// error: timeline.json is not a timeline object\nconst x = 1;",
      "/* the error is timeline.json not found */ const y = 2;",
      'return { ok: false, error: "the project\'s timeline could not be read (it is damaged)." };',
      'const s = "timeline.json is where it lives";',
    ])
      expect(sentencesNamingInternalFiles(fine), fine).toEqual([]);
  });
});
