// The closed list of ways the speech-model download fails, and the words that go with each. The
// list is a contract (the words a card shows, the reasons a local record keeps), so it is written
// out here independently: a kind added or removed is a decision, not an accident.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isModelFailureKind,
  kindOfHttpStatus,
  MODEL_FAILURE_KINDS,
  MODEL_FAILURE_WORDS,
  type ModelFailureKind,
} from "./modelFailure";

const CLOSED: readonly string[] = [
  "network",
  "stalled",
  "server_busy",
  "server_refused",
  "size_mismatch",
  "damaged",
  "incomplete",
  "cannot_resume",
  "disk_write",
  "cannot_stream",
  "unknown",
];
const IS_CLOSED = new Set(CLOSED);

describe("the closed list of kinds", () => {
  it("is exactly the agreed list, each kind once", () => {
    expect(new Set(MODEL_FAILURE_KINDS).size).toBe(MODEL_FAILURE_KINDS.length);
    expect([...MODEL_FAILURE_KINDS].sort()).toEqual([...CLOSED].sort());
  });

  it("has words for every kind and for nothing else, checked in both directions", () => {
    for (const kind of MODEL_FAILURE_KINDS) {
      const words = MODEL_FAILURE_WORDS[kind];
      expect(typeof words, `${kind} has no words`).toBe("string");
      expect(words.trim().length, `${kind} has empty words`).toBeGreaterThan(0);
    }
    for (const key of Object.keys(MODEL_FAILURE_WORDS)) {
      expect(IS_CLOSED.has(key), `"${key}" has words but is not a listed kind`).toBe(true);
    }
  });
});

