// A small, safe evaluator for the arithmetic subset of ffmpeg's expression language that the exporter itself writes (anim.ts `compileAnim`,
// the cover aperture in render.ts): numbers, the variables T (or t), W and H, `+ - * /`, unary minus, parentheses and the functions
// if, lt, lte, gt, gte, max, min, round, floor, ceil, abs, clip, pow. It evaluates in IEEE doubles in the order ffmpeg's evaluator does, so a
// value computed here is the value ffmpeg's `geq`/`scale` computes for the same T, W and H (that is what lets the lean paths place a mask
// exactly where the per-pixel expression would have). There is no `eval` and no `new Function`: the desktop webview may forbid both, and a fix
// that silently never runs is the failure this lane must not ship.
//
// Anything outside the subset (an unknown name or function, a stray token, a missing parenthesis) compiles to `null`, never throws: the caller
// then keeps 0.27.0's recipe for that clip.
export interface LeanEnv {
  /** The frame's time in seconds (pts times the stream's time base). */
  T: number;
  W: number;
  H: number;
}

export type LeanExpr = (env: LeanEnv) => number;

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
  constructor(private readonly tokens: Token[]) {}

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
      const spec = FUNCTIONS[name];
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
    return null;
  }
}

/** Compile an expression text once; evaluate it per frame. null = outside the subset (the caller keeps today's recipe). */
export function compileLeanExpr(text: string): LeanExpr | null {
  const tokens = tokenize(text);
  if (!tokens || tokens.length === 0) return null;
  const parser = new Parser(tokens);
  const compiled = parser.expr();
  return compiled && parser.atEnd() ? compiled : null;
}
