// The bridge's answer to `tools/list` — driven through `dispatch`, the real boundary Rust calls.
//
// The contract is the REAL bundled one, not a stand-in: what an external agent receives is the
// committed catalog, and a substitute catalog would agree with itself while the shipped file was
// empty or names-only — the exact regression bundling was meant to end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function listTools(): Promise<Record<string, unknown>> {
  const { dispatch } = await import("./bridge");
  return dispatch({ id: 1, method: "tools/list" } as never);
}

function names(res: Record<string, unknown>): string[] {
  return ((res.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
}

describe("tools/list", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("lists the real bundled catalog with descriptions and schemas, needing no network", async () => {
    // The bundle is why this door works offline. An empty or names-only list here is what made an
    // external agent's tool list useless.
    const out = await listTools();
    const listed = out.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    expect(listed.length).toBeGreaterThan(20);
    for (const t of listed) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.inputSchema, t.name).toBeTruthy();
    }
  });

  it("appends manage_project, which exists only for MCP", async () => {
    const listed = names(await listTools());
    expect(listed).toContain("manage_project");
    expect(listed.filter((n) => n === "manage_project")).toHaveLength(1);
  });

  it("does not advertise a withdrawn tool", async () => {
    const { WITHDRAWN_TOOLS } = await import("../contract/withdrawn");
    const listed = new Set(names(await listTools()));
    for (const n of WITHDRAWN_TOOLS) expect(listed, n).not.toContain(n);
  });
});

// The in-app agent scrubs absolute paths, strips `_attachments` and caps an oversized result
// before the model sees it; this door was returning the raw reply. Found by driving the running
// app over MCP: `inspect_media` handed back `"media_ref": "C:/Users/<name>/qa_media/take_a.mp4"`,
// and `inspect_timeline` an `_attachments` array of absolute cache paths. That is the user's
// directory structure, and it teaches an agent to address media by path in a product whose rule
// is that it cannot.
describe("results handed to an external agent", () => {
  const sanitize = async (v: unknown) => (await import("./bridge")).sanitizeForMcp(v);

  it("reduces an absolute path to its basename", async () => {
    const out = (await sanitize({
      ok: true,
      media_ref: "C:/Users/someone/private/footage/take_a.mp4",
    })) as Record<string, unknown>;
    expect(String(out.media_ref)).not.toContain("Users");
    expect(String(out.media_ref)).toContain("take_a.mp4");
  });

  it("drops the internal attachments field", async () => {
    const out = (await sanitize({ ok: true, _attachments: [{ path: "C:/x/y.png" }] })) as Record<
      string,
      unknown
    >;
    expect("_attachments" in out).toBe(false);
  });

  it("caps a result that would otherwise be unbounded", async () => {
    const big = { ok: true, blob: "x".repeat(400_000) };
    const out = JSON.stringify(await sanitize(big));
    expect(out.length).toBeLessThan(JSON.stringify(big).length);
  });

  it("leaves a normal result alone", async () => {
    const r = { ok: true, count: 2, created: [{ clip_id: "clip_a" }] };
    expect(await sanitize(r)).toEqual(r);
  });

  it("passes a non-object through untouched", async () => {
    expect(await sanitize("plain")).toBe("plain");
    expect(await sanitize(null)).toBe(null);
  });
});


// A gated app has no editor mounted, so the Shell that opens a ProjectDocument never runs. The
// bridge used to wait 15s and then blame routing, which sent an agent looking in the wrong place.
describe("manage_project under the sign-in gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses immediately and names sign-in, instead of timing out on a Shell that cannot mount", async () => {
    vi.doMock("../store/auth", () => ({
      isSignedOutGate: () => true,
      useAuth: { getState: () => ({ status: "locked", hasStoredSession: false }) },
    }));
    const { dispatch } = await import("./bridge");
    // The document wait polls on setTimeout, so under fake timers it can only finish if the clock
    // is advanced. A bridge that fell into it hangs here rather than racing a wall-clock budget,
    // which is what made this assertion fail on a loaded machine while the behaviour was right.
    vi.useFakeTimers();
    const res = (await dispatch({
      id: 2,
      method: "tools/call",
      params: { name: "manage_project", arguments: { action: "open", id: "p1" } },
    } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    vi.useRealTimers();

    expect(res.isError).toBe(true);
    const body = res.content[0].text;
    expect(body).toMatch(/sign-in|sign in/i);
  });
});


