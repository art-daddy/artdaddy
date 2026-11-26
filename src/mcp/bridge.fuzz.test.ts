// The MCP door, fuzzed in both directions: a malformed or unknown request is refused cleanly and runs nothing, and a
// legitimate one, generated from the real tool schemas, is never refused and reaches its tool unchanged.
//
// The door is `dispatch` (bridge.ts), what Rust hands every `tools/list` and `tools/call` to, and below it the REAL tool host
// and the REAL argument gate (ClientToolRegistry: arguments must be an object, an undeclared top-level name is refused,
// numbers are clamped to the catalog's range, a strict-mode null or empty string is dropped). Only the tools themselves are
// recorders, so a test sees exactly which tool ran and with what, and that nothing ran for a refused call. The catalog is
// the real one. Rust's own framing (malformed JSON, batches, notifications, bodies) is tested in src-tauri/src/mcp.rs.
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import canonical from "../contract/catalog.json";
import type { Catalog, ParamSchema } from "../contract";

const h = vi.hoisted(() => ({
  activeId: "p1" as string | null,
  /** Every tool that ran, with the arguments it was handed and the surface its context says it was called from. */
  calls: [] as Array<{ name: string; args: unknown; surface?: string }>,
  /** Every URL the code fetched while a call ran. */
  fetched: [] as string[],
}));

vi.mock("../store/projects", () => ({
  useProjects: {
    getState: () => ({
      activeId: h.activeId,
      active: h.activeId ? { id: h.activeId, name: "QA" } : undefined,
      projects: h.activeId ? [{ id: h.activeId, name: "QA" }] : [],
      refresh: async () => undefined,
      create: async (name: string) => ({ id: "made_1", name }),
    }),
  },
}));
vi.mock("../project/openDocuments", () => ({ openDocumentById: () => ({}) }));
// Every catalog tool is a recorder, registered in the real registry the real host builds.
vi.mock("../tools", async () => {
  const { ClientToolRegistry } = await import("../tools/registry");
  const { toolDefinitions } = await import("../contract");
  return {
    ClientToolRegistry,
    createToolRegistry: (getCtx: () => { surface?: string } | null) => {
      const registry = new ClientToolRegistry();
      for (const { name } of toolDefinitions())
        registry.register(name, (args) => {
          h.calls.push({
            name,
            args: JSON.parse(JSON.stringify(args)),
            surface: getCtx()?.surface,
          });
          return { ok: true, ran: name };
        });
      return registry;
    },
  };
});
vi.mock("../tools/dataRoot", async (original) => ({
  ...(await original<typeof import("../tools/dataRoot")>()),
  projectDirFor: async () => "C:/proj",
}));
vi.mock("../tools/tauri", async () => {
  const { MemFs, makeRunner } = await import("../test/timelineKit");
  const { ProjectStoreAccess } = await import("../tools/store");
  return {
    makeTauriContext: async () => ({
      store: new ProjectStoreAccess("C:/proj", new MemFs()),
      runner: makeRunner(),
    }),
  };
});

type Reply = { isError?: boolean; tools?: Array<{ name: string }>; content?: unknown };

beforeEach(async () => {
  vi.resetModules();
  h.activeId = "p1";
  h.calls.length = 0;
  h.fetched.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      h.fetched.push(String(url));
      return new Response("{}", { status: 200 });
    }),
  );
  const { useAuth } = await import("../store/auth");
  useAuth.setState({ status: "unlocked", hasStoredSession: true });
  window.history.replaceState({}, "", "/p/p1");
});

async function door() {
  return (await import("./bridge")).dispatch;
}

