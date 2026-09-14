import { beforeEach, describe, expect, it, vi } from "vitest";

import { useProjects } from "./projects";

// The projects store now owns CRUD locally via a ProjectRegistry over the
// co-located app-data dir (no server). Mock the registry + the data-root/Tauri
// fs seams so tests never touch disk or load Tauri plugins.
const reg = vi.hoisted(() => ({
  read: vi.fn(),
  listLive: vi.fn(),
  createProject: vi.fn(),
  register: vi.fn(),
  setActive: vi.fn(),
  readProject: vi.fn(),
  // F14: open() goes through openProjectData (schema guard/migration); default OK.
  openProjectData: vi.fn(async () => ({ ok: true, data: {} })),
  writeProject: vi.fn(),
  // Mirror the real registry: updateProject is a locked read-modify-write that
  // delegates to readProject + writeProject, so the existing write assertions hold.
  updateProject: vi.fn(
    async (id: string, mutate: (pj: Record<string, unknown>) => Record<string, unknown>) => {
      const pj = (await reg.readProject(id)) as Record<string, unknown>;
      const next = mutate(pj);
      await reg.writeProject(id, next);
      return next;
    },
  ),
  write: vi.fn(),
  // Mirror the real registry: updateRegistry is a locked RMW over projects.json
  // that delegates to read + write, so existing write assertions still hold.
  updateRegistry: vi.fn(
    async (mutate: (r: Record<string, unknown>) => Record<string, unknown> | void) => {
      const r = (await reg.read()) as Record<string, unknown>;
      const next = mutate(r) ?? r;
      await reg.write(next);
      return next;
    },
  ),
  duplicateProject: vi.fn(),
  deleteProject: vi.fn(
    async (): Promise<{
      deleted: boolean;
      trashFailed?: boolean;
      error?: string;
      active_project_id: string | null;
    }> => ({
      deleted: true,
      active_project_id: null,
    }),
  ),
  projectDir: vi.fn((id: string) => `/root/projects/${id}`),
  dirFor: vi.fn(async (id: string) => `/root/projects/${id}`),
  saveProjectAs: vi.fn(async (id: string, dest: string) => ({ id, path: dest })),
  migrateUnsafeIds: vi.fn(async () => ({ migrated: [], dropped: [], failed: [] })),
  repairLegacyRootPaths: vi.fn(async () => ({ repaired: [] })),
}));

// F7: the projects store refuses to delete the project that's OPEN in the editor.
// Mock the editor store so we can toggle which project is open without loading it.
const editorState = vi.hoisted(() => ({ projectId: null as string | null }));

vi.mock("../tools/dataRoot", () => ({
  projectsRoot: vi.fn(async () => "/root/projects"),
  registryPath: vi.fn(async () => "/root/projects.json"),
}));
vi.mock("../tools/tauri", () => ({ TauriFs: class {} }));
vi.mock("../tools/project", () => ({ ProjectRegistry: vi.fn(() => reg) }));
vi.mock("./editor", () => ({ useEditor: { getState: () => editorState } }));

beforeEach(() => {
  vi.clearAllMocks();
  reg.read.mockResolvedValue({ activeProjectId: null, projects: [] });
  reg.listLive.mockResolvedValue([]);
  reg.projectDir.mockImplementation((id: string) => `/root/projects/${id}`);
  reg.dirFor.mockImplementation(async (id: string) => `/root/projects/${id}`);
  reg.openProjectData.mockResolvedValue({ ok: true, data: {} });
  editorState.projectId = null;
  useProjects.setState({ projects: [], activeId: null, active: null, loading: false, error: null });
});

