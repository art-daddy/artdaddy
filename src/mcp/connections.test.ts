// Who has connected to the MCP server, and when each last asked for something.
//
// The point is that a person who has just pasted the setup into Claude Code can SEE it worked, so the rules that matter
// are about what is listed and what it says: nobody is listed until a program announced itself or asked for something,
// each program once, most recently active first, the list never grows without bound (a name is whatever a local
// program announces), and the words say how long ago without ever being empty or wrong-signed.
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { MCP_CLIENTS, MCP_CLIENT_TITLES, MCP_CLIENT_NAME_MAX } from "./clientName";
import {
  ACTIVE_WINDOW_MS,
  MAX_CONNECTED_PROGRAMS,
  agoLabel,
  isActive,
  programTitle,
  useMcpConnections,
} from "./connections";

const claude = { name: "claude-code", version: "2.1.4" };
const cursor = { name: "cursor-vscode", version: "1.0.0" };
const listed = () => useMcpConnections.getState().programs;

beforeEach(() => useMcpConnections.getState().clear());

describe("who is listed", () => {
  it("lists nobody until a program announces itself or asks for something", () => {
    expect(listed()).toEqual([]);
    useMcpConnections.getState().connected(claude, 1_000);
    expect(listed()).toHaveLength(1);
  });

  it("lists a program once, keeping when it first connected and counting what it asked for", () => {
    const { connected, asked } = useMcpConnections.getState();
    connected(claude, 1_000);
    asked(claude, 2_000);
    asked(claude, 5_000);

    expect(listed()).toEqual([
      {
        key: "claude-code|2.1.4",
        client: "claude_code",
        name: "claude-code",
        version: "2.1.4",
        connectedAt: 1_000,
        lastActiveAt: 5_000,
        requests: 2, // connecting is not a request
      },
    ]);
  });

  it("lists a program that asks without having announced itself in this run, as it announced itself on the request", () => {
    useMcpConnections.getState().asked(cursor, 3_000);
    expect(listed()).toMatchObject([{ client: "cursor", connectedAt: 3_000, requests: 1 }]);
  });

  it("keeps two versions of one program apart, and the one that asked last first", () => {
    const { connected, asked } = useMcpConnections.getState();
    connected({ name: "claude-code", version: "2.0.0" }, 1_000);
    connected({ name: "claude-code", version: "2.1.0" }, 2_000);
    asked({ name: "claude-code", version: "2.0.0" }, 3_000);

    expect(listed().map((p) => p.version)).toEqual(["2.0.0", "2.1.0"]);
  });

  it.each([undefined, null, "claude-code", 42, [], {}, { name: 7 }, { name: "", version: "1" }])(
    "lists a program that announced nothing usable (%j) as one unknown agent, and never fails",
    (info) => {
      useMcpConnections.getState().connected(info, 1_000);
      useMcpConnections.getState().asked(info, 2_000);
      expect(listed()).toMatchObject([{ client: "unknown", key: "unknown", requests: 1 }]);
    },
  );

  it("empties the list when the server is switched off", () => {
    useMcpConnections.getState().connected(claude, 1_000);
    useMcpConnections.getState().clear();
    expect(listed()).toEqual([]);
  });

  it("lists, whatever happens, no more than the cap, each program once, the most recent first", () => {
    // Names are whatever a local program announces: a flood of them must not grow the list or the screen.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
            version: fc.constantFrom("1", "2"),
            asks: fc.boolean(),
          }),
          { maxLength: 80 },
        ),
        (events) => {
          useMcpConnections.getState().clear();
          events.forEach((e, i) => {
            const info = { name: e.name, version: e.version };
            if (e.asks) useMcpConnections.getState().asked(info, i);
            else useMcpConnections.getState().connected(info, i);
          });

          const programs = listed();
          expect(programs.length).toBeLessThanOrEqual(MAX_CONNECTED_PROGRAMS);
          expect(new Set(programs.map((p) => p.key)).size).toBe(programs.length);
          const times = programs.map((p) => p.lastActiveAt);
          expect(times).toEqual([...times].sort((a, b) => b - a));
          // The program heard from last is always on the list, and at the top.
          if (events.length > 0) {
            const last = events[events.length - 1];
            expect(programs[0]).toMatchObject({
              name: last.name,
              version: last.version,
              lastActiveAt: events.length - 1,
            });
          }
        },
      ),
    );
  });

  it("counts exactly what each program asked for and remembers when it first appeared, while the list has room", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ name: fc.constantFrom("a", "b", "c"), asks: fc.boolean() }), {
          minLength: 1,
          maxLength: 60,
        }),
        (events) => {
          useMcpConnections.getState().clear();
          events.forEach((e, i) => {
            const info = { name: e.name, version: "1" };
            if (e.asks) useMcpConnections.getState().asked(info, 100 + i);
            else useMcpConnections.getState().connected(info, 100 + i);
          });
          for (const p of listed()) {
            const mine = events
              .map((e, i) => ({ ...e, at: 100 + i }))
              .filter((e) => e.name === p.name);
            expect(p.requests).toBe(mine.filter((e) => e.asks).length);
            expect(p.connectedAt).toBe(mine[0].at);
            expect(p.lastActiveAt).toBe(mine[mine.length - 1].at);
          }
        },
      ),
    );
  });

  it("keeps only a name's own characters, cut short, so nothing odd reaches the screen", () => {
    useMcpConnections
      .getState()
      .connected({ name: `<b>${"x".repeat(100)}</b>`, version: "1.0 beta" }, 1_000);
    const [p] = listed();
    expect(p.name).toMatch(/^[A-Za-z0-9_.:-]+$/);
    expect(p.name.length).toBeLessThanOrEqual(MCP_CLIENT_NAME_MAX);
    expect(p.version).toMatch(/^[A-Za-z0-9_.:-]*$/);
  });
});