// Withdrawn tools keep their implementations so they can be brought back, which means the tool
// host still answers `has(name)` for one. The catalog is what decides, and an agent that
// remembers a name from an older session must not be able to reach past the list.
describe("a tool withdrawn from the catalog", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is refused even though its implementation is still registered", async () => {
    const ran = vi.fn();
    vi.doMock("../contract", () => ({
      allTools: () => [{ name: "add_clips", description: "", parameters: {} }],
      paramSchema: () => undefined,
      contractStatus: () => "ready",
      ensureContract: async () => {},
    }));
    vi.doMock("../store/projects", () => ({
      useProjects: { getState: () => ({ activeId: "p1", refresh: async () => {} }) },
    }));
    vi.doMock("../store/auth", () => ({
      isSignedOutGate: () => false,
      useAuth: { getState: () => ({ status: "unlocked", hasStoredSession: true }) },
    }));
    vi.doMock("../project/openDocuments", () => ({ openDocumentById: () => ({}) }));
    vi.doMock("../tools/host", () => ({
      openToolHost: () => ({ ready: Promise.resolve(), has: () => true, run: ran }),
    }));

    const { dispatch } = await import("./bridge");
    const res = (await dispatch({
      id: 9,
      method: "tools/call",
      params: { name: "extract_style", arguments: {} },
    } as never)) as { isError?: boolean; content: Array<{ text: string }> };

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unknown tool/i);
    expect(ran, "a withdrawn tool must never reach its implementation").not.toHaveBeenCalled();
  });
});

// manage_project refused a gated app from the start; every OTHER tool discarded the same answer
// and ran anyway, so an external agent got whatever the tool happened to fail with -- a store
// error for a local edit, an HTTP 401 for a hosted one -- and no way to read either as "a human
// has to sign in". The refusal belongs to the door, not to one tool.
describe("any tool under the sign-in gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const gated = async (tool: string) => {
    const ran = vi.fn();
    vi.doMock("../store/projects", () => ({
      useProjects: { getState: () => ({ activeId: "p1", refresh: async () => {} }) },
    }));
    vi.doMock("../store/auth", () => ({
      isSignedOutGate: () => true,
      useAuth: { getState: () => ({ status: "locked", hasStoredSession: false }) },
    }));
    vi.doMock("../tools/host", () => ({
      openToolHost: () => ({ ready: Promise.resolve(), has: () => true, run: ran }),
    }));
    const { dispatch } = await import("./bridge");
    const res = (await dispatch({
      id: 11,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    } as never)) as { isError?: boolean; content: Array<{ text: string }> };
    return { res, ran };
  };

  // A LOCAL edit and a HOSTED call fail for different reasons underneath, so verifying one says
  // nothing about the other.
  it.each(["add_clips", "generate_video"])("refuses %s and names sign-in", async (tool) => {
    const { res, ran } = await gated(tool);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/sign.?in/i);
    expect(ran, "a gated app must not reach the implementation at all").not.toHaveBeenCalled();
  });

  it("tells the agent what to do about it, not just that it failed", async () => {
    const { res } = await gated("add_clips");
    expect(res.content[0].text).toMatch(/remedy/i);
    expect(res.content[0].text).toMatch(/ran/i);
  });
});

// The socket binds at boot, outside the AuthProvider gate, so a signed-out app still answers on
// this door. Gating per method would leave tools/list -- which needs no session to answer from the
// bundled catalog -- advertising a surface the user cannot reach.
describe("the MCP door when signed out", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../store/auth", () => ({
      isSignedOutGate: () => true,
      useAuth: { getState: () => ({ status: "locked", hasStoredSession: false }) },
    }));
  });

  it.each([
    ["tools/list", undefined],
    ["tools/call", { name: "add_clips", arguments: {} }],
    ["something/new", undefined],
  ])("refuses %s and names sign-in", async (method, params) => {
    const { dispatch } = await import("./bridge");
    const res = (await dispatch({ id: 3, method, params } as never)) as {
      isError?: boolean;
      tools?: unknown[];
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.tools, "a signed-out app must advertise nothing").toBeUndefined();
    expect(res.content[0].text).toMatch(/signed out/i);
    expect(res.content[0].text).toMatch(/sign in/i);
  });
});
