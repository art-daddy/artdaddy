import { describe, expect, it } from "vitest";

import { claimsIn } from "../test/retiredNames";
import type { ChipPref } from "./chipPref";
import {
  CHIP_ROW_NOTES,
  chipRowModel,
  type ChipRowAction,
  type ChipRowInput,
  type ChipRowState,
} from "./chipRow";

const base: ChipRowInput = {
  found: true,
  pref: "auto",
  testing: false,
  verdict: "unknown",
  setAside: false,
  flagsOn: true,
  quickFlagOn: true,
  sizeServed: true,
};
const model = (over: Partial<ChipRowInput>) => chipRowModel({ ...base, ...over });

/** Every combination of the row's inputs: 2 x 2 x 2 x 3 x 2 x 2 x 2 x 2 = 384. */
function* everyInput(): Generator<ChipRowInput> {
  for (const found of [false, true])
    for (const pref of ["auto", "off"] as ChipPref[])
      for (const testing of [false, true])
        for (const verdict of ["passed", "not_passed", "unknown"] as const)
          for (const setAside of [false, true])
            for (const flagsOn of [false, true])
              for (const quickFlagOn of [false, true])
                for (const sizeServed of [false, true])
                  yield {
                    found,
                    pref,
                    testing,
                    verdict,
                    setAside,
                    flagsOn,
                    quickFlagOn,
                    sizeServed,
                  };
}

const STATES: ChipRowState[] = [
  "none",
  "checking",
  "auto_passed",
  "auto_not_passed",
  "set_aside",
  "off",
];
const ACTIONS: (ChipRowAction | null)[] = ["turn_on", "try_again_now", null];

describe("the graphics-chip row: the states the mockups draw", () => {
  it("checking: a chip is found and nothing is known yet, or its test is running", () => {
    for (const over of [{ testing: true }, { verdict: "unknown" as const }]) {
      const row = model(over);
      expect(row).toEqual({
        state: "checking",
        visible: true,
        note: "Checking this PC's graphics chip…",
        action: null,
      });
    }
  });

  it("Auto and passed", () => {
    expect(model({ verdict: "passed" })).toEqual({
      state: "auto_passed",
      visible: true,
      note: "Auto: used on this PC. The file is usually larger. It passed ArtDaddy's test on this PC.",
      action: null,
    });
  });

  it("Auto and not passed", () => {
    expect(model({ verdict: "not_passed" })).toEqual({
      state: "auto_not_passed",
      visible: true,
      note: "Auto: not used. The graphics chip did not pass ArtDaddy's test on this PC, so exports use the processor.",
      action: null,
    });
  });

  it("set aside for a day, with the way back", () => {
    expect(model({ verdict: "passed", setAside: true })).toEqual({
      state: "set_aside",
      visible: true,
      note: "The graphics chip stopped an export on this PC, so it is set aside for a day. Try it again now",
      action: "try_again_now",
    });
  });

  it("Off", () => {
    expect(model({ pref: "off" })).toEqual({
      state: "off",
      visible: true,
      note: "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor.",
      action: "turn_on",
    });
  });

  // The person who switches off a chip that was doing them good is told what it costs, in the same note: one voice, one paragraph.
  it("Off, where the chip passed its test: the same note, and one more sentence that exports are usually slower without the chip", () => {
    expect(model({ pref: "off", verdict: "passed" })).toEqual({
      state: "off",
      visible: true,
      note: "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor. Without the graphics chip, exports are usually slower.",
      action: "turn_on",
    });
  });

  it("no row at all when no chip of a known maker is found", () => {
    expect(model({ found: false })).toEqual({
      state: "none",
      visible: false,
      note: null,
      action: null,
    });
  });

  it("holds the copy pack's words and no one else's", () => {
    expect(Object.keys(CHIP_ROW_NOTES).sort()).toEqual(
      ["auto_not_passed", "auto_passed", "checking", "off", "set_aside"].sort(),
    );
    // The hints about a driver or the BIOS are not the row's: no brand, driver or BIOS in any of its words.
    for (const note of Object.values(CHIP_ROW_NOTES))
      expect(note).not.toMatch(/nvidia|intel|amd|driver|bios|update/i);
  });

  // The Export dialog leaves the old Mode row out where this row is drawn, and that row is where the person was told, before the start, what the chip costs.
  it("says what the chip costs, the file usually larger and nothing of the picture, in the one state where the chip is used and in no other", () => {
    const COST = "The file is usually larger.";
    const states = new Set<string>();
    for (const input of everyInput()) {
      const row = chipRowModel(input);
      if (row.note === null) continue;
      expect(row.note.includes(COST), `${row.state}: ${JSON.stringify(input)}`).toBe(
        row.state === "auto_passed",
      );
      // no state says the picture differs or is softer, whatever the chip did
      expect(claimsIn(row.note), `${row.state}: ${JSON.stringify(input)}`).toEqual([]);
      states.add(row.state);
    }
    expect([...states].sort()).toEqual([
      "auto_not_passed",
      "auto_passed",
      "checking",
      "off",
      "set_aside",
    ]);
  });
});

