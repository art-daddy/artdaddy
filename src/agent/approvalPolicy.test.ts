// Conformance guard for the approval policy.
//
// The rule: a tool that BILLS the user, or pulls third-party content onto their
// machine, must ask first in "default" mode — and must run untouched in
// "autopilot", which is the mode's entire purpose.
//
// The failure this exists to stop is DRIFT. "Costs something" is declared once, on
// the server (`expensive` in definitions.py); the gate that acts on it is a
// hand-written Set in loop.ts. Those two lists have already diverged once —
// `extract_style` and `get_page_image` were billing without ever asking — and
// nothing failed, because a missing entry in an allowlist is invisible. So this
// derives the expectation from the CONTRACT SNAPSHOT and forces every expensive
// tool to be classified: gated, or explicitly named as local compute.
import { describe, expect, it } from "vitest";

import { expensiveToolNames, toolNames } from "../contract/views";
import { WITHDRAWN_TOOLS } from "../contract/withdrawn";
import { EXTERNAL_FETCH_TOOLS, LOCAL_COMPUTE_TOOLS, needsApproval, PAID_TOOLS } from "./loop";

const EXPENSIVE: string[] = expensiveToolNames();
// Withdrawn tools keep their implementation, so they keep their gate: restoring one must not
// quietly ship it ungated. Their `expensive` flag is no longer in the catalog, so name them.
const WITHDRAWN_PAID = new Set(["extract_style", "find_content", "image_ask", "vision_describe"]);
const CONTRACT = new Set([...toolNames(), ...WITHDRAWN_TOOLS]);
const GENERATION = ["generate_image", "generate_video", "generate_voiceover", "generate_music"];

describe("the contract snapshot carries the expensive flag", () => {
  it("is populated (regenerate with `npm run codegen` if this is empty)", () => {
    expect(EXPENSIVE.length).toBeGreaterThan(0);
  });
});

describe("every expensive tool is classified", () => {
  it("no expensive tool is left unclassified — that is an ungated spend path", () => {
    const unclassified = EXPENSIVE.filter(
      (n) => !PAID_TOOLS.has(n) && !EXTERNAL_FETCH_TOOLS.has(n) && !LOCAL_COMPUTE_TOOLS.has(n),
    );
    expect(
      unclassified,
      "add each to PAID_TOOLS / EXTERNAL_FETCH_TOOLS, or to LOCAL_COMPUTE_TOOLS if it " +
        "only costs the user's own CPU",
    ).toEqual([]);
  });

  it("a tool is in exactly one class", () => {
    const all = [...PAID_TOOLS, ...EXTERNAL_FETCH_TOOLS, ...LOCAL_COMPUTE_TOOLS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("nothing is gated that the contract doesn't advertise (no phantom entries)", () => {
    const phantom = [...PAID_TOOLS, ...EXTERNAL_FETCH_TOOLS, ...LOCAL_COMPUTE_TOOLS].filter(
      (n) => !CONTRACT.has(n),
    );
    expect(phantom).toEqual([]);
  });

  it("every PAID tool really is expensive server-side (no gating something free)", () => {
    const notExpensive = [...PAID_TOOLS].filter(
      (n) => !EXPENSIVE.includes(n) && !WITHDRAWN_PAID.has(n),
    );
    expect(notExpensive).toEqual([]);
  });

  it("every withdrawn-paid name really is withdrawn (the exemption can't outlive the withdrawal)", () => {
    for (const n of WITHDRAWN_PAID) expect(WITHDRAWN_TOOLS, n).toContain(n);
  });

  it("local-compute exemptions are expensive but deliberately ungated", () => {
    for (const n of LOCAL_COMPUTE_TOOLS) {
      expect(EXPENSIVE, `${n} is exempt but not expensive — drop the exemption`).toContain(n);
      expect(needsApproval(n)).toBe(false);
    }
  });
});

describe("default mode asks before spending", () => {
  it.each(GENERATION)("%s requires approval", (name) => {
    expect(needsApproval(name)).toBe(true);
  });

  it("every paid and external tool requires approval", () => {
    for (const n of [...PAID_TOOLS, ...EXTERNAL_FETCH_TOOLS]) {
      expect(needsApproval(n), `${n} does not require approval`).toBe(true);
    }
  });

  it("an ordinary reversible edit does NOT require approval", () => {
    for (const n of ["add_clips", "set_clip_properties", "undo", "get_timeline", "export"]) {
      expect(needsApproval(n), `${n} should not need a click`).toBe(false);
    }
  });

  it("library_op is classified per CALL — delete asks, list does not", () => {
    expect(needsApproval("library_op", { action: "delete" })).toBe(true);
    expect(needsApproval("library_op", { action: "list" })).toBe(false);
    expect(needsApproval("library_op")).toBe(false);
  });

  it("an unknown tool name is not silently treated as free", () => {
    // It isn't gated (nothing can bill through a name the registry rejects), but
    // pin it so a future "default deny" change is a deliberate one.
    expect(needsApproval("make_coffee")).toBe(false);
  });
});
