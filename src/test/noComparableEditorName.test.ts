// The comparable editor is never named: not in code, comments, tests, file names or documents of
// this repository (owner rule, 2026-11-01). Describe what the code does, not who else does it.
//
// This file does not name it either: it keeps the name's length and a salted SHA-256 of it, never
// its letters. Every run of ASCII letters in every file git knows (tracked, or new and not ignored)
// and in every file's path is lower-cased, and each stretch of the name's length in it is hashed and
// compared. So the name is found on its own and inside a longer word (a camelCase identifier, a
// plural, a web address), in any case, in text and binary files alike. A failure names the file and
// the line (the byte, in a binary file; the path with the name masked) and never prints the word.
// Where there is no git checkout (a copied sandbox), the tree is walked instead; an empty tree can
// never pass.
//
// To ban another word, add its length and the hex SHA-256 of SALT followed by the word in lower
// case. Work it out on your own computer and never commit the word:
//   node -e "const w=process.argv[1].toLowerCase();console.log(w.length,require('crypto').createHash('sha256').update('artdaddy/comparable-editor/'+w).digest('hex'))" <word>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

/** A word that must not appear: how many letters it has, and the SHA-256 of SALT + it in lower case. */
interface Term {
  letters: number;
  sha256: string;
}

/** Salted, so the digests below are not in public tables of hashed words. */
const SALT = "artdaddy/comparable-editor/";
/** The comparable editor's name. */
const BANNED: readonly Term[] = [
  { letters: 7, sha256: "adc3c8e9f665fad0edc1c182269621db376775871e26c84ce18abb7615017bcf" },
];
/** A made-up word as long as the name: the matcher is proved on it, here and in this very file. */
const DECOY = "zumbrix";

const ROOT = path.resolve(__dirname, "..", "..");
const SELF = "src/test/noComparableEditorName.test.ts";
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "reports",
  "test-results",
  ".stryker-tmp",
  "binaries",
]);

function digest(word: string): string {
  return createHash("sha256")
    .update(SALT + word)
    .digest("hex");
}

function termFor(word: string): Term {
  return { letters: word.length, sha256: digest(word.toLowerCase()) };
}

/** Finds terms inside runs of ASCII letters (lower-cased), whether a term is the whole run or a part
 *  of a longer one. Each distinct run is hashed once, however often it appears. */
class Matcher {
  private readonly sums = new Map<number, Set<string>>();
  private readonly known = new Map<string, Array<[number, number]>>();
  private readonly runs: string;

  constructor(terms: readonly Term[]) {
    if (!terms.length) throw new Error("no terms to look for");
    for (const { letters, sha256 } of terms) {
      const sums = this.sums.get(letters) ?? new Set<string>();
      sums.add(sha256.toLowerCase());
      this.sums.set(letters, sums);
    }
    this.runs = `[A-Za-z]{${Math.min(...this.sums.keys())},}`;
  }

  /** Each occurrence in `text`: where it starts and how many letters it covers. */
  find(text: string): Array<{ at: number; letters: number }> {
    const found: Array<{ at: number; letters: number }> = [];
    const runs = new RegExp(this.runs, "g");
    for (let run = runs.exec(text); run; run = runs.exec(text))
      for (const [offset, letters] of this.within(run[0].toLowerCase()))
        found.push({ at: run.index + offset, letters });
    return found;
  }

  private within(run: string): Array<[number, number]> {
    let hits = this.known.get(run);
    if (!hits) {
      hits = [];
      for (const [letters, sums] of this.sums)
        for (let i = 0; i + letters <= run.length; i++)
          if (sums.has(digest(run.slice(i, i + letters)))) hits.push([i, letters]);
      this.known.set(run, hits);
    }
    return hits;
  }
}

/** A file's text, and whether it is binary (a NUL byte in its first 8000 bytes, git's own test). A
 *  UTF-16 file with its byte-order mark is decoded as text; anything else is read byte for byte,
 *  which keeps every ASCII letter, and so every offset, where it is in the file. */
