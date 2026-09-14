// The completion rule is transport-specific, and getting it wrong is invisible: the model
// simply promises to "check back" and the user waits forever for a message MCP cannot send.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as boolean[], text: "", fail: false }));

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

beforeEach(() => {
  __testing.reset();
  h.calls = [];
  h.text = "SHARED PROMPT";
  h.fail = false;
});

describe("MCP instructions", () => {
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
