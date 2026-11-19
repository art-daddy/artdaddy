// The MCP instruction prose names tools by hand, in text the server never sees. That is a second
// copy of something the catalog already knows, so it drifts silently: COST_POLICY went on telling
// external agents to confirm before calling image_ask / vision_describe / find_content /
// extract_style long after those were withdrawn, which teaches an agent names it would then try.
// Anchor the prose to the catalog instead of re-checking it by hand.
import { readFileSync } from "node:fs";
import path from "node:path";

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
// Fields a tool's REPLY carries, which are not parameters. The prose names them so an agent reads
// the reply the way it was meant. Each one counts only while the code that builds the reply still
// returns it (a property of that name in the file that builds it), so a field the app stops
// returning is a ghost here like any withdrawn tool. The tool texts need not repeat it: the
// export list's old sentence about `retry_after_s` was the only place a catalog description
// documented that field, and it counted by accident, for a bullet about a different tool.
const REPLY_FIELDS: Readonly<Record<string, string>> = {
  eta_s: "tools/refState.ts",
  retry_after_s: "tools/refState.ts",
  time_left_s: "timeline/exportQueue.ts",
};
const SRC = path.resolve(__dirname, "..");

/** Whether `source` returns `field`: a property of that name (`name:`), which is how a reply object and its type spell one. */
function returns(source: string, field: string): boolean {
  return new RegExp(`\\b${field}\\s*:`).test(source);
}
const returned = (field: string): boolean =>
  returns(readFileSync(path.join(SRC, REPLY_FIELDS[field]), "utf8"), field);
const vocabulary = new Set([
  ...offered,
  ...MCP_ONLY,
  ...Object.values(paramsByTool()).flatMap((t) => t.params),
  ...Object.keys(REPLY_FIELDS).filter(returned),
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

  it("counts a reply field only while the code that builds the reply returns it", () => {
    // Not vacuous: every field the prose may name is returned today, by the file named for it.
    for (const field of Object.keys(REPLY_FIELDS)) expect(returned(field), field).toBe(true);
    // Both directions: a field the code does not return is a ghost; a reply object and its type both spell a real one.
    expect(returns("return { eta_s: 1, slow };", "retry_after_s")).toBe(false);
    expect(returns("// the retry_after_s of a reply", "retry_after_s")).toBe(false);
    expect(returns("const wait = { retry_after_s: 10 };", "retry_after_s")).toBe(true);
    expect(returns("interface Wait { eta_s: number }", "eta_s")).toBe(true);
    const ghosts = identifiersIn("pending:true with ghost_field_s and retry_after_s").filter(
      (n) => !vocabulary.has(n),
    );
    expect(ghosts).toEqual(["ghost_field_s"]);
  });
});
