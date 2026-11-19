// The completion rule is transport-specific, and getting it wrong is invisible: the model
// simply promises to "check back" and the user waits forever for a message MCP cannot send.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as boolean[], text: "", fail: false }));
const session = vi.hoisted(() => ({ present: true }));
vi.mock("../api/auth", () => ({ hasSession: async () => session.present }));

vi.mock("../api/client", () => ({
  api: {
    instructions: async (hostNotifies = true) => {
      h.calls.push(hostNotifies);
      if (h.fail) throw new Error("offline");
      return { instructions: h.text };
    },
  },
}));

import { ASYNC_JOBS, mcpInstructions, __testing } from "./instructions";
import { paramsByTool } from "../contract/views";

beforeEach(() => {
  __testing.reset();
  h.calls = [];
  h.text = "SHARED PROMPT";
  h.fail = false;
  session.present = true;
});

describe("MCP instructions", () => {
  it("uses local guidance before sign-in without making an unauthenticated request", async () => {
    session.present = false;
    const early = await mcpInstructions();
    expect(h.calls).toEqual([]);
    expect(early).toContain(ASYNC_JOBS);
    session.present = true;
    const ready = await mcpInstructions();
    expect(ready).toContain("SHARED PROMPT");
    expect(h.calls).toEqual([false]);
  });

  it("asks the server for the prompt that does NOT promise a completion message", async () => {
    await mcpInstructions();
    expect(h.calls).toEqual([false]);
  });

  it("tells the agent nothing will wake it, and where to check instead", async () => {
    const text = await mcpInstructions();
    expect(text).toContain("SHARED PROMPT");
    expect(text).toMatch(/NOTHING will tell you when one lands/);
    expect(text).toContain("library_op");
    expect(text).toContain("manage_exports");
  });

  it("has the LAST word when an older server ignores the flag and sends the in-app rule", async () => {
    // Version skew is the real failure here: a backend that predates `host_notifies` returns
    // the in-app "you WILL be told" wording. Ours has to come after it, not before.
    h.text = "You WILL be told in this conversation when each one finishes.";
    const text = await mcpInstructions();
    expect(text.indexOf(ASYNC_JOBS)).toBeGreaterThan(text.indexOf("WILL be told"));
  });

  it("keeps the rule when the backend is unreachable", async () => {
    // The rule lives here, not in the fetched prompt, precisely so this case still has it.
    h.fail = true;
    expect(await mcpInstructions()).toContain(ASYNC_JOBS);
  });
});

// The assistant's export habits are fixed by words alone (no code guard), so what is asserted is
// the text an agent is actually handed, not the constant's shape.
describe("the export rules an MCP agent is handed", () => {
  const RULES = [
    /Exports run one at a time: start ONE; no second, and no cancel of a running one, unless the person asked/,
    /Never guess how long one takes; when asked, give manage_exports' `time_left_s`/,
    /Leave `resolution`, `quality` and `fps` out unless the person names one; never lower them to speed it up/,
    /On a failure, say in plain words what happened and offer to try again as it was, only on their yes/,
  ];

  it("reach the agent with the shared prompt and without it", async () => {
    const online = await mcpInstructions();
    __testing.reset();
    h.fail = true;
    const offline = await mcpInstructions();
    expect(online).toContain("SHARED PROMPT");
    expect(offline).not.toContain("SHARED PROMPT");
    for (const text of [online, offline])
      for (const rule of RULES) expect(text.replace(/\s+/g, " ")).toMatch(rule);
  });

  it("name the export settings only through parameters `export` really has", () => {
    const params = paramsByTool().export?.params ?? [];
    for (const name of ["resolution", "quality", "fps"]) {
      expect(ASYNC_JOBS).toContain(`\`${name}\``);
      expect(params).toContain(name);
    }
  });

  it("offer no lighter export, quote no expected time, promise no speed-up and no picture", () => {
    // Both directions: a planted promise is caught, and the legitimate words pass.
    const PROMISE =
      /\b(?:twice|double|\d+(?:\.\d+)?\s*(?:x|times))\s+(?:as\s+)?(?:fast|quick|the speed)|\bhalf the time\b|\d+\s*(?:%|percent)\s+(?:faster|quicker)|\b(?:same pixels|identical|unchanged picture)\b/i;
    for (const bad of ["twice as fast", "half the time", "3 times quicker", "the same pixels"])
      expect(`a lower setting takes ${bad}`).toMatch(PROMISE);
    expect(
      "a lower setting may render sooner; `time_left_s` is the only time to quote",
    ).not.toMatch(PROMISE);
    expect(ASYNC_JOBS.replace(/\s+/g, " ")).not.toMatch(PROMISE);
    // The old advice must not come back: the app gives no expected time, and nothing offers a lighter export.
    expect(ASYNC_JOBS.replace(/\s+/g, " ")).not.toMatch(/lighter export|expected_s|how long it is expected|may be quicker/i);
  });
});
