// Starting the server while something else still holds the port.
//
// Four people in four weeks found the server not running seconds after relaunching the app, with a raw "os error 10048" and
// advice to look in a system tray the app does not have. The rules here are about what the person gets, not how it is
// done: a port let go in time starts the server, a start never waits longer than it says, nothing starts after a switch-off,
// and what is shown and what is counted say who held the port without ever carrying the raw message.
//
// These drive the real `startMcpServer` / `initMcp`, faking only Tauri's IPC and time.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BindClock } from "./service";

let nowMs = 0;
let elapsed: () => number = () => nowMs;
let serverUp = false;
let script: (cmd: string, args?: unknown) => unknown = () => {
  throw new Error("no script");
};
const calls: Array<{ cmd: string; at: number }> = [];
const reported: Array<[string, unknown]> = [];

vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: { localTools: true, fileSystem: true }, apiBaseUrl: "" },
}));
vi.mock("../observability/sentry", () => ({ captureError: () => undefined }));
vi.mock("../api/appEvents", () => ({
  reportMcpEvent: (event: string, detail: unknown) => void reported.push([event, detail]),
}));
vi.mock("./instructions", () => ({ mcpInstructions: async () => "instructions" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.push({ cmd, at: elapsed() });
    return script(cmd, args);
  },
}));

const TAKEN =
  "could not bind 127.0.0.1:19787: Only one usage of each socket address (protocol/network address/port) is normally permitted. (os error 10048)";
const RESERVED =
  "could not bind 127.0.0.1:19787: An attempt was made to access a socket in a way forbidden by its access permissions. (os error 10013)";

type Holder = Record<string, unknown> | "unreadable";