/** One request through the door; it must settle, whatever it is. */
async function ask(method: string, params?: unknown): Promise<Reply> {
  const dispatch = await door();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} did not settle in 5 s`)), 5_000);
  });
  try {
    return (await Promise.race([dispatch({ id: 1, method, params } as never), hang])) as Reply;
  } finally {
    clearTimeout(timer);
  }
}

const call = (name: unknown, args?: unknown) =>
  ask("tools/call", args === undefined ? { name } : { name, arguments: args });

/** The text an agent reads in a reply, which must be there and be text. */
function replyText(reply: Reply): string {
  const content = reply.content as Array<{ type?: unknown; text?: unknown }>;
  expect(Array.isArray(content), "the reply carries content").toBe(true);
  expect(content[0]?.type).toBe("text");
  expect(typeof content[0]?.text).toBe("string");
  return content[0].text as string;
}

/** A refusal as an agent receives it: an error it can read, and nothing ran and nothing was fetched. */
function expectRefused(reply: Reply, why: string): void {
  expect(reply.isError, why).toBe(true);
  expect(replyText(reply).length, why).toBeGreaterThan(0);
  expect(h.calls, `${why}: no tool may run`).toEqual([]);
  expect(
    h.fetched.filter((url) => !/\/telemetry\//.test(url)),
    why,
  ).toEqual([]);
}

// ── Arguments from the real schemas ─────────────────────────────────────────────────────────────────────────────

type Schema = ParamSchema & {
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
};

/** A value the schema accepts. Strings are never empty: the registry reads "" as "not set" and drops it (dropStrictNulls),
 *  so an empty string is not a value an agent can mean. */
function valueFor(schema: Schema | undefined, depth: number): fc.Arbitrary<unknown> {
  if (!schema) return fc.string({ minLength: 1, maxLength: 12 });
  if (schema.enum?.length) return fc.constantFrom(...schema.enum);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? "object"];
  return fc.oneof(...types.map((type) => ofType(type, schema, depth)));
}

function ofType(type: string, schema: Schema, depth: number): fc.Arbitrary<unknown> {
  const min = schema.minimum;
  const max = schema.maximum;
  switch (type) {
    case "string":
      return fc.string({ minLength: 1, maxLength: 12 });
    case "integer":
      return fc.integer({ min: Math.ceil(min ?? -1_000_000), max: Math.floor(max ?? 1_000_000) });
    case "number":
      return fc.double({
        min: min ?? -1_000_000,
        max: max ?? 1_000_000,
        noNaN: true,
        noDefaultInfinity: true,
      });
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    case "array": {
      const least = schema.minItems ?? 0;
      return fc.array(valueFor(schema.items as Schema, depth + 1), {
        minLength: least,
        maxLength: Math.max(least, Math.min(schema.maxItems ?? 3, 3)),
      });
    }
    default:
      return objectFor(schema, depth);
  }
}

function objectFor(schema: Schema, depth: number): fc.Arbitrary<Record<string, unknown>> {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  if (!Object.keys(properties).length) {
    // A free-form object (no declared properties): the tool's own data, which nothing above it may touch.
    return depth === 0
      ? fc.constant({})
      : fc.dictionary(
          fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== "__proto__"),
          fc.jsonValue({ maxDepth: 2 }),
          { maxKeys: 3 },
        );
  }
  const model = Object.fromEntries(
    Object.entries(properties).map(([key, sub]) => [key, valueFor(sub, depth + 1)]),
  );
  return fc.record(model, {
    requiredKeys: (schema.required ?? []).filter((key) => key in properties),
  }) as fc.Arbitrary<Record<string, unknown>>;
}

/** Every tool an agent is offered over MCP except `manage_project` (the door answers it itself), with arguments its own
 *  schema accepts. */
async function legitimateCalls() {
  const { mcpTools } = await import("./tools");
  const tools = mcpTools().filter((tool) => tool.name !== "manage_project");
  expect(tools.length).toBeGreaterThan(40);
  return fc.oneof(
    ...tools.map((tool) =>
      objectFor(tool.inputSchema as Schema, 0).map((args) => ({ name: tool.name, args })),
    ),
  );
}

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("a legitimate request is never refused or changed", () => {
  it("runs the tool it names, once, with exactly the arguments it sent, and hands back what the tool answered", async () => {
    const calls = await legitimateCalls();
    await fc.assert(
      fc.asyncProperty(calls, async ({ name, args }) => {
        h.calls.length = 0;
        const reply = await call(name, args);
        expect(reply.isError, replyText(reply)).toBe(false);
        expect(h.calls.map((c) => c.name)).toEqual([name]);
        expect(h.calls[0].args).toEqual(json(args));
        // The tool knows it was called over MCP: that decides what it tells an agent nothing will wake (refState.ts).
        expect(h.calls[0].surface).toBe("mcp");
        expect(JSON.parse(replyText(reply))).toEqual({ ok: true, ran: name });
      }),
      { numRuns: 250 },
    );
  });

  it("lists every tool it will run, each with an object schema", async () => {
    const reply = await ask("tools/list");
    const listed = reply.tools ?? [];
    const { toolsForSurface } = await import("../contract");
    expect(listed.map((t) => t.name).sort()).toEqual(
      toolsForSurface("mcp")
        .map((t) => t.name)
        .sort(),
    );
    for (const tool of listed as Array<{ name: string; inputSchema: { type?: unknown } }>)
      expect(tool.inputSchema.type, tool.name).toBe("object");
  });

  it("answers an argument-less call of a tool that takes no arguments, and treats absent and null arguments alike", async () => {
    for (const args of [undefined, null, {}]) {
      h.calls.length = 0;
      const reply = await call("get_timeline", args);
      expect(reply.isError, `arguments ${String(args)}`).toBe(false);
      expect(h.calls).toEqual([{ name: "get_timeline", args: {}, surface: "mcp" }]);
    }
  });

  it("offers a tool the catalog gives no parameters with an empty object schema, which MCP clients require, and runs it", async () => {
    const { setContract } = await import("../contract");
    setContract({
      ...(canonical as Catalog),
      tools: canonical.tools.map((tool) =>
        tool.name === "undo" ? { ...tool, parameters: undefined } : tool,
      ),
    });
    const listed = (await ask("tools/list")).tools as Array<{ name: string; inputSchema: unknown }>;
    expect(listed.find((tool) => tool.name === "undo")?.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
    const reply = await call("undo", {});
    expect(reply.isError, replyText(reply)).toBe(false);
    expect(h.calls.map((c) => c.name)).toEqual(["undo"]);
  });
});

describe("a malformed or unknown request is refused cleanly and runs nothing", () => {
  it("refuses a tool name that is not offered: made up, withdrawn, or a near miss of a real one", async () => {
    const { mcpTools } = await import("./tools");
    const { WITHDRAWN_TOOLS } = await import("../contract/withdrawn");
    const offered = new Set(mcpTools().map((t) => t.name));
    const names = [...offered];
    const unknown = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom(...WITHDRAWN_TOOLS),
      fc
        .constantFrom(...names)
        .chain((n) =>
          fc.constantFrom(
            `artdaddy-${n}`,
            n.toUpperCase(),
            ` ${n}`,
            `${n} `,
            n.replace(/_/g, "-"),
            `${n}\u0000`,
            `${n}()`,
          ),
        ),
      fc.constantFrom("__proto__", "constructor", "toString", "hasOwnProperty"),
    );
    await fc.assert(
      fc.asyncProperty(
        unknown.filter((n) => !offered.has(n)),
        async (name) => {
          h.calls.length = 0;
          h.fetched.length = 0;
          const reply = await call(name, {});
          expectRefused(reply, `tool ${JSON.stringify(name)}`);
          expect(replyText(reply)).toMatch(/unknown tool/i);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("refuses params that are not an object, or name no tool", async () => {
    const params = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.jsonValue({ maxDepth: 2 }), { maxLength: 3 }),
      fc.dictionary(
        fc.string().filter((k) => k !== "name" && k !== "__proto__"),
        fc.jsonValue({ maxDepth: 2 }),
        { maxKeys: 3 },
      ),
    );
    await fc.assert(
      fc.asyncProperty(params, async (p) => {
        h.calls.length = 0;
        h.fetched.length = 0;
        expectRefused(await ask("tools/call", p), `params ${JSON.stringify(p)}`);
      }),
      { numRuns: 100 },
    );
  });

  it("refuses a tool name of the wrong type that does not spell a tool", async () => {
    for (const name of [
      7,
      true,
      null,
      {},
      { name: "get_timeline" },
      ["get_timeline", "undo"],
      [],
    ]) {
      h.calls.length = 0;
      expectRefused(await call(name, {}), `name ${JSON.stringify(name)}`);
    }
  });

  it("refuses arguments that are not an object, for every tool", async () => {
    const { mcpTools } = await import("./tools");
    const names = mcpTools()
      .map((t) => t.name)
      .filter((n) => n !== "manage_project");
    const notAnObject = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.double(),
      fc.boolean(),
      fc.array(fc.jsonValue({ maxDepth: 2 }), { maxLength: 3 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...names), notAnObject, async (name, args) => {
        h.calls.length = 0;
        h.fetched.length = 0;
        const reply = await call(name, args);
        expectRefused(reply, `${name} with arguments ${JSON.stringify(args)}`);
        expect(replyText(reply)).toMatch(/arguments must be an object/);
      }),
      { numRuns: 120 },
    );
  });

  it("refuses an argument the tool does not declare, and names it", async () => {
    const { mcpTools } = await import("./tools");
    const tools = mcpTools().filter((t) => t.name !== "manage_project");
    const withExtra = fc.constantFrom(...tools).chain((tool) =>
      fc
        .string({ minLength: 1, maxLength: 16 })
        .filter((key) => !key.startsWith("_") && !(key in (tool.inputSchema.properties ?? {})))
        .map((key) => ({ name: tool.name, key })),
    );
    await fc.assert(
      fc.asyncProperty(withExtra, fc.jsonValue({ maxDepth: 2 }), async ({ name, key }, value) => {
        h.calls.length = 0;
        h.fetched.length = 0;
        // Built from JSON, as the request arrives: a key such as "constructor" is then an own property, not the prototype's.
        const args = JSON.parse(JSON.stringify({ [key]: value ?? 1 }));
        const reply = await call(name, args);
        expectRefused(reply, `${name} with ${JSON.stringify(key)}`);
        expect(replyText(reply)).toContain("unknown param");
      }),
      { numRuns: 120 },
    );
  });

  it("refuses every call while no project is open, except manage_project", async () => {
    h.activeId = null;
    const { mcpTools } = await import("./tools");
    for (const tool of mcpTools().filter((t) => t.name !== "manage_project")) {
      h.calls.length = 0;
      const reply = await call(tool.name, {});
      expectRefused(reply, tool.name);
      expect(replyText(reply)).toMatch(/^No project is open/);
    }
    const list = await call("manage_project", { action: "list" });
    expect(list.isError).toBe(false);
  });

  it("answers a deeply nested argument without running out of stack or running the tool", async () => {
    // Rust's JSON reader refuses nesting past 128 levels before the bridge sees a request, and the arguments sit three
    // levels down in it: this is about the deepest that can arrive.
    let deep: unknown = "leaf";
    for (let i = 0; i < 120; i++) deep = i % 2 ? { a: deep } : [deep];
    const reply = await call("get_timeline", { nest: deep });
    expectRefused(reply, "a 120-level argument the tool does not declare");
    expect(replyText(reply)).toContain("unknown param");
  });

  it("never changes Object.prototype, whatever the argument names", async () => {
    const args = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}',
    );
    await call("get_timeline", args);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// KNOWN BUGS, each kept as an expected failure that fails on its own assertion. When one passes, remove its `.fails`.
describe("known bugs at the door", () => {
  // The door asks the APP's tool list (`allTools`) whether a tool may run, and so does the host (`toolByName`), while
  // tools/list offers the MCP list (`toolsForSurface("mcp")`). They agree today only because every tool is on both. The
  // moment the catalog withholds a tool from MCP (`surfaces: ["app"]`, as a study recommended for the video tools), tools/list
  // stops offering it and tools/call still runs it, spending credits for an agent that remembered the name or holds a list
  // cached from before the change.
  it.fails("does not run a tool the catalog withholds from MCP", async () => {
    const { setContract } = await import("../contract");
    setContract({
      ...(canonical as Catalog),
      tools: canonical.tools.map((tool) =>
        tool.name === "video_ask" ? { ...tool, surfaces: ["app"] } : tool,
      ),
    });
    const listed = (await ask("tools/list")).tools?.map((t) => t.name) ?? [];
    expect(listed).not.toContain("video_ask");
    const reply = await call("video_ask", { media_ref: "media_1", prompt: "what happens?" });
    expect(
      h.calls.map((c) => c.name),
      "a tool MCP does not offer ran over MCP",
    ).toEqual([]);
    expect(reply.isError).toBe(true);
  });

  // The other direction of the same check: a tool the catalog offers ONLY over MCP is listed and then refused as unknown.
  it.fails("runs a tool the catalog offers only over MCP", async () => {
    const { setContract } = await import("../contract");
    setContract({
      ...(canonical as Catalog),
      tools: canonical.tools.map((tool) =>
        tool.name === "get_timeline" ? { ...tool, surfaces: ["mcp"] } : tool,
      ),
    });
    const listed = (await ask("tools/list")).tools?.map((t) => t.name) ?? [];
    expect(listed).toContain("get_timeline");
    const reply = await call("get_timeline", {});
    expect(reply.isError, replyText(reply)).toBe(false);
    expect(h.calls.map((c) => c.name)).toEqual(["get_timeline"]);
  });

  // The door opens the active project (navigating the window to it) BEFORE it checks that the tool exists, so a call it
  // then refuses as unknown has already moved the app off the screen the person was on.
  it.fails("leaves the app where the person left it when it refuses an unknown tool", async () => {
    window.history.replaceState({}, "", "/");
    const reply = await call("not_a_tool", {});
    expectRefused(reply, "an unknown tool");
    expect(window.location.pathname, "a refused call moved the app").toBe("/");
  });

  // `name` is read with String(...), so a one-element array spells the tool inside it and that tool runs: a request that
  // is not well formed (the name must be a string) makes an edit.
  it.fails(
    "refuses a tool name that is an array, instead of running the tool it spells",
    async () => {
      const reply = await call(["undo"], {});
      expectRefused(reply, 'name ["undo"]');
    },
  );
});