describe("what the panel calls a program", () => {
  it("has a name for every label a program can be counted under, and for nothing else", () => {
    // Anchored to the list the labels come from, so a label added there cannot reach the screen nameless.
    expect(Object.keys(MCP_CLIENT_TITLES).sort()).toEqual([...MCP_CLIENTS].sort());
    const titles = Object.values(MCP_CLIENT_TITLES);
    expect(titles.every((t) => t.trim().length > 0)).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("uses a program's own announced name only when it has no label of its own", () => {
    expect(programTitle({ client: "claude_code", name: "claude-code" })).toBe("Claude Code");
    expect(programTitle({ client: "other", name: "Brand_New_Agent" })).toBe("Brand_New_Agent");
    expect(programTitle({ client: "other", name: "" })).toBe(MCP_CLIENT_TITLES.other);
    expect(programTitle({ client: "unknown", name: "" })).toBe("An agent");
  });

  it("calls a program connected while it has asked within the window, and seen earlier after it", () => {
    useMcpConnections.getState().asked(claude, 1_000);
    const [p] = listed();
    expect(isActive(p, 1_000 + ACTIVE_WINDOW_MS)).toBe(true);
    expect(isActive(p, 1_000 + ACTIVE_WINDOW_MS + 1)).toBe(false);
  });
});

describe("how long ago", () => {
  it.each([
    [0, "just now"],
    [4_999, "just now"],
    [5_000, "5 s ago"],
    [59_999, "59 s ago"],
    [60_000, "1 min ago"],
    [3_599_999, "59 min ago"],
    [3_600_000, "1 h ago"],
    [86_399_999, "23 h ago"],
    [86_400_000, "1 d ago"],
    [-5_000, "just now"], // a clock that moved backwards
    [Number.NaN, "just now"],
    [Number.POSITIVE_INFINITY, "just now"],
  ])("says %j as %s", (ms, words) => {
    expect(agoLabel(ms)).toBe(words);
  });

  it("never fails, is never empty, and never says a longer time in a smaller unit", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e12, max: 1e12, noNaN: false }), (ms) => {
        const words = agoLabel(ms);
        expect(words).toMatch(/^(just now|\d+ (s|min|h|d) ago)$/);
        const n = Number(/^(\d+)/.exec(words)?.[1] ?? 0);
        if (words.endsWith(" s ago")) expect(n).toBeLessThan(60);
        if (words.endsWith(" min ago")) expect(n).toBeLessThan(60);
        if (words.endsWith(" h ago")) expect(n).toBeLessThan(24);
      }),
    );
  });
});