/** The desktop side with the port held until `releaseAt` ms after the test began. Tauri rejects with the bare string. */
function portHeldUntil(releaseAt: number, holder: Holder = { holder: "artdaddy" }) {
  return (cmd: string): unknown => {
    switch (cmd) {
      case "mcp_set_instructions":
        return undefined; // the bridge hands the desktop side the agent instructions as it wires up
      case "mcp_start":
        if (elapsed() < releaseAt) return Promise.reject(TAKEN);
        serverUp = true;
        return { running: true, port: 19787 };
      case "mcp_stop":
        serverUp = false;
        return { running: false, port: 19787 };
      case "mcp_status":
        return { running: serverUp, port: 19787 };
      case "mcp_port_holder":
        return holder === "unreadable" ? Promise.reject(new Error("no such command")) : holder;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  };
}

/** Ten seconds of waiting in no time: sleeping only moves the clock. */
const clock: BindClock = {
  now: () => nowMs,
  sleep: async (ms) => {
    nowMs += ms;
  },
};

const load = () => import("./service");
// The commands that matter to the server, in the order they were sent.
const sent = () => calls.map((c) => c.cmd).filter((cmd) => cmd !== "mcp_set_instructions");
const startsMade = () => calls.filter((c) => c.cmd === "mcp_start").length;

const realSetImmediate = globalThis.setImmediate;

/** Everything a start needs is loaded BEFORE time is faked. A first import is real I/O, and fake time would run out
 *  while a start still waits for it. */
async function loadWithFakeTime() {
  const service = await load();
  await import("../store/mcpPanel");
  await import("@tauri-apps/api/core");
  await import("@tauri-apps/api/event");
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const began = Date.now();
  elapsed = () => Date.now() - began;
  return service;
}

/** Runs fake time until the promise has settled, moving it only when the start is really sleeping on a timer: never while
 *  it waits on real I/O, which would spend the wait before the first attempt. */
async function runUntilSettled<T>(promise: Promise<T>, realLimitMs = 10_000): Promise<T> {
  const state = { settled: false };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  const deadline = performance.now() + realLimitMs;
  while (!state.settled) {
    if (performance.now() > deadline) throw new Error("the start never settled");
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
  return promise;
}

beforeEach(() => {
  vi.resetModules();
  nowMs = 0;
  elapsed = () => nowMs;
  serverUp = false;
  calls.length = 0;
  reported.length = 0;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting while something else still holds the port", () => {
  it("starts whenever the port is let go in time, never waits longer than it says, and says so once", async () => {
    const { startMcpServer, MCP_BIND_WAIT_MS, McpPortTakenError } = await load();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 15_000 }), async (releaseAt) => {
        nowMs = 0;
        calls.length = 0;
        reported.length = 0;
        serverUp = false;
        script = portHeldUntil(releaseAt);

        const outcome = await startMcpServer({ where: "boot", clock }).then(
          (status) => ({ status }),
          (error: unknown) => ({ error }),
        );

        // Nothing it does ever runs past the wait it states.
        expect(nowMs).toBeLessThanOrEqual(MCP_BIND_WAIT_MS);

        if (releaseAt <= MCP_BIND_WAIT_MS - 1_000) {
          // Freed with a second to spare: the server starts, soon after it was let go.
          expect(outcome).toEqual({ status: { running: true, port: 19787 } });
          expect(nowMs - releaseAt).toBeLessThan(1_000);
        }
        if (releaseAt > MCP_BIND_WAIT_MS) {
          // Still held when the wait ends: a failure that carries who held it, asked for once and last.
          expect((outcome as { error: unknown }).error).toBeInstanceOf(McpPortTakenError);
          expect(calls.filter((c) => c.cmd === "mcp_port_holder")).toHaveLength(1);
          expect(calls.at(-1)?.cmd).toBe("mcp_port_holder");
          expect(reported).toEqual([]);
        }
        if ("status" in outcome) {
          // A wait is reported when there was one, with the seconds it took, and never when the first try worked.
          if (nowMs === 0) {
            expect(reported).toEqual([]);
          } else {
            expect(reported).toHaveLength(1);
            const [event, detail] = reported[0] as [string, { reason: string }];
            expect(event).toBe("mcp_bind_waited");
            const seconds = Number(/^(\d+)s:boot$/.exec(detail.reason)?.[1]);
            expect(seconds).toBeGreaterThanOrEqual(Math.max(1, Math.floor(nowMs / 1_000)));
            expect(seconds).toBeLessThanOrEqual(MCP_BIND_WAIT_MS / 1_000);
          }
        }
      }),
      { numRuns: 80 },
    );
  });

  it.each([
    ["a port Windows keeps for something else", RESERVED, "port_reserved:toggle"],
    [
      "a refusal of another kind",
      "could not bind: access denied for C:\\Users\\ada",
      "other:toggle",
    ],
  ])("does not wait, or look for a holder, for %s", async (_what, message, reason) => {
    const { startMcpServer, mcpBindFailureReason } = await load();
    script = (cmd) => {
      if (cmd === "mcp_start") return Promise.reject(new Error(message));
      return undefined; // the instructions the bridge hands over; anything else asked would show in `sent()`
    };

    const error = await startMcpServer({ where: "toggle", clock }).catch((e: unknown) => e);

    expect(sent()).toEqual(["mcp_start"]);
    expect(nowMs).toBe(0); // it did not sleep
    expect(mcpBindFailureReason(error, "toggle")).toBe(reason);
  });

  it("does not turn a refusal it cannot read into a wait", async () => {
    const { startMcpServer, classifyBindError } = await load();
    script = (cmd) => (cmd === "mcp_start" ? Promise.reject(undefined) : undefined);
    const error = await startMcpServer({ clock }).catch((e: unknown) => e);
    expect(classifyBindError(error)).toBe("other");
    expect(startsMade()).toBe(1);
  });

  it("still explains a taken port when who holds it cannot be found out", async () => {
    const { startMcpServer, MCP_PORT, explainMcpError, mcpBindFailureReason } = await load();
    script = portHeldUntil(Number.POSITIVE_INFINITY, "unreadable");
    const error = await startMcpServer({ where: "boot", clock }).catch((e: unknown) => e);
    expect(mcpBindFailureReason(error, "boot")).toBe("port_in_use:boot");
    expect(explainMcpError(error)).toContain(String(MCP_PORT));
  });
});

