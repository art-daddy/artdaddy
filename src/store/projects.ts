import { create } from "zustand";

import type { ProjectListEntry, ProjectSummary } from "../api/types";
import { BRAND } from "../brand";
import { noteSessionProject } from "../observability/crashWatch";
import { reportProjectOpened } from "../api/appEvents";
import { projectsRoot, registryPath } from "../tools/dataRoot";
import { ProjectRegistry } from "../tools/project";
import { useEditor } from "./editor";

const ASPECT: Record<string, [number, number]> = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
};

/** A ProjectRegistry over the co-located app-data root, using the Tauri fs.
 *  Lazy-imports TauriFs so the browser bundle / tests never load Tauri plugins. */
async function localRegistry(): Promise<ProjectRegistry> {
  const { TauriFs } = await import("../tools/tauri");
  return new ProjectRegistry(await projectsRoot(), await registryPath(), new TauriFs());
}

async function summaryOf(reg: ProjectRegistry, id: string): Promise<ProjectSummary> {
  const pj = await reg.readProject(id);
  return {
    id,
    name: typeof pj.name === "string" ? pj.name : id,
    path: await reg.dirFor(id),
    settings: (pj.settings as ProjectSummary["settings"]) ?? {},
    manifest: null,
  };
}

// Monotonic activation ticket for open(): each call takes the next number, and
// only the LATEST may persist/highlight its project. Guards the A->B->A race a
// plain equality check misses (RF6).
let openSeq = 0;

