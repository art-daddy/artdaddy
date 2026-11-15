// A small, safe evaluator for the arithmetic subset of ffmpeg's expression language that the exporter itself writes (anim.ts `compileAnim`,
// the cover aperture in render.ts, the alpha windows in leanWindows.ts): numbers, the variables T (or t), W, H, X and Y, `+ - * /`, unary minus,
// parentheses and the functions if, lt, lte, gt, gte, between, eq, not, max, min, round, floor, ceil, abs, clip, pow. It evaluates in IEEE doubles in the order ffmpeg's evaluator does, so a
// value computed here is the value ffmpeg's `geq`/`scale` computes for the same T, W and H (that is what lets the lean paths place a mask
// exactly where the per-pixel expression would have), EXCEPT pow(x, 2): ffmpeg calls the C library's pow, which differs from x * x by one unit in the last place on 0.33 percent of
// inputs of its own Windows build (measured: rig\tmp\probe\pow_probe.mjs against 2,000,000 values; EXP-1 of the 16 Nov re-audit found 5 such values in 137,736 compared bit for bit).
// A decision that must hold whatever that last bit is compiles the text again with `powUlps` (-1, +1). There is no `eval` and no `new Function`: the desktop webview may forbid both, and a fix
// that silently never runs is the failure this lane must not ship.
//
// Anything outside the subset (an unknown name or function, a stray token, a missing parenthesis) compiles to `null`, never throws: the caller
// then keeps 0.27.0's recipe for that clip.
export interface LeanEnv {
  /** The frame's time in seconds (pts times the stream's time base). */
  T: number;
  W: number;
  H: number;
  /** The sample's column and row, as in `geq`; 0 when the expression has none. */
  X?: number;
  Y?: number;
}

export type LeanExpr = (env: LeanEnv) => number;

/** The float `ulps` steps above (positive) or below (negative) a number. */
export function stepUlps(x: number, ulps: number): number {
  if (ulps === 0 || !Number.isFinite(x)) return x;
  if (x === 0) return ulps * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigInt64(
    0,
    view.getBigInt64(0) + (x > 0 === ulps > 0 ? 1n : -1n) * BigInt(Math.abs(ulps)),
  );
  return view.getFloat64(0);
}

