import { describe, expect, it } from "vitest";

import { stderrExcerpt } from "./command";

// The rule: a truncated stderr must still contain the line that EXPLAINS the
// failure. ffmpeg names the cause on one of its first lines and then floods, so
// tail-only truncation kept the noise and dropped the answer — the `-22` abort
// had to be found by bisecting tracks instead of read straight off the error.
describe("stderrExcerpt", () => {
  const CAUSE = "Padded dimensions cannot be smaller than input dimensions";
  const LAST = "conversion failed, exiting";
  const flood = (n: number) => Array.from({ length: n }, (_, i) => `frame ${i} noise`).join("\n");

  it("keeps a cause printed FIRST even when megabytes of noise follow", () => {
    const out = stderrExcerpt(`${CAUSE}\n${flood(5000)}`, 400);
    expect(out).toContain(CAUSE);
    expect(out.length).toBeLessThan(600); // still bounded
  });

  it("keeps a cause printed LAST too (whisper/yt-dlp summarise at the end)", () => {
    expect(stderrExcerpt(`${flood(5000)}\n${LAST}`, 400)).toContain(LAST);
  });

  it("keeps BOTH ends when the cause is first and the summary is last", () => {
    const out = stderrExcerpt(`${CAUSE}\n${flood(5000)}\n${LAST}`, 400);
    expect(out).toContain(CAUSE);
    expect(out).toContain(LAST);
  });

  it("marks the elision so a reader knows the middle is missing", () => {
    expect(stderrExcerpt(flood(5000), 400)).toMatch(/\[\d+ chars elided\]/);
  });

  it("returns short output untouched — no marker, no padding", () => {
    expect(stderrExcerpt(`  ${CAUSE}  `, 400)).toBe(CAUSE);
    expect(stderrExcerpt("")).toBe("");
    expect(stderrExcerpt(null)).toBe("");
    expect(stderrExcerpt(undefined)).toBe("");
  });

  it("never exceeds the budget by more than the elision marker", () => {
    for (const max of [80, 160, 400, 1500]) {
      const out = stderrExcerpt(flood(9000), max);
      expect(out.length).toBeLessThanOrEqual(max + 40);
    }
  });
});
