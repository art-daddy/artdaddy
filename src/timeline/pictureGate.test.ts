// The picture gate's table cannot drift (witness V5, rule E3c-23 and register row C48): the table keeps a hash of each quiet route's arguments beside the owner's recorded answer, and these tests
// recompute the hashes FROM THE CODE (the real command builder, the chip's argument table, the rungs' thread caps), so an argument that changes after the owner's answer breaks a test and the answer stops
// counting. The rule that decides what a record allows is checked against a truth table written from the rule's words, not from the implementation.
import { describe, expect, it } from "vitest";

import { CHIP_MAKERS, chipVideoArgs, type ChipMaker, type Tier } from "./exportEncoder";
import { RUNG_THREAD_CAPS } from "./exportPlan";
import {
  GATE_ROUTES,
  GATE_TABLE,
  hashArgs,
  mayWidenRoute,
  type GateRecord,
  type GateRoute,
  type GuardState,
  type OwnerAnswer,
} from "./pictureGate";
import { buildRenderCommand } from "./render";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const TIERS: readonly Tier[] = ["high", "medium", "low"];

function timeline(inputs: number): Timeline {
  const tracks: Any[] = Array.from({ length: inputs }, (_, i) => ({
    id: `v${i}`,
    kind: "video",
    z: i,
    clips: [
      {
        media_ref: `/v${i}.mp4`,
        kind: "video",
        source_in: 0,
        source_out: 4,
        timeline_in: 0,
        timeline_out: 4,
      },
    ],
  }));
  return { canvas: { width: 1920, height: 1080, fps: 30 }, tracks } as Timeline;
}

/** Everything from the encoder's name to the audio choice: what the final encoder is asked to do. */
function encoderSection(args: string[]): string[] {
  const from = args.lastIndexOf("-c:v");
  const to = args.findIndex((arg, index) => index > from && (arg === "-an" || arg === "-c:a"));
  return args.slice(from, to);
}

function threadArguments(args: string[]): string[][] {
  return args.flatMap((arg, i) => (arg === "-threads:v" ? [[arg, args[i + 1] ?? ""]] : []));
}

/** What each route changes, as the code produces it now: the chip's argument table and the real final-encoder section for each quality tier; the faster setting's real section per tier;
 *  a rung's thread-cap table and the thread arguments of a one-input and a three-input command at that rung. */
function routeArguments(route: GateRoute): unknown {
  const out = "/out.mp4";
  if (route.startsWith("chip_")) {
    const maker = route.slice(5) as ChipMaker;
    return Object.fromEntries(
      TIERS.map((tier) => [
        tier,
        {
          table: chipVideoArgs(maker, tier),
          section: encoderSection(
            buildRenderCommand(timeline(1), out, {
              mode: "fast",
              chip: maker,
              quality: tier,
            } as Any).args,
          ),
        },
      ]),
    );
  }
  if (route === "faster_x264") {
    return Object.fromEntries(
      TIERS.map((tier) => [
        tier,
        encoderSection(
          buildRenderCommand(timeline(1), out, { faster: true, quality: tier } as Any).args,
        ),
      ]),
    );
  }
  const rung = route === "rung_1" ? 1 : 2;
  return {
    caps: RUNG_THREAD_CAPS[rung],
    one: threadArguments(buildRenderCommand(timeline(1), out, { rung } as Any).args),
    three: threadArguments(buildRenderCommand(timeline(3), out, { rung } as Any).args),
  };
}

describe("the gate table has one record per quiet route", () => {
  it("lists every route once, in the code's order, and nothing else", () => {
    expect(GATE_TABLE.map((r) => r.route)).toEqual([...GATE_ROUTES]);
    expect(new Set(GATE_TABLE.map((r) => r.route)).size).toBe(GATE_TABLE.length);
  });
  it("covers every chip maker the encoder rules know", () => {
    for (const maker of CHIP_MAKERS) expect(GATE_ROUTES).toContain(`chip_${maker}`);
  });
});