interface ProjectsState {
  projects: ProjectListEntry[];
  activeId: string | null;
  active: ProjectSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string, aspect?: string, fps?: number, at?: string) => Promise<ProjectSummary>;
  open: (id: string) => Promise<ProjectSummary>;
  rename: (id: string, name: string) => Promise<void>;
  duplicate: (id: string, name?: string) => Promise<ProjectSummary>;
  /** Copy the project to `destDir` and make that its home. The caller must have CLOSED it
   *  first: close flushes the in-memory timeline to disk, so the copy is what the user sees. */
  saveAs: (id: string, destDir: string) => Promise<ProjectSummary>;
  remove: (id: string) => Promise<{ trashFailed: boolean; error?: string }>;
  removePermanently: (id: string) => Promise<void>;
  updateSettings: (
    id: string,
    s: { width?: number; height?: number; fps?: number },
  ) => Promise<void>;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  activeId: null,
  active: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const reg = await localRegistry();
      // Recorded paths first: the data-folder rename left them inside the old root, and both
      // the unsafe-id repair and listLive judge an entry by whether its directory exists.
      await reg.repairLegacyRootPaths();
      // Repair/drop any unsafe legacy ids (corrupt registry) before we list or
      // resolve any path from them — the id→dir containment invariant (F4).
      await reg.migrateUnsafeIds();
      const registry = await reg.read();
      const live = await reg.listLive();
      const projects: ProjectListEntry[] = live.map((e) => ({
        id: e.id,
        name: e.name,
        path: e.path,
        lastOpenedAt: e.lastOpenedAt,
      }));
      set({ projects, activeId: registry.activeProjectId, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  create: async (name, aspect = "9:16", fps = 30, at) => {
    const reg = await localRegistry();
    const [w, h] = ASPECT[aspect] ?? ASPECT["9:16"];
    const { id, dir } = await reg.createProject(name, { width: w, height: h, fps }, "", at);
    await reg.register({ id, name, path: dir, lastOpenedAt: new Date().toISOString() }, true);
    const summary = await summaryOf(reg, id);
    await get().refresh();
    return summary;
  },

  saveAs: async (id, destDir) => {
    const reg = await localRegistry();
    await reg.saveProjectAs(id, destDir);
    const summary = await summaryOf(reg, id);
    await get().refresh();
    return summary;
  },

  open: async (id) => {
    // Monotonic activation ticket: only the LATEST open() may persist/highlight
    // its project, so a slow open(A) that resolves AFTER the user switched to B
    // can't stomp B's activation -- the A->B->A race a plain equality guard
    // misses (RF6). F5 already fenced the editor store; this fences the
    // projects-store activation + the persisted active id.
    const token = ++openSeq;
    const reg = await localRegistry();
    const opened = await reg.openProjectData(id);
    if (!opened.ok) {
      const msg = `This project was created by a newer version of ${BRAND.displayName} (project schema v${opened.tooNew}, this app supports v${opened.current}). Update ${BRAND.displayName} to open it.`;
      if (token === openSeq) set({ error: msg }); // a superseded open must not clobber the winner
      throw new Error(msg);
    }
    if (token === openSeq) await reg.setActive(id); // don't persist a superseded activation
    const summary = await summaryOf(reg, id);
    if (token === openSeq) {
      set({ active: summary, activeId: id, error: null });
      noteSessionProject(id); // so a crash report names the project that was open
      // Deliberately here and not at the call sites: this is the one point where an open has
      // actually succeeded AND won the supersede race, which is what "reached the product"
      // means. A superseded or failed open must not report one.
      reportProjectOpened(id);
    }
    return summary;
  },

  rename: async (id, name) => {
    const reg = await localRegistry();
    await reg.updateProject(id, (pj) => ({ ...pj, name, modifiedAt: new Date().toISOString() }));
    await reg.updateRegistry((registry) => {
      for (const e of registry.projects) if (e.id === id) e.name = name;
    });
    if (get().activeId === id) set({ active: await summaryOf(reg, id) });
    await get().refresh();
  },

  duplicate: async (id, name) => {
    const reg = await localRegistry();
    const srcPj = await reg.readProject(id);
    const srcName = typeof srcPj.name === "string" ? srcPj.name : id;
    const dup = await reg.duplicateProject(id, (name && name.trim()) || `${srcName} copy`);
    const summary = await summaryOf(reg, dup.id);
    await get().refresh();
    return summary;
  },

  remove: async (id) => {
    // Refuse to trash the project that's currently OPEN: the editor's index, the
    // ~2s thumbnail-save timer, and the session writer still hold its dir and would
    // recreate the folder right after the trash move (a "ghost" that reappears on
    // disk). Make the user switch away first — mirrors the agent tool, which never
    // deletes the active project (F7).
    if (useEditor.getState().projectId === id) {
      return {
        trashFailed: false,
        error: "Switch to another project before deleting the one you're editing.",
      };
    }
    const reg = await localRegistry();
    const res = await reg.deleteProject(id);
    // Trash move failed: keep everything intact and let the UI offer a
    // keep / delete-permanently choice (R12). Never silently hard-delete.
    if (res.trashFailed) return { trashFailed: true, error: res.error };
    if (get().activeId === id) set({ active: null, activeId: null });
    await get().refresh();
    return { trashFailed: false };
  },

  removePermanently: async (id) => {
    if (useEditor.getState().projectId === id) return; // never shred the open project (see remove, F7)
    const reg = await localRegistry();
    await reg.deleteProject(id, { permanent: true });
    if (get().activeId === id) set({ active: null, activeId: null });
    await get().refresh();
  },

  updateSettings: async (id, s) => {
    const reg = await localRegistry();
    const pj = await reg.readProject(id);
    const curCanvas =
      (pj.settings as { canvas?: Record<string, number> } | undefined)?.canvas ?? {};
    const canvas = {
      width: s.width ?? curCanvas.width ?? 1080,
      height: s.height ?? curCanvas.height ?? 1920,
      fps: s.fps ?? curCanvas.fps ?? 30,
    };
    await reg.updateProject(id, (fresh) => ({
      ...fresh,
      settings: { ...(fresh.settings as Record<string, unknown> | undefined), canvas },
      modifiedAt: new Date().toISOString(),
    }));
    if (get().activeId === id) set({ active: await summaryOf(reg, id) });
  },
}));
