// What an MCP agent must be told to confirm before it calls, derived from the code that decides it, and a check of a text
// against it. Shared by the tests of the cost text (src/mcp/instructions.cost.test.ts) and of what an agent that connects
// while the app is starting is handed (src/mcp/service.initialize.test.ts).
//
// Over MCP the cost text is the whole of the consent: the in-app approval bar (`needsApproval`, src/agent/loop.ts) is never
// asked by the bridge. So every call the in-app agent would stop for has to be named in that text, in a line that says to
// confirm first. Nothing here is a list of tool names: the tools come from the catalog (what is offered over MCP, what is
// flagged expensive, what values an argument can take) and the classes from the in-app gate, so a tool added to the catalog
// as expensive, or a new value of an argument that makes a call destructive, is required here without anyone writing it down.
import { toolsForSurface } from "../contract";
import {
  EXTERNAL_FETCH_TOOLS,
  LOCAL_COMPUTE_TOOLS,
  PAID_TOOLS,
  isDestructive,
} from "../agent/loop";

/** Why a call needs the person's yes: it spends their credits, it fetches from the internet, or it deletes their media. */
export type ConsentKind = "spends" | "fetches" | "deletes";

export interface ConsentNeed {
  tool: string;
  kind: ConsentKind;
  /** For a call that is destructive only with one value of one argument (`library_op` with `action: "delete"`). */
  when?: { param: string; value: string };
}

/** Every call an MCP agent must be told to confirm first, for the catalog that is loaded now. */
export function consentNeeds(): ConsentNeed[] {
  const needs: ConsentNeed[] = [];
  for (const tool of toolsForSurface("mcp")) {
    const name = tool.name;
    if (PAID_TOOLS.has(name)) needs.push({ tool: name, kind: "spends" });
    else if (EXTERNAL_FETCH_TOOLS.has(name)) needs.push({ tool: name, kind: "fetches" });
    // Flagged expensive and not deliberately classed as the person's own computer's work: it costs them something, and
    // nothing in the app asks first, so the words must.
    else if (tool.expensive && !LOCAL_COMPUTE_TOOLS.has(name))
      needs.push({ tool: name, kind: "spends" });
    for (const [param, schema] of Object.entries(tool.parameters?.properties ?? {})) {
      for (const value of (schema as { enum?: unknown[] }).enum ?? []) {
        if (typeof value === "string" && isDestructive(name, { [param]: value }))
          needs.push({ tool: name, kind: "deletes", when: { param, value } });
      }
    }
  }
  return needs;
}

/** What a line must also say, for each kind: what the call does, and to ask first. */
const SAYS: Record<ConsentKind, readonly RegExp[]> = {
  spends: [/\bcredits?\b/i, /\b(?:confirm|wait)\b/i],
  fetches: [/\b(?:internet|fetch(?:es|ing)?)\b/i, /\b(?:first|confirm)\b/i],
  deletes: [/\b(?:delete|deletes|removes?)\b/i, /\bconfirm\b/i],
};

/** The text as the lines an agent reads: each bullet (a line that starts with "- ") with its wrapped lines joined. */
export function textLines(text: string): string[] {
  return text
    .split(/\n(?=[ \t]*- )/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const names = (line: string, word: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_])${word}(?:[^A-Za-z0-9_]|$)`).test(line);

/** The needs that no line of `text` meets: a line that names the tool (and the argument's value, for a destructive one),
 *  says what the call does, and says to confirm first. */
export function unmetConsent(text: string, needs: ConsentNeed[] = consentNeeds()): ConsentNeed[] {
  const lines = textLines(text);
  return needs.filter(
    (need) =>
      !lines.some(
        (line) =>
          names(line, need.tool) &&
          (!need.when || names(line, need.when.value)) &&
          SAYS[need.kind].every((says) => says.test(line)),
      ),
  );
}