describe("the recorded argument hashes are the code's (V5, C48)", () => {
  for (const route of GATE_ROUTES) {
    it(`${route}: the recorded hash is the hash of the arguments the code produces now`, () => {
      const record = GATE_TABLE.find((r) => r.route === route)!;
      const computed = hashArgs(routeArguments(route));
      expect(record.argsHash, `computed ${computed}`).toBe(computed);
    });
  }

  it("a changed argument changes the hash, so an old answer would stop counting (negative control)", () => {
    const base = routeArguments("chip_amd") as Record<
      string,
      { table: { rate: string[] }; section: string[] }
    >;
    const changed = structuredClone(base);
    changed.medium!.table.rate[changed.medium!.table.rate.indexOf("24")] = "25";
    expect(hashArgs(changed)).not.toBe(hashArgs(base));
    const faster = routeArguments("faster_x264") as Record<string, string[]>;
    const slower = structuredClone(faster);
    slower.medium![slower.medium!.indexOf("veryfast")] = "faster";
    expect(hashArgs(slower)).not.toBe(hashArgs(faster));
    const rung = routeArguments("rung_1") as {
      caps: { decoder: number | null; encoder: number | null };
    };
    expect(
      hashArgs({ ...rung, caps: { ...rung.caps, encoder: (rung.caps.encoder ?? 0) + 1 } }),
    ).not.toBe(hashArgs(rung));
  });

  it("the routes really differ from each other in the commands (a hash of nothing would match all)", () => {
    const hashes = GATE_ROUTES.map((r) => hashArgs(routeArguments(r)));
    expect(new Set(hashes).size).toBe(GATE_ROUTES.length);
    const faster = routeArguments("faster_x264") as Record<string, string[]>;
    expect(faster.medium).toContain("veryfast");
  });

  it("each rung's thread-cap table really reaches the command it names", () => {
    for (const route of ["rung_1", "rung_2"] as const) {
      const rung = routeArguments(route) as {
        caps: { decoder: number; encoder: number };
        one: string[][];
        three: string[][];
      };
      expect(
        rung.one.map((pair) => pair[1]),
        route,
      ).toEqual([String(rung.caps.decoder), String(rung.caps.encoder)]);
      expect(
        rung.three.map((pair) => pair[1]),
        route,
      ).toEqual([
        String(rung.caps.decoder),
        String(rung.caps.decoder),
        String(rung.caps.decoder),
        String(rung.caps.encoder),
      ]);
    }
  });
});

describe("what a record allows (a truth table written from the rule's words)", () => {
  const answers: OwnerAnswer[] = ["pending", "agree", "visible_yes", "no"];
  const states: GuardState[] = ["pass", "fail", "unmeasured"];

  // The rule in words: a route may be widened only if the owner said "agree" or "visible, but yes", about the arguments the code has now; "agree" also needs both measured guards to have passed.
  const expected = (
    answer: OwnerAnswer,
    exact: GuardState,
    floor: GuardState,
    sameArgs: boolean,
  ): boolean => {
    if (!sameArgs) return false;
    if (answer === "visible_yes") return true;
    if (answer === "agree") return exact === "pass" && floor === "pass";
    return false;
  };

  it("walks every answer, every pair of guard states and both argument cases, for every route", () => {
    let cases = 0;
    for (const route of GATE_ROUTES) {
      for (const answer of answers)
        for (const exact of states)
          for (const floor of states)
            for (const sameArgs of [true, false]) {
              const record: GateRecord = {
                route,
                argsHash: "aaaaaaaaaaaaaaaa",
                exact,
                floor,
                answer,
                answeredOn: answer === "pending" ? null : "2026-11-14",
              };
              const table = [record];
              expect(
                mayWidenRoute(route, sameArgs ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb", table),
                JSON.stringify({ route, answer, exact, floor, sameArgs }),
              ).toBe(expected(answer, exact, floor, sameArgs));
              cases++;
            }
    }
    expect(cases).toBe(GATE_ROUTES.length * answers.length * states.length * states.length * 2);
  });

  it("a route with no record, or with two records, is never widened", () => {
    const one: GateRecord = {
      route: "rung_1",
      argsHash: "x",
      exact: "pass",
      floor: "pass",
      answer: "agree",
      answeredOn: "2026-11-14",
    };
    expect(mayWidenRoute("rung_2", "x", [one])).toBe(false);
    expect(mayWidenRoute("rung_1", "x", [one, one])).toBe(false);
    expect(mayWidenRoute("rung_1", "x", [])).toBe(false);
    expect(mayWidenRoute("rung_1", "x", [one])).toBe(true);
  });

  it("garbage never throws and never widens", () => {
    expect(mayWidenRoute("chip_amd", "x", null as unknown as GateRecord[])).toBe(false);
    expect(mayWidenRoute("nonsense" as GateRoute, "x")).toBe(false);
  });

  it("before the owner's first look nothing is widened: every route keeps 0.27.0's reach", () => {
    for (const record of GATE_TABLE) {
      expect(record.answer).toBe("pending");
      expect(mayWidenRoute(record.route, record.argsHash)).toBe(false);
    }
  });
});

describe("hashArgs", () => {
  it("is deterministic and notices any change of a value, an order or a type", () => {
    expect(hashArgs({ a: ["x", "1"] })).toBe(hashArgs({ a: ["x", "1"] }));
    expect(hashArgs({ a: ["x", "1"] })).not.toBe(hashArgs({ a: ["x", 1] }));
    expect(hashArgs(["a", "b"])).not.toBe(hashArgs(["b", "a"]));
    expect(hashArgs(null)).not.toBe(hashArgs(undefined));
    expect(hashArgs(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("does not collide on a thousand near-identical argument lists", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(hashArgs(["-qp_i", String(i), "-qp_p", String(i)]));
    expect(seen.size).toBe(1000);
  });
});