/** True when the text calls pow: the one function whose last bit is not the same on every ffmpeg (see `compileLeanExpr`). */
export function usesPow(text: string): boolean {
  return /\bpow\(/.test(text);
}

type Token =
  { kind: "num"; value: number } | { kind: "id"; name: string } | { kind: "op"; ch: string };

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(text: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = rest[0];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num) {
      out.push({ kind: "num", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = IDENT.exec(rest);
    if (id) {
      out.push({ kind: "id", name: id[0] });
      i += id[0].length;
      continue;
    }
    if ("()+-*/,".includes(c)) {
      out.push({ kind: "op", ch: c });
      i += 1;
      continue;
    }
    return null;
  }
  return out;
}

/** C's `round`: to the nearest integer, halves away from zero (JavaScript's Math.round rounds halves up, and floor(x + 0.5) is wrong just below .5). */
export function cRound(x: number): number {
  if (!Number.isFinite(x)) return x;
  const whole = Math.trunc(x);
  return Math.abs(x - whole) >= 0.5 ? whole + Math.sign(x) : whole;
}

type Fn = (...args: number[]) => number;
const FUNCTIONS: Record<string, { arity: number; fn: Fn }> = {
  if: { arity: 3, fn: (c, a, b) => (c !== 0 ? a : b) },
  lt: { arity: 2, fn: (a, b) => (a < b ? 1 : 0) },
  lte: { arity: 2, fn: (a, b) => (a <= b ? 1 : 0) },
  gt: { arity: 2, fn: (a, b) => (a > b ? 1 : 0) },
  gte: { arity: 2, fn: (a, b) => (a >= b ? 1 : 0) },
  between: { arity: 3, fn: (x, lo, hi) => (x >= lo && x <= hi ? 1 : 0) },
  eq: { arity: 2, fn: (a, b) => (a === b ? 1 : 0) },
  not: { arity: 1, fn: (x) => (x === 0 ? 1 : 0) },
  max: { arity: 2, fn: (a, b) => (a > b ? a : b) },
  min: { arity: 2, fn: (a, b) => (a > b ? b : a) },
  round: { arity: 1, fn: cRound },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  abs: { arity: 1, fn: Math.abs },
  // libavutil/eval.c: NaN in, or a lower bound above the upper one, gives NaN
  clip: {
    arity: 3,
    fn: (x, lo, hi) =>
      Number.isNaN(x) || Number.isNaN(lo) || Number.isNaN(hi) || lo > hi
        ? NaN
        : x < lo
          ? lo
          : x > hi
            ? hi
            : x,
  },
  pow: { arity: 2, fn: (x, y) => (y === 2 ? x * x : Math.pow(x, y)) },
};

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly powUlps = 0,
  ) {}

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private peekOp(ch: string): boolean {
    const t = this.tokens[this.pos];
    return t !== undefined && t.kind === "op" && t.ch === ch;
  }

  private take(ch: string): boolean {
    if (this.peekOp(ch)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expr(): LeanExpr | null {
    const first = this.term();
    if (!first) return null;
    let left: LeanExpr = first;
    for (;;) {
      const plus = this.peekOp("+");
      if (!plus && !this.peekOp("-")) return left;
      this.pos += 1;
      const right = this.term();
      if (!right) return null;
      const l: LeanExpr = left;
      left = plus ? (e) => l(e) + right(e) : (e) => l(e) - right(e);
    }
  }

  private term(): LeanExpr | null {
    const first = this.unary();
    if (!first) return null;
    let left: LeanExpr = first;
    for (;;) {
      const mul = this.peekOp("*");
      if (!mul && !this.peekOp("/")) return left;
      this.pos += 1;
      const right = this.unary();
      if (!right) return null;
      const l: LeanExpr = left;
      left = mul ? (e) => l(e) * right(e) : (e) => l(e) / right(e);
    }
  }

  private unary(): LeanExpr | null {
    if (this.take("-")) {
      const operand = this.unary();
      return operand ? (e) => -operand(e) : null;
    }
    if (this.take("+")) return this.unary();
    return this.primary();
  }

  private primary(): LeanExpr | null {
    const t = this.tokens[this.pos];
    if (!t) return null;
    if (t.kind === "num") {
      this.pos += 1;
      const v = t.value;
      return () => v;
    }
    if (t.kind === "op") {
      if (t.ch !== "(") return null;
      this.pos += 1;
      const inner = this.expr();
      return inner && this.take(")") ? inner : null;
    }
    this.pos += 1;
    const name = t.name;
    if (this.peekOp("(")) {
      // pow(x, 2) is the C library's, and not always x * x: ffmpeg's own build differs from x * x by one unit in the last place on 0.33 percent of inputs (rig\tmp\probe\pow_probe.mjs, 2,000,000 values),
      // and another platform's build may differ elsewhere. pow(0, 2) and pow(1, 2) are exact everywhere. A caller that must not depend on that last bit compiles the text again with powUlps of -1 and +1.
      const spec =
        name === "pow" && this.powUlps !== 0
          ? {
              arity: 2,
              fn: (x: number, y: number) =>
                y === 2 && x !== 0 && x !== 1
                  ? stepUlps(x * x, this.powUlps)
                  : FUNCTIONS.pow.fn(x, y),
            }
          : FUNCTIONS[name];
      if (!spec) return null;
      this.pos += 1;
      const args: LeanExpr[] = [];
      if (!this.peekOp(")")) {
        for (;;) {
          const a = this.expr();
          if (!a) return null;
          args.push(a);
          if (this.take(",")) continue;
          break;
        }
      }
      if (!this.take(")") || args.length !== spec.arity) return null;
      const fn = spec.fn;
      switch (args.length) {
        case 1: {
          const [a] = args;
          return (e) => fn(a(e));
        }
        case 2: {
          const [a, b] = args;
          return (e) => fn(a(e), b(e));
        }
        default: {
          const [a, b, c] = args;
          return (e) => fn(a(e), b(e), c(e));
        }
      }
    }
    if (name === "T" || name === "t") return (e) => e.T;
    if (name === "W") return (e) => e.W;
    if (name === "H") return (e) => e.H;
    if (name === "X") return (e) => e.X ?? 0;
    if (name === "Y") return (e) => e.Y ?? 0;
    return null;
  }
}

/** Compile an expression text once; evaluate it per frame. null = outside the subset (the caller keeps today's recipe). `powUlps` (default 0: pow(x, 2) is x * x)
 *  moves every pow(x, 2) of the text, x other than 0 and 1, by that many floats: the way to ask what a text would give on an ffmpeg whose pow is a unit off. */
export function compileLeanExpr(text: string, powUlps = 0): LeanExpr | null {
  const tokens = tokenize(text);
  if (!tokens || tokens.length === 0) return null;
  const parser = new Parser(tokens, powUlps);
  const compiled = parser.expr();
  return compiled && parser.atEnd() ? compiled : null;
}
