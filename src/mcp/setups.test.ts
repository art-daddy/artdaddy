// UJ-085: a setup that was written and produced no connection says so after three minutes, under that app's entry, and never when it
// would be false: too young, the server off, or a program of that kind has connected. The next step must exist for every app the panel
// lists (the panel test walks the real list).
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { MCP_CLIENTS, type McpClient } from "./clientName";
import { NEXT_STEP, SETUP_HINT_AFTER_MS, setupHint, useMcpSetups } from "./setups";

const T0 = 1_000_000;
const none: Array<{ client: McpClient }> = [];

beforeEach(() => useMcpSetups.getState().clear());

describe("the hint for a setup that has produced nothing", () => {
  it("is silent while the setup is younger than three minutes and speaks at exactly three", () => {
    expect(setupHint("claude_desktop", T0, none, T0 + SETUP_HINT_AFTER_MS - 1, true)).toBeNull();
    const hint = setupHint("claude_desktop", T0, none, T0 + SETUP_HINT_AFTER_MS, true);
    expect(hint).toEqual({ ago: "3 min ago", next: NEXT_STEP.claude_desktop });
  });

  it("is silent when no setup was written for that app, or the server is off", () => {
    expect(setupHint("codex", undefined, none, T0 + 10 * SETUP_HINT_AFTER_MS, true)).toBeNull();
    expect(setupHint("codex", T0, none, T0 + 10 * SETUP_HINT_AFTER_MS, false)).toBeNull();
  });

  it("goes the moment a program of that kind has connected, and only for that kind", () => {
    const late = T0 + 5 * SETUP_HINT_AFTER_MS;
    expect(setupHint("cursor", T0, [{ client: "cursor" }], late, true)).toBeNull();
    expect(setupHint("cursor", T0, [{ client: "codex" }], late, true)).not.toBeNull();
  });

  it("is silent for an app that has no next step to give (so the panel never says 'Next:' and nothing)", () => {
    expect(setupHint("other", T0, none, T0 + 5 * SETUP_HINT_AFTER_MS, true)).toBeNull();
    expect(setupHint("unknown", T0, none, T0 + 5 * SETUP_HINT_AFTER_MS, true)).toBeNull();
  });

  it("property: it speaks exactly when the setup is old enough, the server is on, nothing of that kind connected and a next step exists", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MCP_CLIENTS),
        fc.option(fc.integer({ min: 0, max: 10 * SETUP_HINT_AFTER_MS }), { nil: undefined }),
        fc.integer({ min: 0, max: 20 * SETUP_HINT_AFTER_MS }),
        fc.boolean(),
        fc.array(fc.constantFrom(...MCP_CLIENTS), { maxLength: 4 }),
        (client, writtenAt, now, running, kinds) => {
          const hint = setupHint(
            client,
            writtenAt,
            kinds.map((k) => ({ client: k })),
            now,
            running,
          );
          const expected =
            running &&
            writtenAt !== undefined &&
            now - writtenAt >= SETUP_HINT_AFTER_MS &&
            !kinds.includes(client) &&
            NEXT_STEP[client] !== undefined;
          expect(hint !== null).toBe(expected);
          if (hint) expect(hint.next).toBe(NEXT_STEP[client]);
        },
      ),
    );
  });
});

describe("what was written", () => {
  it("remembers the newest time per app, apart from the others, and forgets on clear", () => {
    const { wrote, clear } = useMcpSetups.getState();
    wrote("cursor", 10);
    wrote("codex", 20);
    wrote("cursor", 30);
    expect(useMcpSetups.getState().written).toEqual({ cursor: 30, codex: 20 });
    clear();
    expect(useMcpSetups.getState().written).toEqual({});
  });
});
