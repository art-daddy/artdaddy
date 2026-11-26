// The whole path a request takes through the webview: Rust emits it, the bridge answers it, and the answer goes back by
// `mcp_reply` on the id Rust is blocking a connection thread for. A request that gets no reply hangs that agent until the
// 10-minute call timeout; a reply on the wrong id answers somebody else's call. So whatever arrives, exactly one reply goes
// back, on its own id, in a shape an MCP client accepts.
//
// Driven through the real `startMcpServer` (which wires the bridge) and the real host and argument gate; only Tauri's two IPC
// surfaces, the project store and the tools themselves are stand-ins (the tools record, wait for a Stop, or fail on demand).
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientToolContext } from "../tools/context";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  replies: [] as Array<{ id: number; payload: unknown }>,
  instructionsSent: 0,
  calls: [] as string[],
  /** Whether `export` stands for a long job that waits for its Stop, and what it saw when it did. */
  exportWaits: false,
  waiting: { started: false, aborted: false },
  /** When set, the project cannot be opened for tools, with this error (a folder gone, a disk refusing). */
  openFails: null as Error | null,
  /** When set, what every tool answers (instead of `{ ok: true, ran }`). */
  result: null as unknown,
  /** The frames on disk a tool's attachments point at: path -> bytes; a path missing here cannot be read. */
  files: new Map<string, Uint8Array>(),
}));

vi.mock("../platform", () => ({
  platform: { name: "tauri", capabilities: { localTools: true, fileSystem: true }, apiBaseUrl: "" },
}));
vi.mock("../observability/sentry", () => ({ captureError: () => undefined }));
vi.mock("../api/appEvents", () => ({ reportMcpEvent: () => undefined }));
vi.mock("./instructions", () => ({ mcpInstructions: async () => "instructions" }));
vi.mock("../update/compatibility", async (original) => ({
  ...(await original<typeof import("../update/compatibility")>()),
  compatibilityAllowsWork: () => true,
  assertCompatibleClient: () => undefined,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    h.handlers.set(name, handler);
    return () => undefined;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { id?: number; payload?: unknown }) => {
    if (cmd === "mcp_reply") h.replies.push({ id: Number(args?.id), payload: args?.payload });
    if (cmd === "mcp_set_instructions") h.instructionsSent += 1;
    return { running: true, port: 19787 };
  },
}));
vi.mock("../store/projects", () => ({
  useProjects: {
    getState: () => ({
      activeId: "p1",
      active: { id: "p1", name: "QA" },
      projects: [{ id: "p1", name: "QA" }],
      refresh: async () => undefined,
    }),
  },
}));
vi.mock("../project/openDocuments", () => ({ openDocumentById: () => ({}) }));
vi.mock("../tools", async () => {
  const { ClientToolRegistry } = await import("../tools/registry");
  const { toolDefinitions } = await import("../contract");
  return {
    ClientToolRegistry,
    createToolRegistry: (getCtx: () => ClientToolContext | null) => {
      const registry = new ClientToolRegistry();
      for (const { name } of toolDefinitions())
        registry.register(name, async () => {
          h.calls.push(name);
          if (h.result !== null) return h.result;
          if (name !== "export" || !h.exportWaits) return { ok: true, ran: name };
          // A long job: it ends when the agent's Stop reaches it, and not before.
          const signal = getCtx()?.signal;
          h.waiting.started = true;
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
          h.waiting.aborted = !!signal?.aborted;
          return { ok: false, error: "stopped" };
        });
      return registry;
    },
  };
});
vi.mock("../tools/dataRoot", async (original) => ({
  ...(await original<typeof import("../tools/dataRoot")>()),
  projectDirFor: async () => {
    if (h.openFails) throw h.openFails;
    return "C:/proj";
  },
}));
vi.mock("../tools/tauri", async () => {
  const { MemFs, makeRunner } = await import("../test/timelineKit");
  const { ProjectStoreAccess } = await import("../tools/store");
  return {
    makeTauriContext: async () => {
      const store = new ProjectStoreAccess("C:/proj", new MemFs());
      // Rendered frames are read straight from the project's store.
      Object.assign(store, {
        byteSize: async (path: string) => h.files.get(path)?.length ?? null,
        readBytes: async (path: string) => {
          const bytes = h.files.get(path);
          if (!bytes) throw new Error(`ENOENT ${path}`);
          return bytes;
        },
      });
      return { store, runner: makeRunner() };
    },
  };
});

