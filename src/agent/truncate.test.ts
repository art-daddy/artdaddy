import { describe, expect, it } from "vitest";

import { capToolResult } from "./truncate";

describe("capToolResult", () => {
  it("passes a small result through unchanged (same reference)", () => {
    const r = { ok: true, text: "hi" };
    expect(capToolResult(r, 1000)).toBe(r);
  });

  it("truncates the largest string field and flags it, keeping shape", () => {
    const r = { ok: false, error: "e", text: "a".repeat(5000) };
    const out = capToolResult(r, 500);
    expect(out._truncated).toBe(true);
    expect(String(out._note)).toMatch(/narrow your request/i);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("e"); // untouched small field survives
    expect((out.text as string).length).toBeLessThan(5000);
    expect(String(out.text)).toContain("truncated");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(600);
  });

  it("falls back to a compact preview when the bulk is not in strings", () => {
    const items = Array.from({ length: 3000 }, (_, i) => ({ i, v: i * 2 }));
    const out = capToolResult({ ok: true, items }, 500);
    expect(out._truncated).toBe(true);
    expect(typeof out._preview).toBe("string");
    expect(out.items).toBeUndefined(); // the huge array is dropped, not shipped
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4600);
  });

  it("treats an unserializable result (circular reference) as zero-length, returning it unchanged", () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular; // JSON.stringify throws -> jsonLen's catch -> 0 -> "small enough", passthrough
    expect(capToolResult(circular, 10)).toBe(circular);
  });
});
