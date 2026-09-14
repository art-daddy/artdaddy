import { describe, expect, it } from "vitest";
// The sidecar is a standalone .mjs (no DOM, no Playwright needed for the pure
// predicate), so the test imports the same module the bundle inlines.
import { ddgBlocked } from "../../scripts/ddgBlock.mjs";

// Signatures captured from the LIVE endpoint on 2026-08-04, not invented.
const CAPTCHA = { results: 0, bodyLen: 328, title: "DuckDuckGo", challenge: true };
const SERVED = {
  results: 10,
  bodyLen: 4168,
  title: "usain bolt 100m world record at DuckDuckGo",
  challenge: false,
};

describe("ddgBlocked", () => {
  it("flags the CAPTCHA interstitial we actually got served", () => {
    expect(ddgBlocked(CAPTCHA)).toBe(true);
  });

  it("does NOT flag a real SERP", () => {
    expect(ddgBlocked(SERVED)).toBe(false);
  });

  // The whole point: a blocked page and an empty-but-genuine page both have zero
  // rows. If this ever collapses to "results === 0", the tool starts reporting
  // authoritative silence again.
  it("does NOT flag a genuine zero-result page (real SERP chrome, no matches)", () => {
    expect(
      ddgBlocked({
        results: 0,
        bodyLen: 1800,
        title: "asdkjhasdkjh at DuckDuckGo",
        challenge: false,
      }),
    ).toBe(false);
  });

  it("flags the soft rate-limit: tiny body, bare title, no results", () => {
    expect(ddgBlocked({ results: 0, bodyLen: 120, title: "DuckDuckGo", challenge: false })).toBe(
      true,
    );
  });

  it("treats a challenge as blocking even if the page looks otherwise normal", () => {
    expect(
      ddgBlocked({ results: 8, bodyLen: 5000, title: "x at DuckDuckGo", challenge: true }),
    ).toBe(true);
  });

  it("does not depend on title casing, and tolerates a missing title", () => {
    expect(
      ddgBlocked({ results: 0, bodyLen: 100, title: "X AT DUCKDUCKGO", challenge: false }),
    ).toBe(false);
    expect(ddgBlocked({ results: 0, bodyLen: 100, title: "", challenge: false })).toBe(true);
  });

  it("does not flag a large body just because it has no results yet", () => {
    expect(ddgBlocked({ results: 0, bodyLen: 500, title: "DuckDuckGo", challenge: false })).toBe(
      false,
    );
  });
});
