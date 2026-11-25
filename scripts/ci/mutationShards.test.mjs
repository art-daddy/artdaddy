import { describe, expect, it } from "vitest";

import base from "../../stryker.config.mjs";
import { SHARDS, SHARD_NAMES, shardMutate } from "../../stryker.ci.mjs";

const positive = (list) => list.filter((glob) => !glob.startsWith("!"));
const negative = (list) => list.filter((glob) => glob.startsWith("!"));

describe("the mutation shards (stryker.ci.mjs)", () => {
  it("take every glob of the scope exactly once", () => {
    const taken = SHARD_NAMES.flatMap((name) => positive(shardMutate(base.mutate, name)));
    expect(taken.slice().sort()).toEqual(positive(base.mutate).slice().sort());
    expect(new Set(taken).size).toBe(taken.length);
  });

  it("each carry every exclusion, and none is empty", () => {
    for (const name of SHARD_NAMES) {
      const list = shardMutate(base.mutate, name);
      expect(negative(list), name).toEqual(negative(base.mutate));
      expect(positive(list).length, `${name} must have something to mutate`).toBeGreaterThan(0);
    }
  });

  it("put a glob added to the scope in a shard without anyone editing the shards", () => {
    const grown = [...base.mutate, "src/timeline/brandNew.ts", "src/somewhereElse/**/*.ts"];
    expect(shardMutate(grown, "timeline")).toContain("src/timeline/brandNew.ts");
    expect(shardMutate(grown, "rest")).toContain("src/somewhereElse/**/*.ts");
    expect(shardMutate(grown, "tools")).not.toContain("src/somewhereElse/**/*.ts");
    const taken = SHARD_NAMES.flatMap((name) => positive(shardMutate(grown, name)));
    expect(taken.slice().sort()).toEqual(positive(grown).slice().sort());
  });

  it("keep the timeline and the tools apart from each other and from the rest", () => {
    expect(positive(shardMutate(base.mutate, "timeline")).every(SHARDS.timeline)).toBe(true);
    expect(positive(shardMutate(base.mutate, "tools")).every(SHARDS.tools)).toBe(true);
    const rest = positive(shardMutate(base.mutate, "rest"));
    expect(rest.some(SHARDS.timeline) || rest.some(SHARDS.tools)).toBe(false);
  });

  it("refuse a shard name that does not exist, so a typo cannot mutate nothing and look fine", () => {
    expect(() => shardMutate(base.mutate, "tool")).toThrow(/not one of/);
    expect(() => shardMutate(base.mutate, "")).toThrow(/not one of/);
  });
});
