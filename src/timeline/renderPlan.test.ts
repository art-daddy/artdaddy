import { describe, expect, it } from "vitest";

import schema from "../contract/timeline.schema.json";
import {
  BLEND_KINDS,
  CAPTION_CAPS,
  clampFont,
  FIT_KINDS,
  NOT_MODELED,
  UNIMPLEMENTED_IN_EXPORT,
} from "./renderPlan";
import { TRANSITION_KINDS } from "./transition";

// The shared plan's contract-drift guards. (1) Transition kinds: the ONE look-enum the schema defines is
// `transition.kind`; both backends dispatch over TRANSITION_KINDS, so every schema kind must be in it.
// (2) Caption capabilities: NOT_MODELED is the computed remainder of the tracked caption caps minus the
// ones the plan resolves, so shipping a Fix-#3 slice auto-updates it and a parity claim can't drift.
// (3) Media composite enums: the plan resolves `blend`/`fit` to CLOSED unions both backends dispatch with
// assertNever, so every schema value must be in the union (else a new contract mode is silently dropped).
const schemaKinds = (
  schema as { $defs: { transition: { properties: { kind: { enum: string[] } } } } }
).$defs.transition.properties.kind.enum;
const schemaBlend = (schema as { $defs: { clip: { properties: { blend: { enum: string[] } } } } })
  .$defs.clip.properties.blend.enum;
const schemaFit = (schema as { $defs: { layout: { properties: { fit: { enum: string[] } } } } })
  .$defs.layout.properties.fit.enum;

describe("renderPlan <-> contract drift", () => {
  it("models every transition kind the schema allows (no unrendered contract kind)", () => {
    const modelled = new Set<string>(TRANSITION_KINDS);
    expect(schemaKinds.filter((k) => !modelled.has(k))).toEqual([]);
  });

  it("declares no transition kind the schema does not have (no phantom kinds)", () => {
    const inSchema = new Set(schemaKinds);
    expect([...TRANSITION_KINDS].filter((k) => !inSchema.has(k))).toEqual([]);
  });

  it("models every blend mode the schema allows (both backends dispatch it, no silent drop)", () => {
    const modelled = new Set<string>(BLEND_KINDS);
    expect(schemaBlend.filter((b) => !modelled.has(b))).toEqual([]);
  });

  it("declares no blend mode the schema does not have (no phantom modes)", () => {
    const inSchema = new Set(schemaBlend);
    expect([...BLEND_KINDS].filter((b) => !inSchema.has(b))).toEqual([]);
  });

  it("models every fit mode the schema allows (both backends dispatch it, no silent drop)", () => {
    const modelled = new Set<string>(FIT_KINDS);
    expect(schemaFit.filter((f) => !modelled.has(f))).toEqual([]);
  });

  it("declares no fit mode the schema does not have (no phantom modes)", () => {
    const inSchema = new Set(schemaFit);
    expect([...FIT_KINDS].filter((f) => !inSchema.has(f))).toEqual([]);
  });

  it("NOT_MODELED is exactly the tracked caption caps the plan does not resolve (auto-bookkept)", () => {
    // Shipping a caption capability moves it into CAPTION_CAPS.modeled; NOT_MODELED is the computed
    // remainder, so the closure report can never claim a look the plan doesn't actually resolve.
    expect([...CAPTION_CAPS.modeled].every((c) => CAPTION_CAPS.all.includes(c))).toBe(true); // no phantom modelled cap
    expect(NOT_MODELED.some((c) => CAPTION_CAPS.modeled.has(c))).toBe(false); // modelled and NOT_MODELED are disjoint
    expect([...NOT_MODELED, ...CAPTION_CAPS.modeled].sort()).toEqual([...CAPTION_CAPS.all].sort()); // together cover all
    expect(NOT_MODELED).toContain("text.maxLines"); // metric-free line cap is permanently unmodelled
  });

  it("UNIMPLEMENTED_IN_EXPORT is empty — the exporter renders every caption look the preview does", () => {
    // Commit 2 closed the last preview>export asymmetry (captions burn in via libass: align/wrap/hard
    // breaks/font/size/colour). If a future field the PREVIEW renders but the exporter can't is added to
    // the plan, list it here — this assertion makes leaving the list stale a deliberate, visible act.
    expect([...UNIMPLEMENTED_IN_EXPORT]).toEqual([]);
  });

  it("clampFont keeps bundled families, aliases loose spellings, defaults unknown/empty to Poppins", () => {
    expect(clampFont("Anton")).toBe("Anton");
    expect(clampFont("Playfair Display")).toBe("Playfair Display");
    expect(clampFont("poppins")).toBe("Poppins"); // case-insensitive
    expect(clampFont("bebas neue")).toBe("Bebas Neue");
    expect(clampFont("BebasNeue")).toBe("Bebas Neue"); // space-insensitive
    expect(clampFont("Impact")).toBe("Poppins"); // unbundled -> default (no system-font drift)
    expect(clampFont("")).toBe("Poppins");
    expect(clampFont(undefined)).toBe("Poppins");
  });
});
