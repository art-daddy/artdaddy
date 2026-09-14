import { describe, expect, it } from "vitest";

import { toolNames } from "../contract/views";
import { WITHDRAWN_TOOLS } from "../contract/withdrawn";
import { MAX_CONCURRENT_READS, MUTATING_TOOLS, READ_ONLY_TOOLS, toolEffect } from "./toolEffect";

const TOOLS = [...toolNames(), ...WITHDRAWN_TOOLS];

describe("tool effect classification", () => {
  it("classifies every tool in the contract", () => {
    // A tool nobody classified would silently be treated as a write. That is safe, but it
    // is also invisible — this is what makes the decision deliberate.
    const unclassified = TOOLS.filter((t) => !READ_ONLY_TOOLS.has(t) && !MUTATING_TOOLS.has(t));
    expect(unclassified, `classify these in toolEffect.ts: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("never classifies a tool as both", () => {
    const both = TOOLS.filter((t) => READ_ONLY_TOOLS.has(t) && MUTATING_TOOLS.has(t));
    expect(both).toEqual([]);
  });

  it("does not classify tools that no longer exist", () => {
    // A renamed tool left behind in READS would keep granting concurrency to nothing, and
    // hide that its replacement was never classified.
    const known = new Set(TOOLS);
    const stale = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS].filter((t) => !known.has(t));
    expect(stale, `these are not in the contract any more: ${stale.join(", ")}`).toEqual([]);
  });

  it("treats an unknown tool as a write", () => {
    // The safe default: run it alone. Wrong only in being slower.
    expect(toolEffect("brand_new_tool")).toBe("write");
  });

  it("never lets a tool that changes the timeline run beside another", () => {
    // The rule this whole file exists to enforce, spot-checked against the ones that would
    // actually corrupt an edit if they overlapped.
    for (const name of [
      "add_clips",
      "insert_clips",
      "split_clips",
      "remove_clips",
      "move_clips",
      "ripple_delete",
      "set_clip_properties",
      "undo",
      "redo",
    ]) {
      expect(toolEffect(name), `${name} must not be concurrent`).toBe("write");
    }
  });

  it("keeps media PRODUCERS out of the read set even when they look like reads", () => {
    // get_page_image reads a web page but registers the capture as library media, so it
    // mutates. download_video and the generators are the same shape.
    for (const name of [
      "get_page_image",
      "download_video",
      "import_media",
      "generate_image",
      "generate_video",
      "run_ffmpeg",
      "export",
    ]) {
      expect(toolEffect(name), `${name} produces state and must run alone`).toBe("write");
    }
  });

  it("lets the genuinely observational tools overlap", () => {
    for (const name of [
      "get_timeline",
      "get_transcript",
      "inspect_media",
      "probe_media",
      "web_search",
      "video_ask",
    ]) {
      expect(toolEffect(name), `${name} should be concurrent-safe`).toBe("read");
    }
  });

  it("bounds the read fan-out", () => {
    // Several reads spawn ffmpeg; unbounded would have the agent compete with the render
    // for the same machine.
    expect(MAX_CONCURRENT_READS).toBeGreaterThan(1);
    expect(MAX_CONCURRENT_READS).toBeLessThanOrEqual(8);
  });
});
