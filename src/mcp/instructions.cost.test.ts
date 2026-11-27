// The cost text an MCP agent is handed cannot drift from what the app knows costs something.
//
// Over MCP there is no approval bar: the bridge never asks `needsApproval`, so a paid call runs the moment an agent makes it,
// and the only thing that asks the agent to check with the person first is the cost text in its instructions. That text
// names tools by hand, so it can silently fall behind the catalog. The calls it must name are DERIVED here (see
// src/test/mcpConsent.ts): every tool offered over MCP that the in-app agent would stop for, and every tool the catalog flags
// expensive that is not deliberately classed as the person's own computer's work. costPolicyDrift.test.ts holds the
// opposite direction (the text names nothing that is not real).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import canonical from "../contract/catalog.json";
import { setContract, toolsForSurface, type Catalog } from "../contract";
import { expensiveToolNames } from "../contract/views";
import { needsApproval } from "../agent/loop";
import { consentNeeds, textLines, unmetConsent } from "../test/mcpConsent";

const server = vi.hoisted(() => ({ signedIn: false, prompt: "" }));
vi.mock("../api/auth", () => ({ hasSession: async () => server.signedIn }));
vi.mock("../api/client", () => ({
  api: { instructions: async () => ({ instructions: server.prompt }) },
}));

/** The instruction module, loaded fresh by each test: its texts are built when it loads, and a test that loads it is then
 *  the one the mutation run credits with them. */
const instructions = () => import("./instructions");

/** The instructions an agent is handed: signed in (the shared prompt first, here one that says nothing about cost, so the
 *  MCP text must carry it alone), and signed out or offline (the MCP-only sections). */
async function handed(): Promise<Array<[string, string]>> {
  const { mcpInstructions, __testing } = await instructions();
  __testing.reset();
  server.signedIn = true;
  server.prompt = "SHARED PROMPT: edit the timeline the person asks for.";
  const online = await mcpInstructions();
  __testing.reset();
  server.signedIn = false;
  const offline = await mcpInstructions();
  return [
    ["signed in", online],
    ["signed out or offline", offline],
  ];
}

beforeEach(() => {
  vi.resetModules();
  setContract(canonical as Catalog);
});

afterEach(() => {
  setContract(canonical as Catalog);
});

describe("the cost text an MCP agent is handed", () => {
  it("names every call that spends credits, fetches from the internet or deletes media, in a line that says to confirm first", async () => {
    const texts = await handed();
    const [[, online], [, offline]] = texts;
    expect(online).toContain("SHARED PROMPT");
    expect(offline).not.toContain("SHARED PROMPT");
    for (const [when, text] of texts) {
      expect(unmetConsent(text), `${when}: calls the agent is never told to confirm`).toEqual([]);
    }
  });

  it("is checked against everything the in-app agent would stop for, so the walk cannot be empty", () => {
    const needs = consentNeeds();
    const required = new Set(needs.map((need) => need.tool));
    // Every MCP tool the in-app approval bar stops for, by its name or by a value of one of its arguments, is required.
    for (const tool of toolsForSurface("mcp")) {
      const stops =
        needsApproval(tool.name) ||
        Object.entries(tool.parameters?.properties ?? {}).some(([param, schema]) =>
          ((schema as { enum?: unknown[] }).enum ?? []).some((value) =>
            needsApproval(tool.name, { [param]: value }),
          ),
        );
      if (stops) expect(required, tool.name).toContain(tool.name);
    }
    // And it still finds the calls this text was written for: the four generators and both video tools spend, the two
    // fetchers fetch, and deleting from the library deletes.
    const of = (kind: string) => needs.filter((need) => need.kind === kind).map((n) => n.tool);
    expect(of("spends")).toEqual(
      expect.arrayContaining([
        "generate_image",
        "generate_video",
        "generate_voiceover",
        "generate_music",
        "video_ask",
        "video_find_moment",
      ]),
    );
    expect(of("fetches")).toEqual(expect.arrayContaining(["download_video", "get_page_image"]));
    expect(needs).toContainEqual({
      tool: "library_op",
      kind: "deletes",
      when: { param: "action", value: "delete" },
    });
  });

  it("fails for a tool added to the catalog as expensive that the text does not name", async () => {
    const { COST_POLICY } = await instructions();
    // The point of deriving the list: nobody has to remember to add the new tool here.
    const newTool = {
      name: "generate_hologram",
      description: "Generate a hologram.",
      expensive: true,
      status: "active",
      surfaces: ["app", "mcp"],
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
    };
    setContract({ ...(canonical as Catalog), tools: [...canonical.tools, newTool] });
    expect(expensiveToolNames()).toContain("generate_hologram");
    expect(unmetConsent(COST_POLICY)).toEqual([{ tool: "generate_hologram", kind: "spends" }]);
  });

  it("fails for a paid tool moved out of the line that says it spends credits, not only for one deleted", async () => {
    const { COST_POLICY } = await instructions();
    // video_ask taken out of the credits line and named elsewhere, as a plain read.
    const withoutIt = COST_POLICY.replace(/\bvideo_ask\b(?:,| and)?\s*/, "");
    expect(withoutIt).not.toMatch(/\bvideo_ask\b/);
    const moved = `${withoutIt}\n- video_ask only looks at a clip, like any read.`;
    expect(unmetConsent(moved).map((need) => need.tool)).toEqual(["video_ask"]);
    // A delete line that no longer says to confirm is caught too.
    const deleteLine = textLines(COST_POLICY).find((line) => /library_op/.test(line)) ?? "";
    const unconfirmed = COST_POLICY.replace(/\s*Confirm first\.?/, "");
    expect(unconfirmed, `the delete line was: ${deleteLine}`).not.toBe(COST_POLICY);
    expect(unmetConsent(unconfirmed)).toEqual([
      { tool: "library_op", kind: "deletes", when: { param: "action", value: "delete" } },
    ]);
  });

  // KNOWN GAP, kept as an expected failure. Nothing classes `web_search` as a call that costs anything: the catalog does
  // not flag it expensive (although its own note there mentions a server fallback) and the in-app gate does not class it,
  // so the walk above does not require it and the cost text does not name it. Which it is gets decided in the catalog
  // (src/contract/catalog.json, then codegen), which only the owner changes. If it is classed there, the walk requires it and
  // this passes: then remove `.fails`. If it is decided that it costs nothing, delete this test.
  it.fails("tells an agent to check with the person before web_search", async () => {
    for (const [when, text] of await handed()) {
      const asked = textLines(text).some(
        (line) => /\bweb_search\b/.test(line) && /\b(?:confirm|wait|first)\b/i.test(line),
      );
      expect(asked, `${when}: no line names web_search and says to ask first`).toBe(true);
    }
  });
});
