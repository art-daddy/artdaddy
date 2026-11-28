// One export across attempts: the rules of a chain, the one automatic restart, the gap in which a Cancel has to win, and the
// walk over every function that takes a job id. The registry is pure, so each case is an outcome of a call and of the calls
// after it.
import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import ts from "typescript";
import { assert, beforeEach, describe, expect, it } from "vitest";

import type { ExportStarter } from "../api/exportVocabulary";
import {
  ID_ENTRY_POINTS,
  MAX_ATTEMPTS,
  attempts,
  createAttemptRegistry,
  type AttemptRegistry,
  type AttemptSnapshot,
  type LinkKind,
  type LinkMeta,
  type LinkRefusal,
  type LinkResult,
} from "./exportAttempts";

const OK: LinkResult = { ok: true };
const refusal = (why: LinkRefusal): LinkResult => ({ ok: false, why });

beforeEach(() => attempts.reset());

/** `registry` with the chain `ids` added, joined by `kinds` (switch links where none is given), started by `startedBy`. */
function extend(
  registry: AttemptRegistry,
  ids: string[],
  kinds: LinkKind[] = [],
  startedBy: ExportStarter = "elsewhere",
): AttemptRegistry {
  registry.begin(ids[0], startedBy);
  ids.slice(1).forEach((id, index) => {
    expect(registry.link(ids[index], id, kinds[index] ?? "switch"), `linking ${id}`).toEqual(OK);
  });
  return registry;
}
const build = (
  ids: string[],
  kinds: LinkKind[] = [],
  startedBy: ExportStarter = "elsewhere",
): AttemptRegistry => extend(createAttemptRegistry(), ids, kinds, startedBy);

describe("every id of a chain resolves to the live attempt", () => {
  it("answers alike for the public id, a middle attempt and the last one", () => {
    const registry = build(["a", "b", "c", "d"], ["auto", "switch", "switch"]);
    ["a", "b", "c", "d"].forEach((id, index) => {
      expect(registry.current(id), id).toBe("d");
      expect(registry.publicId(id), id).toBe("a");
      expect(registry.attemptNumber(id), id).toBe(index + 1);
      expect(registry.chainOf(id), id).toEqual(["a", "b", "c", "d"]);
      expect(registry.isSuperseded(id), id).toBe(id !== "d");
      expect(registry.autoRestartsUsed(id), id).toBe(1);
    });
  });

  it("leaves an id it does not know as itself, with nothing pending and nothing used", () => {
    const registry = build(["a", "b"]);
    const before = registry.snapshot();
    expect(registry.current("x")).toBe("x");
    expect(registry.publicId("x")).toBe("x");
    expect(registry.attemptNumber("x")).toBe(1);
    expect(registry.chainOf("x")).toEqual(["x"]);
    expect(registry.isSuperseded("x")).toBe(false);
    expect(registry.autoRestartsUsed("x")).toBe(0);
    expect(registry.hasPending("x")).toBe(false);
    expect(registry.isPendingCancelled("x")).toBe(false);
    expect(registry.describe("x")).toStrictEqual({
      publicId: "x",
      current: "x",
      attempt: 1,
      superseded: false,
    });
    expect(registry.snapshot()).toEqual(before);
  });

  it("keeps one registry apart from another and from the app's own", () => {
    const one = build(["a", "b"]);
    const other = createAttemptRegistry();
    expect(one.current("a")).toBe("b");
    expect(other.current("a")).toBe("a");
    expect(other.snapshot()).toEqual({ chains: [] });
    expect(attempts.current("a")).toBe("a");
  });

  it("hands out copies, so a caller cannot rewrite a chain", () => {
    const registry = build(["a", "b"]);
    registry.chainOf("a").push("z");
    registry.snapshot().chains[0].ids.push("z");
    expect(registry.chainOf("a")).toEqual(["a", "b"]);
    expect(registry.current("a")).toBe("b");
  });

  it("is emptied by reset on the app's own registry, so no id outlives a test", () => {
    extend(attempts, ["a", "b"], ["auto"]);
    attempts.registerPending("b", "switch");
    attempts.reset();
    expect(attempts.snapshot()).toEqual({ chains: [] });
    expect(attempts.current("a")).toBe("a");
    expect(attempts.begin("b", "elsewhere")).toBe(true);
  });
});

describe("begin", () => {
  it("registers a first attempt once, however often it is asked", () => {
    const registry = createAttemptRegistry();
    expect(registry.begin("a", "elsewhere")).toBe(true);
    const once = registry.snapshot();
    expect(registry.begin("a", "elsewhere")).toBe(false);
    expect(registry.snapshot()).toEqual(once);
  });

  it("does not make a later attempt the first of a chain of its own, nor drop what is pending", () => {
    const registry = build(["a", "b"]);
    expect(registry.registerPending("b", "switch")).toBe(true);
    const before = registry.snapshot();
    expect(registry.begin("b", "elsewhere")).toBe(false);
    expect(registry.begin("a", "elsewhere")).toBe(false);
    expect(registry.snapshot()).toEqual(before);
    expect(registry.publicId("b")).toBe("a");
  });
});

describe("who started the export", () => {
  it.each(["chat", "elsewhere"] as const)(
    "is what the chain began with, and every attempt of it answers the same: started by %s",
    (who) => {
      const registry = build(["a", "b", "c", "d"], ["auto", "switch", "switch"], who);
      for (const id of ["a", "b", "c", "d"]) expect(registry.startedBy(id), id).toBe(who);
      expect(registry.snapshot().chains[0].startedBy).toBe(who);
    },
  );

  it("keeps two chains apart", () => {
    const registry = createAttemptRegistry();
    extend(registry, ["a", "b"], ["auto"], "chat");
    extend(registry, ["x", "y"], ["auto"], "elsewhere");
    expect(["a", "b", "x", "y"].map((id) => registry.startedBy(id))).toEqual([
      "chat",
      "chat",
      "elsewhere",
      "elsewhere",
    ]);
  });

  it("says elsewhere for an id in no chain, and for a chain that was forgotten: only a start on record is the chat's", () => {
    const registry = build(["a", "b"], ["auto"], "chat");
    expect(registry.startedBy("ghost")).toBe("elsewhere");
    expect(registry.forget("b")).toBe(true);
    expect(registry.startedBy("a")).toBe("elsewhere");
    expect(registry.startedBy("b")).toBe("elsewhere");
  });

  it("takes the new answer when a forgotten id begins again, and never changes while the chain lives", () => {
    const registry = build(["a", "b"], ["auto"], "chat");
    registry.forget("a");
    expect(registry.begin("a", "elsewhere")).toBe(true);
    expect(registry.startedBy("a")).toBe("elsewhere");
    // Beginning again what is already a chain is refused, and does not turn it into the chat's.
    expect(registry.begin("a", "chat")).toBe(false);
    expect(registry.link("a", "c", "auto")).toEqual(OK);
    expect(registry.registerPending("c", "switch")).toBe(true);
    expect(registry.cancelPending("c")).toBe(true);
    expect(registry.link("c", "d", "switch")).toEqual(refusal("pending_cancelled"));
    expect(registry.cancelAllPending()).toBe(1);
    for (const id of ["a", "c"]) expect(registry.startedBy(id), id).toBe("elsewhere");
  });

  it("reads anything but the word chat as elsewhere", () => {
    const registry = createAttemptRegistry();
    const odd: unknown[] = [undefined, null, "", "CHAT", "chat ", 1, true, {}];
    odd.forEach((value, index) => {
      expect(registry.begin(`odd${index}`, value as ExportStarter)).toBe(true);
      expect(registry.startedBy(`odd${index}`), String(value)).toBe("elsewhere");
    });
  });

  it("hands out the answer in the snapshot as data, so a caller cannot change a chain through it", () => {
    const registry = build(["a", "b"], ["auto"], "chat");
    registry.snapshot().chains[0].startedBy = "elsewhere";
    expect(registry.startedBy("b")).toBe("chat");
  });
});

