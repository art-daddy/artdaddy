import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPILED_FLAG_DEFAULTS,
  COMPILED_PC_CLASS,
  EXPORT_FLAG_NAMES,
  PC_CLASS_BANDS,
  __resetExportFlags,
  exportFlag,
  pcClass,
  refreshExportFlags,
} from "./exportFlags";

const reply = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
/** An answer whose body JSON cannot carry (NaN and infinity become null on the wire). */
const rawReply = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;
const flags = (over: Record<string, unknown> = {}) => ({
  v: 1,
  flags: { stall_stop: true, plan_rung: true, pc_floor: true, ...over },
});
const signedIn = async () => true;

// Ledger F-01, 14 Nov 2026: the 29 off-switches the owner released, in the order both halves list them.
const RELEASED_FLAG_NAMES = [
  "stall_stop",
  "plan_rung",
  "pc_floor",
  "chip_amd",
  "chip_nvidia",
  "chip_intel",
  "chip_default",
  "faster_x264",
  "speech_cpu_cap",
  "speech_gpu_retry",
  "import_note",
  "canvas_ask_stills",
  "proxy_first_needed",
  "lean_zoom",
  "lean_fades",
  "lean_dip",
  "lean_stills",
  "lean_grade",
  "lean_decoders",
  "idle_rule",
  "auto_restart",
  "memory_restart",
  "restart_streamed",
  "pc_check",
  "estimate_v2",
  "memory_shape",
  "quick_export",
  "export_help",
  "chip_restart",
];

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

  it("know the 29 released switches, in order, once each, and every one starts on", () => {
    expect(EXPORT_FLAG_NAMES.slice(0, RELEASED_FLAG_NAMES.length)).toEqual(RELEASED_FLAG_NAMES);
    expect(RELEASED_FLAG_NAMES).toHaveLength(29);
    expect(new Set(EXPORT_FLAG_NAMES).size).toBe(EXPORT_FLAG_NAMES.length);
    expect(Object.keys(COMPILED_FLAG_DEFAULTS)).toEqual([...EXPORT_FLAG_NAMES]);
    for (const name of EXPORT_FLAG_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(COMPILED_FLAG_DEFAULTS[name], name).toBe(true);
      expect(exportFlag(name), name).toBe(true);
    }
  });

  it("switch each of the switches off on its own, whichever one the server names", async () => {
    for (const off of EXPORT_FLAG_NAMES) {
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

  it("never turn on a name they do not know, and never remember one", async () => {
    await refreshExportFlags({
      fetcher: async () =>
        reply({
          v: 1,
          flags: { ...Object.fromEntries(EXPORT_FLAG_NAMES.map((n) => [n, true])), surprise: true },
        }),
      signedIn,
      force: true,
    });
    expect(exportFlag("surprise" as never)).toBe(false);
    expect(
      Object.keys(JSON.parse(localStorage.getItem("artdaddy.exportFlags.v1") ?? "{}")),
    ).toEqual(expect.not.arrayContaining(["surprise"]));
  });

  it("leave the switches an older server does not list on, and take what it does list", async () => {
    const first8 = RELEASED_FLAG_NAMES.slice(0, 8);
    await refreshExportFlags({
      fetcher: async () =>
        reply({ v: 1, flags: Object.fromEntries(first8.map((n) => [n, false])) }),
      signedIn,
      force: true,
    });
    for (const name of EXPORT_FLAG_NAMES)
      expect(exportFlag(name), name).toBe(!first8.includes(name));
  });

  it("start the switches an older copy never knew from their defaults, keeping the ones it did", () => {
    localStorage.setItem("artdaddy.exportFlags.v1", JSON.stringify({ stall_stop: false }));
    __resetExportFlags({ keepStorage: true });
    expect(exportFlag("stall_stop")).toBe(false);
    for (const name of EXPORT_FLAG_NAMES.slice(1)) expect(exportFlag(name), name).toBe(true);
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

describe("the PC class cut-offs the server may retune (pc_class)", () => {
  const withPair = (pair: unknown) => ({ ...flags(), pc_class: pair });
  const answerWith = async (body: unknown) =>
    refreshExportFlags({ fetcher: async () => rawReply(body), signedIn, force: true });
  const retuned = { okOver: 1.5, weakOver: 5 };
  const retune = async () => {
    await answerWith(withPair({ ok_over: 1.5, weak_over: 5 }));
    expect(pcClass()).toEqual(retuned);
  };

  const GOOD_PAIRS: Array<[string, number, number]> = [
    ["the compiled pair", 1, 4],
    ["both at their lowest edge", 0.5, 2],
    ["low ok edge, high weak edge", 0.5, 8],
    ["both at their highest edge", 2, 8],
    ["ok just under weak", 1.999, 2],
    ["ok at its top, weak just over", 2, 2.001],
    ["floats", 1.25, 3.5],
  ];
  // Where only one side is bad, the other is a valid pair that differs from the compiled one, so using half a
  // pair shows.
  const BAD_PAIRS: Array<[string, unknown, unknown]> = [
    ["ok just below its band", 0.49, 3.5],
    ["ok zero", 0, 3.5],
    ["ok negative", -1, 3.5],
    ["ok just above its band", 2.01, 3.5],
    ["weak just below its band", 1.25, 1.99],
    ["weak zero", 1.25, 0],
    ["weak just above its band", 1.25, 8.01],
    ["weak far above", 1.25, 100],
    ["equal", 2, 2],
    ["reversed", 4, 1],
    ["reversed inside the weak band", 3, 2.5],
    ["ok a string", "1.25", 3.5],
    ["weak a string", 1.25, "3.5"],
    ["ok a boolean (true is 1)", true, 3.5],
    ["weak a boolean", 1.25, true],
    ["ok NaN", NaN, 3.5],
    ["weak NaN", 1.25, NaN],
    ["ok infinity", Infinity, 3.5],
    ["ok minus infinity", -Infinity, 3.5],
    ["weak infinity", 1.25, Infinity],
    ["ok a list", [1.25], 3.5],
    ["weak a list", 1.25, [3.5]],
    ["ok an object", { v: 1 }, 3.5],
    ["ok null", null, 3.5],
    ["weak null", 1.25, null],
  ];
  const BAD_SECTIONS: Array<[string, unknown]> = [
    ["an empty object", {}],
    ["only ok_over", { ok_over: 1.25 }],
    ["only weak_over", { weak_over: 3.5 }],
    ["the app's own spelling", { okOver: 1.25, weakOver: 3.5 }],
    ["an empty list", []],
    ["a list of the two", [1.25, 3.5]],
    ["a string", "1.25,3.5"],
    ["a number", 5],
    ["null", null],
    ["a boolean", true],
  ];

  it("run on the compiled pair until the server has said anything", () => {
    expect(pcClass()).toEqual({ okOver: 1, weakOver: 4 });
    expect(pcClass()).toEqual(COMPILED_PC_CLASS);
  });

  it("keep the compiled pair inside the band the server checks, both ends included", () => {
    expect(PC_CLASS_BANDS).toEqual({ okOver: { min: 0.5, max: 2 }, weakOver: { min: 2, max: 8 } });
    expect(COMPILED_PC_CLASS.okOver).toBeGreaterThanOrEqual(PC_CLASS_BANDS.okOver.min);
    expect(COMPILED_PC_CLASS.okOver).toBeLessThanOrEqual(PC_CLASS_BANDS.okOver.max);
    expect(COMPILED_PC_CLASS.weakOver).toBeGreaterThanOrEqual(PC_CLASS_BANDS.weakOver.min);
    expect(COMPILED_PC_CLASS.weakOver).toBeLessThanOrEqual(PC_CLASS_BANDS.weakOver.max);
    expect(COMPILED_PC_CLASS.okOver).toBeLessThan(COMPILED_PC_CLASS.weakOver);
  });

  it("use a pair that is whole, in its bands and in order, edges included", async () => {
    for (const [label, ok, weak] of GOOD_PAIRS) {
      await retune();
      await answerWith(withPair({ ok_over: ok, weak_over: weak }));
      expect(pcClass(), label).toEqual({ okOver: ok, weakOver: weak });
    }
  });

  it("use nothing of a pair that is outside its bands, mistyped or out of order: the compiled pair comes back whole", async () => {
    for (const [label, ok, weak] of BAD_PAIRS) {
      await retune();
      await answerWith(withPair({ ok_over: ok, weak_over: weak }));
      expect(pcClass(), label).toEqual(COMPILED_PC_CLASS);
    }
    for (const [label, section] of BAD_SECTIONS) {
      await retune();
      await answerWith(withPair(section));
      expect(pcClass(), label).toEqual(COMPILED_PC_CLASS);
    }
  });

  it("ignore an extra key beside a good pair, and take the pair", async () => {
    await answerWith(withPair({ ok_over: 1.5, weak_over: 5, note: "x" }));
    expect(pcClass()).toEqual(retuned);
  });

  it("put the compiled pair back when a good answer no longer carries one: removing the section undoes a retune", async () => {
    await retune();
    await answerWith(flags());
    expect(pcClass()).toEqual(COMPILED_PC_CLASS);
  });

  it("keep the last good pair for every answer that is not good, and never throw", async () => {
    await retune();
    const failures: Array<() => Promise<Response>> = [
      async () => reply("not json"),
      async () => reply({ v: 2, flags: {}, pc_class: { ok_over: 1.2, weak_over: 3 } }),
      async () => reply({ v: 1, pc_class: { ok_over: 1.2, weak_over: 3 } }),
      async () => reply({ v: 1, flags: "x", pc_class: { ok_over: 1.2, weak_over: 3 } }),
      async () => reply({}, 500),
      async () => reply({}, 401),
      async () => {
        throw new Error("offline");
      },
    ];
    for (const fetcher of failures) {
      await expect(refreshExportFlags({ fetcher, signedIn, force: true })).resolves.toBeUndefined();
      expect(pcClass()).toEqual(retuned);
    }
  });

  it("keep the last good pair when the server does not answer in time", async () => {
    await retune();
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
    expect(pcClass()).toEqual(retuned);
  });

  it("take the pair and the switches of one answer independently: a bad pair costs no switch, a bad switch costs no pair", async () => {
    await answerWith({ ...withPair({ ok_over: 9, weak_over: 4 }), flags: { stall_stop: false } });
    expect(exportFlag("stall_stop")).toBe(false);
    expect(pcClass()).toEqual(COMPILED_PC_CLASS);
    __resetExportFlags();
    await answerWith({
      ...withPair({ ok_over: 1.5, weak_over: 5 }),
      flags: { stall_stop: "no", plan_rung: false },
    });
    expect(exportFlag("stall_stop")).toBe(true);
    expect(exportFlag("plan_rung")).toBe(false);
    expect(pcClass()).toEqual(retuned);
  });

  it("keep the pair in memory only: nothing of it is written to storage, and a restart starts from the compiled pair", async () => {
    const real = localStorage;
    const written: Array<[string, string]> = [];
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        written.push([key, value]);
        real.setItem(key, value);
      },
      removeItem: (key: string) => real.removeItem(key),
      clear: () => real.clear(),
      key: (index: number) => real.key(index),
      get length() {
        return real.length;
      },
    });
    try {
      await retune();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(written.length).toBeGreaterThan(0); // the switches are remembered, so this check can fail
    for (const [key, value] of written) {
      expect(key).not.toMatch(/pc|class/i);
      expect(value).not.toMatch(/ok_?over|weak_?over|pc_?class|1\.5/i);
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? "";
      expect(key).not.toMatch(/pc|class/i);
      expect(localStorage.getItem(key) ?? "").not.toMatch(/ok_?over|weak_?over|pc_?class|1\.5/i);
    }
    __resetExportFlags({ keepStorage: true }); // the app was closed and opened again
    expect(pcClass()).toEqual(COMPILED_PC_CLASS);
  });

  it("start from the compiled pair again after a reset", async () => {
    await retune();
    __resetExportFlags();
    expect(pcClass()).toEqual(COMPILED_PC_CLASS);
  });
});