describe("switching the server off while a start is still waiting", () => {
  it("ends the wait, and no start reaches the server after the stop", async () => {
    const { startMcpServer, stopMcpServer, McpStartCancelled, mcpLastError } = await load();
    script = portHeldUntil(Number.POSITIVE_INFINITY);
    let stopped: Promise<unknown> | undefined;
    const stopsAt1500: BindClock = {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
        if (nowMs === 1_500) stopped = stopMcpServer();
      },
    };

    await expect(startMcpServer({ where: "boot", clock: stopsAt1500 })).rejects.toBeInstanceOf(
      McpStartCancelled,
    );
    await stopped;

    const order = sent();
    expect(order.at(-1)).toBe("mcp_stop"); // the last thing that reached the server...
    expect(startsMade()).toBe(3); // ...after only the attempts made before it was asked
    expect(order).not.toContain("mcp_port_holder"); // nobody asks who holds a port nobody wants any more
    expect(reported).toEqual([]); // a cancelled start is not a failure
    expect(mcpLastError()).toBeNull();
    expect(serverUp).toBe(false);
  });

  it("a start made straight after the stop is a new one, and never reaches the server before the stop has finished", async () => {
    const { startMcpServer, stopMcpServer, McpStartCancelled } = await load();
    const held = portHeldUntil(1_500); // let go just as the person switches it off and on again
    // The stop takes a moment to reach the server and finish; a start that did not wait for it would be undone by it.
    script = (cmd) => {
      if (cmd !== "mcp_stop") return held(cmd);
      return new Promise((resolve) =>
        setTimeout(() => {
          calls.push({ cmd: "mcp_stop:done", at: elapsed() });
          serverUp = false;
          resolve({ running: false, port: 19787 });
        }, 20),
      );
    };
    let second: Promise<unknown> | undefined;
    const switchesOffAndOn: BindClock = {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
        if (nowMs === 1_000) {
          void stopMcpServer();
          second = startMcpServer({ where: "toggle", clock });
        }
      },
    };

    const first = startMcpServer({ where: "boot", clock: switchesOffAndOn });
    await expect(first).rejects.toBeInstanceOf(McpStartCancelled);
    await expect(second).resolves.toEqual({ running: true, port: 19787 });

    const order = sent();
    expect(order.indexOf("mcp_stop:done")).toBeGreaterThan(-1);
    // Every start of the new series comes after the stop is over: the opposite order leaves it off while the screen says on.
    expect(order.lastIndexOf("mcp_start")).toBeGreaterThan(order.indexOf("mcp_stop:done"));
    expect(order.indexOf("mcp_start", order.indexOf("mcp_stop"))).toBeGreaterThan(
      order.indexOf("mcp_stop:done"),
    );
    expect(serverUp).toBe(true);
  });

  it("two starts at once make one series of attempts and agree on the outcome", async () => {
    const { startMcpServer } = await load();
    script = portHeldUntil(2_000);
    await startMcpServer({ clock });
    const alone = startsMade();

    nowMs = 0;
    calls.length = 0;
    serverUp = false;
    const [a, b] = await Promise.all([startMcpServer({ clock }), startMcpServer({ clock })]);

    expect(a).toEqual(b);
    expect(startsMade()).toBe(alone);
  });
});

describe("the boot hook, on the real clock", () => {
  it("waits out a relaunch: a port let go after three seconds still starts the server, and the wait is counted", async () => {
    const { initMcp, mcpLastError } = await loadWithFakeTime();
    script = portHeldUntil(3_000);

    await runUntilSettled(initMcp());

    expect(serverUp).toBe(true);
    expect(mcpLastError()).toBeNull();
    expect(reported).toEqual([["mcp_bind_waited", { reason: "3s:boot" }]]);
  });

  it.each([
    [{ holder: "artdaddy" }, "port_in_use_artdaddy:boot", /another copy of this app/],
    [
      { holder: "other", process: "node.exe" },
      "port_in_use_other:boot",
      /another program \(node\.exe\)/,
    ],
    [{ holder: "other" }, "port_in_use_other:boot", /another program\. Close it/],
    [{ holder: "none" }, "port_in_use_none:boot", /free now/],
    ["unreadable" as const, "port_in_use:boot", /another copy of this app or another program/],
  ] satisfies Array<[Holder, string, RegExp]>)(
    "gives up after the wait and says who held the port (%j), without counting the raw message",
    async (holder, reason, shown) => {
      const { initMcp, mcpLastError } = await loadWithFakeTime();
      script = portHeldUntil(Number.POSITIVE_INFINITY, holder);

      await runUntilSettled(initMcp());

      expect(reported).toEqual([["mcp_bind_failed", { reason }]]);
      expect(mcpLastError()).toMatch(shown);
      // The program's name is for the person reading, never for the report; and the address is in neither.
      expect(JSON.stringify(reported)).not.toMatch(/node|127\.0\.0\.1|10048/);
      expect(mcpLastError()).not.toMatch(/system tray|127\.0\.0\.1|10048/);
    },
  );

  it("does nothing, loudly or quietly, when the person has switched the server off", async () => {
    const { initMcp, setMcpEnabledPreference } = await load();
    setMcpEnabledPreference(false);
    script = portHeldUntil(0);
    await initMcp();
    expect(calls).toEqual([]);
  });
});