describe("the chain rules", () => {
  it("holds at most 8 attempts and refuses the one after", () => {
    const ids = Array.from({ length: 8 }, (_, index) => `a${index}`);
    const registry = build(ids);
    expect(registry.chainOf("a0")).toEqual(ids);
    const before = registry.snapshot();
    expect(registry.link("a7", "one-too-many", "switch")).toEqual(refusal("chain_too_long"));
    expect(registry.snapshot()).toEqual(before);
    expect(registry.current("a0")).toBe("a7");
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it("allows one automatic link per chain, whatever comes between", () => {
    const registry = build(["a", "b", "c"], ["auto", "switch"]);
    expect(registry.link("c", "d", "auto")).toEqual(refusal("second_auto"));
    expect(registry.link("c", "d", "switch")).toEqual(OK);
    expect(registry.autoRestartsUsed("a")).toBe(1);
  });

  it("takes one successor only when two restarts race for the same attempt", () => {
    const registry = build(["a"]);
    expect(registry.link("a", "b", "auto")).toEqual(OK);
    expect(registry.link("a", "c", "switch")).toEqual(refusal("not_current"));
    expect(registry.link("a", "c", "auto")).toEqual(refusal("not_current"));
    expect(registry.link("a", "b", "auto")).toEqual(refusal("not_current"));
    expect(registry.chainOf("a")).toEqual(["a", "b"]);
  });

  it("lets switch, switch, switch through, and one automatic link after them", () => {
    const registry = build(["a", "b", "c", "d"], ["switch", "switch", "switch"]);
    expect(registry.autoRestartsUsed("a")).toBe(0);
    expect(registry.link("d", "e", "auto")).toEqual(OK);
    expect(registry.link("e", "f", "auto")).toEqual(refusal("second_auto"));
    expect(registry.autoRestartsUsed("a")).toBe(1);
    expect(registry.chainOf("a")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never lets a switch use the count or reset it", () => {
    const switched = build(["a", "b", "c"]);
    expect(switched.autoRestartsUsed("a")).toBe(0);
    expect(switched.registerPending("c", "auto")).toBe(true);
    const registry = build(["a", "b"], ["auto"]);
    for (const id of ["c", "d", "e"])
      expect(registry.link(registry.current("a"), id, "switch")).toEqual(OK);
    expect(registry.autoRestartsUsed("a")).toBe(1);
    expect(registry.registerPending("e", "auto")).toBe(false);
    expect(registry.registerPending("e", "switch")).toBe(true);
  });

  function* kindSequences(max: number, prefix: LinkKind[] = []): Generator<LinkKind[]> {
    if (prefix.length > 0) yield prefix;
    if (prefix.length === max) return;
    for (const kind of ["auto", "switch"] as const) yield* kindSequences(max, [...prefix, kind]);
  }

  it("holds for every sequence of links up to the bound: a switch is always taken, only the first automatic link is, and the bound stops the rest", () => {
    let walked = 0;
    for (const kinds of kindSequences(8)) {
      walked++;
      const registry = createAttemptRegistry();
      registry.begin("a0", "elsewhere");
      let taken = 0;
      let autos = 0;
      kinds.forEach((kind, step) => {
        const result = registry.link(`a${taken}`, `a${taken + 1}`, kind);
        const expected =
          kind === "auto" && autos > 0
            ? refusal("second_auto")
            : taken + 1 >= 8
              ? refusal("chain_too_long")
              : OK;
        expect(result, `${kinds.join(",")} at link ${step + 1}`).toEqual(expected);
        if (result.ok) {
          taken++;
          if (kind === "auto") autos++;
        }
      });
      expect(registry.chainOf("a0"), kinds.join(",")).toHaveLength(taken + 1);
      expect(registry.autoRestartsUsed("a0"), kinds.join(",")).toBe(autos);
    }
    expect(walked).toBe(2 + 4 + 8 + 16 + 32 + 64 + 128 + 256);
  });

  it("counts a kind it does not know as an automatic restart, so a wrong value cannot get round the count", () => {
    const registry = build(["a"]);
    expect(registry.link("a", "b", "retry" as LinkKind)).toEqual(OK);
    expect(registry.autoRestartsUsed("a")).toBe(1);
    expect(registry.link("b", "c", "auto")).toEqual(refusal("second_auto"));
    const other = build(["a", "b"], ["auto"]);
    expect(other.registerPending("b", "again" as LinkKind)).toBe(false);
    expect(other.registerPending("b", "switch")).toBe(true);
  });
});

describe("a refused link says why and changes nothing", () => {
  const scenarios: Record<LinkRefusal, () => [AttemptRegistry, string, string, LinkKind]> = {
    unknown_prev: () => [build(["a", "b"]), "ghost", "x", "auto"],
    not_current: () => [build(["a", "b"]), "a", "x", "switch"],
    pending_cancelled: () => {
      const registry = build(["a", "b"], ["auto"]);
      registry.registerPending("b", "switch");
      registry.cancelPending("a");
      return [registry, "b", "c", "switch"];
    },
    cycle: () => [build(["a", "b", "c"]), "c", "a", "switch"],
    next_taken: () => [extend(build(["a", "b"]), ["c", "d"]), "b", "d", "switch"],
    second_auto: () => [build(["a", "b"], ["auto"]), "b", "c", "auto"],
    chain_too_long: () => [build(["a", "b", "c", "d", "e", "f", "g", "h"]), "h", "i", "switch"],
  };

  for (const [why, scenario] of Object.entries(scenarios))
    it(`as ${why}`, () => {
      const [registry, prev, next, kind] = scenario();
      const before = registry.snapshot();
      expect(registry.link(prev, next, kind)).toEqual(refusal(why as LinkRefusal));
      expect(registry.snapshot()).toEqual(before);
    });

  it("refuses a successor that is the attempt itself or an earlier one as a cycle, and one of another chain as taken", () => {
    const registry = extend(build(["a", "b", "c"]), ["x", "y"]);
    expect(registry.link("c", "c", "switch")).toEqual(refusal("cycle"));
    expect(registry.link("c", "b", "switch")).toEqual(refusal("cycle"));
    expect(registry.link("c", "x", "switch")).toEqual(refusal("next_taken"));
    expect(registry.link("c", "y", "switch")).toEqual(refusal("next_taken"));
  });

  it("reports a cancel before every other reason, and an unknown or stale attempt before the cancel", () => {
    const registry = build(["a", "b", "c"], ["auto", "switch"]);
    registry.registerPending("c", "switch");
    registry.cancelPending("a");
    // Everything else is wrong here too: a cycle, an automatic link after the one automatic link.
    expect(registry.link("c", "a", "auto")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("b", "x", "auto")).toEqual(refusal("not_current"));
    expect(registry.link("ghost", "x", "auto")).toEqual(refusal("unknown_prev"));
  });
});

describe("a restart waiting to start: a Cancel in the gap wins", () => {
  it("never links the successor once the person cancelled, whichever id the Cancel reached", () => {
    for (const reached of ["a", "b", "c"]) {
      const registry = build(["a", "b", "c"], ["switch", "switch"]);
      expect(registry.registerPending("c", "auto"), reached).toBe(true);
      expect(registry.cancelPending(reached), reached).toBe(true);
      const before = registry.snapshot();
      expect(registry.link("c", "d", "auto", { restarted: "gentler_setting" }), reached).toEqual(
        refusal("pending_cancelled"),
      );
      expect(registry.link("c", "d", "switch"), reached).toEqual(refusal("pending_cancelled"));
      expect(registry.snapshot(), reached).toEqual(before);
      expect(registry.current("a"), reached).toBe("c");
      expect(registry.isPendingCancelled("a"), reached).toBe(true);
      expect(registry.autoRestartsUsed("a"), reached).toBe(0);
    }
  });

  it("is an ordinary cancel after the link: nothing is pending and the live attempt is the successor", () => {
    const registry = build(["a"]);
    expect(registry.registerPending("a", "auto")).toBe(true);
    expect(registry.link("a", "b", "auto")).toEqual(OK);
    expect(registry.hasPending("a")).toBe(false);
    expect(registry.hasPending("b")).toBe(false);
    expect(registry.cancelPending("a")).toBe(false);
    expect(registry.current("a")).toBe("b");
  });

  it("is nothing for an id that is not known or has nothing pending, and changes nothing", () => {
    const registry = build(["a", "b"]);
    const before = registry.snapshot();
    expect(registry.cancelPending("ghost")).toBe(false);
    expect(registry.cancelPending("a")).toBe(false);
    expect(registry.snapshot()).toEqual(before);
  });

  it("is accepted again when it is pressed again, and the second press changes nothing", () => {
    const registry = build(["a"]);
    registry.registerPending("a", "auto");
    expect(registry.cancelPending("a")).toBe(true);
    const once = registry.snapshot();
    expect(registry.cancelPending("a")).toBe(true);
    expect(registry.snapshot()).toEqual(once);
  });

  it("is dropped by clearPending, which says whether there was one", () => {
    const registry = build(["a"]);
    registry.registerPending("a", "switch");
    expect(registry.clearPending("a")).toBe(true);
    expect(registry.hasPending("a")).toBe(false);
    expect(registry.clearPending("a")).toBe(false);
    expect(registry.registerPending("a", "switch")).toBe(true);
  });

  it("clears the pending restart in the call that links, so the successor starts with none", () => {
    const registry = build(["a", "b"], ["auto"]);
    expect(registry.registerPending("b", "switch")).toBe(true);
    expect(registry.link("b", "c", "switch")).toEqual(OK);
    for (const id of ["a", "b", "c"]) {
      expect(registry.hasPending(id), id).toBe(false);
      expect(registry.isPendingCancelled(id), id).toBe(false);
    }
    expect(registry.registerPending("c", "switch")).toBe(true);
  });

  const quitScenario = () => {
    const registry = createAttemptRegistry();
    extend(registry, ["a"]);
    extend(registry, ["c", "d"], ["switch"]);
    extend(registry, ["e"]);
    extend(registry, ["g"]);
    registry.registerPending("a", "auto");
    registry.registerPending("d", "switch");
    registry.registerPending("e", "auto");
    registry.cancelPending("e");
    return registry;
  };

  it("cancels every pending restart at quit, and only those", () => {
    const registry = quitScenario();
    expect(registry.cancelAllPending()).toBe(3);
    for (const id of ["a", "c", "d", "e"]) expect(registry.isPendingCancelled(id), id).toBe(true);
    expect(registry.isPendingCancelled("g")).toBe(false);
    expect(registry.link("a", "a2", "auto")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("d", "d2", "switch")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("e", "e2", "auto")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("g", "g2", "auto")).toEqual(OK);
    expect(registry.cancelAllPending()).toBe(3);
  });

  it("is also reached by cancelling every open export one by one, as the quit does", () => {
    const registry = quitScenario();
    for (const open of ["a", "d", "e", "g"]) registry.cancelPending(open);
    expect(registry.link("a", "a2", "auto")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("d", "d2", "switch")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("e", "e2", "auto")).toEqual(refusal("pending_cancelled"));
    expect(registry.link("g", "g2", "auto")).toEqual(OK);
  });

  it("refuses to note a restart that could not be completed, so nothing irreversible is done for it", () => {
    const registry = build(["a", "b"], ["auto"]);
    const before = registry.snapshot();
    expect(registry.registerPending("ghost", "switch")).toBe(false);
    expect(registry.registerPending("a", "switch")).toBe(false); // not the live attempt
    expect(registry.registerPending("b", "auto")).toBe(false); // the one automatic restart is used
    expect(registry.snapshot()).toEqual(before);
    expect(registry.registerPending("b", "switch")).toBe(true);
    expect(registry.registerPending("b", "switch")).toBe(false); // one is already pending
    expect(registry.registerPending("b", "auto")).toBe(false);
    const full = build(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(full.registerPending("h", "switch")).toBe(false); // no room for another attempt
  });
});

describe("forget", () => {
  it("drops the whole chain from whichever id it is asked, and its pending restart", () => {
    for (const asked of ["a", "b", "c"]) {
      const registry = extend(build(["a", "b", "c"], ["auto", "switch"]), ["x", "y"]);
      registry.registerPending("c", "switch");
      expect(registry.forget(asked), asked).toBe(true);
      for (const id of ["a", "b", "c"]) {
        expect(registry.current(id), id).toBe(id);
        expect(registry.publicId(id), id).toBe(id);
        expect(registry.chainOf(id), id).toEqual([id]);
        expect(registry.attemptNumber(id), id).toBe(1);
        expect(registry.isSuperseded(id), id).toBe(false);
        expect(registry.hasPending(id), id).toBe(false);
        expect(registry.autoRestartsUsed(id), id).toBe(0);
      }
      expect(registry.link("c", "d", "switch")).toEqual(refusal("unknown_prev"));
      expect(registry.snapshot()).toEqual(build(["x", "y"]).snapshot());
    }
  });

  it("forgets nothing it does not know", () => {
    const registry = build(["a", "b"]);
    const before = registry.snapshot();
    expect(registry.forget("ghost")).toBe(false);
    expect(registry.snapshot()).toEqual(before);
  });

  it("lets a forgotten id begin again as a new chain, with a fresh count", () => {
    const registry = build(["a", "b"], ["auto"]);
    registry.forget("b");
    expect(registry.begin("a", "elsewhere")).toBe(true);
    expect(registry.autoRestartsUsed("a")).toBe(0);
    expect(registry.link("a", "c", "auto")).toEqual(OK);
  });
});

describe("what the registry says about an attempt", () => {
  const meta: LinkMeta = {
    reason: "memory_short",
    restarted: "gentler_setting",
    failedRung: 0,
    route: 1,
  };

  it("describes each attempt from its own place in the chain", () => {
    const registry = createAttemptRegistry();
    registry.begin("a", "elsewhere");
    registry.link("a", "b", "auto", meta);
    registry.link("b", "c", "switch", { restarted: "quick" });
    expect(registry.describe("a")).toStrictEqual({
      publicId: "a",
      current: "c",
      attempt: 1,
      superseded: true,
    });
    expect(registry.describe("b")).toStrictEqual({
      publicId: "a",
      current: "c",
      attempt: 2,
      restarted: "gentler_setting",
      superseded: true,
    });
    expect(registry.describe("c")).toStrictEqual({
      publicId: "a",
      current: "c",
      attempt: 3,
      restarted: "quick",
      superseded: false,
    });
    expect(registry.incomingLink("a")).toBeNull();
    expect(registry.incomingLink("b")).toEqual({ from: "a", kind: "auto", attempt: 2, meta });
    expect(registry.incomingLink("c")).toEqual({
      from: "b",
      kind: "switch",
      attempt: 3,
      meta: { restarted: "quick" },
    });
    expect(registry.incomingLink("ghost")).toBeNull();
  });

  it("keeps its own copy of what it was given and hands out copies", () => {
    const registry = build(["a"]);
    const given = { ...meta };
    registry.link("a", "b", "auto", given);
    given.reason = "changed";
    given.restarted = "quick";
    expect(registry.incomingLink("b")?.meta).toEqual(meta);
    registry.incomingLink("b")!.meta.reason = "tampered";
    registry.snapshot().chains[0].links[0].meta.reason = "tampered too";
    expect(registry.incomingLink("b")?.meta).toEqual(meta);
  });

  it("drops what it cannot say instead of passing it on to the words", () => {
    const registry = build(["a"]);
    const odd = {
      restarted: "teleport",
      failedRung: Number.NaN,
      route: "1",
      reason: 5,
      extra: true,
    };
    expect(registry.link("a", "b", "auto", odd as never)).toEqual(OK);
    expect(registry.incomingLink("b")?.meta).toEqual({});
    expect(registry.describe("b")).toStrictEqual({
      publicId: "a",
      current: "b",
      attempt: 2,
      superseded: false,
    });
    expect(registry.link("b", "c", "switch")).toEqual(OK);
    expect(registry.incomingLink("c")?.meta).toEqual({});
  });
});

// Random sequences of every operation, with every invariant asserted after every step. The ids come from a small pool and
// the operations are chosen to meet each other often (a link of the live attempt with a fresh id, a pending restart on it,
// a cancel, a quit, a forget), so refusals and the bound of 8 are reached.

type Ref =
  | { how: "fresh" }
  | { how: "ghost" | "used"; n: number }
  | { how: "public" | "current" | "member"; n: number; m: number };

type Op =
  | { op: "begin"; id: Ref }
  | { op: "link"; prev: Ref; next: Ref; kind: LinkKind }
  | { op: "register"; id: Ref; kind: LinkKind }
  | { op: "cancel" | "clear" | "forget" | "resolve"; id: Ref }
  | { op: "quit" };

type Call =
  | { op: "begin"; id: string }
  | { op: "link"; prev: string; next: string; kind: LinkKind }
  | { op: "register"; id: string; kind: LinkKind }
  | { op: "cancel" | "clear" | "forget" | "resolve"; id: string }
  | { op: "quit" };

const nat = fc.nat({ max: 9 });
const chainIndex = fc.oneof(
  { weight: 5, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: nat },
);
const refFresh = fc.constant<Ref>({ how: "fresh" });
const refOld: fc.Arbitrary<Ref> = fc.record({ how: fc.constantFrom("ghost", "used"), n: nat });
const refChain = (...how: Array<"public" | "current" | "member">): fc.Arbitrary<Ref> =>
  fc.record({ how: fc.constantFrom(...how), n: chainIndex, m: nat });
const refAny: fc.Arbitrary<Ref> = fc.oneof(
  { weight: 4, arbitrary: refChain("current") },
  { weight: 2, arbitrary: refChain("public") },
  { weight: 3, arbitrary: refChain("member") },
  { weight: 2, arbitrary: refOld },
  { weight: 1, arbitrary: refFresh },
);
const kindArb: fc.Arbitrary<LinkKind> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<LinkKind>("switch") },
  { weight: 1, arbitrary: fc.constant<LinkKind>("auto") },
);
const growKind: fc.Arbitrary<LinkKind> = fc.oneof(
  { weight: 9, arbitrary: fc.constant<LinkKind>("switch") },
  { weight: 1, arbitrary: fc.constant<LinkKind>("auto") },
);
const extendOp = (kind: fc.Arbitrary<LinkKind>) =>
  fc.record({
    op: fc.constant("link" as const),
    prev: refChain("current"),
    next: refFresh,
    kind,
  });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: refFresh.map((id): Op => ({ op: "begin", id })) },
  { weight: 1, arbitrary: refAny.map((id): Op => ({ op: "begin", id })) },
  { weight: 20, arbitrary: extendOp(kindArb) },
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constant("link" as const),
      prev: refAny,
      next: refAny,
      kind: kindArb,
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      op: fc.constant("register" as const),
      id: refChain("current"),
      kind: kindArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant("register" as const), id: refAny, kind: kindArb }),
  },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("cancel" as const), id: refAny }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("clear" as const), id: refAny }) },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant("forget" as const), id: refChain("public", "member") }),
  },
  { weight: 2, arbitrary: fc.constant<Op>({ op: "quit" }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("resolve" as const), id: refAny }) },
);
/** A chain grown first, up to 10 links and mostly switches, so that the bound of 8 is met; then everything else is thrown at it. */
const growth: fc.Arbitrary<Op[]> = fc
  .array(extendOp(growKind), { maxLength: 10 })
  .map((links) => [{ op: "begin", id: { how: "fresh" } } as Op, ...links]);
