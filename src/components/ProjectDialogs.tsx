// The project-lifecycle chrome (create / open / thumbnail) plus the modal shell they sit in.
//
// These lived inside MenuBar until the no-project welcome screen needed the SAME create and
// open affordances. Two doors onto one operation must not grow two implementations of it —
// a second "New Project" form would drift from this one the first time the create signature
// changed — so the menu and the picker both render these.
import { useEffect, useState } from "react";

import type { ProjectListEntry } from "../api/types";
import { BRAND } from "../brand";
import { confirmDestructive } from "../lib/confirm";
import { platform } from "../platform";
import { useProjects } from "../store/projects";
import { Button, cn, Overlay } from "./ui";

export function NewProjectDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const create = useProjects((s) => s.create);
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [where, setWhere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickWhere = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "Where to keep this project" });
    if (typeof dir === "string") setWhere(dir);
  };
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      // A chosen folder is the PARENT; the project gets its own folder inside it, so
      // picking Documents twice does not put two projects in one directory.
      const at = where
        ? `${where.replace(/[\\/]+$/, "")}/${name.trim().replace(/[^\w.\- ]+/g, "_")}`
        : undefined;
      const p = await create(name.trim(), aspect, undefined, at);
      onClose();
      onDone(p.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay title="New Project" onClose={onClose}>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="Project name…"
        className="mb-3 w-full rounded-md border border-edge bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-accent"
      />
      {platform.name === "tauri" && (
        <div className="mb-3 flex items-center gap-2 text-xs">
          <label className="text-neutral-400">Location</label>
          <span className="min-w-0 flex-1 truncate text-neutral-300" title={where ?? undefined}>
            {where ?? `${BRAND.displayName} projects folder`}
          </span>
          <Button onClick={() => void pickWhere()}>Choose…</Button>
          {where && <Button onClick={() => setWhere(null)}>Reset</Button>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="text-xs text-neutral-400">Aspect</label>
        <select
          value={aspect}
          onChange={(e) => setAspect(e.target.value)}
          className="rounded-md border border-edge bg-neutral-900 px-2 py-1.5 text-sm"
        >
          <option value="9:16">9:16</option>
          <option value="16:9">16:9</option>
          <option value="1:1">1:1</option>
        </select>
        <div className="ml-auto flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

/** Project thumbnail (internals/thumbnail.jpg) for the Open-Project list. Resolves
 *  a Tauri asset URL; a neutral placeholder shows on web / before load / when the
 *  project has no thumbnail yet. */
export function ProjectThumb({ path, className }: { path: string; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const url = convertFileSrc(`${path}/internals/thumbnail.jpg`);
        if (alive) setSrc(url);
      } catch {
        /* web / no tauri -> placeholder */
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className={cn("ml-1 h-9 w-9 shrink-0 overflow-hidden rounded bg-neutral-800", className)}>
      {src && (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
    </div>
  );
}

export function OpenProjectDialog({
  activeId,
  onClose,
  onOpen,
}: {
  activeId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { projects, refresh, rename, remove, removePermanently } = useProjects();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Overlay title="Open Project" onClose={onClose}>
      <div className="max-h-[50vh] overflow-y-auto">
        {projects.length === 0 && (
          <p className="px-1 py-4 text-xs text-neutral-500">No projects yet.</p>
        )}
        {projects.map((p: ProjectListEntry) => (
          <div
            key={p.id}
            className={cn(
              "group flex items-center rounded-md",
              p.id === activeId && "bg-neutral-800",
            )}
          >
            <ProjectThumb path={p.path} />
            <button
              onClick={() => {
                onClose();
                onOpen(p.id);
              }}
              className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm hover:text-white"
            >
              {p.name}
            </button>
            <button
              title="Rename"
              onClick={() => {
                const n = window.prompt("Rename project", p.name);
                if (n) void rename(p.id, n);
              }}
              className="px-1.5 text-neutral-500 opacity-0 hover:text-neutral-200 group-hover:opacity-100"
            >
              ✎
            </button>
            <button
              title={
                p.id === activeId
                  ? "Switch to another project before deleting the one you're editing"
                  : "Delete"
              }
              disabled={p.id === activeId}
              onClick={() => {
                void (async () => {
                  const ok = await confirmDestructive(
                    `Move "${p.name}" to the trash? You can restore it from the app data folder.`,
                  );
                  if (!ok) return;
                  const res = await remove(p.id);
                  // Refused (e.g. it's the currently-open project) — say why nothing happened.
                  if (res?.error && !res.trashFailed) {
                    window.alert(res.error);
                    return;
                  }
                  // Trash move failed (cross-volume, locked, …): offer an explicit
                  // permanent delete rather than losing OR silently shredding it (R12).
                  if (
                    res?.trashFailed &&
                    (await confirmDestructive(
                      `Couldn't move "${p.name}" to the trash. Delete it permanently? This cannot be undone.`,
                    ))
                  ) {
                    await removePermanently(p.id);
                  }
                })();
              }}
              className={cn(
                "px-1.5 pr-2 opacity-0 group-hover:opacity-100",
                p.id === activeId
                  ? "cursor-not-allowed text-neutral-700"
                  : "text-neutral-500 hover:text-red-400",
              )}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </Overlay>
  );
}
