import { afterEach, describe, expect, it } from "vitest";

import { detectPlatform } from ".";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("detectPlatform", () => {
  it("is web by default (no local tools)", () => {
    const p = detectPlatform();
    expect(p.name).toBe("web");
    expect(p.capabilities.localTools).toBe(false);
    expect(p.capabilities.fileSystem).toBe(false);
    expect(typeof p.apiBaseUrl).toBe("string");
  });

  it("is tauri when window.__TAURI__ is present", () => {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
    const p = detectPlatform();
    expect(p.name).toBe("tauri");
    expect(p.capabilities.localTools).toBe(true);
    expect(p.capabilities.fileSystem).toBe(true);
  });

  it("is tauri when window.__TAURI_INTERNALS__ is present (v2 default)", () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const p = detectPlatform();
    expect(p.name).toBe("tauri");
    expect(p.capabilities.localTools).toBe(true);
    expect(p.capabilities.fileSystem).toBe(true);
  });
});