const opsArb: fc.Arbitrary<Op[]> = fc
  .tuple(growth, fc.array(opArb, { maxLength: 90, size: "max" }))
  .map(([grown, rest]) => [...grown, ...rest]);

/** What a link carries in a run, by its kind. */
const META: Record<LinkKind, LinkMeta> = {
  auto: { reason: "memory_short", restarted: "gentler_setting", failedRung: 0, route: 1 },
  switch: { restarted: "quick" },
};

/** Who starts the chain a run begins with this id, from the id alone, so that what any chain must answer is known without asking it. Both
 *  answers turn up among the ids a run makes (j0, j1, ... and the ghosts). */
const starterOf = (id: string): ExportStarter =>
  id.charCodeAt(id.length - 1) % 2 === 0 ? "chat" : "elsewhere";

interface Pending {
  kind: LinkKind;
  cancelled: boolean;
}

/** One operation, seen from outside: what was called, what came back, and what the registry held before and after. The
 *  pending maps are kept from the results alone (a restart is pending from the `true` of registerPending until a link,
 *  a clear or a forget), so they check the registry's own answers about it rather than repeat them. */
interface Step {
  registry: AttemptRegistry;
  call: Call;
  result: unknown;
  before: AttemptSnapshot;
  after: AttemptSnapshot;
  pendingBefore: ReadonlyMap<string, Pending>;
  pending: ReadonlyMap<string, Pending>;
  ids: readonly string[];
}