function decode(bytes: Buffer): { text: string; binary: boolean } {
  const pairs = (b: Buffer): Buffer => b.subarray(0, b.length - (b.length % 2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: pairs(bytes.subarray(2)).toString("utf16le"), binary: false };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return {
      text: Buffer.from(pairs(bytes.subarray(2)))
        .swap16()
        .toString("utf16le"),
      binary: false,
    };
  return { text: bytes.toString("latin1"), binary: bytes.subarray(0, 8000).includes(0) };
}

function lineOf(text: string, at: number): number {
  let line = 1;
  for (let nl = text.indexOf("\n"); nl !== -1 && nl < at; nl = text.indexOf("\n", nl + 1)) line++;
  return line;
}

/** Where the terms are in one file, the way a person would look for them: "file:line" in a text
 *  file, "file (byte n)" in a binary one, "file (in its path)" for its path, which is shown with
 *  every occurrence masked. Never the word itself. */
function scanFile(matcher: Matcher, file: string, bytes: Buffer | null): string[] {
  const inPath = matcher.find(file);
  const chars = file.split("");
  for (const { at, letters } of inPath) chars.fill("*", at, at + letters);
  const shown = chars.join("");
  const reports = inPath.length ? [`${shown} (in its path)`] : [];
  if (!bytes) return reports;
  const { text, binary } = decode(bytes);
  const places = matcher
    .find(text)
    .map(({ at }) => (binary ? `${shown} (byte ${at})` : `${shown}:${lineOf(text, at)}`));
  return [...reports, ...new Set(places)];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
}

/** A file's bytes on disk, or null when it is not a file there. */
function bytesOf(file: string): Buffer | null {
  const full = path.join(ROOT, file);
  try {
    return statSync(full).isFile() ? readFileSync(full) : null;
  } catch {
    return null; // listed by git but deleted in the working tree
  }
}

function git(args: string[], input = ""): Buffer {
  return execFileSync("git", args, {
    cwd: ROOT,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function listed(...args: string[]): string[] {
  return git(["ls-files", "-z", ...args])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

type Tree = Array<{ file: string; bytes: Buffer | null }>;

/** Every file git knows about (tracked, or new and not ignored) with its bytes; empty where there is
 *  no git checkout. A tracked file the working tree has not changed is read from git's object store,
 *  all of them in one process: on Windows the first open of each file of a fresh checkout is slow
 *  (it is scanned), and reading 1,600 of them one by one took two minutes on a busy computer. The
 *  others (changed or deleted, unmerged, a submodule, new) are read from disk. */
function gitTree(): Tree {
  let index: Array<{ mode: string; oid: string; stage: string; file: string }>;
  try {
    index = listed("-s").map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, oid, stage] = entry.slice(0, tab).split(" ");
      return { mode, oid, stage, file: entry.slice(tab + 1) };
    });
  } catch {
    return []; // no git here
  }
  const changed = new Set(listed("-m"));
  const kept = index.filter((e) => e.stage === "0" && e.mode !== "160000" && !changed.has(e.file));
  const store = git(["cat-file", "--batch"], kept.map((e) => `${e.oid}\n`).join(""));
  const tree: Tree = [];
  let at = 0;
  for (const { oid, file } of kept) {
    const eol = store.indexOf(0x0a, at);
    const [answered, type, size] = store.subarray(at, eol).toString("latin1").split(" ");
    if (answered !== oid) throw new Error(`git cat-file answered ${answered} for ${oid}`);
    at = eol + 1;
    if (type !== "blob") {
      tree.push({ file, bytes: bytesOf(file) }); // not in this clone's store
      continue;
    }
    tree.push({ file, bytes: store.subarray(at, at + Number(size)) });
    at += Number(size) + 1;
  }
  const fromStore = new Set(kept.map((e) => e.file));
  const elsewhere = new Set([
    ...index.map((e) => e.file).filter((f) => !fromStore.has(f)),
    ...listed("--others", "--exclude-standard"),
  ]);
  for (const file of elsewhere) tree.push({ file, bytes: bytesOf(file) });
  return tree;
}

/** The whole repository: what git knows, or every file under the root when there is no git
 *  checkout (a copied sandbox). */
function repoTree(): Tree {
  const tree = gitTree();
  return tree.length ? tree : walk(ROOT).map((file) => ({ file, bytes: bytesOf(file) }));
}

const tree = repoTree();
const files = tree.map((e) => e.file);
const bytesIn = (file: string): Buffer | null => tree.find((e) => e.file === file)?.bytes ?? null;

describe("the comparable editor is never named", () => {
  it("looks at the whole repository, so an empty list cannot pass", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("package.json");
    expect(files).toContain(SELF);
    expect(files.some((f) => f.startsWith("src/tools/"))).toBe(true);
  });

  it("finds a word in every form it is written, and nothing else (the matcher, on a made-up word)", () => {
    const matcher = new Matcher([termFor(DECOY)]);
    const title = DECOY[0].toUpperCase() + DECOY.slice(1);
    const half = Math.floor(DECOY.length / 2);
    for (const sample of [
      DECOY,
      title,
      DECOY.toUpperCase(),
      `like ${title} does`,
      `see ${title}'s grid`,
      `two ${title}s`,
      `${DECOY}Snap`,
      `snap${title}Grid`,
      `SNAP_${DECOY.toUpperCase()}_GRID`,
      `https://www.${DECOY}.com/help`,
      `src/${DECOY}-compat/a.ts`,
      `${DECOY}2`,
    ])
      expect(matcher.find(sample), sample).toHaveLength(1);
    for (const clean of [
      "",
      "the editor",
      DECOY.slice(1),
      DECOY.slice(0, -1),
      `${DECOY.slice(0, half)} ${DECOY.slice(half)}`,
      `${DECOY.slice(0, half)}-${DECOY.slice(half)}`,
      `${DECOY.slice(0, -1)}${DECOY.endsWith("q") ? "x" : "q"}`,
    ])
      expect(matcher.find(clean), clean).toEqual([]);
  });

  it("says where, by file and line, and never prints the word (the report, on a made-up word)", () => {
    const matcher = new Matcher([termFor(DECOY)]);
    const title = DECOY[0].toUpperCase() + DECOY.slice(1);
    const reports = [
      ...scanFile(
        matcher,
        "docs/a.md",
        Buffer.from(`one\r\ntwo\r\nlike ${title} does\r\n${DECOY} and ${DECOY}\r\n`),
      ),
      ...scanFile(matcher, `src/${title}Grid/b.ts`, Buffer.from("const a = 1;\n")),
      ...scanFile(
        matcher,
        "c.png",
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]),
          Buffer.from(`tEXtSoftware ${title}`),
        ]),
      ),
      ...scanFile(
        matcher,
        "d.txt",
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`a\r\nb ${DECOY}\r\n`, "utf16le")]),
      ),
      ...scanFile(matcher, "gone.ts", null),
    ];
    expect(reports).toEqual([
      "docs/a.md:3",
      "docs/a.md:4",
      `src/${"*".repeat(DECOY.length)}Grid/b.ts (in its path)`,
      "c.png (byte 19)",
      "d.txt:2",
    ]);
    expect(reports.join("\n").toLowerCase()).not.toContain(DECOY);
  });

  it("names exactly the lines the word is on, whatever surrounds it (property)", () => {
    const matcher = new Matcher([termFor(DECOY)]);
    const forms = [DECOY, DECOY.toUpperCase(), DECOY[0].toUpperCase() + DECOY.slice(1)];
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 25 }),
        fc.array(fc.record({ line: fc.nat(), at: fc.nat(), form: fc.constantFrom(...forms) }), {
          maxLength: 6,
        }),
        fc.constantFrom("\n", "\r\n"),
        (lines, plants, eol) => {
          const planted = [...lines];
          const on = new Set<number>();
          for (const { line, at, form } of plants) {
            const i = line % planted.length;
            const cut = at % (planted[i].length + 1);
            planted[i] = planted[i].slice(0, cut) + form + planted[i].slice(cut);
            on.add(i + 1);
          }
          expect(scanFile(matcher, "f.txt", Buffer.from(planted.join(eol), "latin1"))).toEqual(
            [...on].sort((a, b) => a - b).map((n) => `f.txt:${n}`),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reads what it claims to: the made-up word in this very file is found on its line", () => {
    const line =
      readFileSync(path.join(ROOT, SELF), "utf8")
        .split("\n")
        .findIndex((l) => l.startsWith("const DECOY = ")) + 1;
    expect(line).toBeGreaterThan(0);
    expect(scanFile(new Matcher([termFor(DECOY)]), SELF, bytesIn(SELF))).toEqual([
      `${SELF}:${line}`,
    ]);
  });

  it("reads each file's own bytes, from git's store or from disk", () => {
    // Git may store a file with LF where the working tree has CRLF: the same lines either way.
    const lines = (b: Buffer | null) => b?.toString("latin1").replace(/\r\n/g, "\n") ?? null;
    for (const file of [SELF, "package.json", "src-tauri/PRIVACY.txt", "src-tauri/icons/icon.png"])
      expect(lines(bytesIn(file)), file).toBe(lines(bytesOf(file)));
  });

  it("is in no file's path, text or bytes", { timeout: 120_000 }, () => {
    const matcher = new Matcher(BANNED);
    const reports = tree.flatMap(({ file, bytes }) => scanFile(matcher, file, bytes));
    expect(tree.filter((e) => e.bytes).length, "files read").toBeGreaterThan(files.length * 0.9);
    expect(reports, "the comparable editor is named here (the word is not printed)").toEqual([]);
  });
});