describe("the screen follows a start nobody on screen asked for", () => {
  it("says it is starting while the boot waits, and running once it has the port", async () => {
    const { initMcp } = await loadWithFakeTime();
    const { useMcpPanel } = await import("../store/mcpPanel");
    script = portHeldUntil(2_000);

    const booted = initMcp();
    expect(useMcpPanel.getState()).toMatchObject({ starting: true, running: false });

    await runUntilSettled(booted);
    await runUntilSettled(Promise.resolve()); // the refresh that follows
    await vi.advanceTimersByTimeAsync(0);
    expect(useMcpPanel.getState()).toMatchObject({ starting: false, running: true });
  });

  it("goes back to stopped, not to starting, when the start is given up", async () => {
    const { initMcp } = await loadWithFakeTime();
    const { useMcpPanel } = await import("../store/mcpPanel");
    script = portHeldUntil(Number.POSITIVE_INFINITY);

    await runUntilSettled(initMcp());
    await vi.advanceTimersByTimeAsync(0);

    expect(useMcpPanel.getState()).toMatchObject({ starting: false, running: false });
  });
});

describe("what is shown and what is counted", () => {
  it("counts only closed words, and shows words that name the port and never the raw message", async () => {
    const { McpPortTakenError, explainMcpError, mcpBindFailureReason, MCP_PORT, readPortHolder } =
      await load();
    const messages = [TAKEN, RESERVED, "something else broke at C:\\Users\\ada\\app.log"];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...messages),
        fc.constantFrom<unknown>(
          null,
          { holder: "artdaddy" },
          { holder: "none" },
          { holder: "other", process: "Secret Project.exe" },
          { holder: "other" },
          { holder: "bogus" },
        ),
        fc.boolean(),
        fc.constantFrom("boot", "toggle"),
        async (message, rawHolder, taken, where) => {
          const error = taken
            ? new McpPortTakenError(message, readPortHolder(rawHolder))
            : new Error(message);

          const reason = mcpBindFailureReason(error, where);
          expect(reason).toMatch(
            /^(port_in_use(_artdaddy|_other|_none)?|port_reserved|other):(boot|toggle)$/,
          );
          expect(reason).not.toMatch(/Secret|exe|127|\\/);

          const shown = explainMcpError(error);
          expect(shown).not.toMatch(/system tray|127\.0\.0\.1|os error/);
          if (taken || /10048|10013/.test(message)) expect(shown).toContain(String(MCP_PORT));
        },
      ),
      { numRuns: 120 },
    );
  });

  it("keeps the message of a failure that is not about the port as it came, so nothing is hidden", async () => {
    const { explainMcpError } = await load();
    expect(explainMcpError(new Error("event system unavailable"))).toBe("event system unavailable");
    expect(explainMcpError("plain text from the desktop side")).toBe(
      "plain text from the desktop side",
    );
  });
});

describe("who holds the port, as the desktop side reports it", () => {
  it("keeps every ordinary program name exactly as sent", async () => {
    const { readPortHolder } = await load();
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,30}[A-Za-z0-9)]$/), (name) => {
        expect(readPortHolder({ holder: "other", process: name })).toEqual({
          holder: "other",
          process: name,
        });
      }),
    );
    expect(readPortHolder({ holder: "other", process: "Code - Insiders.exe" })?.process).toBe(
      "Code - Insiders.exe",
    );
  });

  it("lets nothing else through, whatever it is sent", async () => {
    const { readPortHolder } = await load();
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (name) => {
        const shown = readPortHolder({ holder: "other", process: name })?.process ?? "";
        expect(shown).toMatch(/^[\w .()-]{0,64}$/);
        expect(shown).toBe(shown.trim());
      }),
    );
    expect(
      readPortHolder({ holder: "other", process: "<img src=x onerror=alert(1)>.exe" })?.process,
    ).toBe("img srcx onerroralert(1).exe");
  });

  it("refuses a shape it does not know instead of guessing", async () => {
    const { readPortHolder } = await load();
    for (const raw of [null, undefined, "other", 5, [], {}, { holder: "root" }, { holder: 3 }]) {
      expect(readPortHolder(raw)).toBeNull();
    }
    expect(readPortHolder({ holder: "other", process: 42 })).toEqual({ holder: "other" });
  });
});
