// The door's own answers: what manage_project does (the one tool that exists only for MCP), and what happens when the app
// is signed out or must update WHILE a call is on its way in. A gate checked at the door and then not again lets a call that
// started before the change run after it, so these change the state at the moment it can really change: while the tool host
// starts, while a project is being created, or while it opens.
//
// The door (`dispatch`), the tool host, the registry and the sign-in and update stores are real; the project list, the open
// documents and the tools themselves are stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  activeId: "p1" as string | null,
  projects: [{ id: "p1", name: "First cut" }] as Array<{ id: string; name: string }>,
  created: [] as unknown[][],
  calls: [] as string[],
  /** Whether a project's document opens when the app is sent to it. */
  documentOpens: true,
  /** Each runs once: while the tool host starts, while a project is being created, while the bridge waits for a document. */
  whileHostStarts: null as null | (() => void),
  whileCreating: null as null | (() => void),
  whileDocumentOpens: null as null | (() => void),
  routes: [] as string[],
}));

const once = (key: "whileHostStarts" | "whileCreating" | "whileDocumentOpens") => {
  const run = h[key];
  h[key] = null;
  run?.();
};

vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: { localTools: true, fileSystem: true }, apiBaseUrl: "" },
}));
vi.mock("../store/projects", () => ({
  useProjects: {
    getState: () => ({
      activeId: h.activeId,
      active: h.projects.find((p) => p.id === h.activeId),
      projects: h.projects,
      refresh: async () => undefined,
      create: async (...args: unknown[]) => {
        h.created.push(args);
        once("whileCreating");
        const made = { id: "made_1", name: String(args[0]) };
        h.projects = [...h.projects, made];
        return made;
      },
    }),
  },
}));
vi.mock("../project/openDocuments", () => ({
  openDocumentById: () => {
    once("whileDocumentOpens");
    return h.documentOpens ? {} : undefined;
  },
}));
vi.mock("../tools", async () => {
  const { ClientToolRegistry } = await import("../tools/registry");
  const { toolDefinitions } = await import("../contract");
  return {
    ClientToolRegistry,
    createToolRegistry: () => {
      const registry = new ClientToolRegistry();
      for (const { name } of toolDefinitions())
        registry.register(name, () => {
          h.calls.push(name);
          return { ok: true };
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
    makeTauriContext: async () => {
      once("whileHostStarts");
      return { store: new ProjectStoreAccess("C:/proj", new MemFs()), runner: makeRunner() };
    },
  };
});

// What the router hears: one listener for the whole file, as the app has one.
window.addEventListener("popstate", () => h.routes.push(window.location.pathname));

type Reply = { isError?: boolean; content: Array<{ type: string; text: string }> };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const { dispatch } = await import("./bridge");
  return (await dispatch({
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  } as never)) as unknown as Reply;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  h.activeId = "p1";
  h.projects = [{ id: "p1", name: "First cut" }];
  h.created.length = 0;
  h.calls.length = 0;
  h.documentOpens = true;
  h.whileHostStarts = null;
  h.whileCreating = null;
  h.whileDocumentOpens = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  window.history.replaceState({}, "", "/p/p1");
  const { useAuth } = await import("../store/auth");
  useAuth.setState({ status: "unlocked", hasStoredSession: true });
  const { useCompatibility } = await import("../update/compatibility");
  useCompatibility.setState({ status: "allowed" });
  // Every module the door loads on its way, loaded now: a test on a fake clock then waits on nothing but that clock.
  await call("manage_project", { action: "current" });
  h.routes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** The reply's text as the JSON object it carries (every answer of the door here is one). */
const body = (reply: Reply): Record<string, unknown> => JSON.parse(reply.content[0].text);

/** Run the fake clock on, in small steps, until `pending` settles or `ms` have passed; whether it settled. */
async function runClock(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let spent = 0; spent < ms && !settled; spent += 100) await vi.advanceTimersByTimeAsync(100);
  return settled;
}

describe("a gate that closes while a call is on its way in", () => {
  it("the person signs out while the tool host starts: refused, named as sign-in, and nothing runs", async () => {
    const { useAuth } = await import("../store/auth");
    h.whileHostStarts = () => useAuth.setState({ status: "locked", hasStoredSession: false });
    const reply = await call("get_timeline");
    expect(reply.isError).toBe(true);
    expect(body(reply)).toMatchObject({ tool: "get_timeline", ran: false });
    expect(String(body(reply).reason)).toMatch(/sign-in screen/);
    expect(h.calls, "a tool ran for a signed-out app").toEqual([]);
  });

  it("an update becomes required while the project opens: refused at once, named as the update, and nothing runs", async () => {
    const { useCompatibility } = await import("../update/compatibility");
    h.documentOpens = false;
    h.whileDocumentOpens = () => useCompatibility.setState({ status: "required" });
    const started = Date.now();
    const reply = await call("get_timeline");
    // Not after the 15 s the bridge gives a document to open: the update is known at once.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reply.isError).toBe(true);
    expect(body(reply)).toMatchObject({ ran: false });
    expect(String(body(reply).reason)).toMatch(/required update/);
    expect(h.calls, "a tool ran on a build that must update").toEqual([]);
  });

  it("an update becomes required while manage_project creates a project: it is created, not opened, and the reply says why", async () => {
    const { useCompatibility } = await import("../update/compatibility");
    h.whileCreating = () => useCompatibility.setState({ status: "required" });
    window.history.replaceState({}, "", "/");
    const reply = await call("manage_project", { action: "create", name: "Trailer" });
    expect(h.created).toHaveLength(1);
    expect(reply.isError).toBe(true);
    expect(body(reply)).toMatchObject({ created: "made_1", name: "Trailer", ready: false });
    expect(String(body(reply).reason)).toMatch(/requires an update/);
    expect(window.location.pathname, "a build that must update opened the project").toBe("/");
  });

  it("the door refuses a signed-out app and says that nothing ran", async () => {
    const { useAuth } = await import("../store/auth");
    useAuth.setState({ status: "locked", hasStoredSession: false });
    const reply = await call("get_timeline");
    expect(reply.isError).toBe(true);
    expect(body(reply).ran).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("manage_project is refused on a build that must update, before it lists, opens or creates anything", async () => {
    const { useCompatibility } = await import("../update/compatibility");
    useCompatibility.setState({ status: "required" });
    window.history.replaceState({}, "", "/");
    for (const args of [
      { action: "list" },
      { action: "open", id: "p1" },
      { action: "create", name: "X" },
    ]) {
      const reply = await call("manage_project", args);
      expect(reply.isError, JSON.stringify(args)).toBe(true);
      expect(body(reply).ran, JSON.stringify(args)).toBe(false);
    }
    expect(h.created).toEqual([]);
    expect(h.routes).toEqual([]);
  });
});

describe("manage_project", () => {
  it("list: every project by id and name, and which one is open", async () => {
    h.projects = [
      { id: "p1", name: "First cut" },
      { id: "p2", name: "Second cut" },
    ];
    const reply = await call("manage_project", { action: "list" });
    expect(reply.isError).toBe(false);
    expect(body(reply)).toEqual({
      active_id: "p1",
      projects: [
        { id: "p1", name: "First cut" },
        { id: "p2", name: "Second cut" },
      ],
    });
  });

  it("open: sends the app to the project the way a click does, and says it is ready once its document is open", async () => {
    h.projects = [...h.projects, { id: "p2", name: "Second cut" }];
    window.history.replaceState({}, "", "/");
    const reply = await call("manage_project", { action: "open", id: "p2" });
    expect(window.location.pathname).toBe("/p/p2");
    expect(h.routes, "the router was told").toEqual(["/p/p2"]);
    expect(reply.isError).toBe(false);
    expect(body(reply)).toEqual({ opened: "p2", ready: true });
  });

  it("open: a project whose document never opens is reported as not ready, as an error that says what to do", async () => {
    vi.useFakeTimers();
    h.documentOpens = false;
    const pending = call("manage_project", { action: "open", id: "p2" });
    expect(await runClock(pending, 20_000)).toBe(true);
    const reply = await pending;
    expect(reply.isError).toBe(true);
    expect(body(reply)).toMatchObject({ opened: "p2", ready: false });
    expect(String(body(reply).remedy)).toMatch(/action='current'/);
  });

  it("open: a project still opening is waited for, and not given up on before its time", async () => {
    vi.useFakeTimers();
    h.documentOpens = false;
    const pending = call("manage_project", { action: "open", id: "p2" });
    expect(await runClock(pending, 10_000), "gave up on a project that was still opening").toBe(
      false,
    );
    h.documentOpens = true;
    expect(await runClock(pending, 1_000)).toBe(true);
    expect(body(await pending)).toEqual({ opened: "p2", ready: true });
  });

  it("create: makes the project with the name, aspect and fps asked for, opens it and says so", async () => {
    window.history.replaceState({}, "", "/");
    const reply = await call("manage_project", {
      action: "create",
      name: "  Trailer  ",
      aspect: "16:9",
      fps: 25,
    });
    expect(h.created).toEqual([["Trailer", "16:9", 25]]);
    expect(window.location.pathname).toBe("/p/made_1");
    expect(reply.isError).toBe(false);
    expect(body(reply)).toEqual({ created: "made_1", name: "Trailer", ready: true });
  });

  it("create: an fps that is not a number is not passed on as one", async () => {
    await call("manage_project", { action: "create", name: "T", fps: "25" });
    expect(h.created).toEqual([["T", undefined, undefined]]);
  });

  it.each([
    [{ action: "open" }, /open requires 'id'/],
    [{ action: "open", id: "" }, /open requires 'id'/],
    [{ action: "create" }, /create requires 'name'/],
    [{ action: "create", name: "   " }, /create requires 'name'/],
    [{ action: "rename" }, /unknown action 'rename'/],
    [{}, /unknown action ''/],
  ])("refuses %j without creating or opening anything", async (args, why) => {
    window.history.replaceState({}, "", "/");
    const reply = await call("manage_project", args);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toMatch(why);
    expect(h.created).toEqual([]);
    expect(window.location.pathname).toBe("/");
  });

  it("current: a project that is no longer in the list is reported with no name, not as a failure", async () => {
    h.activeId = "gone";
    const reply = await call("manage_project", { action: "current" });
    expect(reply.isError).toBe(false);
    expect(body(reply)).toEqual({ active_id: "gone", name: null });
  });

  // KNOWN BUG, kept as an expected failure. `open` learned that "ready: false" travelling alone, as a success, made an agent
  // carry on while every write went to the project that was still active, and now answers it as an error with what to do.
  // `create` did not: a project that is created but does not open (still open in another window, a slow disk) is answered
  // `{created, ready: false}` as a SUCCESS, so the agent goes on editing, and its edits land in the project the person had
  // open before. When this passes, remove `.fails`.
  it.fails(
    "create: a project that was created but did not open is an error that says what to do",
    async () => {
      vi.useFakeTimers();
      h.documentOpens = false;
      const pending = call("manage_project", { action: "create", name: "Trailer" });
      expect(await runClock(pending, 20_000)).toBe(true);
      const reply = await pending;
      expect(body(reply)).toMatchObject({ created: "made_1", ready: false });
      expect(reply.isError, "a project that did not open was reported as a success").toBe(true);
    },
  );
});
