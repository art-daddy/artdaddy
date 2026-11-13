// UJ-085: a setup that was written and produced no connection says so after three minutes, under that app's entry, and never when it
// would be false: too young, the server off or only just back on, or a program of that kind has connected at any time in this run. The next step
// must exist for every app the panel lists (the panel test walks the real list).
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { MCP_CLIENTS, type McpClient } from "./clientName";
import { NEXT_STEP, SETUP_HINT_AFTER_MS, setupHint, useMcpSetups } from "./setups";

const T0 = 1_000_000;
const none: Partial<Record<McpClient, true>> = {};

beforeEach(() => useMcpSetups.getState().clear());

describe("the hint for a setup that has produced nothing", () => {
  it("is silent while the setup is younger than three minutes and speaks at exactly three", () => {
    expect(
      setupHint("claude_desktop", T0, T0, none, T0 + SETUP_HINT_AFTER_MS - 1, true),
    ).toBeNull();
    const hint = setupHint("claude_desktop", T0, T0, none, T0 + SETUP_HINT_AFTER_MS, true);
    expect(hint).toEqual({ ago: "3 min ago", next: NEXT_STEP.claude_desktop });
  });

  it("is silent when no setup was written for that app, or the server is off", () => {
    const late = T0 + 10 * SETUP_HINT_AFTER_MS;
    expect(setupHint("codex", undefined, T0, none, late, true)).toBeNull();
    expect(setupHint("codex", T0, null, none, late, false)).toBeNull();
  });

  it("counts the three minutes from the later of the setup and the server coming up: an app cannot connect to a server that is down", () => {
    const setup = T0;
    const serverBack = T0 + 10 * SETUP_HINT_AFTER_MS;
    expect(setupHint("cursor", setup, serverBack, none, serverBack + 1_000, true)).toBeNull();
    const hint = setupHint(
      "cursor",
      setup,
      serverBack,
      none,
      serverBack + SETUP_HINT_AFTER_MS,
      true,
    );
    expect(hint).toEqual({ ago: "33 min ago", next: NEXT_STEP.cursor }); // still says how long ago it was set up
  });

  it("goes for an app that has connected at any time in this run, and only for that kind", () => {
    const late = T0 + 5 * SETUP_HINT_AFTER_MS;
    expect(setupHint("cursor", T0, T0, { cursor: true }, late, true)).toBeNull();
    expect(setupHint("cursor", T0, T0, { codex: true }, late, true)).not.toBeNull();
  });

  it("is silent for an app that has no next step to give (so the panel never says 'Next:' and nothing)", () => {
    expect(setupHint("other", T0, T0, none, T0 + 5 * SETUP_HINT_AFTER_MS, true)).toBeNull();
    expect(setupHint("unknown", T0, T0, none, T0 + 5 * SETUP_HINT_AFTER_MS, true)).toBeNull();
  });

  it("property: it speaks exactly when the setup and the server are old enough, the server is on, nothing of that kind was ever seen and a next step exists", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MCP_CLIENTS),
        fc.option(fc.integer({ min: 0, max: 10 * SETUP_HINT_AFTER_MS }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 10 * SETUP_HINT_AFTER_MS }), { nil: null }),
        fc.integer({ min: 0, max: 20 * SETUP_HINT_AFTER_MS }),
        fc.boolean(),
        fc.array(fc.constantFrom(...MCP_CLIENTS), { maxLength: 4 }),
        (client, writtenAt, serverOnSince, now, running, kinds) => {
          const seen = Object.fromEntries(kinds.map((k) => [k, true]));
          const hint = setupHint(client, writtenAt, serverOnSince, seen, now, running);
          const waitedFrom =
            writtenAt === undefined ? 0 : Math.max(writtenAt, serverOnSince ?? writtenAt);
          const expected =
            running &&
            writtenAt !== undefined &&
            now - waitedFrom >= SETUP_HINT_AFTER_MS &&
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