const REQUEST = "artdaddy://mcp-request";
const CANCEL = "artdaddy://mcp-cancel";

beforeEach(async () => {
  vi.resetModules();
  h.handlers.clear();
  h.replies.length = 0;
  h.instructionsSent = 0;
  h.calls.length = 0;
  h.exportWaits = false;
  h.waiting = { started: false, aborted: false };
  h.openFails = null;
  h.result = null;
  h.files.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  const { useAuth } = await import("../store/auth");
  useAuth.setState({ status: "unlocked", hasStoredSession: true });
  window.history.replaceState({}, "", "/p/p1");
  const { startMcpServer } = await import("./service");
  await startMcpServer();
});

function send(payload: Record<string, unknown>): void {
  h.handlers.get(REQUEST)!({ payload });
}

/** The replies sent for `id`, once at least one has arrived. */
async function repliesFor(id: number): Promise<unknown[]> {
  await vi.waitFor(() => expect(h.replies.some((r) => r.id === id)).toBe(true), {
    timeout: 5_000,
    interval: 2,
  });
  // Anything sent twice would be on its way by now.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return h.replies.filter((r) => r.id === id).map((r) => r.payload);
}

/** A reply an MCP client accepts: a tool list, or content that opens with a text block and holds only text and image
 *  blocks, with a yes/no error flag. */
