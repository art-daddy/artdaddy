// Project file tree. On desktop we read the co-located project dir directly off
// the filesystem; on web we ask the server. The recursive walk mirrors the
// server's shape (folders first, case-insensitive by name, depth- and
// count-capped) so the two builds render an identical tree.
import type { FileNode } from "../api/types";
import { desktopStore } from "./desktop";
import { type DirEntry, type FsLike, joinPath, type ProjectStoreAccess } from "../tools/store";

const MAX_ENTRIES = 4000;
const MAX_DEPTH = 8;

// Only the media `library/` is user-facing (NLE-style); everything else
// (project.json, timeline.json, history/, cache/, internals/, …) is
// internal and hidden from the tree. The library manifest itself is data, not a
// media item, so it's hidden too.
const ROOT_VISIBLE = new Set(["library"]);
function isHidden(name: string, depth: number): boolean {
  if (name.startsWith(".")) return true;
  if (name === "library.json") return true;
  return depth === 0 && !ROOT_VISIBLE.has(name);
}

/** Recursively build the project file tree from the fs (desktop). Sizes are
 *  omitted — `readDir` doesn't expose them and a stat-per-file would be too
 *  costly for a large tree; FileTree already treats size as optional. */
export async function walkProjectDir(
  fs: Pick<FsLike, "readDir">,
  root: string,
): Promise<FileNode[]> {
  const readDir = fs.readDir;
  if (!readDir) return [];
  const state = { count: 0 };
  const walk = async (dir: string, rel: string, depth: number): Promise<FileNode[]> => {
    if (depth > MAX_DEPTH) return [];
    let entries: DirEntry[];
    try {
      entries = await readDir(dir);
    } catch {
      return [];
    }
    // Folders first, then case-insensitive by name (matches the server).
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const out: FileNode[] = [];
    for (const e of entries) {
      if (state.count >= MAX_ENTRIES) break;
      if (isHidden(e.name, depth)) continue;
      state.count += 1;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        out.push({
          name: e.name,
          path: childRel,
          type: "dir",
          children: await walk(joinPath(dir, e.name), childRel, depth + 1),
        });
      } else {
        out.push({ name: e.name, path: childRel, type: "file" });
      }
    }
    return out;
  };
  return walk(root, "", 0);
}

/** The project's file tree. Desktop reads the fs directly; web asks the server.
 *  `store` is injectable for tests. */
export async function listProjectFiles(
  projectId: string,
  store: ProjectStoreAccess | null = desktopStore(projectId),
): Promise<FileNode[]> {
  if (!store) return [];
  const tree = await walkProjectDir({ readDir: (p) => store.readDir(p) }, store.projectDir);
  // Show the library's CONTENTS at the tree root (not a nested `library` node).
  const lib = tree.find((n) => n.name === "library" && n.type === "dir");
  const onDisk = lib?.children ?? [];
  // Referenced-in-place media (`external`) has NO file under library/ — the user
  // picked it from their own disk and we linked it. A directory walk therefore
  // cannot see it at all, so the catalog is the only record it exists. Key the
  // node by media id: resolveRef() maps that back to the external absolute path,
  // so preview / @mention / drag all keep working.
  const external = await Promise.all(
    (await store.listClips())
      .filter((c) => c.external)
      .map(async (c): Promise<FileNode> => ({
        name: c.filename || c.path.split(/[\\/]/).pop() || c.id,
        path: c.id,
        type: "file",
        // The user can move or delete their own file at any time; say so instead of
        // failing at render with a path nobody recognises.
        offline: !(await store.exists(c.path)),
      })),
  );
  if (!external.length) return onDisk;
  return [...onDisk, ...external].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}
