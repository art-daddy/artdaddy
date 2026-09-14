import { describe, expect, it } from "vitest";

import { decodeCommandOutput } from "./decode";

describe("decodeCommandOutput", () => {
  it("passes strings through unchanged", () => {
    expect(decodeCommandOutput("hello")).toBe("hello");
  });

  it("decodes a plain number[] (the Tauri raw-encoding IPC shape)", () => {
    expect(decodeCommandOutput([104, 105])).toBe("hi"); // regression guard
  });

  it("decodes a Uint8Array and an ArrayBuffer", () => {
    expect(decodeCommandOutput(new Uint8Array([104, 105]))).toBe("hi");
    expect(decodeCommandOutput(new Uint8Array([104, 105]).buffer)).toBe("hi");
  });

  it("treats null/undefined as empty output", () => {
    expect(decodeCommandOutput(null)).toBe("");
    expect(decodeCommandOutput(undefined)).toBe("");
  });

  it("decodes non-utf-8 bytes leniently instead of throwing", () => {
    // 0x92 is a cp1252 smart-quote — invalid as standalone utf-8.
    const s = decodeCommandOutput([0x41, 0x92, 0x42]);
    expect(s.startsWith("A")).toBe(true);
    expect(s.endsWith("B")).toBe(true);
  });

  it("falls back to String() for unexpected shapes", () => {
    expect(decodeCommandOutput(42)).toBe("42");
  });
});