const chainIn = (snapshot: AttemptSnapshot, id: string) =>
  snapshot.chains.find((chain) => chain.ids.includes(id));
const publicOf = (snapshot: AttemptSnapshot, id: string): string =>
  chainIn(snapshot, id)?.ids[0] ?? id;
const liveOf = (chain: { ids: string[] }): string => chain.ids[chain.ids.length - 1];
const autosIn = (chain: { links: Array<{ kind: LinkKind }> } | undefined): number =>
  chain ? chain.links.filter((link) => link.kind === "auto").length : 0;

function resolveRef(ref: Ref, snapshot: AttemptSnapshot, used: string[]): string {
  const remember = (id: string): string => {
    if (!used.includes(id)) used.push(id);
    return id;
  };
  switch (ref.how) {
    case "fresh":
      return remember(`j${used.length}`);
    case "ghost":
      return remember(`ghost${ref.n % 3}`);
    case "used":
      return used.length ? used[ref.n % used.length] : remember("ghost0");
    default: {
      if (!snapshot.chains.length) return remember("ghost0");
      const chain = snapshot.chains[ref.n % snapshot.chains.length];
      return ref.how === "public"
        ? chain.ids[0]
        : ref.how === "current"
          ? liveOf(chain)
          : chain.ids[ref.m % chain.ids.length];
    }
  }
}