// What plain words never contain: a protocol, a hashing term, or the app's own plumbing.
const JARGON: ReadonlyArray<[string, RegExp]> = [
  ["HTTP", /\bhttps?\b/i],
  ["checksum", /checksum/i],
  ["SHA", /\bsha[-\d]*\b/i],
  ["mirror", /mirror/i],
  ["origin", /origin/i],
  ["socket", /socket/i],
  ["TLS", /\btls\b/i],
  ["DNS", /\bdns\b/i],
  ["undefined", /undefined/i],
  ["a template leak", /\$\{|\[object|\bnull\b|\bNaN\b/],
];
// The card says whether the app will try again. The words never promise it.
const PROMISE = /\b(will|again|retry|retrying|soon|automatically|please|try)\b/i;

const jargonIn = (text: string): string[] =>
  JARGON.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

describe("the words", () => {
  const entries = Object.entries(MODEL_FAILURE_WORDS) as Array<[ModelFailureKind, string]>;

  it.each(entries)("%s: says what went wrong in a short, plain sentence", (kind, text) => {
    expect(text.length, kind).toBeLessThanOrEqual(120);
    expect(text.endsWith("."), `${kind} must end with a full stop`).toBe(true);
    expect(text, kind).toBe(text.trim());
    expect(text, kind).toMatch(/^[A-Z]/);
    expect(text, kind).not.toMatch(/\s{2,}/);
    expect(text, `${kind} leaks an identifier`).not.toMatch(/\w_\w/);
    expect(jargonIn(text), `${kind} uses jargon`).toEqual([]);
    expect(PROMISE.test(text), `${kind} promises something`).toBe(false);
  });

  it("gives no two kinds the same words, or a person could not tell them apart", () => {
    const texts = entries.map(([, text]) => text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  // A check that cannot fail proves nothing: each is shown to fire on a text that breaks it.
  it.each<[string, string]>([
    ["HTTP", "The site answered HTTP 503."],
    ["HTTP", "Could not reach https://example.test."],
    ["checksum", "The checksum did not match."],
    ["SHA", "The SHA-256 did not match."],
    ["mirror", "Every mirror failed."],
    ["origin", "The origin refused the request."],
    ["socket", "The socket closed."],
    ["TLS", "The TLS handshake failed."],
    ["DNS", "The DNS lookup failed."],
    ["undefined", "The download failed: undefined"],
    ["a template leak", "The download failed: [object Object]"],
  ])("the jargon check catches %s", (name, text) => {
    expect(jargonIn(text)).toContain(name);
  });

  it("does not raise a false alarm on a word that only contains a jargon term", () => {
    expect(jargonIn("The file was not shared.")).toEqual([]);
    expect(jargonIn("The download site was not reached.")).toEqual([]);
  });

  it.each(["It will try again.", "Please wait.", "We will retry soon.", "Trying automatically."])(
    "the promise check catches %j",
    (text) => {
      expect(PROMISE.test(text)).toBe(true);
    },
  );
});

describe("kindOfHttpStatus", () => {
  // Built from a set rather than comparisons, so it is not the code's own arithmetic again.
  const WORTH_WAITING = new Set<number>([408, 429]);
  for (let status = 500; status <= 599; status++) WORTH_WAITING.add(status);
  const expected = (status: number) =>
    WORTH_WAITING.has(status) ? "server_busy" : "server_refused";

  it("waits for a busy site: every 5xx, 408 and 429, and for nothing else from 100 to 599", () => {
    for (let status = 100; status <= 599; status++)
      expect(kindOfHttpStatus(status), String(status)).toBe(expected(status));
  });

  it.each([408, 429, 500, 501, 502, 503, 504, 507, 511, 599])("%i is a busy site", (status) => {
    expect(kindOfHttpStatus(status)).toBe("server_busy");
  });

  it.each([100, 200, 206, 301, 304, 400, 401, 403, 404, 405, 410, 416, 418, 451, 499])(
    "%i is a site that said no",
    (status) => {
      expect(kindOfHttpStatus(status)).toBe("server_refused");
    },
  );

  it("gives every number outside the real statuses, and every one that is not a whole number, a no", () => {
    const outside = [
      0,
      -1,
      -503,
      99,
      600,
      999,
      1000,
      503.5,
      429.5,
      408.01,
      499.99,
      NaN,
      Infinity,
      -Infinity,
    ];
    for (const status of outside)
      expect(kindOfHttpStatus(status), String(status)).toBe("server_refused");
  });

  it("agrees with the rule for any number, and always names a listed kind that has words", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: -2000, max: 10_000 }), fc.double(), fc.constantFrom(NaN, -0, 0)),
        (status) => {
          const kind = kindOfHttpStatus(status);
          expect(kind).toBe(expected(status));
          expect(IS_CLOSED.has(kind)).toBe(true);
          expect(MODEL_FAILURE_WORDS[kind].length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("isModelFailureKind", () => {
  const nearMisses = fc
    .tuple(
      fc.constantFrom(...CLOSED),
      fc.constantFrom<(kind: string) => string>(
        (kind) => kind.toUpperCase(),
        (kind) => `${kind[0].toUpperCase()}${kind.slice(1)}`,
        (kind) => ` ${kind}`,
        (kind) => `${kind} `,
        (kind) => `${kind}\n`,
        (kind) => kind.slice(1),
        (kind) => kind.slice(0, -1),
        (kind) => `${kind}x`,
        (kind) => kind.replace("_", "-"),
        (kind) => kind.replace("_", " "),
      ),
    )
    .map(([kind, change]) => change(kind));

  const anything = fc.anything({
    withBigInt: true,
    withBoxedValues: true,
    withDate: true,
    withMap: true,
    withNullPrototype: true,
    withObjectString: true,
    withSet: true,
    withSparseArray: true,
    withTypedArray: true,
  });

  it("accepts every listed kind", () => {
    for (const kind of CLOSED) expect(isModelFailureKind(kind), kind).toBe(true);
  });

  it("accepts exactly the closed list, out of anything it is given", () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        fc.oneof(anything, fc.string(), fc.constantFrom(...CLOSED), nearMisses),
        (value) => {
          const listed = typeof value === "string" && IS_CLOSED.has(value);
          expect(isModelFailureKind(value)).toBe(listed);
          if (listed) accepted++;
        },
      ),
      { numRuns: 500 },
    );
    expect(accepted, "the generator must reach the accepting side").toBeGreaterThan(0);
  });

  it.each<[string, unknown]>([
    ["an inherited property name", "constructor"],
    ["the prototype name", "__proto__"],
    ["a method name", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["an array method", "push"],
    ["an array index", "0"],
    ["a boxed string of a kind", new String("network")],
    ["a list holding a kind", ["network"]],
    ["an object that prints as a kind", { toString: () => "network" }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
  ])("refuses %s", (_what, value) => {
    expect(isModelFailureKind(value)).toBe(false);
  });

  it("narrows what it accepts, so words can be looked up without a cast", () => {
    const value: unknown = "stalled";
    const words = isModelFailureKind(value) ? MODEL_FAILURE_WORDS[value] : undefined;
    expect(words).toBe("The download stopped receiving data.");
  });
});
