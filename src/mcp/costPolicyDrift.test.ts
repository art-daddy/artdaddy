// The MCP instruction prose names tools by hand, in text the server never sees. That is a second
// copy of something the catalog already knows, so it drifts silently: COST_POLICY went on telling
// external agents to confirm before calling image_ask / vision_describe / find_content /
// extract_style long after those were withdrawn, which teaches an agent names it would then try.
// Anchor the prose to the catalog instead of re-checking it by hand.
import { describe, expect, it } from "vitest";

import { paramsByTool, toolNames } from "../contract/views";
import { COST_POLICY, ASYNC_JOBS, PROJECT_NAVIGATION } from "./instructions";

/** Identifiers as written in the prose: snake_case runs of 2+ words. Over-broad on purpose — an
 *  agent reading `media_ref` or `image_ask` cannot tell a param from a tool either, so both have
 *  to be real. */
function identifiersIn(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];
}

const offered = new Set(toolNames());
// manage_project exists only for MCP (an external session has no window to click in), so it is
// callable without appearing in the server catalog.
const MCP_ONLY = ["manage_project"];
const vocabulary = new Set([
  ...offered,
  ...MCP_ONLY,
  ...Object.values(paramsByTool()).flatMap((t) => t.params),
]);

describe("MCP instruction prose vs the tool catalog", () => {
  for (const [label, text] of [
    ["COST_POLICY", COST_POLICY],
    ["ASYNC_JOBS", ASYNC_JOBS],
    ["PROJECT_NAVIGATION", PROJECT_NAVIGATION],
  ] as const) {
    it(`${label} names only tools and params that still exist`, () => {
      const ghosts = identifiersIn(text).filter((n) => !vocabulary.has(n));
      expect(ghosts, `named in ${label} but withdrawn from (or never in) the catalog`).toEqual([]);
    });
  }

  it("still names the paid tools that ARE offered, so the warning has not been emptied out", () => {
    // The opposite failure direction: deleting the list entirely would satisfy the drift check
    // above while stripping every "ask before you spend the user's money" warning from a session
    // that, unlike the in-app UI, has no approval prompt of its own.
    const named = new Set(identifiersIn(COST_POLICY));
    const paid = ["generate_image", "generate_video", "generate_voiceover", "generate_music"];
    for (const tool of paid.filter((t) => offered.has(t))) {
      expect(named, `${tool} is offered and spends credits but COST_POLICY is silent`).toContain(
        tool,
      );
    }
  });
});
