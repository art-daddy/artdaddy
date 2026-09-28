import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// HTMLMediaElement.play() returns a promise that REJECTS whenever playback is interrupted (a
// pause, a new source, a hidden tab). `void el.play()` discards the value, not the rejection:
// one user's session logged it 24 times as an unhandled rejection. 99ebcab fixed the two call
// sites that were reported — this walks EVERY call, because fixing one member of a class is
// evidence about that member only.
//
// Typed, not grepped: `audio.play(t)` / `transport.play()` are our own void methods and need no
// handler, and only the checker can tell them from a media element's.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|e2e)\.tsx?$/.test(name) && !name.startsWith("__"))
      out.push(p);
  }
  return out;
}

/** True when the promise this call returns is handled: `.catch(...)`, a two-arg `.then`, or an
 *  `await` inside a `try`. */
function handled(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  for (;;) {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const name = parent.name.text;
      const outer = parent.parent;
      if (name === "catch" && outer && ts.isCallExpression(outer)) return true;
      if (name === "then" && outer && ts.isCallExpression(outer) && outer.arguments.length >= 2)
        return true;
      return false;
    }
    if (ts.isAwaitExpression(parent)) {
      for (let a: ts.Node | undefined = parent; a; a = a.parent) if (ts.isTryStatement(a)) return true;
      return false;
    }
    return false;
  }
}

describe("every media element play() handles its rejection", () => {
  it("has no unhandled HTMLMediaElement.play() anywhere in the app", () => {
    const files = sources(SRC);
    const candidates = files.filter((f) => /\.play\b/.test(readFileSync(f, "utf8")));
    const program = ts.createProgram(candidates, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    });
    const checker = program.getTypeChecker();

    const mediaCalls: string[] = [];
    const unhandled: string[] = [];
    for (const file of candidates) {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "play"
        ) {
          const recv = checker.getNonNullableType(checker.getTypeAtLocation(node.expression.expression));
          const names = (recv.isUnion() ? recv.types : [recv]).map((t) => checker.typeToString(t));
          if (names.some((n) => /^HTML(Media|Video|Audio)Element$/.test(n))) {
            const where = `${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
            mediaCalls.push(where);
            if (!handled(node)) unhandled.push(where);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // Guard the guard: if type resolution silently failed, NOTHING would match and this would
    // pass on an empty list. The two call sites 99ebcab fixed must be found.
    expect(mediaCalls.some((w) => w.includes("SourceMonitor"))).toBe(true);
    expect(mediaCalls.some((w) => w.includes("StagePanel"))).toBe(true);
    expect(unhandled, "play() rejections must be handled (see ignorePlayRejection)").toEqual([]);
  }, 60_000);
});