function resolveOp(op: Op, snapshot: AttemptSnapshot, used: string[]): Call {
  const id = (ref: Ref) => resolveRef(ref, snapshot, used);
  switch (op.op) {
    case "link":
      return { op: "link", prev: id(op.prev), next: id(op.next), kind: op.kind };
    case "register":
      return { op: "register", id: id(op.id), kind: op.kind };
    case "quit":
      return { op: "quit" };
    default:
      return { op: op.op, id: id(op.id) };
  }
}

function perform(registry: AttemptRegistry, call: Call): unknown {
  switch (call.op) {
    case "begin":
      return registry.begin(call.id, starterOf(call.id));
    case "link":
      return registry.link(call.prev, call.next, call.kind, META[call.kind]);
    case "register":
      return registry.registerPending(call.id, call.kind);
    case "cancel":
      return registry.cancelPending(call.id);
    case "clear":
      return registry.clearPending(call.id);
    case "forget":
      return registry.forget(call.id);
    case "quit":
      return registry.cancelAllPending();
    case "resolve":
      registry.current(call.id);
      registry.publicId(call.id);
      registry.attemptNumber(call.id);
      registry.chainOf(call.id);
      registry.isSuperseded(call.id);
      registry.autoRestartsUsed(call.id);
      registry.startedBy(call.id);
      registry.hasPending(call.id);
      registry.isPendingCancelled(call.id);
      registry.describe(call.id);
      registry.incomingLink(call.id);
      return null;
  }
}

function trackPending(
  pending: ReadonlyMap<string, Pending>,
  call: Call,
  result: unknown,
  before: AttemptSnapshot,
): Map<string, Pending> {
  const next = new Map(pending);
  switch (call.op) {
    case "register":
      if (result === true)
        next.set(publicOf(before, call.id), { kind: call.kind, cancelled: false });
      break;
    case "cancel": {
      const key = publicOf(before, call.id);
      const mine = next.get(key);
      if (result === true && mine) next.set(key, { ...mine, cancelled: true });
      break;
    }
    case "clear":
    case "forget":
      if (result === true) next.delete(publicOf(before, call.id));
      break;
    case "link":
      if ((result as LinkResult).ok) next.delete(publicOf(before, call.prev));
      break;
    case "quit":
      for (const [key, mine] of next) next.set(key, { ...mine, cancelled: true });
      break;
  }
  return next;
}

function run(ops: readonly Op[], onStep: (step: Step) => void = () => undefined): AttemptRegistry {
  const registry = createAttemptRegistry();
  const used: string[] = [];
  let pending: Map<string, Pending> = new Map();
  for (const op of ops) {
    const before = registry.snapshot();
    const call = resolveOp(op, before, used);
    const result = perform(registry, call);
    const after = registry.snapshot();
    const pendingBefore = pending;
    pending = trackPending(pending, call, result, before);
    onStep({ registry, call, result, before, after, pendingBefore, pending, ids: used });
  }
  return registry;
}

const RUNS = { numRuns: 100 };

/** A value as a string that does not depend on the order of its keys, and tells a missing key from an undefined one. */
const canon = (value: object): string =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));

