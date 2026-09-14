// Drift guard for the tool effect classification (Step 4). The effect map (effects.ts) is the single
// source of truth the tool host routes each run through, so it MUST stay in lockstep with the served
// contract: a tool added/removed/renamed via `npm run codegen` fails here until it is classified, and
// a stale classification for a dropped tool is caught too.
import { describe, expect, it } from "vitest";

import { toolNames } from "./views";
import { WITHDRAWN_TOOLS } from "./withdrawn";
import {
  TOOL_EFFECTS,
  toolEffect,
  isJobEffect,
  isMutationEffect,
  type ToolEffect,
} from "./effects";

const KNOWN_EFFECTS: readonly ToolEffect[] = [
  "read",
  "project-mutation",
  "project-job",
  "derived-job",
  "app-operation",
  "deliverable",
];

describe("tool effect classification (Step 4 single source of truth)", () => {
  const contract = toolNames();
  const classified = Object.keys(TOOL_EFFECTS);
  // A withdrawn tool keeps its implementation, so it keeps its effect class too — otherwise
  // bringing one back would silently leave it unclassified.
  const expected = [...new Set([...contract, ...WITHDRAWN_TOOLS])].sort();

  it("every served contract tool has an effect class (no unclassified tool can slip through)", () => {
    expect(contract.filter((n) => !toolEffect(n))).toEqual([]);
  });

  it("no phantom classifications: every classified tool is served or withdrawn", () => {
    expect(classified.filter((n) => !expected.includes(n))).toEqual([]);
  });

  it("the classification set equals the served contract set (regenerate effects.ts after codegen)", () => {
    expect([...classified].sort()).toEqual(expected);
  });

  it("every effect value is a known class", () => {
    for (const [name, effect] of Object.entries(TOOL_EFFECTS))
      expect(KNOWN_EFFECTS, name).toContain(effect);
  });

  it("classifies the canonical members of each class (pins the mapping against silent drift)", () => {
    expect(toolEffect("get_timeline")).toBe("read"); // a pure read
    expect(toolEffect("video_ask")).toBe("read"); // a PAID read is still turn-scoped, not a job
    expect(toolEffect("add_clips")).toBe("project-mutation");
    expect(toolEffect("library_op")).toBe("project-mutation");
    expect(toolEffect("undo")).toBe("project-mutation");
    expect(toolEffect("download_video")).toBe("project-job");
    expect(toolEffect("generate_image")).toBe("project-job");
    expect(toolEffect("get_transcript")).toBe("derived-job");
    expect(toolEffect("new_project")).toBe("app-operation");
    expect(toolEffect("export")).toBe("deliverable");
    expect(toolEffect("pack_project")).toBe("deliverable");
  });

  it("isJobEffect / isMutationEffect select the right classes", () => {
    expect(isJobEffect("project-job")).toBe(true);
    expect(isJobEffect("derived-job")).toBe(true);
    expect(isJobEffect("read")).toBe(false);
    expect(isJobEffect("project-mutation")).toBe(false);
    expect(isMutationEffect("project-mutation")).toBe(true);
    expect(isMutationEffect("project-job")).toBe(false);
  });
});
