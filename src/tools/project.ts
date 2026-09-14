// Project lifecycle tools (client): list / new / open / rename / duplicate
// / delete / set_project_settings + get_project_state. Ports project_tools.py +
// the registry half of project_store.py to the co-located desktop client. Ops
// run on the SHARED app-data filesystem: the projects.json registry plus each
// <projects_root>/<id>/ directory. The registry + projects_root are derived from
// the active project's dir (standard desktop layout <data_root>/projects/<id>,
// which holds when ARTDADDY_DATA_DIR / ARTDADDY_PROJECTS_DIR are not overridden).
import { DEFAULT_CANVAS, emptyTimeline } from "../timeline/model";
import { resolveCanvas } from "../timeline/canvas";
import { setCanvasTool } from "../timeline/ops";
import { projectAggregate } from "../timeline/aggregate";
import { platform } from "../platform";
import { BRAND, IDENTITY } from "../brand";
import type { ClientToolContext } from "./context";
import type { ClientToolRegistry } from "./registry";
import {
  atomicWriteText,
  type FsLike,
  INTERNAL_DIR,
  isAbsolutePath,
  isProjectDirDead,
  joinPath,
  markProjectDirDead,
  ProjectStoreAccess,
  readJsonOrRecover,
  reviveProjectDir,
} from "./store";
import { runProjectMutation, withProjectLock } from "./coordinator";
import type { MutationOrigin } from "../project/MutationGate";
import { warmWhisperModel } from "./transcribe";
import { isSafeProjectId } from "./dataRoot";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const SCHEMA_VERSION = 1;

/** How many library items get_project_state lists inline before deferring to library_op. */
const LIBRARY_PREVIEW = 60;

/** The schema version stamped in a project.json (legacy files predate the stamp
 *  ⇒ treated as v1, the earliest). */
function projectSchemaVersion(data: Result): number {
  return typeof data.schemaVersion === "number" ? data.schemaVersion : 1;
}

/** Forward-migrate an OLDER project.json to the current schema, then stamp the
 *  version. Ordered upgrades (v1→v2, …) go here as the schema evolves — none yet
 *  at v1. Pure; never throws. */
function migrateProjectData(data: Result): Result {
  // for (let v = projectSchemaVersion(data); v < SCHEMA_VERSION; v++) data = MIGRATIONS[v](data);
  return { ...data, schemaVersion: SCHEMA_VERSION };
}

const PROJECT_SUBDIRS = [
  "library",
  `${INTERNAL_DIR}/chat/tool_calls`,
  `${INTERNAL_DIR}/chat/checkpoints`,
  `${INTERNAL_DIR}/cache`,
  `${INTERNAL_DIR}/styles`,
  `${INTERNAL_DIR}/workflows`,
];

interface RegistryEntry {
  id: string;
  name: string;
  path: string;
  lastOpenedAt?: string;
  [k: string]: unknown;
}
interface Registry {
  version: number;
  activeProjectId: string | null;
  projects: RegistryEntry[];
}