describe("random sequences of operations", () => {
  it("keep every chain a simple path of at most 8, and every id of one resolves to the same live attempt", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        run(ops, ({ registry, after, ids }) => {
          const seen = new Set<string>();
          for (const chain of after.chains) {
            assert(chain.ids.length >= 1 && chain.ids.length <= 8, `${chain.ids.length} attempts`);
            assert(chain.links.length === chain.ids.length - 1, "one link between two attempts");
            const live = liveOf(chain);
            const path = chain.ids.join("|");
            chain.ids.forEach((id, index) => {
              assert(!seen.has(id), `${id} is in two places`);
              seen.add(id);
              assert(registry.current(id) === live, `current(${id}) is not ${live}`);
              assert(registry.publicId(id) === chain.ids[0], `publicId(${id})`);
              assert(registry.attemptNumber(id) === index + 1, `attemptNumber(${id})`);
              assert(registry.chainOf(id).join("|") === path, `chainOf(${id})`);
              assert(registry.isSuperseded(id) === (id !== live), `isSuperseded(${id})`);
              // Who started the export is what its first attempt began with, for every attempt, whatever was done to the chain since.
              assert(
                chain.startedBy === starterOf(chain.ids[0]),
                `the chain of ${path} was started by ${chain.startedBy}`,
              );
              assert(registry.startedBy(id) === chain.startedBy, `startedBy(${id})`);
            });
          }
          for (const id of ids) {
            const live = registry.current(id);
            assert(registry.current(live) === live, `current is not idempotent at ${id}`);
            assert(registry.publicId(live) === registry.publicId(id), `${id} changed chain`);
            assert(registry.current(registry.publicId(id)) === live, `public id of ${id}`);
            if (!seen.has(id)) {
              assert(live === id, `${id} is forgotten or unknown: not itself`);
              assert(registry.chainOf(id).join("|") === id, `chainOf(${id}) is not just itself`);
              assert(registry.attemptNumber(id) === 1, `attemptNumber(${id})`);
              assert(!registry.isSuperseded(id), `isSuperseded(${id})`);
              assert(
                registry.startedBy(id) === "elsewhere",
                `startedBy(${id}) of an id in no chain`,
              );
            }
          }
        });
      }),
      RUNS,
    );
  });

  it("describe and incomingLink say what the chain says, for every id, known or not", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        run(ops, ({ registry, after, ids }) => {
          const known = new Set<string>();
          for (const chain of after.chains)
            chain.ids.forEach((id, index) => {
              known.add(id);
              const arrived = index > 0 ? chain.links[index - 1] : undefined;
              const restarted = arrived?.meta.restarted;
              const view = canon({
                publicId: chain.ids[0],
                current: liveOf(chain),
                attempt: index + 1,
                superseded: id !== liveOf(chain),
                ...(restarted ? { restarted } : {}),
              });
              assert(canon(registry.describe(id)) === view, `describe(${id})`);
              const link = registry.incomingLink(id);
              assert(
                arrived
                  ? link !== null &&
                      canon({ ...link, meta: canon(link.meta) }) ===
                        canon({
                          from: chain.ids[index - 1],
                          kind: arrived.kind,
                          attempt: index + 1,
                          meta: canon(arrived.meta),
                        })
                  : link === null,
                `incomingLink(${id})`,
              );
            });
          for (const id of ids)
            if (!known.has(id)) {
              const alone = { publicId: id, current: id, attempt: 1, superseded: false };
              assert(canon(registry.describe(id)) === canon(alone), `describe(${id})`);
              assert(registry.incomingLink(id) === null, `incomingLink(${id})`);
            }
        });
      }),
      RUNS,
    );
  });

  it("use the one automatic restart at most once per chain, and a switch never changes the count", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        run(ops, ({ registry, call, result, before, after }) => {
          for (const chain of after.chains) {
            const autos = autosIn(chain);
            assert(autos <= 1, `${autos} automatic links in one chain`);
            for (const id of chain.ids)
              assert(registry.autoRestartsUsed(id) === autos, `autoRestartsUsed(${id})`);
          }
          if (call.op === "link" && (result as LinkResult).ok) {
            const was = autosIn(chainIn(before, call.prev));
            const now = registry.autoRestartsUsed(call.next);
            assert(
              now === was + (call.kind === "auto" ? 1 : 0),
              `${call.kind} link: ${was} -> ${now}`,
            );
          }
        });
      }),
      RUNS,
    );
  });

  it("leave the whole registry as it was when an operation was refused or only looked", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        run(ops, ({ call, result, before, after }) => {
          const nothing =
            call.op === "resolve" ||
            (call.op === "link" && !(result as LinkResult).ok) ||
            (call.op === "quit" ? result === 0 : result === false);
          if (nothing) assert.deepEqual(after, before, `${call.op} changed the registry`);
        });
      }),
      RUNS,
    );
  });

  it("never link after a cancel until the pending restart is cleared, and agree with what was cancelled", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        run(ops, ({ registry, call, result, before, after, pendingBefore, pending }) => {
          if (call.op === "link" && pendingBefore.get(publicOf(before, call.prev))?.cancelled)
            assert(!(result as LinkResult).ok, `link(${call.prev}, ${call.next}) after the cancel`);
          for (const key of pending.keys())
            assert(
              after.chains.some((chain) => chain.ids[0] === key),
              `a pending restart is held for ${key}, which is not a chain`,
            );
          for (const chain of after.chains) {
            const mine = pending.get(chain.ids[0]);
            for (const id of chain.ids) {
              assert(registry.hasPending(id) === (mine !== undefined), `hasPending(${id})`);
              assert(
                registry.isPendingCancelled(id) === (mine?.cancelled === true),
                `isPendingCancelled(${id})`,
              );
            }
          }
        });
      }),
      RUNS,
    );
  });

  it("do what the rules say: each call is taken when they allow it and only then, says why when not, and changes only what it names", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        run(ops, ({ call, result, before, after, pendingBefore }) => {
          const chain = (id: string) => chainIn(before, id);
          const pendingOf = (id: string) => pendingBefore.get(publicOf(before, id));
          const next = structuredClone(before);
          const target = (id: string) => next.chains.find((c) => c.ids.includes(id));
          switch (call.op) {
            case "begin":
              assert(result === (chain(call.id) === undefined), "begin is taken for a new id only");
              if (result === true)
                next.chains.push({
                  ids: [call.id],
                  startedBy: starterOf(call.id),
                  links: [],
                  pending: null,
                });
              break;
            case "link": {
              const from = chain(call.prev);
              const holder = chain(call.next);
              const cancelled = pendingOf(call.prev)?.cancelled === true;
              const blocking: Record<LinkRefusal, boolean> = {
                unknown_prev: !from,
                not_current: !!from && liveOf(from) !== call.prev,
                pending_cancelled: cancelled,
                cycle: !!holder && holder === from,
                next_taken: !!holder && holder !== from,
                second_auto: call.kind === "auto" && autosIn(from) > 0,
                chain_too_long: !!from && from.ids.length >= 8,
              };
              const reasons = Object.keys(blocking).filter((why) => blocking[why as LinkRefusal]);
              const linked = result as LinkResult;
              assert(linked.ok === (reasons.length === 0), `link: ${JSON.stringify(reasons)}`);
              if (!linked.ok) {
                assert(reasons.includes(linked.why), `refused as ${linked.why}, not ${reasons}`);
                if (cancelled && from && liveOf(from) === call.prev)
                  assert(
                    linked.why === "pending_cancelled",
                    `a cancel is reported as ${linked.why}`,
                  );
              } else {
                const joined = target(call.prev)!;
                joined.ids.push(call.next);
                joined.links.push({ kind: call.kind, meta: META[call.kind] });
                joined.pending = null;
              }
              break;
            }
            case "register": {
              const own = chain(call.id);
              const allowed =
                !!own &&
                liveOf(own) === call.id &&
                !pendingOf(call.id) &&
                own.ids.length < 8 &&
                (call.kind === "switch" || autosIn(own) === 0);
              assert(result === allowed, `registerPending(${call.id}, ${call.kind}) is ${result}`);
              if (result === true) target(call.id)!.pending = { kind: call.kind, cancelled: false };
              break;
            }
            case "cancel":
              assert(
                result === (pendingOf(call.id) !== undefined),
                "cancel is taken for a pending one",
              );
              if (result === true) target(call.id)!.pending!.cancelled = true;
              break;
            case "clear":
              assert(
                result === (pendingOf(call.id) !== undefined),
                "clear is taken for a pending one",
              );
              if (result === true) target(call.id)!.pending = null;
              break;
            case "forget":
              assert(result === (chain(call.id) !== undefined), "forget is taken for a known id");
              if (result === true)
                next.chains = next.chains.filter((c) => !c.ids.includes(call.id));
              break;
            case "quit":
              assert(
                result === pendingBefore.size,
                `quit found ${result} of ${pendingBefore.size}`,
              );
              for (const c of next.chains) if (c.pending) c.pending.cancelled = true;
              break;
            case "resolve":
              break;
          }
          assert.deepEqual(after, next, `${call.op}: not the registry its result describes`);
        });
      }),
      RUNS,
    );
  });

  it("can always be completed once a restart was noted, unless it is cancelled first", () => {
    fc.assert(
      fc.property(opsArb, kindArb, (ops, kind) => {
        const registry = run(ops);
        registry.snapshot().chains.forEach((chain, index) => {
          const live = liveOf(chain);
          if (!registry.registerPending(live, kind)) return;
          const linked = registry.link(live, `after${index}`, kind);
          assert(
            linked.ok,
            `a noted ${kind} restart of ${live} was refused: ${JSON.stringify(linked)}`,
          );
        });
      }),
      RUNS,
    );
  });

  it("reach the bound of 8 and every kind of answer in many runs, or these properties would prove nothing", () => {
    const refusals: Record<LinkRefusal, true> = {
      unknown_prev: true,
      not_current: true,
      pending_cancelled: true,
      cycle: true,
      next_taken: true,
      second_auto: true,
      chain_too_long: true,
    };
    const reachedIn = new Map<string, number>();
    fc.assert(
      fc.property(opsArb, (ops) => {
        const facts = new Set<string>();
        run(ops, ({ call, result, after }) => {
          if (after.chains.some((chain) => chain.ids.length === 8)) facts.add("a chain of 8");
          if (after.chains.length >= 2) facts.add("two chains");
          const linked = result as LinkResult;
          if (call.op === "link")
            facts.add(linked.ok ? "link taken" : `link refused: ${linked.why}`);
          else if (call.op === "quit")
            facts.add(result === 0 ? "quit found none" : "quit found some");
          else if (call.op !== "resolve") facts.add(`${call.op} ${result ? "taken" : "refused"}`);
        });
        for (const fact of facts) reachedIn.set(fact, (reachedIn.get(fact) ?? 0) + 1);
      }),
      { numRuns: 200 },
    );
    const wanted = [
      "a chain of 8",
      "two chains",
      "link taken",
      ...Object.keys(refusals).map((why) => `link refused: ${why}`),
      "begin taken",
      "begin refused",
      "register taken",
      "register refused",
      "cancel taken",
      "cancel refused",
      "clear taken",
      "forget taken",
      "quit found some",
    ];
    for (const fact of wanted) expect(reachedIn.get(fact) ?? 0, fact).toBeGreaterThanOrEqual(10);
  });
});