function expectWellFormed(payload: unknown, why: string): void {
  expect(payload && typeof payload === "object" && !Array.isArray(payload), why).toBe(true);
  const reply = payload as { tools?: unknown; content?: unknown; isError?: unknown };
  if (Array.isArray(reply.tools)) return;
  const content = reply.content as Array<Record<string, unknown>>;
  expect(Array.isArray(content) && content.length > 0, why).toBe(true);
  expect(content[0].type, why).toBe("text");
  for (const block of content) {
    expect(
      block && typeof block === "object",
      `${why}: a content block that is not an object`,
    ).toBe(true);
    if (block.type === "image") {
      expect(typeof block.data, why).toBe("string");
      expect(String(block.mimeType), why).toMatch(/^image\//);
    } else {
      expect(block.type, why).toBe("text");
      expect(typeof block.text, why).toBe("string");
    }
  }
  expect(typeof reply.isError, why).toBe("boolean");
}

describe("every request gets exactly one reply, on its own id", () => {
  it("whatever Rust hands over: any method, any params, any client", async () => {
    const methods = fc.oneof(fc.constantFrom("tools/list", "tools/call"), fc.string());
    const params = fc.oneof(
      fc.jsonValue({ maxDepth: 3 }),
      fc.record({
        name: fc.constantFrom("get_timeline", "undo", "not_a_tool", "manage_project", ""),
        arguments: fc.jsonValue({ maxDepth: 2 }),
      }),
    );
    let id = 1_000;
    await fc.assert(
      fc.asyncProperty(
        methods,
        params,
        fc.jsonValue({ maxDepth: 2 }),
        async (method, p, client) => {
          id += 1;
          send({ id, method, params: p, client });
          const sent = await repliesFor(id);
          const why = `${method} ${JSON.stringify(p)}`;
          expect(sent, why).toHaveLength(1);
          expectWellFormed(sent[0], why);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("answers requests that overlap, each on its own id, whatever order they finish in", async () => {
    // The export waits for a Stop; the reads behind it must not wait for it, nor take its reply.
    h.exportWaits = true;
    send({ id: 1, method: "tools/call", params: { name: "export", arguments: {} } });
    await vi.waitFor(() => expect(h.waiting.started).toBe(true));
    send({ id: 2, method: "tools/call", params: { name: "get_timeline", arguments: {} } });
    send({ id: 3, method: "tools/list", params: {} });
    expect(await repliesFor(2)).toHaveLength(1);
    expect(await repliesFor(3)).toHaveLength(1);
    expect(h.replies.some((r) => r.id === 1)).toBe(false);
    h.handlers.get(CANCEL)!({ payload: { id: 1 } });
    const [export1] = await repliesFor(1);
    expectWellFormed(export1, "the stopped export");
  });
});

describe("a Stop from the agent", () => {
  beforeEach(() => {
    h.exportWaits = true;
  });

  it("reaches the running tool, which ends, and its call is answered once", async () => {
    send({ id: 7, method: "tools/call", params: { name: "export", arguments: {} } });
    await vi.waitFor(() => expect(h.waiting.started).toBe(true));
    h.handlers.get(CANCEL)!({ payload: { id: 7 } });
    const sent = await repliesFor(7);
    expect(h.waiting.aborted, "the tool's signal was aborted").toBe(true);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { isError?: boolean }).isError).toBe(true);
  });

  it("for a call that is not running changes nothing and stops nobody else", async () => {
    send({ id: 8, method: "tools/call", params: { name: "export", arguments: {} } });
    await vi.waitFor(() => expect(h.waiting.started).toBe(true));
    for (const id of [9, 0, -1, 7_000_000]) h.handlers.get(CANCEL)!({ payload: { id } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.waiting.aborted, "a Stop for another call stopped this one").toBe(false);
    expect(h.replies).toEqual([]);
    h.handlers.get(CANCEL)!({ payload: { id: 8 } });
    expect(await repliesFor(8)).toHaveLength(1);
  });
});

describe("a failure below the door", () => {
  const PRIVATE = "D:\\Clients\\Acme\\HolidayCut\\project.json";

  it("reaches the agent as an error, never as a success and never as silence", async () => {
    h.openFails = new Error(`could not read ${PRIVATE}: access denied`);
    send({ id: 21, method: "tools/call", params: { name: "get_timeline", arguments: {} } });
    const sent = await repliesFor(21);
    expect(sent).toHaveLength(1);
    expectWellFormed(sent[0], "a project that could not be opened");
    expect((sent[0] as { isError?: boolean }).isError).toBe(true);
    expect(h.calls, "no tool ran").toEqual([]);
  });

  // KNOWN BUG, kept as an expected failure. A tool's own failure, and every result, is cleaned of the person's absolute paths
  // and capped before an outside agent sees it (`sanitizeForMcp`); an error THROWN below the door is not: the request handler
  // turns it into text as it is. The in-app agent cleans the same error (loop.ts `runCall`). When this passes, remove `.fails`.
  it.fails("does not hand the agent the person's folders in the error", async () => {
    h.openFails = new Error(`could not read ${PRIVATE}: access denied`);
    send({ id: 22, method: "tools/call", params: { name: "get_timeline", arguments: {} } });
    const [reply] = await repliesFor(22);
    const text = JSON.stringify(reply);
    expect(text).toContain("project.json");
    expect(text, "the reply names the person's folders").not.toMatch(/Clients\\\\Acme/);
  });
});

describe("the instructions handed to Rust", () => {
  it("are handed over again each time the app is signed in, and only then", async () => {
    const { useAuth } = await import("../store/auth");
    await vi.waitFor(() => expect(h.instructionsSent).toBe(1));
    useAuth.setState({ status: "unlocked" });
    useAuth.setState({ status: "locked" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.instructionsSent, "nothing new to hand over until the app is signed in again").toBe(1);
    useAuth.setState({ status: "unlocked" });
    await vi.waitFor(() => expect(h.instructionsSent).toBe(2));
  });
});

/** One tools/call through the whole path, and the one reply it got. */
async function answer(id: number, name = "inspect_timeline"): Promise<Record<string, unknown>> {
  send({ id, method: "tools/call", params: { name, arguments: {} } });
  const sent = await repliesFor(id);
  expect(sent).toHaveLength(1);
  expectWellFormed(sent[0], name);
  return sent[0] as Record<string, unknown>;
}

describe("what a tool answered, on its way to the agent", () => {
  it("is cut down to the size an agent can take, and says so", async () => {
    h.result = { ok: true, blob: "x".repeat(600_000) };
    const reply = await answer(31);
    const text = (reply.content as Array<{ text: string }>)[0].text;
    // The reply cap is 200,000 characters of the result (truncate.ts); pretty-printing adds a little.
    expect(text.length).toBeLessThan(205_000);
    expect(text).toMatch(/truncated/);
    expect(reply.isError).toBe(false);
  });

  it("names media by file name, never by the person's folders", async () => {
    h.result = { ok: true, media_ref: "D:\\Clients\\Acme\\Videos\\take_a.mp4" };
    const text = (await answer(32)).content as Array<{ text: string }>;
    expect(text[0].text).toContain("take_a.mp4");
    expect(text[0].text).not.toMatch(/Clients|Acme|Videos/);
  });

  // KNOWN BUG, kept as an expected failure. The path cleaner (agent/scrubPaths.ts, shared with the in-app agent) ends a path at
  // the first space, so a folder name with a space in it, which is common ("Holiday cut", "John Smith"), is only cut down to
  // its first word and everything after the space reaches the agent: here "Holiday cut\take_a.mp4". When this passes, remove
  // `.fails`.
  it.fails("names media by file name when a folder name has a space in it", async () => {
    h.result = { ok: true, media_ref: "D:\\Clients\\Acme\\Holiday cut\\take_a.mp4" };
    const text = (await answer(36)).content as Array<{ text: string }>;
    expect(text[0].text).toContain("take_a.mp4");
    expect(text[0].text, "the reply names the person's folders").not.toMatch(/Holiday|cut\\/);
  });

  it("is reported as an error exactly when the tool says it failed", async () => {
    h.result = { ok: false, error: "no such clip" };
    expect((await answer(33)).isError).toBe(true);
    h.result = { ok: true };
    expect((await answer(34)).isError).toBe(false);
    // A tool that answers with a bare value is not a failure.
    h.result = "done";
    const plain = await answer(35);
    expect(plain.isError).toBe(false);
    expect((plain.content as Array<{ text: string }>)[0].text).toBe("done");
  });
});

// A rendered frame travels as an MCP image block beside the text: an agent that is told `frames_attached: 3` and gets nothing
// viewable has nothing to look at. A reply is JSON over a socket, so the frames are capped: at most 8 of them, at most 4 MB each.
describe("the frames a tool rendered", () => {
  const MB = 1024 * 1024;
  const frame = (path: string, bytes: number) => {
    h.files.set(path, new Uint8Array(bytes).fill(7));
    return { path };
  };
  const images = (reply: Record<string, unknown>) =>
    (reply.content as Array<Record<string, unknown>>).filter((block) => block.type === "image");

  it("reach the agent as images of the right kind, with their captions, and their paths do not", async () => {
    h.result = {
      ok: true,
      frames_attached: 5,
      _attachments: [
        { ...frame("C:/proj/cache/f1.png", 10), caption: "first" },
        frame("C:/proj/cache/f2.JPG", 10),
        frame("C:/proj/cache/f3.jpeg", 10),
        frame("C:/proj/cache/f4.webp", 10),
        frame("C:/proj/cache/f5.gif", 10),
      ],
    };
    const reply = await answer(41);
    expect(images(reply).map((block) => block.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(images(reply)[0]._caption).toBe("first");
    expect(images(reply)[1]).not.toHaveProperty("_caption");
    expect(atob(String(images(reply)[0].data))).toBe("\u0007".repeat(10));
    expect(JSON.stringify((reply.content as unknown[])[0])).not.toMatch(/cache\/f1|_attachments/);
  });

  it("are at most eight, however many the tool rendered", async () => {
    h.result = {
      ok: true,
      _attachments: Array.from({ length: 12 }, (_, i) => frame(`C:/proj/cache/f${i}.png`, 10)),
    };
    expect(images(await answer(42))).toHaveLength(8);
  });

  it("leave out a frame over 4 MB, and keep one at 4 MB", async () => {
    h.result = {
      ok: true,
      _attachments: [
        frame("C:/proj/cache/big.png", 4 * MB + 1),
        frame("C:/proj/cache/ok.png", 4 * MB),
      ],
    };
    const sent = images(await answer(43));
    expect(sent).toHaveLength(1);
    expect(atob(String(sent[0].data)).length).toBe(4 * MB);
  });

  it("leave out video, sound and a frame that cannot be read, and still answer", async () => {
    h.result = {
      ok: true,
      _attachments: [
        frame("C:/proj/cache/clip.mp4", 10),
        frame("C:/proj/cache/voice.wav", 10),
        { path: "C:/proj/cache/gone.png" },
        frame("C:/proj/cache/kept.png", 10),
        "not an attachment",
      ],
    };
    const reply = await answer(44);
    expect(images(reply)).toHaveLength(1);
    expect(reply.isError).toBe(false);
  });
});