function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}
function stripTrail(p: string): string {
  return normSep(p).replace(/\/+$/, "");
}
function parentOf(p: string): string {
  const n = stripTrail(p);
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : n;
}
function baseName(p: string): string {
  const n = stripTrail(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}
function nowIso(): string {
  return new Date().toISOString();
}
function slugify(name: string): string {
  const s = (name || "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (s || "project").slice(0, 32);
}
function rand6(): string {
  let s = "";
  while (s.length < 6)
    s += Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return s.slice(0, 6);
}
function newProjectId(name: string): string {
  return `${slugify(name)}_${rand6()}`;
}
function intOr(v: unknown, fallback: unknown): number {
  if (typeof v === "number" && !Number.isNaN(v)) return Math.trunc(v);
  const n = Number(fallback);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

/** Recursive directory copy (handles binary media) via readDir + copyFile. `skip`
 *  (matched on the absolute source path) excludes a subtree — used to leave the
 *  regeneratable derived cache out of a duplicate. */
async function copyDir(
  fs: FsLike,
  src: string,
  dst: string,
  skip?: (path: string) => boolean,
): Promise<void> {
  if (!fs.readDir || !fs.copyFile) throw new Error("filesystem does not support directory copy");
  await fs.mkdir(dst);
  for (const e of await fs.readDir(src)) {
    const s = joinPath(src, e.name);
    if (skip?.(s)) continue; // e.g. internals/cache — derived + regeneratable, never copied
    const d = joinPath(dst, e.name);
    if (e.isDirectory) await copyDir(fs, s, d, skip);
    else await fs.copyFile(s, d);
  }
}

/** projects.json registry + project-dir lifecycle on the shared app-data fs.
 *  Ports the module-level functions of project_store.py. */
export class ProjectRegistry {
  constructor(
    readonly projectsDir: string,
    readonly registryPath: string,
    private readonly fs: FsLike,
  ) {}

  /** Derive from an active project dir, ASSUMING the default layout
   *  `<dataRoot>/projects/<id>`. Correct only while the project still sits in the app
   *  folder — use {@link forProjectDir} anywhere a project may have been moved. */
  static fromProjectDir(projectDir: string, fs: FsLike): ProjectRegistry {
    const projectsDir = parentOf(projectDir);
    const dataRoot = parentOf(projectsDir);
    return new ProjectRegistry(projectsDir, joinPath(dataRoot, "projects.json"), fs);
  }

  /** The registry for the app's REAL data root — what production must use.
   *  `fromProjectDir` walks UP from the project, so a project moved out of the app
   *  folder by Save As would invent `D:/projects.json` beside itself: an empty recents
   *  list, and every registry write landing somewhere the app never reads again.
   *  Off-desktop (web, tests) there is no OS data dir and a project is necessarily in
   *  the default layout, so the walk-up is exact there. */
  static async forProjectDir(projectDir: string, fs: FsLike): Promise<ProjectRegistry> {
    const { platform } = await import("../platform");
    if (platform.name !== "tauri") return ProjectRegistry.fromProjectDir(projectDir, fs);
    const { projectsRoot, registryPath } = await import("./dataRoot");
    return new ProjectRegistry(await projectsRoot(), await registryPath(), fs);
  }

  /** The DEFAULT location for a project id: `<projectsDir>/<id>`. Rejects an unsafe
   *  id outright instead of silently building a traversing path — the F4 containment
   *  owner for every id that arrives from a route param or the model. This is where a
   *  project is CREATED; where it currently LIVES is `dirFor` (Save As moves it). */
  projectDir(id: string): string {
    if (!isSafeProjectId(id)) throw new Error(`unsafe project id: ${id}`);
    return joinPath(this.projectsDir, id);
  }

  /** Where project `id` ACTUALLY lives. The registry's recorded `path` wins when it
   *  has one — Save As moves a project out of the app folder and the id, which keys
   *  the route, the open document and the undo stack, must keep resolving to it.
   *  Falls back to the default location for a project that has never moved.
   *
   *  The id is validated FIRST regardless, so a crafted route param cannot reach the
   *  registry lookup at all; and a recorded path is only honoured when it is absolute,
   *  so a relative or empty one degrades to the default rather than resolving against
   *  the process's working directory. */
  dirIn(reg: Registry, id: string): string {
    const fallback = this.projectDir(id);
    const p = reg.projects.find((e) => e.id === id)?.path;
    return typeof p === "string" && isAbsolutePath(p) ? stripTrail(p) : fallback;
  }

  /** `dirIn` against a freshly-read registry. Prefer `dirIn` inside an RMW that has
   *  already loaded it, so one operation cannot read two different registries. */
  async dirFor(id: string): Promise<string> {
    return this.dirIn(await this.read(), id);
  }

  async read(): Promise<Registry> {
    // Corrupt registry -> bytes preserved to <path>.corrupt-<ts>, degrade to empty
    // (a half-written projects.json must NOT silently drop the recents list).
    const d = await readJsonOrRecover<Partial<Registry>>(this.fs, this.registryPath, {});
    return {
      version: typeof d.version === "number" ? d.version : SCHEMA_VERSION,
      activeProjectId: d.activeProjectId ?? null,
      projects: Array.isArray(d.projects) ? d.projects : [],
    };
  }

  async write(reg: Registry): Promise<void> {
    await this.fs.mkdir(parentOf(this.registryPath));
    // Atomic (temp + rename): a crash mid-write can't corrupt the recents list.
    await atomicWriteText(this.fs, this.registryPath, JSON.stringify(reg, null, 2));
  }

  /** Serialized read-modify-write of the shared projects.json registry. Every
   *  registry RMW (register / setActive / delete / rename) runs through this one
   *  per-registry lock so two overlapping edits can't lose an update (R10) — the
   *  registry analog of the per-project timeline lock. `mutate` may edit in place
   *  (return void) or return a replacement. */
  async updateRegistry(mutate: (reg: Registry) => Registry | void): Promise<Registry> {
    return withProjectLock(this.registryPath, async () => {
      const reg = await this.read();
      const next = mutate(reg) ?? reg;
      await this.write(next);
      return next;
    });
  }

  async register(entry: RegistryEntry, makeActive: boolean): Promise<void> {
    await this.updateRegistry((reg) => {
      reg.projects = reg.projects.filter((e) => e.id !== entry.id);
      reg.projects.push(entry);
      if (makeActive) reg.activeProjectId = entry.id;
    });
  }

  async setActive(id: string): Promise<void> {
    await this.updateRegistry((reg) => {
      reg.activeProjectId = id;
      for (const e of reg.projects) if (e.id === id) e.lastOpenedAt = nowIso();
    });
  }

  /** One-time defensive normalization of the shared projects.json: any entry whose
   *  id is not a safe single segment (legacy / imported / corrupt registry) is
   *  REPAIRED to the safe basename of its real folder — but ONLY when that folder is
   *  the canonical DIRECT child `<root>/<basename>` (so the re-keyed id resolves back
   *  to the SAME path via projectDir; a nested `root/a/b` would leave
   *  projectDir("b")=root/b ≠ the stored path — RF10), the basename is a safe id, and
   *  it isn't already TAKEN by another entry (no duplicate ids — RF10). Otherwise the
   *  entry is DROPPED. A folder can never literally be named `..` or `a/b`, so nothing
   *  is physically moved — only the registry KEY is repaired (or the poisoned entry
   *  removed); the filesystem is never touched for an unsafe id. The active pointer is
   *  normalized LAST: if it no longer names a kept, safe project (dropped / re-keyed
   *  away / an unsafe orphan — RF10) it falls back to the newest live project. Fail-
   *  safe: an entry we can't classify (fs error) is kept as-is (projectDir still
   *  refuses it). Serialized on the registry lock so it can't race a register /
   *  rename / delete (R10). */
  async migrateUnsafeIds(): Promise<{
    migrated: Array<{ from: string; to: string }>;
    dropped: string[];
    failed: string[];
  }> {
    const migrated: Array<{ from: string; to: string }> = [];
    const dropped: string[] = [];
    const failed: string[] = [];
    await withProjectLock(this.registryPath, async () => {
      const reg = await this.read();
      const root = stripTrail(this.projectsDir);
      // Fast path only when EVERY id is safe AND the active pointer is null or names
      // a retained SAFE entry -- a syntactically-safe but ORPHAN active id (e.g.
      // "ghost", matching no entry) still needs repair (RF10 + Q8).
      // The active pointer is "resolved" only if it's null or names a safe entry whose
      // DIRECTORY still exists -- a registered-but-missing active must fall through to
      // the repair below, not short-circuit here (R7-6).
      const activeFast = reg.projects.find(
        (e) => e.id === reg.activeProjectId && isSafeProjectId(e.id),
      );
      const activeResolved =
        reg.activeProjectId === null ||
        (activeFast !== undefined && (await this.fs.exists(this.entryDir(activeFast))));
      if (activeResolved && reg.projects.every((e) => isSafeProjectId(e.id))) return;
      const keep: RegistryEntry[] = [];
      // ids already claimed by a kept/re-keyed entry — a re-key must never collide
      // onto one. Seed with every entry that KEEPS its (safe) id (RF10).
      const taken = new Set(reg.projects.filter((e) => isSafeProjectId(e.id)).map((e) => e.id));
      for (const e of reg.projects) {
        if (isSafeProjectId(e.id)) {
          keep.push(e);
          continue;
        }
        try {
          const path = typeof e.path === "string" ? stripTrail(e.path) : "";
          const seg = baseName(path);
          if (
            path &&
            isSafeProjectId(seg) &&
            path === joinPath(root, seg) &&
            !taken.has(seg) &&
            (await this.fs.exists(path))
          ) {
            // The folder is a valid DIRECT child; only the registry key was corrupt
            // -> re-key it (and follow it with the active pointer if it was this id).
            if (reg.activeProjectId === e.id) reg.activeProjectId = seg;
            taken.add(seg);
            keep.push({ ...e, id: seg, path });
            migrated.push({ from: e.id, to: seg });
          } else {
            // Nested / escaping / duplicate / missing folder -> poisoned entry: drop
            // it, never touching the filesystem for an unsafe path.
            dropped.push(e.id);
          }
        } catch {
          failed.push(e.id); // fail-safe: keep the entry (projectDir will refuse it)
          keep.push(e);
        }
      }
      reg.projects = keep;
      // Normalize the active pointer: if it no longer names a kept, safe project
      // (dropped / re-keyed away / an unsafe orphan) fall back to the newest live one.
      // Reassign the active pointer if it names no kept safe entry OR that entry's
      // DIRECTORY is gone -- a registered-but-missing active would fail to open with no
      // recovery, and the earlier membership-only check (R6-7) missed it (R7-6). Fall
      // back to the newest project whose folder still exists (else null).
      const activeKept = keep.find((x) => x.id === reg.activeProjectId && isSafeProjectId(x.id));
      const activeAlive =
        reg.activeProjectId === null ||
        (activeKept !== undefined && (await this.fs.exists(this.entryDir(activeKept))));
      if (!activeAlive) {
        const present: RegistryEntry[] = [];
        for (const e of keep) {
          if (isSafeProjectId(e.id) && (await this.fs.exists(this.entryDir(e)))) present.push(e);
        }
        present.sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
        reg.activeProjectId = present.length ? present[0].id : null;
      }
      await this.write(reg);
    });
    return { migrated, dropped, failed };
  }

  /** The dir a liveness check should probe. A recorded path is the project's real
   *  location (Save As), so it wins; an entry with none falls back to the default. An
   *  unsafe id (projectDir throws) can only offer its stored path. */
  private entryDir(e: RegistryEntry): string {
    if (!isSafeProjectId(e.id)) return e.path ?? "";
    return typeof e.path === "string" && isAbsolutePath(e.path)
      ? stripTrail(e.path)
      : this.projectDir(e.id);
  }

  /**
   * Repair recorded paths left pointing inside a PREVIOUS data folder.
   *
   * The rename moved `<appData>/ArtDaddy` to `<appData>/ArtDaddy` but not the absolute paths
   * already written into projects.json. `entryDir` prefers a recorded path and `listLive`
   * hides an entry whose directory is missing, so every such project silently disappeared
   * from the picker while its files sat safely under the new root.
   *
   * Deliberately narrow: only a DIRECT child of `<legacy>/projects/`, only when the recorded
   * path is gone AND the same folder exists under the current root. A project moved elsewhere
   * by Save As never matches, and a machine where both roots still exist keeps whichever copy
   * is really there. Idempotent — a repaired path no longer matches.
   */
  async repairLegacyRootPaths(): Promise<{ repaired: Array<{ id: string; to: string }> }> {
    const legacy = IDENTITY.legacyDataFolders.filter(Boolean);
    const repaired: Array<{ id: string; to: string }> = [];
    if (!legacy.length) return { repaired };
    const alt = legacy.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const under = new RegExp(`[\\\\/](?:${alt})[\\\\/]projects[\\\\/]([^\\\\/]+)[\\\\/]?$`, "i");

    await withProjectLock(this.registryPath, async () => {
      const reg = await this.read();
      let changed = false;
      for (const e of reg.projects) {
        if (typeof e.path !== "string" || !e.path) continue;
        const m = under.exec(stripTrail(e.path));
        if (!m) continue;
        const candidate = joinPath(this.projectsDir, m[1]);
        // Both checks, in this order: never move an entry whose real folder is still there.
        if (await this.fs.exists(stripTrail(e.path)).catch(() => true)) continue;
        if (!(await this.fs.exists(candidate).catch(() => false))) continue;
        e.path = candidate;
        repaired.push({ id: e.id, to: candidate });
        changed = true;
      }
      if (changed) await this.write(reg);
    });
    return { repaired };
  }

  /** Live projects (dir still exists), most-recently-opened first. */
  async listLive(): Promise<RegistryEntry[]> {
    const reg = await this.read();
    const checked = await Promise.all(
      reg.projects.map(async (e) => {
        const dir = this.entryDir(e);
        return dir && (await this.fs.exists(dir)) ? e : null;
      }),
    );
    const live = checked.filter((e): e is RegistryEntry => e !== null);
    live.sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
    return live;
  }

  async readProject(id: string): Promise<Result> {
    return readJsonOrRecover<Result>(
      this.fs,
      joinPath(await this.dirFor(id), INTERNAL_DIR, "project.json"),
      {},
    );
  }

  async writeProject(id: string, data: Result): Promise<void> {
    const dir = await this.dirFor(id);
    // A concurrent delete may have tombstoned this dir (deleteProject marks it dead
    // synchronously right after trashing). Skip the write so an in-flight
    // rename/settings RMW can't recreate internals/project.json after deletion (the
    // ProjectStoreAccess writers are already tombstone-gated -- RF4/Q7).
    if (isProjectDirDead(dir)) return;
    await this.fs.mkdir(joinPath(dir, INTERNAL_DIR));
    await atomicWriteText(
      this.fs,
      joinPath(dir, INTERNAL_DIR, "project.json"),
      JSON.stringify(data, null, 2),
    );
  }

  /** Atomic read-modify-write of project.json (settings / name). project.json is authoritative document
   *  state, so the RMW commits through the SHARED project-mutation executor — the AUTHORITY document's
   *  gate when the project is OPEN (serialized with timeline + library in ONE domain, and rejected when
   *  the doc is closing / the agent origin was superseded / the turn was Stopped), and the plain
   *  per-project lock when NO document owns the dir (an INACTIVE project renamed from the list, or a
   *  being-created one — the fallback still fails closed while that dir is mid-close). So a settings /
   *  rename write can no longer slip past admission during close, while renaming an inactive project
   *  still works (owner Q1). `opts` carries the agent origin + Stop signal when a tool drives it. */
  async updateProject(
    id: string,
    mutate: (pj: Result) => Result,
    opts?: { origin?: MutationOrigin; signal?: AbortSignal },
  ): Promise<Result> {
    return runProjectMutation(
      await this.dirFor(id),
      "project.settings",
      async (_doc, gctx) => {
        const pj = await this.readProject(id);
        const next = mutate(pj);
        await this.writeProject(id, next);
        gctx?.markCommitted();
        return next;
      },
      opts,
    );
  }

  /** Read project.json for OPENING: refuse a project written by a NEWER schema than
   *  this build (rather than silently coercing it) and forward-migrate an OLDER one
   *  to the current schema, persisting the upgrade. `{ok:false}` carries the
   *  versions so the caller can tell the user to update the app. */
  async openProjectData(
    id: string,
  ): Promise<{ ok: true; data: Result } | { ok: false; tooNew: number; current: number }> {
    const raw = await this.readProject(id);
    const sv = projectSchemaVersion(raw);
    if (sv > SCHEMA_VERSION) return { ok: false, tooNew: sv, current: SCHEMA_VERSION };
    if (sv < SCHEMA_VERSION && Object.keys(raw).length > 0) {
      const migrated = migrateProjectData(raw);
      await withProjectLock(await this.dirFor(id), () => this.writeProject(id, migrated));
      return { ok: true, data: migrated };
    }
    return { ok: true, data: raw };
  }

  /** Scaffold a new project dir (subdirs + project.json + seed timeline.json +
   *  a minimal TurnConfig so the server can open it). Ports EphemeralSession.create.
   *  `at` places it in a folder the user chose; omitted, it lands in the app folder. */
  async createProject(
    name: string,
    canvas: { width: number; height: number; fps: number },
    modelId = "",
    at?: string,
  ): Promise<{ id: string; dir: string }> {
    const pid = newProjectId(name);
    const dir = at ? stripTrail(at) : this.projectDir(pid);
    if (at && !isAbsolutePath(dir)) throw new Error("choose a folder for the project");
    if (at && (await this.fs.exists(joinPath(dir, INTERNAL_DIR, "project.json"))))
      throw new Error(`there is already a project in "${baseName(dir)}"`);
    reviveProjectDir(dir); // fresh project at this path: clear any stale tombstone (RF4)
    for (const sub of PROJECT_SUBDIRS) await this.fs.mkdir(joinPath(dir, sub));
    const now = nowIso();
    const { width, height, fps } = canvas;
    await this.fs.writeTextFile(
      joinPath(dir, INTERNAL_DIR, "project.json"),
      JSON.stringify(
        {
          id: pid,
          name: name || pid,
          schemaVersion: SCHEMA_VERSION,
          createdAt: now,
          modifiedAt: now,
          activeTimeline: "timeline.json",
          settings: {
            canvas: { width, height, fps },
            model_id: modelId,
            active_style: "",
            active_workflow: "",
            planning_mode: "beats",
          },
        },
        null,
        2,
      ),
    );
    await this.fs.writeTextFile(
      joinPath(dir, INTERNAL_DIR, "timeline.json"),
      JSON.stringify(emptyTimeline(width, height, fps), null, 2),
    );
    return { id: pid, dir };
  }

  /** Copy a project into a brand-new one (fresh id), register it active. */
  async duplicateProject(
    srcId: string,
    name: string,
  ): Promise<{ id: string; name: string; path: string }> {
    const src = await this.dirFor(srcId);
    const newId = newProjectId(name);
    const dst = this.projectDir(newId);
    reviveProjectDir(dst); // fresh project at this path: clear any stale tombstone (RF4)
    // Copy AUTHORITATIVE state only; the derived cache (internals/cache — proxies, posters,
    // gemini encodes, transcodes, downloads, transcripts, render cache) is regeneratable and is
    // never copied (invariant 29). It rebuilds on demand in the duplicate.
    const cacheDir = joinPath(src, INTERNAL_DIR, "cache");
    await copyDir(this.fs, src, dst, (p) => p === cacheDir);
    // Flat consistency bridge: copyDir cloned the source's ON-DISK timeline.json, but the source may
    // be OPEN with unsaved in-memory edits ahead of disk. Re-materialize the copy's timeline from the
    // same read model every reader uses, so the duplicate captures those edits — only when an open
    // document actually holds an in-memory timeline (else the copied-from-disk file is already current).
    try {
      const agg = await projectAggregate(new ProjectStoreAccess(src, this.fs));
      if (agg.timelineSource === "memory") {
        await atomicWriteText(
          this.fs,
          joinPath(dst, INTERNAL_DIR, "timeline.json"),
          JSON.stringify(agg.timeline, null, 2),
        );
      }
    } catch {
      /* no open document / unreadable source: the copied-from-disk timeline stands */
    }
    const now = nowIso();
    const pj = await this.readProject(newId);
    await this.fs.writeTextFile(
      joinPath(dst, INTERNAL_DIR, "project.json"),
      JSON.stringify({ ...pj, id: newId, name, createdAt: now, modifiedAt: now }, null, 2),
    );
    await this.register({ id: newId, name, path: dst, lastOpenedAt: now }, true);
    return { id: newId, name, path: dst };
  }

  /** Save As: write the project to a folder the user chose and CONTINUE EDITING there.
   *  Premiere's semantics — the id, and therefore the route and the open document, survive
   *  the move; the original folder is left on disk at its last saved state.
   *
   *  Owned media under `library/` is copied because it exists nowhere else; LINKED media
   *  keeps pointing at the user's originals, so this stays proportional to what the
   *  project actually owns rather than to the footage it references. The derived cache is
   *  skipped, exactly as Duplicate does.
   *
   *  The copy is written FIRST and the registry repointed only after it lands, so a
   *  failure part-way leaves the project still open on the original folder rather than
   *  pointing at a half-written one. */
  async saveProjectAs(id: string, destDir: string): Promise<{ id: string; path: string }> {
    const dst = stripTrail(destDir);
    if (!isAbsolutePath(dst)) throw new Error("choose a folder for the project");
    const src = await this.dirFor(id);
    if (stripTrail(src) === dst) return { id, path: dst };
    // Refuse to write into a folder that already holds something: Save As must never
    // merge into an unrelated directory, and a half-merge is unrecoverable by hand.
    if (await this.fs.exists(joinPath(dst, INTERNAL_DIR, "project.json")))
      throw new Error(`there is already a project in "${baseName(dst)}"`);
    reviveProjectDir(dst);
    const cacheDir = joinPath(src, INTERNAL_DIR, "cache");
    await copyDir(this.fs, src, dst, (p) => p === cacheDir);
    // The open document's in-memory timeline is ahead of disk; the copy must carry the
    // edits the user can see, not the last autosave.
    try {
      const agg = await projectAggregate(new ProjectStoreAccess(src, this.fs));
      if (agg.timelineSource === "memory")
        await atomicWriteText(
          this.fs,
          joinPath(dst, INTERNAL_DIR, "timeline.json"),
          JSON.stringify(agg.timeline, null, 2),
        );
    } catch {
      /* no open document / unreadable source: the copied-from-disk timeline stands */
    }
    await this.updateRegistry((reg) => {
      const e = reg.projects.find((p) => p.id === id);
      if (e) {
        e.path = dst;
        e.lastOpenedAt = nowIso();
      } else {
        reg.projects.push({ id, name: baseName(dst), path: dst, lastOpenedAt: nowIso() });
      }
      reg.activeProjectId = id;
    });
    return { id, path: dst };
  }

  /** Move a project to the trash + drop it from the registry, reassigning active.
   *  Hardened against the delete-traversal class: only a REGISTERED project id that
   *  is a simple directory name (no separators or `..`) is eligible, so a crafted id
   *  can never resolve to a path outside the projects root. Recoverable — the folder
   *  is moved to `<dataRoot>/.trash/` rather than permanently removed (falls back to a
   *  hard delete when the fs has no rename). */
  async deleteProject(
    id: string,
    opts: { permanent?: boolean } = {},
  ): Promise<{
    id: string;
    deleted: boolean;
    trashFailed?: boolean;
    error?: string;
    active_project_id: string | null;
  }> {
    // Whole read-modify-write serialized on the registry lock (R10) so a concurrent
    // register/setActive/rename can't clobber the post-delete registry.
    return withProjectLock(this.registryPath, async () => {
      const reg = await this.read();
      const registered = reg.projects.some((e) => e.id === id);
      if (!registered || !isSafeProjectId(id)) {
        // Unknown or unsafe id: refuse without ever touching the filesystem.
        return { id, deleted: false, active_project_id: reg.activeProjectId };
      }
      const dir = this.dirIn(reg, id);
      // Serialize the fs delete + tombstone under the SAME per-project lock that
      // updateProject uses. writeProject's isProjectDirDead() check (Q7) alone left a
      // TOCTOU: it runs on the PROJECT lock while delete held only the REGISTRY lock,
      // so a settings/rename RMW could pass the dead-check and then recreate the dir
      // (mkdir + atomic write) AFTER delete trashed it. Holding the project lock here
      // makes them mutually exclusive. Nesting registry -> project is deadlock-free:
      // no path takes project -> registry (updateProject's writeProject takes no
      // registry lock) (R6-6).
      const outcome = await withProjectLock(
        dir,
        async (): Promise<"ok" | "absent" | "trash_failed"> => {
          const present = await this.fs.exists(dir);
          if (present) {
            if (opts.permanent) {
              // The user explicitly confirmed a permanent delete after the trash move
              // failed -- the ONLY path that hard-removes an existing project.
              await this.removeProjectDir(dir);
            } else if ((await this.trashProjectDir(id, dir)) === "trash_failed") {
              // A real move failure must NOT silently become a permanent delete (R12):
              // leave the project intact + writable (NOT tombstoned) so the caller can
              // offer keep / delete-permanently.
              return "trash_failed";
            }
          }
          // Gone now, or already absent: tombstone so any in-flight background writer
          // (index / thumbnail / session persist) can't recreate it as orphan litter
          // (RF4). Only reached when the project is genuinely removed.
          markProjectDirDead(dir);
          return present ? "ok" : "absent";
        },
      );
      if (outcome === "trash_failed") {
        return {
          id,
          deleted: false,
          trashFailed: true,
          error: "couldn't move the project to the trash",
          active_project_id: reg.activeProjectId,
        };
      }
      const existed = outcome === "ok";
      reg.projects = reg.projects.filter((e) => e.id !== id);
      if (reg.activeProjectId === id) {
        const remaining: RegistryEntry[] = [];
        for (const e of reg.projects) if (await this.fs.exists(this.entryDir(e))) remaining.push(e);
        remaining.sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
        reg.activeProjectId = remaining.length ? remaining[0].id : null;
      }
      await this.write(reg);
      return { id, deleted: existed, active_project_id: reg.activeProjectId };
    });
  }

  /** Soft-delete a validated project folder so a mistaken delete is recoverable:
   *  the OS Recycle Bin / Trash when available (`fs.trash`), else an app-managed
   *  `<dataRoot>/.trash/<id>-<ts>` move (`fs.rename`).
   *   - "trashed": moved to the OS trash, or to the app `.trash/`.
   *   - "removed": the fs has NEITHER trash NOR rename (e.g. the in-memory test fs), so a
   *     hard delete is the only option — there is no recoverable trash to fail into.
   *   - "trash_failed": a trash / move was attempted but threw (cross-volume, locked,
   *     no permission, …). We do NOT fall through to a permanent delete — the caller
   *     decides whether to keep the project or shred it (R12). */
  private async trashProjectDir(
    id: string,
    dir: string,
  ): Promise<"trashed" | "removed" | "trash_failed"> {
    // Prefer the OS Recycle Bin / Trash: recoverable AND user-discoverable via the OS.
    if (this.fs.trash) {
      try {
        await this.fs.trash(dir);
        return "trashed";
      } catch {
        return "trash_failed"; // a failed move is NOT a permanent delete (R12)
      }
    }
    // Fallback (fs with rename but no OS trash): an app-managed trash under <dataRoot>/.trash/.
    if (this.fs.rename) {
      const trashRoot = joinPath(parentOf(this.projectsDir), ".trash");
      try {
        await this.fs.mkdir(trashRoot);
        await this.fs.rename(dir, joinPath(trashRoot, `${id}-${Date.now()}`));
        return "trashed";
      } catch {
        return "trash_failed"; // a failed move is NOT a permanent delete (R12)
      }
    }
    // No trash or rename capability at all -> a hard delete is the only way to remove it.
    await this.removeProjectDir(dir);
    return "removed";
  }

  /** Permanently remove a project folder (the shred path — UI-confirmed only). */
  private async removeProjectDir(dir: string): Promise<void> {
    if (!this.fs.remove) throw new Error("filesystem does not support delete");
    await this.fs.remove(dir);
  }
}

function regOf(ctx: ClientToolContext): Promise<ProjectRegistry> {
  return ProjectRegistry.forProjectDir(ctx.store.projectDir, ctx.store.fsForProjectRegistry());
}
/** The open project's id. Read from project.json rather than taken from the folder
 *  name: once Save As lets a project live at `D:/Client Work/My Film`, the folder is
 *  named by the user and only the file still carries the id that keys the route, the
 *  open document and the undo stack. Falls back to the basename for a project whose
 *  project.json is unreadable — the default layout, where the two agree. */
async function currentPid(ctx: ClientToolContext): Promise<string> {
  const fallback = baseName(ctx.store.projectDir);
  const pj = await ctx.store
    .readJson<{ id?: unknown }>(joinPath(ctx.store.projectDir, INTERNAL_DIR, "project.json"), {})
    .catch(() => ({}) as { id?: unknown });
  return isSafeProjectId(pj.id) ? pj.id : fallback;
}
/** Resolve a model-supplied project id OR directory path to a CONTAINED project id
 *  (a bare simple name), or "" when the ref is unsafe / unresolvable. Ports
 *  _resolve_pid, hardened: a traversal-shaped ref (`../../x`) never survives, so
 *  every caller that derives a path from the result stays inside the projects root. */
async function resolvePid(ctx: ClientToolContext, ref: string): Promise<string> {
  const s = (ref || "").trim();
  if (!s) return "";
  // A real directory path resolves to its final segment; a bare ref is taken as-is.
  const candidate = (await looksLikeExistingDir(ctx, s)) ? baseName(s) : s;
  return isSafeProjectId(candidate) ? candidate : "";
}

/** Is this ref an existing directory? Answers the question WITHOUT letting the
 *  filesystem veto the caller, because on desktop `exists` THROWS for any path the
 *  fs scope disallows — which includes a bare project id (not an absolute path at
 *  all). Probing one surfaced Tauri's "forbidden path: <id>" out of open_project /
 *  delete_project for every id `list_projects` hands the model; the in-memory test
 *  fs returns false there, so the whole class looked healthy. Only PATH-shaped refs
 *  are worth a probe, and a rejected probe means "not a usable path", never a fault. */
async function looksLikeExistingDir(ctx: ClientToolContext, ref: string): Promise<boolean> {
  if (!/[/\\]/.test(ref)) return false;
  try {
    return await ctx.store.exists(ref);
  } catch {
    return false;
  }
}

export async function listProjectsTool(
  _args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const reg = await regOf(ctx);
  const registry = await reg.read();
  // Never expose filesystem paths - the project id + name are the model's handles.
  const projects = (await reg.listLive()).map((p) => ({
    id: p.id,
    name: p.name,
    lastOpenedAt: p.lastOpenedAt,
  }));
  return { ok: true, active_project_id: registry.activeProjectId, projects };
}

export async function newProjectTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  const aspect = typeof args.aspect_ratio === "string" ? args.aspect_ratio : "9:16";
  const canvas = resolveCanvas({ aspect_ratio: aspect, quality: args.quality }, DEFAULT_CANVAS);
  if ("error" in canvas) return { ok: false, error: canvas.error };
  const w = canvas.width;
  const h = canvas.height;
  const fps = typeof args.fps === "number" ? Math.trunc(args.fps) : 30;
  const reg = await regOf(ctx);
  let model = "";
  try {
    const pj = JSON.parse(
      await ctx.store.readText(joinPath(ctx.store.projectDir, INTERNAL_DIR, "project.json")),
    ) as Result;
    const settings = (pj.settings as Result | undefined) ?? {};
    if (typeof settings.model_id === "string") model = settings.model_id;
  } catch {
    /* no current project.json -> empty model */
  }
  const { id, dir } = await reg.createProject(name, { width: w, height: h, fps }, model);
  await reg.register({ id, name, path: dir, lastOpenedAt: nowIso() }, true);
  // Preload the whisper model in the background (desktop only) so the first
  // transcribe is warm — mirrors the server's warm_whisper on session start.
  if (platform.capabilities.localTools) void warmWhisperModel(ctx).catch(() => undefined);
  return {
    ok: true,
    id,
    name,
    canvas: { width: w, height: h, fps },
    note: "Created, and set as the app's active project. This does NOT switch YOU: your next tool calls still act on the project you already had open. To work on this one, call manage_project {action:'open', id}.",
  };
}

export async function openProjectTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const ref = typeof args.project === "string" ? args.project.trim() : "";
  if (!ref) return { ok: false, error: "project id or path is required" };
  const reg = await regOf(ctx);
  const pid = await resolvePid(ctx, ref);
  if (!pid) return { ok: false, error: `unknown or invalid project: ${ref}` };
  const dir = await reg.dirFor(pid);
  if (!(await ctx.store.exists(dir))) return { ok: false, error: `project not found: ${ref}` };
  const opened = await reg.openProjectData(pid);
  if (!opened.ok) {
    return {
      ok: false,
      error: `project "${ref}" was created by a newer version of ${BRAND.displayName} (project schema v${opened.tooNew} > supported v${opened.current}); update the app to open it.`,
    };
  }
  await reg.setActive(pid);
  const pj = opened.data;
  return {
    ok: true,
    id: pid,
    name: typeof pj.name === "string" ? pj.name : pid,
    note: "Set active. The current conversation continues on its own project; the opened project resumes in a fresh session.",
  };
}

/** The ONE canvas tool. The ACTIVE timeline is the authority: it is resolved and
 *  mutated first (undoable, rescaling clip frames on an fps change), and only then is
 *  project.json's `settings.canvas` synced to match so the two cannot drift.
 *
 *  NOT atomic, and deliberately not claimed to be: the timeline edit and the
 *  project.json write are two separate writes. If the sync fails the timeline change
 *  still stands (it is the one the user asked for) and the tool says so rather than
 *  reporting a clean success — project.json's copy is derived and is re-synced by the
 *  next successful call. */
export async function setProjectSettingsTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const applied = await setCanvasTool(args, ctx);
  if (!applied.ok) return applied;

  const [w, h] = String(applied.resolution ?? "")
    .split("x")
    .map(Number);
  const f = intOr(applied.fps, 30);
  if (!(w > 0 && h > 0)) return applied;

  try {
    await (
      await regOf(ctx)
    ).updateProject(
      await currentPid(ctx),
      (fresh) => ({
        ...fresh,
        settings: {
          ...(fresh.settings as Result | undefined),
          canvas: { width: w, height: h, fps: f },
        },
        modifiedAt: nowIso(),
      }),
      { origin: ctx.origin, signal: ctx.signal },
    );
  } catch (e) {
    return {
      ...applied,
      note: [
        applied.note,
        `canvas applied to the timeline, but saving it as the project default failed (${e instanceof Error ? e.message : String(e)}); the timeline is correct.`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  return applied;
}

export async function renameProjectTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  const reg = await regOf(ctx);
  const pid = args.project ? await resolvePid(ctx, String(args.project)) : await currentPid(ctx);
  if (!pid) return { ok: false, error: "no project to rename" };
  const dir = await reg.dirFor(pid);
  if (!(await ctx.store.exists(dir)))
    return { ok: false, error: `project not found: ${args.project ?? pid}` };
  await reg.updateProject(pid, (pj) => ({ ...pj, name, modifiedAt: nowIso() }), {
    origin: ctx.origin,
    signal: ctx.signal,
  });
  // Registry rename under the per-registry lock (R10/F9) so a concurrent
  // register / setActive / delete can't lose this name update. Was a raw
  // read -> mutate -> write that could clobber an interleaving registry edit.
  await reg.updateRegistry((registry) => {
    for (const e of registry.projects) if (e.id === pid) e.name = name;
  });
  return { ok: true, id: pid, name };
}

export async function duplicateProjectTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const reg = await regOf(ctx);
  const pid = args.project ? await resolvePid(ctx, String(args.project)) : await currentPid(ctx);
  if (!pid) return { ok: false, error: "no project to duplicate" };
  const src = await reg.dirFor(pid);
  if (!(await ctx.store.exists(src)))
    return { ok: false, error: `project not found: ${args.project ?? pid}` };
  const srcPj = await reg.readProject(pid);
  const srcName = typeof srcPj.name === "string" ? srcPj.name : pid;
  const name = (typeof args.name === "string" && args.name.trim()) || `${srcName} copy`;
  const dup = await reg.duplicateProject(pid, name);
  return {
    ok: true,
    id: dup.id,
    name: dup.name,
    note: "Copied to a new project and set active. The current conversation continues on its own project.",
  };
}

/** NOTE: intentionally NOT registered as an agent tool (see registerProjectTools)
 *  — project deletion is user-only (F1 hardening). Retained only for the e2e/unit
 *  suites; the in-app UI deletes via ProjectRegistry.deleteProject directly. Either
 *  way, removal routes through the hardened, soft-deleting deleteProject above. */
export async function deleteProjectTool(
  args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const ref = typeof args.project === "string" ? args.project.trim() : "";
  if (!ref)
    return {
      ok: false,
      error: "project id or path is required (delete never defaults to the open project)",
    };
  const reg = await regOf(ctx);
  const pid = await resolvePid(ctx, ref);
  if (pid === (await currentPid(ctx))) {
    return {
      ok: false,
      error: "cannot delete the project that is currently open; open another project first",
    };
  }
  const res = await reg.deleteProject(pid);
  if (!res.deleted) return { ok: false, error: `project not found: ${ref}` };
  return { ok: true, ...res, note: "Moved the project to the trash and removed it from recents." };
}

export async function getProjectStateTool(
  _args: Args,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const reg = await regOf(ctx);
  const pid = await currentPid(ctx);
  // The library is the project's inventory, and the ONLY one reported: `registerLibraryClip` is
  // the single door every import, drag-drop, download and generated asset enters by, so
  // internals/cache/{downloads,audio} held nothing that is not already here. Listing those
  // cache paths handed the model addresses for a directory `duplicate_project` deliberately
  // does not copy, and — because they were the only inventory this tool returned — an empty
  // pair read as an empty project while the user's attached reference video sat in the library.
  const clips = await ctx.store.listClips();
  const library = clips.slice(0, LIBRARY_PREVIEW).map((c) => {
    // `status` is carried ONLY when the asset is not usable yet. This projection used to drop it
    // entirely while `library_op action='list'` kept it, so two views of one catalog disagreed:
    // a generation that had already FAILED appeared here as an ordinary asset, and this tool's own
    // description calls the library "the source of truth for what this project already HAS". An
    // agent placing from that list builds a timeline of refs that will never resolve — 11 dead
    // shots in one benchmark run, with every tool call it made having reported success.
    const status = typeof c.status === "string" ? c.status : "";
    const pending = status === "generating" || status === "failed";
    return {
      media_ref: c.id,
      filename: c.filename ?? c.path.split("/").pop() ?? c.id,
      kind: c.kind ?? null,
      folder: (typeof c.folder === "string" ? c.folder : "") || null,
      ...(pending ? { status } : {}),
      ...(status === "failed" && typeof c.error === "string" && c.error ? { error: c.error } : {}),
    };
  });
  const pj = await reg.readProject(pid);
  const settings = ((pj.settings as Result | undefined) ?? {}) as Result;
  // Durable config comes from project.json; there is NO meta.json. Transient
  // run state (status/counts) is server-in-memory and not surfaced here.
  return {
    ok: true,
    project_id: pid,
    name: pj.name ?? null,
    canvas: settings.canvas ?? null,
    model_id: typeof settings.model_id === "string" ? settings.model_id : "",
    active_style: typeof settings.active_style === "string" ? settings.active_style : "",
    active_workflow: typeof settings.active_workflow === "string" ? settings.active_workflow : "",
    library,
    library_count: clips.length,
    // Say so explicitly rather than letting a truncated list read as the whole inventory —
    // that misreading is the bug this field exists to prevent.
    ...(clips.length > library.length
      ? { library_truncated: `showing ${library.length} of ${clips.length}; use library_op list` }
      : {}),
  };
}

export function registerProjectTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("list_projects", (a) => listProjectsTool(a, getCtx()));
  registry.register("new_project", (a) => newProjectTool(a, getCtx()));
  registry.register("open_project", (a) => openProjectTool(a, getCtx()));
  registry.register("set_project_settings", (a) => setProjectSettingsTool(a, getCtx()));
  registry.register("rename_project", (a) => renameProjectTool(a, getCtx()));
  registry.register("duplicate_project", (a) => duplicateProjectTool(a, getCtx()));
  registry.register("get_project_state", (a) => getProjectStateTool(a, getCtx()));
}