// The queue resolves every id it is given through the registry. Reading its source as text is the check that none is
// forgotten: a function added later that takes a job id fails here until it is listed in ID_ENTRY_POINTS or, when it acts
// on one attempt's own resources, excused below with the reason.

const QUEUE = path.resolve(__dirname, "exportQueue.ts");
const STORE = path.resolve(__dirname, "../store/exportJob.ts");

/** Exported functions of exportQueue.ts that take an id and deliberately do not resolve it. */
const NOT_RESOLVED: Readonly<Record<string, string>> = {
  offerExportRetry:
    "gives the retry of the one row it names: an attempt's own row, never the chain's",
  sealExportBatch: "takes the id of an export call (a batch of files), not a job's",
};

const JOB_ID_NAMES = new Set(["jobId", "publicId", "job_id"]);

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile("source.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
const isFunction = (node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** The names a parameter brings in: itself, or the properties a destructured one takes. */
const namesOf = (parameter: ts.ParameterDeclaration): string[] =>
  ts.isIdentifier(parameter.name)
    ? [parameter.name.text]
    : parameter.name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? [(element.propertyName ?? element.name).getText()] : [],
      );

/** The function reads `job_id` off its first parameter: an argument bag such as manage_exports' is an id taker too. */
function readsJobId(fn: ts.FunctionLikeDeclaration): boolean {
  const first = fn.parameters[0]?.name;
  if (!fn.body || !first || !ts.isIdentifier(first)) return false;
  const isFirst = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === first.text;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      isFirst(node.expression) &&
      node.name.text === "job_id"
    )
      found = true;
    else if (
      ts.isElementAccessExpression(node) &&
      isFirst(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "job_id"
    )
      found = true;
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isFirst(node.initializer) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText() === "job_id",
      )
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

/** A job id by any parameter named for one, or an `id` first; or an argument bag with a `job_id`. */
function takesJobId(fn: ts.FunctionLikeDeclaration): boolean {
  const names = fn.parameters.map(namesOf);
  return (
    names.some((own) => own.some((name) => JOB_ID_NAMES.has(name))) ||
    names[0]?.includes("id") === true ||
    readsJobId(fn)
  );
}

/** Every function a source exports, as a declaration or a const holding an arrow or function expression, by whether it
 *  takes a job id. A function that only passes its argument bag on is not seen. */
function exportedFunctions(text: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const statement of parse(text).statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name)
      found.set(statement.name.text, takesJobId(statement));
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && isFunction(declaration.initializer))
          found.set(declaration.name.text, takesJobId(declaration.initializer));
  }
  return found;
}

