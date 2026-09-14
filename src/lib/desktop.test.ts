// Guards the desktop fs fast-path. The invariant: this helper may ONLY hand back a
// store that really belongs to the requested project. Handing back the active
// editor's store for a DIFFERENT projectId would write one project's session into
// another's folder — silent cross-project corruption that no type catches.
import { beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = { capabilities: { fileSystem: true } };
const editorState: { projectId: string | null; store: unknown } = { projectId: null, store: null };
const createProjectStore = vi.fn(async (dir: string) => ({ tag: "fresh", dir }));
const projectDirFor = vi.fn(async (id: string) => `/projects/${id}`);

vi.mock("../platform", () => ({ platform: platformMock }));
vi.mock("../store/editor", () => ({
  createProjectStore: (dir: string) => createProjectStore(dir),
  useEditor: { getState: () => editorState },
}));
vi.mock("../tools/dataRoot", () => ({
  boundProjectId: () => "",
  projectDirFor: (id: string) => projectDirFor(id),
}));

const { desktopStore, storeForProject } = await import("./desktop");

const ACTIVE = { tag: "editor" };

beforeEach(() => {
  platformMock.capabilities.fileSystem = true;
  editorState.projectId = null;
  editorState.store = null;
  createProjectStore.mockClear();
  projectDirFor.mockClear();
  projectDirFor.mockImplementation(async (id: string) => `/projects/${id}`);
});

describe("desktopStore", () => {
  it("returns null on web (no local filesystem) even when a store is loaded", () => {
    platformMock.capabilities.fileSystem = false;
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    expect(desktopStore("p1")).toBeNull();
  });

  it("returns the editor store when it is the SAME project", () => {
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    expect(desktopStore("p1")).toBe(ACTIVE);
  });

  it("returns null for a DIFFERENT project — never leaks another project's store", () => {
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    expect(desktopStore("p2")).toBeNull();
  });

  it("returns null when the id matches but no store is loaded yet", () => {
    editorState.projectId = "p1";
    editorState.store = null;
    expect(desktopStore("p1")).toBeNull();
  });

  it("never returns a store when the editor has no project open", () => {
    editorState.projectId = null;
    editorState.store = ACTIVE;
    expect(desktopStore("p1")).toBeNull();
  });
});

describe("storeForProject", () => {
  it("returns null on web", async () => {
    platformMock.capabilities.fileSystem = false;
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    await expect(storeForProject("p1")).resolves.toBeNull();
    expect(createProjectStore).not.toHaveBeenCalled();
  });

  it("reuses the editor's store for the active project (no second store for one dir)", async () => {
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    await expect(storeForProject("p1")).resolves.toBe(ACTIVE);
    expect(createProjectStore).not.toHaveBeenCalled();
  });

  it("builds a fresh store for a project the editor does not have open", async () => {
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    const s = await storeForProject("p2");
    expect(s).not.toBe(ACTIVE);
    expect(projectDirFor).toHaveBeenCalledWith("p2");
    expect(createProjectStore).toHaveBeenCalledWith("/projects/p2");
  });

  it("builds a fresh store when nothing is open at all", async () => {
    const s = await storeForProject("p3");
    expect(s).toMatchObject({ dir: "/projects/p3" });
  });

  it("returns null (rather than throwing) when the project dir cannot be resolved", async () => {
    projectDirFor.mockRejectedValueOnce(new Error("outside the data root"));
    await expect(storeForProject("../escape")).resolves.toBeNull();
  });

  it("returns null when building the store throws", async () => {
    createProjectStore.mockRejectedValueOnce(new Error("mkdir denied"));
    await expect(storeForProject("p4")).resolves.toBeNull();
  });

  it("a rejected path resolution never falls back to the ACTIVE project's store", async () => {
    editorState.projectId = "p1";
    editorState.store = ACTIVE;
    projectDirFor.mockRejectedValueOnce(new Error("nope"));
    await expect(storeForProject("p2")).resolves.toBeNull();
  });
});
