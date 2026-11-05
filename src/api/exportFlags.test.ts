import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPILED_FLAG_DEFAULTS,
  EXPORT_FLAG_NAMES,
  __resetExportFlags,
  exportFlag,
  refreshExportFlags,
} from "./exportFlags";

const reply = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const flags = (over: Record<string, unknown> = {}) => ({
  v: 1,
  flags: { stall_stop: true, plan_rung: true, pc_floor: true, ...over },
});
const signedIn = async () => true;

beforeEach(() => __resetExportFlags());
afterEach(() => {
  vi.useRealTimers();
  __resetExportFlags();
});

describe("the exporter's remote switches", () => {
  it("run on the compiled defaults until the server has said anything", () => {
    for (const name of EXPORT_FLAG_NAMES)
      expect(exportFlag(name)).toBe(COMPILED_FLAG_DEFAULTS[name]);
  });

  // Phase 3, S4: a switch for each maker's graphics chip, one for choosing Fast for the person, one for the
  // faster processor setting. Each is its own: the server can take one back without touching another.
  it("have a switch per chip maker, for the default and for the faster setting, each on its own", async () => {
    const chip = ["chip_amd", "chip_nvidia", "chip_intel", "chip_default", "faster_x264"] as const;
    for (const name of chip) {
      expect(EXPORT_FLAG_NAMES).toContain(name);
      expect(COMPILED_FLAG_DEFAULTS[name]).toBe(true);
    }
    for (const off of chip) {
      await refreshExportFlags({
        fetcher: async () =>
          reply({
            v: 1,
            flags: Object.fromEntries(EXPORT_FLAG_NAMES.map((name) => [name, name !== off])),
          }),
        signedIn,
        force: true,
      });
      for (const name of EXPORT_FLAG_NAMES)
        expect(exportFlag(name), `${off} off: ${name}`).toBe(name !== off);
    }
  });

  it("switch a behaviour off when the server says so, and on again when it says so", async () => {
    await refreshExportFlags({
      fetcher: async () => reply(flags({ stall_stop: false })),
      signedIn,
      force: true,
    });
    expect(exportFlag("stall_stop")).toBe(false);
    expect(exportFlag("plan_rung")).toBe(true);
    await refreshExportFlags({ fetcher: async () => reply(flags()), signedIn, force: true });
    expect(exportFlag("stall_stop")).toBe(true);
  });

  it("keep what they were for every way the server can fail, and never throw", async () => {
    await refreshExportFlags({
      fetcher: async () => reply(flags({ pc_floor: false })),
      signedIn,
      force: true,
    });
    const failures: Array<() => Promise<Response>> = [
      async () => reply("not json"),
      async () => reply({ v: 2, flags: { pc_floor: true } }),
      async () => reply({ v: 1 }),
      async () => reply({ v: 1, flags: "x" }),
      async () => reply({}, 500),
      async () => reply({}, 401),
      async () => {
        throw new Error("offline");
      },
    ];
    for (const fetcher of failures) {
      await expect(refreshExportFlags({ fetcher, signedIn, force: true })).resolves.toBeUndefined();
      expect(exportFlag("pc_floor")).toBe(false); // the last good answer stands
    }
  });

  it("take only booleans for names they know, one by one", async () => {
    await refreshExportFlags({
      fetcher: async () =>
        reply(flags({ stall_stop: "no", plan_rung: 0, pc_floor: false, surprise: false })),
      signedIn,
      force: true,
    });
    expect(exportFlag("stall_stop")).toBe(COMPILED_FLAG_DEFAULTS.stall_stop);
    expect(exportFlag("plan_rung")).toBe(COMPILED_FLAG_DEFAULTS.plan_rung);
    expect(exportFlag("pc_floor")).toBe(false);
    expect(exportFlag("surprise" as never)).toBe(false); // an unknown name is never on
  });

  it("do not ask a server for anyone who is not signed in", async () => {
    const fetcher = vi.fn(async () => reply(flags({ stall_stop: false })));
    await refreshExportFlags({ fetcher, signedIn: async () => false, force: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(exportFlag("stall_stop")).toBe(COMPILED_FLAG_DEFAULTS.stall_stop);
  });

  it("do not wait for a server that does not answer: a refresh gives up after its time", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const done = refreshExportFlags({ fetcher, signedIn, force: true, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(done).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const name of EXPORT_FLAG_NAMES)
      expect(exportFlag(name)).toBe(COMPILED_FLAG_DEFAULTS[name]);
  });

  it("ask at most once in a while unless told to", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const fetcher = vi.fn(async () => reply(flags()));
    await refreshExportFlags({ fetcher, signedIn });
    await refreshExportFlags({ fetcher, signedIn });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + 11 * 60_000);
    await refreshExportFlags({ fetcher, signedIn });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await refreshExportFlags({ fetcher, signedIn, force: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("do not spend the ten minutes on a look that found nobody signed in: the first export after signing in still asks", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const fetcher = vi.fn(async () => reply(flags({ stall_stop: false })));
    await refreshExportFlags({ fetcher, signedIn: async () => false }); // the app opened, nobody yet
    expect(fetcher).not.toHaveBeenCalled();
    vi.setSystemTime(1_000_000 + 60_000); // a minute later, signed in
    await refreshExportFlags({ fetcher, signedIn });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(exportFlag("stall_stop")).toBe(false);
  });

  it("make one request however many places ask at once", async () => {
    let answer!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    const first = refreshExportFlags({ fetcher, signedIn });
    const second = refreshExportFlags({ fetcher, signedIn, force: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    answer(reply(flags({ plan_rung: false })));
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(exportFlag("plan_rung")).toBe(false);
  });

  it("remember a switch that was turned off across a restart, so an offline start does not undo it", async () => {
    await refreshExportFlags({
      fetcher: async () => reply(flags({ plan_rung: false })),
      signedIn,
      force: true,
    });
    __resetExportFlags({ keepStorage: true }); // the app was closed and opened again, offline
    expect(exportFlag("plan_rung")).toBe(false);
    expect(exportFlag("stall_stop")).toBe(true);
  });

  it("start from the defaults when what was remembered is damaged", () => {
    localStorage.setItem("artdaddy.exportFlags.v1", "{not json");
    __resetExportFlags({ keepStorage: true });
    for (const name of EXPORT_FLAG_NAMES)
      expect(exportFlag(name)).toBe(COMPILED_FLAG_DEFAULTS[name]);
  });

  it("ask the route the server serves, and carry no body or identity of its own", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => reply(flags()));
    await refreshExportFlags({ fetcher, signedIn, force: true });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toMatch(/\/client\/export-flags$/);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
  });
});
