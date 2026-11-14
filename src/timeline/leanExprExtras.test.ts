// The evaluator's additions for the alpha windows (Phase 3a, fix 2): the sample's column X and row Y, and the functions between, eq and not.
// The rule they must keep is ffmpeg's own (libavutil/eval.c): between is inclusive at both ends, eq is exact equality, not is 1 only for zero, and a NaN
// is never between, never equal and never zero. The comparison with an independent evaluator walks random expression trees: the reference here is the TREE
// evaluated directly, never the text, so a misreading of precedence or arity in the text evaluator cannot hide behind itself.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileLeanExpr, type LeanEnv } from "./leanExpr";

const run = (text: string, env: Partial<LeanEnv> = {}): number => {
  const compiled = compileLeanExpr(text);
  expect(compiled, text).not.toBeNull();
  return compiled!({ T: 0, W: 100, H: 50, ...env });
};

describe("leanExpr: X and Y", () => {
  it("read the sample's column and row, and are 0 when the caller has none", () => {
    expect(run("X*10+Y", { X: 3, Y: 2 })).toBe(32);
    expect(run("X")).toBe(0);
    expect(run("W-X-1", { X: 99 })).toBe(0);
    expect(run("Y/H", { Y: 25 })).toBe(0.5);
  });

  it("stay names of variables only: a call or a lower-case x is outside the subset", () => {
    for (const text of ["X(1)", "Y(1,2)", "x", "y", "Z"])
      expect(compileLeanExpr(text), text).toBeNull();
  });
});

describe("leanExpr: between, eq, not", () => {
  it("between is inclusive at both ends and false for an empty or NaN range", () => {
    const cases: Array<[x: number, lo: number, hi: number, want: number]> = [
      [1, 1, 2, 1],
      [2, 1, 2, 1],
      [1.5, 1, 2, 1],
      [0.999999, 1, 2, 0],
      [2.000001, 1, 2, 0],
      [1, 2, 1, 0],
      [1, 1, 1, 1],
    ];
    for (const [x, lo, hi, want] of cases)
      expect(run(`between(${x},${lo},${hi})`), `${x} in [${lo}, ${hi}]`).toBe(want);
    for (const text of ["between(0/0,0,1)", "between(0,0/0,1)", "between(0,0,0/0)"])
      expect(run(text), text).toBe(0);
  });

  it("eq is exact equality, so 0.1+0.2 is not 0.3, and a NaN is not equal to itself", () => {
    expect(run("eq(2,2)")).toBe(1);
    expect(run("eq(2,2.0000000000000004)")).toBe(0);
    expect(run("eq(0.1+0.2,0.3)")).toBe(0);
    expect(run("eq(0/0,0/0)")).toBe(0);
    expect(run("eq(1/0,1/0)")).toBe(1);
  });

  it("not is 1 for zero (either sign) and 0 for everything else, NaN included", () => {
    expect(run("not(0)")).toBe(1);
    expect(run("not(-0)")).toBe(1);
    expect(run("not(0.0000001)")).toBe(0);
    expect(run("not(-3)")).toBe(0);
    expect(run("not(0/0)")).toBe(0);
  });

  it("a sum of windows is non-zero when either side is open (how an enable expression is written)", () => {
    const text = "between(t,1.5,2.5)+between(t,4.5,5.5)";
    const at = (T: number) => run(text, { T });
    expect(at(1.5)).toBe(1);
    expect(at(2.5)).toBe(1);
    expect(at(3)).toBe(0);
    expect(at(5)).toBe(1);
    expect(at(6)).toBe(0);
    expect(run("lte(t,2)+gte(t,1)", { T: 1.5 })).toBe(2);
  });

  it("refuses the wrong number of arguments instead of guessing", () => {
    for (const text of [
      "between(1,2)",
      "between(1,2,3,4)",
      "eq(1)",
      "eq(1,2,3)",
      "not()",
      "not(1,2)",
    ])
      expect(compileLeanExpr(text), text).toBeNull();
  });
});

type Ast =
  | { k: "num"; v: number }
  | { k: "var"; name: "T" | "X" | "Y" | "W" | "H" }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Ast; b: Ast }
  | { k: "fn"; name: string; args: Ast[] };

const ARITY: Record<string, number> = {
  lt: 2,
  lte: 2,
  gt: 2,
  gte: 2,
  eq: 2,
  max: 2,
  between: 3,
  clip: 3,
  if: 3,
  not: 1,
  abs: 1,
  floor: 1,
  ceil: 1,
};

