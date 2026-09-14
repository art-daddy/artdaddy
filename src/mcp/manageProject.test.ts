// `manage_project` — the one tool that exists only for MCP, and the first thing an external
// session calls.
//
// Found by a QA sweep of 0.12.0: on a COLD start `current` answered `name: null` for a project
// that has a perfectly good name. `activeId` is restored from the persisted preference while the
// project LIST is still empty, and `current` looked the name up in that empty list — `list`
// refreshes first for exactly this reason and `current` did not. The agent's opening question,
// "what am I working on?", was answered "nothing you can name".
import { beforeEach, describe, expect, it, vi } from "vitest";

type Project = { id: string; name: string };

let projects: Project[] = [];
let activeId: string | null = null;
let refreshes = 0;

// The real store shape: `active` is DERIVED from the list, so it is undefined until a refresh
// populates it. Faking `active` directly would hide the very bug this file exists for.
const state = () => ({
  projects,
  activeId,
  active: projects.find((p) => p.id === activeId),
  refresh: async () => {
    refreshes += 1;
    projects = [{ id: "restored_1", name: "Holiday Cut" }];
  },
  create: async (name: string) => ({ id: "made_1", name }),
});

vi.mock("../store/projects", () => ({
  useProjects: { getState: () => state() },
}));
vi.mock("../project/openDocuments", () => ({
  openDocumentById: async () => ({ ok: true }),
}));
vi.mock("../tools/host", () => ({ openToolHost: async () => ({ ready: Promise.resolve() }) }));

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { dispatch } = await import("./bridge");
  const res = (await dispatch({
    id: 1,
    method: "tools/call",
    params: { name: "manage_project", arguments: args },
  } as never)) as { content?: Array<{ text?: string }> };
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

describe("manage_project current", () => {
  beforeEach(() => {
    vi.resetModules();
    projects = [];
    activeId = null;
    refreshes = 0;
  });

  it("names the project restored at startup, before anything has been opened", async () => {
    // The cold-start shape: an active id with a list nobody has loaded yet.
    activeId = "restored_1";
    expect(await call({ action: "current" })).toEqual({
      active_id: "restored_1",
      name: "Holiday Cut",
    });
  });

  it("does not pay for a refresh when the name is already known", async () => {
    // The failure direction of the fix: refreshing unconditionally would put a project-list
    // reload in front of every call an agent makes.
    projects = [{ id: "restored_1", name: "Holiday Cut" }];
    activeId = "restored_1";
    await call({ action: "current" });
    expect(refreshes).toBe(0);
  });

  it("still says plainly when nothing is open", async () => {
    const out = await call({ action: "current" });
    expect(out.active_id).toBeNull();
    expect(String(out.hint)).toMatch(/no project open/);
  });
});