/** A store action (`attach: (jobId) => ...`) that takes a job id, and the hook the store exports. */
function storeAction(text: string, hook: string, action: string): boolean {
  const file = parse(text);
  const exportsHook = file.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      isExported(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === hook,
      ),
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === action &&
      isFunction(node.initializer) &&
      takesJobId(node.initializer)
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return exportsHook && found;
}

/** What is wrong between the table, the excused functions and the sources: empty when nothing is. */
function problems(
  queue: string,
  store: string,
  table: readonly string[] = ID_ENTRY_POINTS,
  excused: Readonly<Record<string, string>> = NOT_RESOLVED,
): string[] {
  const found = exportedFunctions(queue);
  const out: string[] = [];
  for (const [name, takesId] of found)
    if (takesId && !table.includes(name) && !Object.hasOwn(excused, name))
      out.push(`${name} takes a job id and is neither in ID_ENTRY_POINTS nor excused`);
  table.forEach((entry, index) => {
    if (table.indexOf(entry) !== index) out.push(`${entry} is listed twice`);
    const [hook, action] = entry.split(".");
    if (action === undefined && !found.has(entry))
      out.push(`${entry} is in ID_ENTRY_POINTS but exportQueue.ts does not export it`);
    if (action !== undefined && !storeAction(store, hook, action))
      out.push(`${entry} is in ID_ENTRY_POINTS but the store has no such action taking a job id`);
  });
  for (const name of Object.keys(excused)) {
    if (!found.get(name))
      out.push(`${name} is excused but exportQueue.ts no longer exports it taking a job id`);
    if (table.includes(name)) out.push(`${name} is both in ID_ENTRY_POINTS and excused`);
  }
  return out;
}

describe("every function that takes a job id resolves it through the registry", () => {
  const queue = readFileSync(QUEUE, "utf8");
  const store = readFileSync(STORE, "utf8");

  it("is listed in ID_ENTRY_POINTS, or excused with its reason, for every export of exportQueue.ts", () => {
    expect(problems(queue, store)).toEqual([]);
    for (const reason of Object.values(NOT_RESOLVED)) expect(reason.length).toBeGreaterThan(20);
  });

  it("walks the sources it really reads, not an empty file", () => {
    const found = exportedFunctions(queue);
    for (const name of ["cancelExport", "retryExport", "manageExportsTool", "offerExportRetry"])
      expect(found.get(name), name).toBe(true);
    for (const name of ["listExportRecords", "listExportOutcomes", "submitExport", "listExports"])
      expect(found.get(name), name).toBe(false);
  });

  it("fails on an extra function that takes a job id, however it is written", () => {
    const forms: Record<string, string> = {
      "a function": "export function nudge(jobId: string): void {}",
      "an async function": "export async function nudge(id: string): Promise<void> {}",
      "a constant arrow": "export const nudge = (jobId: string): void => {};",
      "a function expression": "export const nudge = function (jobId: string) {};",
      "a signature over several lines":
        "export function nudge(\n  ctx: Ctx,\n  jobId?: string | null,\n) {}",
      "a destructured parameter": "export function nudge({ jobId }: { jobId: string }) {}",
      "an argument bag":
        "export function nudge(args: Bag) {\n  return String(args.job_id ?? '');\n}",
      "an argument bag read by key":
        "export function nudge(args: Bag) {\n  return args['job_id'];\n}",
      "an argument bag taken apart":
        "export function nudge(args: Bag) {\n  const { job_id: only } = args;\n}",
    };
    for (const [what, extra] of Object.entries(forms))
      expect(problems(`${queue}\n${extra}\n`, store), what).toEqual([
        "nudge takes a job id and is neither in ID_ENTRY_POINTS nor excused",
      ]);
  });

  it("does not fail on what takes no job id, or is not exported, or is only named in a comment", () => {
    const quiet = [
      "export function nudge(spec: Spec): void {}",
      "export const nudge = (record: Row) => record.state;",
      "function nudge(jobId: string): void {}",
      "// export function nudge(jobId: string): void {}",
      "export const nudge = 5;",
      "export interface Nudge { (jobId: string): void }",
      "export function nudge(first: string, id: string): void {}",
    ];
    for (const extra of quiet) expect(problems(`${queue}\n${extra}\n`, store), extra).toEqual([]);
  });

  it("fails on a name in the table the queue does not export, a duplicate and a stale or contradictory excuse", () => {
    expect(problems(queue, store, [...ID_ENTRY_POINTS, "cancelExports"])).toEqual([
      "cancelExports is in ID_ENTRY_POINTS but exportQueue.ts does not export it",
    ]);
    expect(problems(queue, store, [...ID_ENTRY_POINTS, "cancelExport"])).toEqual([
      "cancelExport is listed twice",
    ]);
    expect(
      problems(queue, store, ID_ENTRY_POINTS, {
        ...NOT_RESOLVED,
        listExports: "no longer takes an id",
      }),
    ).toEqual(["listExports is excused but exportQueue.ts no longer exports it taking a job id"]);
    expect(problems(queue, store, [...ID_ENTRY_POINTS, "offerExportRetry"])).toEqual([
      "offerExportRetry is both in ID_ENTRY_POINTS and excused",
    ]);
    expect(
      problems(
        queue,
        store,
        ID_ENTRY_POINTS.filter((name) => name !== "dismissExport"),
      ),
    ).toEqual(["dismissExport takes a job id and is neither in ID_ENTRY_POINTS nor excused"]);
  });

  it("fails when the store's action is gone, renamed or no longer takes a job id", () => {
    expect(problems(queue, store.replace("attach: (jobId) =>", "attach: () =>"))).toEqual([
      "useExportJob.attach is in ID_ENTRY_POINTS but the store has no such action taking a job id",
    ]);
    expect(problems(queue, store.replace("attach: (jobId) =>", "follow: (jobId) =>"))).toEqual([
      "useExportJob.attach is in ID_ENTRY_POINTS but the store has no such action taking a job id",
    ]);
  });

  // That each entry point really passes a superseded id through current() is shown by the behaviour, one two-attempt case
  // per entry of ID_ENTRY_POINTS and a check that the cases are exactly the table: exportAutoRestart.test.ts, "every entry
  // point that takes a job id works with either attempt's id of a restarted export".
});
