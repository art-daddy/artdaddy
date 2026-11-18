// Who decides Quality or Fast for an export that reaches the `export` tool: the dialog's slot, read once, when the export is asked for, and only while the switch `quick_route` is on.
// These are the rules of `decideRoute` on their own (the tool's whole journey is in exportFast.journey.test.ts): a Fast pick is Fast only with the switch on; anything else, and anything
// that cannot be read, is Quality; and what the person set comes from the dialog's own word where it gives one, else from the call's arguments.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetExportFlags, __setExportFlag, __setHeldOffByBuild } from "../api/exportFlags";
import type { ClientToolContext } from "../tools/context";
import { decideRoute } from "./routeDecide";

type Slot = ClientToolContext["exportRoute"];
const withSlot = (slot: unknown): Pick<ClientToolContext, "exportRoute"> => ({
  exportRoute: slot as Slot,
});
const NOTHING_SET = { size: false, fps: false, quality: false };

beforeEach(() => {
  __resetExportFlags();
  __setHeldOffByBuild(false);
  __setExportFlag("quick_route", true);
});
afterEach(() => {
  __resetExportFlags();
  __setHeldOffByBuild(null);
});

describe("a Fast pick is Fast only while the switch is on", () => {
  it("is Fast, with what the dialog says the person set, when the switch is on", () => {
    const explicit = { size: true, fps: false, quality: true };
    expect(decideRoute(withSlot({ route: "quick", explicit }), {})).toEqual({
      route: "quick",
      offer: "offered",
      quick: { explicit },
    });
  });

  it.each([
    ["switched off on the server", () => __setExportFlag("quick_route", false)],
    ["held off by the build, as shipped", () => __setHeldOffByBuild(true)],
  ])("is Quality, and says the switch is off, whatever was picked: %s", (_name, turnOff) => {
    turnOff();
    for (const slot of [
      { route: "quick", explicit: NOTHING_SET },
      { route: "standard" },
      undefined,
    ])
      expect(decideRoute(withSlot(slot), {})).toEqual({
        route: "standard",
        offer: "off",
        quick: null,
      });
  });

  it("is Quality, with Fast on offer, for a pick of Quality and for no pick", () => {
    for (const ctx of [withSlot({ route: "standard" }), withSlot(undefined), {}, null, undefined])
      expect(decideRoute(ctx, {})).toEqual({ route: "standard", offer: "offered", quick: null });
  });

  it("reads the switch each time it is asked, never keeps an answer", () => {
    const slot = withSlot({ route: "quick", explicit: NOTHING_SET });
    expect(decideRoute(slot, {}).route).toBe("quick");
    __setExportFlag("quick_route", false);
    expect(decideRoute(slot, {}).route).toBe("standard");
    __setExportFlag("quick_route", true);
    expect(decideRoute(slot, {}).route).toBe("quick");
  });
});

describe("what the person set", () => {
  const fast = (explicit: unknown, args: Record<string, unknown> = {}) =>
    decideRoute(withSlot({ route: "quick", explicit }), args).quick?.explicit;

  it("is the dialog's own word where it gives one: a 'same as the project' that was picked is a setting, which the call's arguments cannot say", () => {
    expect(fast({ size: true, fps: false, quality: false }, { resolution: "source" })).toEqual({
      size: true,
      fps: false,
      quality: false,
    });
    // ...and what the dialog says wins over the arguments, in both directions.
    expect(fast(NOTHING_SET, { resolution: "720p", fps: 24, quality: "high" })).toEqual(
      NOTHING_SET,
    );
  });

  it("leaves the quality out when the dialog says nothing of it, so it is read as set and nothing is taken from the person", () => {
    expect(fast({ size: false, fps: false })).toEqual({ size: false, fps: false });
    expect(fast({ size: false, fps: false, quality: "yes" })).toEqual({ size: false, fps: false });
  });

  it.each([
    ["strings for the flags", { size: "yes", fps: "no" }],
    ["nulls for the flags", { size: null, fps: null }],
    ["numbers for the flags", { size: 1, fps: 0 }],
    ["no size", { fps: false }],
    ["no rate", { size: false }],
    ["a string", "everything"],
    ["an array", [true, true]],
    ["null", null],
    ["nothing", undefined],
  ])(
    "falls back to the call's arguments when the dialog's word is unusable: %s",
    (_n, explicit) => {
      expect(fast(explicit, {})).toEqual({ size: false, fps: false, quality: false });
      expect(fast(explicit, { resolution: "1440p" })?.size).toBe(true);
      expect(fast(explicit, { resolution: "source" })?.size).toBe(false);
      expect(fast(explicit, { resolution: "  " })?.size).toBe(false);
      expect(fast(explicit, { fps: 24 })?.fps).toBe(true);
      expect(fast(explicit, { fps: "24" })?.fps).toBe(false);
      expect(fast(explicit, { quality: "high" })?.quality).toBe(true);
      expect(fast(explicit, { quality: "" })?.quality).toBe(false);
    },
  );
});

describe("whatever it is given", () => {
  it("never throws, and a slot that cannot be read is Quality", () => {
    const hostile = {
      get exportRoute(): never {
        throw new Error("the context cannot be read");
      },
    };
    expect(decideRoute(hostile as never, {})).toEqual({
      route: "standard",
      offer: "off",
      quick: null,
    });
    const unreadableRoute = Object.defineProperty({}, "route", {
      get(): never {
        throw new Error("the slot cannot be read");
      },
    });
    expect(decideRoute(withSlot(unreadableRoute), {}).route).toBe("standard");
  });

  it("is Fast exactly when the switch is on and the slot says quick, and says why; the answer carries what the person set only for Fast", () => {
    // Slots and calls of every shape, and a good share of the shape the dialog makes, so that the Fast branch is walked as well as the refusals.
    const slots = fc.oneof(
      fc.anything(),
      fc.record({
        route: fc.constantFrom<unknown>("quick", "standard", "fast", null, 1),
        explicit: fc.anything(),
      }),
    );
    const calls = fc.oneof(
      fc.anything(),
      fc.record({ resolution: fc.anything(), fps: fc.anything(), quality: fc.anything() }),
    );
    fc.assert(
      fc.property(slots, calls, fc.boolean(), (slot, args, on) => {
        __setExportFlag("quick_route", on);
        const out = decideRoute(withSlot(slot), args as Record<string, unknown>);
        const asksFast =
          typeof slot === "object" &&
          slot !== null &&
          (slot as { route?: unknown }).route === "quick";
        expect(out.route === "quick").toBe(on && asksFast);
        expect(out.offer).toBe(on ? "offered" : "off");
        expect(out.quick === null).toBe(out.route === "standard");
        if (out.quick) {
          expect(typeof out.quick.explicit.size).toBe("boolean");
          expect(typeof out.quick.explicit.fps).toBe("boolean");
          expect(["boolean", "undefined"]).toContain(typeof out.quick.explicit.quality);
        }
      }),
    );
  });
});
