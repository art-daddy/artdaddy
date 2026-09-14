// Fuzz for dropStrictNulls. strictNulls.test.ts pins the known cases; this pins the
// laws over arbitrary arg shapes, because this function runs on EVERY tool call and a
// bug in it is a bug in all 56 tools at once.
//
// The two failure directions are opposite and equally bad: strip too little and a null
// reaches a handler (Number(null) === 0 -> a 0x0 canvas); strip too much and real data
// silently disappears from the model's request.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { setContract } from ".";
import { dropStrictNulls } from "./clamp";

const TOOL = "fuzz_tool";

beforeAll(() => {
  setContract({
    version: "test",
    tools: [
      {
        name: TOOL,
        parameters: {
          type: "object",
          properties: {
            num: { type: "integer" },
            str: { type: "string" },
            nullable: { type: ["string", "null"] }, // null means something here
            freeform: { type: "object" }, // no declared properties -> model's own data
            nested: {
              type: "object",
              properties: {
                inner: { type: "integer" },
                innerNullable: { type: ["integer", "null"] },
              },
            },
            list: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, opt: { type: "integer" } },
              },
            },
          },
        },
      },
    ],
  });
});

const maybeNull = <T>(g: fc.Arbitrary<T>) => fc.oneof(g, fc.constant(null));
const argsGen = fc.record(
  {
    num: maybeNull(fc.integer()),
    str: maybeNull(fc.string()),
    nullable: maybeNull(fc.string()),
    freeform: maybeNull(
      fc.dictionary(fc.string({ minLength: 1 }), fc.oneof(fc.integer(), fc.constant(null))),
    ),
    nested: maybeNull(
      fc.record(
        { inner: maybeNull(fc.integer()), innerNullable: maybeNull(fc.integer()) },
        {
          requiredKeys: [],
        },
      ),
    ),
    list: fc.array(
      fc.record({ id: maybeNull(fc.string()), opt: maybeNull(fc.integer()) }, { requiredKeys: [] }),
      { maxLength: 4 },
    ),
    undeclared: maybeNull(fc.integer()),
  },
  { requiredKeys: [] },
);

describe("dropStrictNulls (fuzz)", () => {
  it("never changes a value that isn't blank", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        for (const [k, v] of Object.entries(args)) {
          if (v !== null && v !== "" && k !== "nested" && k !== "list") expect(out[k]).toEqual(v);
        }
      }),
    );
  });

  it("only ever removes keys, never adds one", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        for (const k of Object.keys(out)) expect(k in args).toBe(true);
      }),
    );
  });

  it("removes a declared blank and keeps a contract-declared nullable one", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        if (args.num === null) expect("num" in out).toBe(false);
        if (args.str === null || args.str === "") expect("str" in out).toBe(false);
        if (args.nullable === null) expect(out.nullable).toBeNull();
      }),
    );
  });

  it("never touches the inside of a free-form object (that is the model's own data)", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        if (args.freeform && typeof args.freeform === "object")
          expect(out.freeform).toEqual(args.freeform);
      }),
    );
  });

  it("preserves array length and strips inside entries", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        const list = out.list as Record<string, unknown>[] | undefined;
        if (!Array.isArray(args.list)) return;
        expect(list).toHaveLength(args.list.length);
        for (const entry of list ?? []) {
          expect(Object.values(entry).every((v) => v !== null && v !== "")).toBe(true);
        }
      }),
    );
  });

  it("leaves an undeclared key alone so unknownParams can still report it", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        if ("undeclared" in args) expect("undeclared" in out).toBe(true);
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(argsGen, (args) => {
        const once = dropStrictNulls(TOOL, args);
        expect(dropStrictNulls(TOOL, once)).toEqual(once);
      }),
    );
  });

  it("no declared non-nullable param ever survives as a blank", () => {
    // The single law the handlers depend on: what reaches them is a real value or
    // nothing at all — never a placeholder the model emitted to satisfy the schema.
    fc.assert(
      fc.property(argsGen, (args) => {
        const out = dropStrictNulls(TOOL, args) as Record<string, unknown>;
        for (const k of ["num", "str", "nested"]) {
          expect(out[k]).not.toBeNull();
          expect(out[k]).not.toBe("");
        }
      }),
    );
  });
});
