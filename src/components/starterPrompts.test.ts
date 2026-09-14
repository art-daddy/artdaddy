import { describe, expect, it } from "vitest";

import { toolNames } from "../contract/views";
import { STARTER_PROMPTS } from "./starterPrompts";

const SHIPPED = new Set(toolNames());

// A starter prompt is a PROMISE on an empty screen. Offering "sync my multicam" when no tool can
// sync anything spends the user's first impression on a failure, and the model burns a turn
// discovering it cannot comply. So every entry names the tools that carry it out and this walks
// the whole table against the shipped contract — a new suggestion cannot land without one.
describe("starter prompts are things the editor can actually do", () => {
  it("names only tools that ship in the contract", () => {
    const unknown: string[] = [];
    for (const p of STARTER_PROMPTS)
      for (const t of p.tools) if (!SHIPPED.has(t)) unknown.push(`${p.label} -> ${t}`);
    expect(unknown).toEqual([]);
  });

  it("backs every suggestion with at least one tool", () => {
    for (const p of STARTER_PROMPTS) expect(p.tools.length, p.label).toBeGreaterThan(0);
  });

  it("has a distinct label and body for each, and keeps labels chip-sized", () => {
    expect(new Set(STARTER_PROMPTS.map((p) => p.label)).size).toBe(STARTER_PROMPTS.length);
    for (const p of STARTER_PROMPTS) {
      // The label is a summary; inserting it instead of the body would send a much vaguer ask.
      expect(p.text, p.label).not.toBe(p.label);
      expect(p.text.length, p.label).toBeGreaterThan(p.label.length);
      expect(p.label.length, p.label).toBeLessThanOrEqual(24);
    }
  });
});