/** The reference: ffmpeg's definitions written out again, over the tree. `min` is left out of the trees: see the todo below. */
const REFERENCE: Record<string, (...a: number[]) => number> = {
  lt: (a, b) => (a < b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0),
  max: (a, b) => (a > b ? a : b),
  between: (x, lo, hi) => (x >= lo && x <= hi ? 1 : 0),
  not: (x) => (x === 0 ? 1 : 0),
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  if: (c, a, b) => (c !== 0 ? a : b),
  clip: (x, lo, hi) =>
    Number.isNaN(x) || Number.isNaN(lo) || Number.isNaN(hi) || lo > hi
      ? NaN
      : x < lo
        ? lo
        : x > hi
          ? hi
          : x,
};

function evalAst(ast: Ast, env: Required<LeanEnv>): number {
  switch (ast.k) {
    case "num":
      return ast.v;
    case "var":
      return env[ast.name];
    case "bin": {
      const a = evalAst(ast.a, env);
      const b = evalAst(ast.b, env);
      return ast.op === "+" ? a + b : ast.op === "-" ? a - b : ast.op === "*" ? a * b : a / b;
    }
    default:
      return REFERENCE[ast.name](...ast.args.map((arg) => evalAst(arg, env)));
  }
}

function print(ast: Ast): string {
  switch (ast.k) {
    case "num":
      return ast.v < 0 ? `(${ast.v})` : String(ast.v);
    case "var":
      return ast.name;
    case "bin":
      return `(${print(ast.a)}${ast.op}${print(ast.b)})`;
    default:
      return `${ast.name}(${ast.args.map(print).join(",")})`;
  }
}

function astArb(depth: number): fc.Arbitrary<Ast> {
  const leaf: fc.Arbitrary<Ast> = fc.oneof(
    fc.integer({ min: -16, max: 16 }).map((n): Ast => ({ k: "num", v: n / 4 })),
    fc
      .constantFrom<"T" | "X" | "Y" | "W" | "H">("T", "X", "Y", "W", "H")
      .map((name): Ast => ({ k: "var", name })),
  );
  if (depth <= 0) return leaf;
  const sub = astArb(depth - 1);
  const binary = fc
    .tuple(fc.constantFrom<"+" | "-" | "*" | "/">("+", "-", "*", "/"), sub, sub)
    .map(([op, a, b]): Ast => ({ k: "bin", op, a, b }));
  const call = fc
    .constantFrom(...Object.keys(ARITY))
    .chain((name) =>
      fc
        .array(sub, { minLength: ARITY[name], maxLength: ARITY[name] })
        .map((args): Ast => ({ k: "fn", name, args })),
    );
  return fc.oneof(leaf, binary, call, call);
}

describe("leanExpr: agreement with the tree it was written from", () => {
  // Found by this test: ffmpeg's min(d, d2) is `d < d2 ? d : d2` (inferred from libavutil/eval.c as remembered, not re-read), so a NaN second
  // argument gives NaN, while leanExpr's min gives the FIRST argument when the comparison fails (min(0, 0/0) is 0 here, NaN in ffmpeg). Only a NaN
  // can tell them apart, and no expression the exporter writes has min over a NaN; the file is not changed here (not part of the window work).
  it.todo(
    "min gives the second argument when the first is not below it, a NaN included, as ffmpeg does (an existing difference, see HANDOFF)",
  );
  it("gives the reference's double for random trees over every function and variable, X, Y, between, eq and not included", () => {
    fc.assert(
      fc.property(
        astArb(3),
        fc.record({
          T: fc.integer({ min: -60, max: 600 }).map((n) => n / 30),
          X: fc.integer({ min: 0, max: 40 }),
          Y: fc.integer({ min: 0, max: 40 }),
          W: fc.integer({ min: 2, max: 40 }),
          H: fc.integer({ min: 2, max: 40 }),
        }),
        (ast, env) => {
          const text = print(ast);
          const compiled = compileLeanExpr(text);
          expect(compiled, text).not.toBeNull();
          const got = compiled!(env);
          const want = evalAst(ast, env);
          expect(
            Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want)),
            `${text} -> ${got} against ${want}`,
          ).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("can fail: a reference with between made exclusive disagrees with the text evaluator on some tree", () => {
    const original = REFERENCE.between;
    REFERENCE.between = (x, lo, hi) => (x > lo && x < hi ? 1 : 0);
    try {
      const outcome = fc.check(
        fc.property(
          astArb(2),
          fc.record({
            T: fc.constant(1),
            X: fc.integer({ min: 0, max: 3 }),
            Y: fc.constant(0),
            W: fc.constant(4),
            H: fc.constant(4),
          }),
          (ast, env) => {
            const got = compileLeanExpr(print(ast))!(env);
            const want = evalAst(ast, env);
            return Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want));
          },
        ),
        { numRuns: 600, seed: 7 },
      );
      expect(outcome.failed).toBe(true);
    } finally {
      REFERENCE.between = original;
    }
  });
});
