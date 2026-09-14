// The registry drives BOTH the key matching and the printed label, so these walk every entry
// rather than spot-checking a few.
//
// This exists because the two used to be separate: the Edit menu advertised "S" for Split at
// Playhead while the binding was Ctrl+K (S had become snapping), and View advertised "Ctrl+=" for
// zoom while the binding was a bare "+". Both were caught by reading the code, not by a test.
import { describe, expect, it } from "vitest";

import { hit, SHORTCUTS, shortcutLabel, shortcutLabels } from "./shortcuts";

/** A KeyboardEvent-alike; `hit` only reads these five fields. */
const ev = (
  key: string,
  mods: { cmd?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent =>
  ({
    key,
    ctrlKey: !!mods.cmd,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  }) as KeyboardEvent;

describe("shortcut registry", () => {
  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry fires on its own combo, and prints a label for it", () => {
    for (const s of SHORTCUTS) {
      expect(s.combos.length, `${s.id} has no combo`).toBeGreaterThan(0);
      for (const c of s.combos) {
        const fired = hit(
          ev(c.key, { cmd: c.cmd, shift: c.shift === true, alt: c.alt === true }),
          s.id,
        );
        expect(fired, `${s.id} did not fire on its own combo ${c.key}`).toBe(true);
      }
      expect(shortcutLabel(s.id), `${s.id} printed no label`).not.toBe("");
      expect(shortcutLabels(s.id).length).toBe(s.combos.length);
    }
  });

  // The failure direction: a binding that fires when a modifier it never asked for is held is how
  // "S toggles snapping" quietly also answered Ctrl+S.
  it("a plain-key binding does NOT fire when Ctrl is held", () => {
    for (const s of SHORTCUTS) {
      for (const c of s.combos) {
        if (c.cmd) continue;
        expect(
          hit(ev(c.key, { cmd: true, shift: c.shift === true, alt: c.alt === true }), s.id),
        ).toBe(false);
      }
    }
  });

  it("a Ctrl binding does NOT fire on the bare key", () => {
    for (const s of SHORTCUTS) {
      for (const c of s.combos) {
        if (!c.cmd) continue;
        expect(hit(ev(c.key, { shift: c.shift === true, alt: c.alt === true }), s.id)).toBe(false);
      }
    }
  });

  it("no modifier key press is ever itself a shortcut", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta"]) {
      for (const s of SHORTCUTS) {
        expect(hit(ev(k, { cmd: true, shift: true, alt: true }), s.id), `${k} fired ${s.id}`).toBe(
          false,
        );
      }
    }
  });

  // The specific pairs that were reported wrong. Pinned by VALUE, so renaming the binding without
  // updating the sheet fails here.
  it("prints the labels the menu was getting wrong", () => {
    expect(shortcutLabel("split", false)).toBe("Ctrl+K"); // was advertised as "S"
    expect(shortcutLabel("snapping", false)).toBe("S"); // which is what S actually does
    expect(shortcutLabel("zoomIn", false)).toBe("+"); // was advertised as "Ctrl+="
    expect(shortcutLabel("zoomOut", false)).toBe("-"); // was advertised as "Ctrl+-"
    expect(shortcutLabel("redo", false)).toBe("Ctrl+Shift+Z");
    expect(shortcutLabel("delete", false)).toBe("Del");
  });

  it("no two commands claim the same chord", () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      for (const c of s.combos) {
        const chord = `${c.cmd ? "C" : ""}${c.alt === true ? "A" : ""}${c.shift === true ? "S" : ""}:${c.key.toLowerCase()}`;
        const prev = seen.get(chord);
        expect(prev, `${chord} is claimed by both ${prev} and ${s.id}`).toBeUndefined();
        seen.set(chord, s.id);
      }
    }
  });

  it("separates the arrow bindings by Alt: nudging a clip is not stepping the playhead", () => {
    expect(hit(ev("ArrowRight", { alt: true }), "nudge")).toBe(true);
    expect(hit(ev("ArrowRight", { alt: true }), "step")).toBe(false);
    expect(hit(ev("ArrowRight"), "step")).toBe(true);
    expect(hit(ev("ArrowRight"), "nudge")).toBe(false);
    // Shift changes the DISTANCE for both, so it must not stop either from firing.
    expect(hit(ev("ArrowLeft", { alt: true, shift: true }), "nudge")).toBe(true);
    expect(hit(ev("ArrowLeft", { shift: true }), "step")).toBe(true);
  });

  it("Delete fires with or without Shift (plain delete vs ripple delete)", () => {
    expect(hit(ev("Delete"), "delete")).toBe(true);
    expect(hit(ev("Delete", { shift: true }), "delete")).toBe(true);
    expect(hit(ev("Backspace", { shift: true }), "delete")).toBe(true);
  });

  it("distinguishes Select All from the select-forward keys that share the letter", () => {
    expect(hit(ev("a", { cmd: true }), "selectAll")).toBe(true);
    expect(hit(ev("a", { cmd: true }), "selectForwardTrack")).toBe(false);
    expect(hit(ev("a"), "selectForwardTrack")).toBe(true);
    expect(hit(ev("a", { shift: true }), "selectForwardAll")).toBe(true);
    expect(hit(ev("a", { shift: true }), "selectForwardTrack")).toBe(false);
  });
});