describe("the graphics-chip row: which state wins", () => {
  it("Off beats everything: not checked, not set aside, not tested, whatever else is true", () => {
    for (const over of [
      { testing: true },
      { setAside: true },
      { verdict: "passed" as const },
      { verdict: "not_passed" as const },
      { testing: true, setAside: true, verdict: "passed" as const },
    ])
      expect(model({ pref: "off", ...over }).state, JSON.stringify(over)).toBe("off");
  });

  it("a chip set aside is not shown as being tested, and not as passed", () => {
    expect(model({ setAside: true, testing: true }).state).toBe("set_aside");
    expect(model({ setAside: true, verdict: "not_passed" }).state).toBe("set_aside");
  });

  it("a test that is running beats an older answer, which may be for another picture size", () => {
    expect(model({ testing: true, verdict: "passed" }).state).toBe("checking");
    expect(model({ testing: true, verdict: "not_passed" }).state).toBe("checking");
  });
});

describe("the graphics-chip row: every combination of its inputs (a conformance walk)", () => {
  const all = [...everyInput()];

  it("walks all 384 combinations", () => {
    expect(all).toHaveLength(384);
    expect(new Set(all.map((input) => JSON.stringify(input))).size).toBe(384);
  });

  it("gives every combination exactly one known state, and never throws", () => {
    for (const input of all) {
      const row = chipRowModel(input);
      expect(STATES, JSON.stringify(input)).toContain(row.state);
      expect(ACTIONS).toContain(row.action);
    }
  });

  it("draws the row exactly when a chip is found and either the person's own Off is stored or the server allows the chip and this row and the picture is one the chip serves", () => {
    for (const input of all) {
      const row = chipRowModel(input);
      expect(row.visible, JSON.stringify(input)).toBe(
        input.found &&
          (input.pref === "off" || (input.flagsOn && input.quickFlagOn && input.sizeServed)),
      );
      // One thing, said four ways: a row that is not drawn is state none and has no words and no link.
      expect(row.visible).toBe(row.state !== "none");
      expect(row.note !== null).toBe(row.visible);
      if (!row.visible) expect(row.action).toBeNull();
    }
  });

  it("always draws the person's own Off where a chip is found, so it can be undone, whatever the server's switches and the picture's size say", () => {
    const offs = all.filter((input) => input.found && input.pref === "off");
    expect(offs.length).toBeGreaterThan(0);
    for (const input of offs) {
      const row = chipRowModel(input);
      expect(row, JSON.stringify(input)).toMatchObject({
        state: "off",
        visible: true,
        action: "turn_on",
      });
      // the Off note is always the start of what is said (the sentence about what Off costs may follow it)
      expect(row.note?.startsWith(CHIP_ROW_NOTES.off), JSON.stringify(input)).toBe(true);
    }
  });

  // Off costs speed only where the chip would have been used. Where it would not (no pass, set aside, the server's switches off, a picture size the chip does not serve) the row must not say it does:
  // the rule is stated through the row's own Auto state, so it follows whatever decides that state.
  it("says exports are usually slower without the chip exactly where the same PC, left on Auto, would say the chip is used", () => {
    const WARNING = "Without the graphics chip, exports are usually slower.";
    let said = 0;
    let silent = 0;
    for (const input of all) {
      const row = chipRowModel(input);
      if (row.note === null) continue;
      const says = row.note.includes(WARNING);
      if (input.pref !== "off") {
        expect(says, `not Off: ${JSON.stringify(input)}`).toBe(false);
        continue;
      }
      const onAuto = chipRowModel({ ...input, pref: "auto", testing: false, quickFlagOn: true });
      expect(says, JSON.stringify(input)).toBe(onAuto.state === "auto_passed");
      if (says) {
        // the Off note first, then the one sentence, nothing else
        expect(row.note).toBe(`${CHIP_ROW_NOTES.off} ${WARNING}`);
        said += 1;
      } else {
        expect(row.note).toBe(CHIP_ROW_NOTES.off);
        silent += 1;
      }
    }
    expect(said).toBeGreaterThan(0);
    expect(silent).toBeGreaterThan(0);
  });

  it("says it for a chip that passed whatever the server's Quick export switch says, since that switch decides the row and not whether the chip is used", () => {
    for (const quickFlagOn of [true, false])
      expect(
        model({ pref: "off", verdict: "passed", quickFlagOn }).note,
        `quickFlagOn ${quickFlagOn}`,
      ).toContain("exports are usually slower");
  });

  it("does not speak for the chip at a picture size it never serves: Auto draws no row there", () => {
    const unserved = all.filter((input) => input.pref === "auto" && !input.sizeServed);
    expect(unserved.length).toBeGreaterThan(0);
    for (const input of unserved)
      expect(chipRowModel(input).visible, JSON.stringify(input)).toBe(false);
  });

  it("with the switch Off never tests, offers or uses a chip: no state or link of the row asks for one", () => {
    for (const input of all.filter((i) => i.pref === "off")) {
      const row = chipRowModel(input);
      expect(["none", "off"], JSON.stringify(input)).toContain(row.state);
      expect(row.action === null || row.action === "turn_on").toBe(true);
      expect(row.note).not.toBe(CHIP_ROW_NOTES.checking);
      expect(row.note).not.toBe(CHIP_ROW_NOTES.set_aside);
    }
  });

  it("shows a chip as set aside, checking or answered only when the person has not turned it off", () => {
    for (const input of all) {
      const row = chipRowModel(input);
      if (row.state === "set_aside") expect(input.pref === "auto" && input.setAside).toBe(true);
      if (row.state === "checking") expect(input.pref === "auto" && !input.setAside).toBe(true);
      if (row.state === "auto_passed" || row.state === "auto_not_passed")
        expect(input.pref === "auto" && !input.setAside && !input.testing).toBe(true);
      if (row.state === "off") expect(input.pref).toBe("off");
    }
  });

  it("offers a link only where it makes sense: the way back to Auto where the chip is Off, Try again where it was set aside, and never one that switches the chip off", () => {
    for (const input of all) {
      const row = chipRowModel(input);
      expect(row.action === "try_again_now").toBe(row.state === "set_aside");
      expect(row.action === "turn_on").toBe(row.state === "off");
    }
    // over every input the links are exactly these two (and none): the chip is switched off in the Export dialog's row alone
    expect(new Set(all.map((input) => chipRowModel(input).action))).toEqual(
      new Set([null, "turn_on", "try_again_now"]),
    );
  });

  it("reaches every state the mockups draw, and no state the mockups do not", () => {
    const reached = new Set(all.map((input) => chipRowModel(input).state));
    expect([...reached].sort()).toEqual([...STATES].sort());
  });

  it("gives each visible state its own words", () => {
    const wordsOf = new Map<string, ChipRowState>();
    for (const input of all) {
      const row = chipRowModel(input);
      if (!row.visible) continue;
      const seen = wordsOf.get(row.note!);
      expect(seen === undefined || seen === row.state).toBe(true);
      wordsOf.set(row.note!, row.state);
    }
    // five states, and the Off state has two sets of words: its own, and its own with the sentence about what Off costs
    expect(wordsOf.size).toBe(6);
  });
});

