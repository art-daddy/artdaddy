import { describe, expect, it } from "vitest";

import { clientLoopEnabled } from "./flag";

describe("clientLoopEnabled", () => {
  it("always returns true — the client owns the agent loop", () => {
    expect(clientLoopEnabled()).toBe(true);
  });
});