describe("useProjects", () => {
  it("refresh loads projects + active id", async () => {
    reg.read.mockResolvedValue({
      activeProjectId: "p1",
      projects: [{ id: "p1", name: "A", path: "/root/projects/p1" }],
    });
    reg.listLive.mockResolvedValue([
      { id: "p1", name: "A", path: "/root/projects/p1", lastOpenedAt: "t" },
    ]);
    await useProjects.getState().refresh();
    expect(useProjects.getState().projects).toHaveLength(1);
    expect(useProjects.getState().activeId).toBe("p1");
    expect(useProjects.getState().loading).toBe(false);
  });

  it("refresh records an error on failure", async () => {
    reg.read.mockRejectedValue(new Error("down"));
    await useProjects.getState().refresh();
    expect(useProjects.getState().error).toContain("down");
    expect(useProjects.getState().loading).toBe(false);
  });

  it("create scaffolds a project with the aspect canvas then refreshes", async () => {
    reg.createProject.mockResolvedValue({ id: "p2", dir: "/root/projects/p2" });
    reg.readProject.mockResolvedValue({ name: "B", settings: {} });
    const p = await useProjects.getState().create("B", "16:9");
    expect(p.id).toBe("p2");
    expect(reg.createProject).toHaveBeenCalledWith(
      "B",
      { width: 1920, height: 1080, fps: 30 },
      "",
      undefined,
    );
    expect(reg.register).toHaveBeenCalled();
    expect(reg.read).toHaveBeenCalled(); // refresh ran
  });

  it("open sets the active project", async () => {
    reg.readProject.mockResolvedValue({ name: "A", settings: {} });
    await useProjects.getState().open("p1");
    expect(reg.setActive).toHaveBeenCalledWith("p1");
    expect(useProjects.getState().active?.id).toBe("p1");
    expect(useProjects.getState().activeId).toBe("p1");
  });

  it("a superseded slow open() does not stomp the newer activation (RF6)", async () => {
    reg.readProject.mockResolvedValue({ name: "X", settings: {} });
    // open("a") is invoked first, so it takes the one-time SLOW schema read and
    // blocks; open("b") falls through to the default immediate mock and wins.
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((r) => (releaseA = r));
    reg.openProjectData.mockImplementationOnce(async () => {
      await aGate;
      return { ok: true, data: {} };
    });

    const pa = useProjects.getState().open("a"); // starts, then blocks in openProjectData
    await useProjects.getState().open("b"); // completes first -> active = b
    expect(useProjects.getState().activeId).toBe("b");

    releaseA(); // "a" now resolves LATE, after the user is already on "b"
    await pa;

    // The stale open("a") must NOT re-highlight or re-persist itself.
    expect(useProjects.getState().activeId).toBe("b");
    expect(useProjects.getState().active?.id).toBe("b");
    expect(reg.setActive).toHaveBeenCalledWith("b");
    expect(reg.setActive).not.toHaveBeenCalledWith("a");
  });

  it("rename updates the active project when it is current", async () => {
    useProjects.setState({ activeId: "p1" });
    reg.read.mockResolvedValue({
      activeProjectId: "p1",
      projects: [{ id: "p1", name: "A", path: "/root/projects/p1" }],
    });
    reg.readProject.mockResolvedValue({ name: "New", settings: {} });
    await useProjects.getState().rename("p1", "New");
    expect(reg.writeProject).toHaveBeenCalled();
    expect(useProjects.getState().active?.name).toBe("New");
  });

  it("remove clears the active project when it is current", async () => {
    useProjects.setState({
      activeId: "p1",
      active: { id: "p1", name: "A", path: "", settings: {} },
    });
    await useProjects.getState().remove("p1");
    expect(reg.deleteProject).toHaveBeenCalledWith("p1");
    expect(useProjects.getState().active).toBeNull();
    expect(useProjects.getState().activeId).toBeNull();
  });

  it("duplicate returns the copy + refreshes", async () => {
    reg.readProject.mockResolvedValue({ name: "A copy", settings: {} });
    reg.duplicateProject.mockResolvedValue({ id: "p3", dir: "/root/projects/p3" });
    const p = await useProjects.getState().duplicate("p1", "A copy");
    expect(p.id).toBe("p3");
    expect(reg.duplicateProject).toHaveBeenCalledWith("p1", "A copy");
  });

  it("updateSettings updates the active project's canvas when current", async () => {
    useProjects.setState({ activeId: "p1" });
    reg.readProject.mockResolvedValue({
      name: "A",
      settings: { canvas: { width: 1, height: 2, fps: 30 } },
    });
    await useProjects.getState().updateSettings("p1", { width: 1 });
    expect(reg.writeProject).toHaveBeenCalled();
    expect(useProjects.getState().active?.settings.canvas?.width).toBe(1);
  });

  it("rename leaves the active project alone when a different one is renamed", async () => {
    useProjects.setState({
      activeId: "other",
      active: { id: "other", name: "O", path: "", settings: {} },
    });
    reg.readProject.mockResolvedValue({ name: "New", settings: {} });
    await useProjects.getState().rename("p1", "New");
    expect(useProjects.getState().active?.id).toBe("other");
    expect(useProjects.getState().active?.name).toBe("O");
  });

  it("remove keeps the active project when a different one is removed", async () => {
    useProjects.setState({
      activeId: "keep",
      active: { id: "keep", name: "K", path: "", settings: {} },
    });
    reg.read.mockResolvedValue({ activeProjectId: "keep", projects: [] });
    await useProjects.getState().remove("p1");
    expect(useProjects.getState().active?.id).toBe("keep");
  });

  it("remove surfaces trashFailed and keeps the project; removePermanently shreds (R12)", async () => {
    useProjects.setState({
      activeId: "p1",
      active: { id: "p1", name: "A", path: "", settings: {} },
    });
    reg.deleteProject.mockResolvedValueOnce({
      deleted: false,
      trashFailed: true,
      error: "nope",
      active_project_id: "p1",
    });
    const res = await useProjects.getState().remove("p1");
    expect(res).toEqual({ trashFailed: true, error: "nope" });
    expect(useProjects.getState().activeId).toBe("p1"); // kept, NOT cleared
    // The explicit permanent delete goes through with the permanent flag.
    await useProjects.getState().removePermanently("p1");
    expect(reg.deleteProject).toHaveBeenLastCalledWith("p1", { permanent: true });
  });

  it("refuses to delete the project that's currently open in the editor (F7)", async () => {
    editorState.projectId = "p1"; // p1 is open -> its index/thumbnail/session writers are live
    const res = await useProjects.getState().remove("p1");
    expect(res.trashFailed).toBe(false);
    expect(res.error).toMatch(/Switch to another project/);
    expect(reg.deleteProject).not.toHaveBeenCalled(); // never touched the fs -> no ghost
    await useProjects.getState().removePermanently("p1"); // also a no-op for the open project
    expect(reg.deleteProject).not.toHaveBeenCalled();
  });

  it("allows deleting a project that is not the open one (F7)", async () => {
    editorState.projectId = "p2"; // a DIFFERENT project is open
    await useProjects.getState().remove("p1");
    expect(reg.deleteProject).toHaveBeenCalledWith("p1");
  });

  it("updateSettings leaves the active project alone when not current", async () => {
    useProjects.setState({
      activeId: "other",
      active: { id: "other", name: "O", path: "", settings: {} },
    });
    reg.readProject.mockResolvedValue({ name: "A", settings: {} });
    await useProjects.getState().updateSettings("p1", { fps: 30 });
    expect(reg.writeProject).toHaveBeenCalled();
    expect(useProjects.getState().active?.id).toBe("other");
  });
});