describe("the graphics-chip row: hostile input", () => {
  it("is the quiet answer, no row, and never throws, for anything that is not what the type says", () => {
    const hidden = { state: "none", visible: false, note: null, action: null };
    const junk: unknown[] = [
      undefined,
      null,
      7,
      "found",
      [],
      {},
      { found: "yes", flagsOn: "yes", quickFlagOn: "yes" },
      { ...base, found: 1 },
      { ...base, flagsOn: undefined },
      { ...base, quickFlagOn: null },
      { ...base, sizeServed: undefined },
      { ...base, sizeServed: "yes" },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("no");
          },
        },
      ),
    ];
    for (const input of junk) expect(chipRowModel(input as ChipRowInput)).toEqual(hidden);
  });

  it("reads a pref that is not Off as Auto, as the stored pref does, and fields it was not given as not set", () => {
    expect(model({ pref: "banana" as ChipPref, verdict: "passed" }).state).toBe("auto_passed");
    expect(
      chipRowModel({
        found: true,
        flagsOn: true,
        quickFlagOn: true,
        sizeServed: true,
      } as ChipRowInput).state,
    ).toBe("checking");
    expect(model({ verdict: "maybe" as "passed" }).state).toBe("checking");
  });

  it("hands out a new object each time, so a caller cannot change what the next one gets", () => {
    const first = model({ verdict: "passed" });
    first.note = "changed";
    first.action = null;
    expect(model({ verdict: "passed" }).note).toBe(CHIP_ROW_NOTES.auto_passed);
    expect(model({ verdict: "passed" }).action).toBeNull();
    const none = model({ found: false });
    none.visible = true;
    expect(model({ found: false }).visible).toBe(false);
  });
});
