import { type ReactNode, useEffect, useRef, useState } from "react";

import type { FileNode } from "../api/types";
import { listProjectFiles } from "../lib/files";
import { copyIntoProject, relinkMedia } from "../lib/mediaLink";
import { beginDrag } from "../lib/dragSource";
import { onOsDragOver, onOsDrop, webOwnsFileDrops } from "../lib/osDrop";
import { filesFromItems, importPaths, importViaDialog, MEDIA_RE, uploadFiles } from "../lib/upload";
import { kindOf } from "../media/formats";
import { useProjectNotice } from "../store/projectNotice";
import { useRecordPanel } from "../store/recordPanel";
import { useChat } from "../store/chat";
import { useEditor } from "../store/editor";
import { buildMediaMention } from "../timeline/mentions";
import type { Clip } from "../timeline/model";
import type { ProjectStoreAccess } from "../tools/store";
import { ClipThumbnail } from "./ClipThumbnail";
import { cn } from "./ui";

type LibView = "thumbnails" | "list";
function readView(): LibView {
  try {
    return localStorage.getItem("artdaddy:libview") === "list" ? "list" : "thumbnails";
  } catch {
    return "thumbnails";
  }
}

// Project file/folder tree. Refetches when the session changes (i.e. after a
// turn writes new files) so renders/downloads/transcripts appear automatically.
// Library media shows as a thumbnail grid by default; a right-click menu toggles
// between Thumbnails and List (and offers Import).
export default function FileTree({ projectId }: { projectId: string }) {
  const session = useChat((s) => s.session);
  const store = useEditor((s) => s.store);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [view, setViewState] = useState<LibView>(readView);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [itemMenu, setItemMenu] = useState<{
    x: number;
    y: number;
    ref: string;
    name: string;
    kind: string;
    offline: boolean;
  } | null>(null);
  const addMention = useChat((s) => s.addMention);
  const [toast, setToast] = useState<string | null>(null);
  const onItemMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setItemMenu({
      x: e.clientX,
      y: e.clientY,
      ref: node.path,
      name: node.name,
      kind: tileKind(node.name),
      offline: node.offline === true,
    });
  };

  // Premiere's Link Media: locate ONE file, then match the rest by name in that folder,
  // so a whole moved folder relinks in a single pass.
  const linkMedia = async (mediaId: string, name: string) => {
    if (!store) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, title: `Locate "${name}"` });
    if (typeof picked !== "string") return;
    const res = await relinkMedia(store, mediaId, picked);
    setNonce((n) => n + 1);
    setToast(
      res.remaining > 0
        ? `Relinked ${res.relinked.length}; ${res.remaining} still offline.`
        : `Relinked ${res.relinked.length} file${res.relinked.length === 1 ? "" : "s"}.`,
    );
  };

  const copyIn = async (mediaId: string) => {
    if (!store) return;
    const res = await copyIntoProject(store, mediaId);
    setNonce((n) => n + 1);
    setToast(res.ok ? "Copied into the project." : res.error);
  };
  const setView = (v: LibView) => {
    setViewState(v);
    try {
      localStorage.setItem("artdaddy:libview", v);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listProjectFiles(projectId)
      .then((tree) => {
        if (cancelled) return;
        setTree(tree);
        setListError(null);
      })
      // A failed read used to blank the panel, which is indistinguishable from a project that
      // genuinely has no media — reported as "library empty while the agent could see all 27
      // assets", with no way to tell it was a failure and nothing but a restart to try.
      .catch((e: unknown) => {
        if (cancelled) return;
        setListError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // `store` matters: on a cold open the editor's store lands AFTER this mounts,
    // and the first fetch (no store) returns nothing. Without it in the deps the
    // panel stays "No files yet" until something else happens to bump `nonce`.
  }, [projectId, session, nonce, store]);

  const inputRef = useRef<HTMLInputElement>(null);

  // Refetch when an import happens anywhere (the + button, File menu, paste, drop).
  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    window.addEventListener("artdaddy:files-changed", bump);
    return () => window.removeEventListener("artdaddy:files-changed", bump);
  }, []);

  // Desktop file drops arrive as PATHS, so they are LINKED in place rather than copied in.
  useEffect(() => {
    const offDrop = onOsDrop("library", (d) => {
      const media = d.paths.filter((p) => MEDIA_RE.test(p));
      if (!media.length) return;
      setDragOver(false);
      setLoading(true);
      void importPaths(projectId, media).finally(() => {
        setLoading(false);
        setNonce((n) => n + 1);
      });
    });
    const offOver = onOsDragOver((d) => setDragOver(d?.target === "library"));
    return () => {
      offDrop();
      offOver();
    };
  }, [projectId]);

  const importPicked = async (files: File[]) => {
    if (!files.length) return;
    setLoading(true);
    try {
      await uploadFiles(projectId, files);
    } catch (e) {
      // Per-file failures are reported by uploadFiles; this is the boundary throwing.
      useProjectNotice
        .getState()
        .notify(`Couldn't import: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void importPicked(files);
  };

  /** Desktop opens the OS dialog; the hidden input is the WEB fallback only — a file input
   *  never opens on macOS while the window keeps native drag-drop. */
  const onImportClick = async () => {
    setLoading(true);
    try {
      const picked = await importViaDialog(projectId, "Import media");
      if (picked === null) {
        inputRef.current?.click();
        return;
      }
      if (picked.length) setNonce((n) => n + 1);
    } catch (e) {
      useProjectNotice
        .getState()
        .notify(`Couldn't import: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col outline-none",
        dragOver && "ring-2 ring-inset ring-accent",
      )}
      tabIndex={0}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onPaste={(e) => {
        const files = filesFromItems(e.clipboardData?.items);
        if (!files.length) return;
        e.preventDefault();
        void importPicked(files);
      }}
      data-artdaddy-drop="library"
      onDragOver={(e) => {
        // Web only: on desktop the page must not claim the drag, or Tauri never gets the file.
        if (!webOwnsFileDrops()) return;
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        // Web only: on desktop Tauri owns file drops and they arrive through osDrop with paths.
        if (!webOwnsFileDrops()) return;
        setDragOver(false);
        const files = [...(e.dataTransfer.files ?? [])].filter((f) => MEDIA_RE.test(f.name));
        if (!files.length) return;
        e.preventDefault();
        void importPicked(files).then(() => setNonce((n) => n + 1));
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-accent/10 text-xs font-medium text-accent">
          Drop to import
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
        <span className="truncate">Library</span>
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            onChange={onPickFiles}
          />
          <button
            onClick={() => void onImportClick()}
            className="rounded px-1.5 py-0.5 text-base leading-none text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            title="Import media"
            aria-label="import media"
          >
            ＋
          </button>
          <button
            onClick={() => useRecordPanel.getState().openRecorder()}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
            title="Record from your camera"
            aria-label="record video"
          >
            <span className="h-2 w-2 rounded-full bg-red-500" />
            Record
          </button>
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="rounded px-1.5 py-0.5 text-base leading-none text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            title="Refresh files"
            aria-label="refresh files"
          >
            ⟳
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2 text-xs">
        {loading && tree.length === 0 ? (
          <p className="px-3 py-1 text-neutral-600">Loading…</p>
        ) : listError && tree.length === 0 ? (
          <div className="px-3 py-1 text-neutral-400">
            <p>Couldn’t read this project’s files.</p>
            <p className="mt-0.5 text-neutral-600">{listError}</p>
            <button
              type="button"
              className="mt-1 underline hover:text-neutral-200"
              onClick={() => setNonce((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : tree.length === 0 ? (
          <p className="px-3 py-1 text-neutral-600">No files yet.</p>
        ) : view === "thumbnails" ? (          <div className="grid grid-cols-2 gap-1.5 p-2">
            {collectMedia(tree).map((n) => (
              <LibraryTile key={n.path} node={n} store={store} onItemMenu={onItemMenu} />
            ))}
          </div>
        ) : (
          tree.map((n) => <Node key={n.path} node={n} depth={0} onItemMenu={onItemMenu} />)
        )}
      </div>
      {menu && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            role="menu"
            className="absolute min-w-36 rounded border border-edge bg-neutral-900 py-1 text-xs shadow-xl"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MenuItem
              checked={view === "thumbnails"}
              onClick={() => {
                setView("thumbnails");
                setMenu(null);
              }}
            >
              Thumbnails
            </MenuItem>
            <MenuItem
              checked={view === "list"}
              onClick={() => {
                setView("list");
                setMenu(null);
              }}
            >
              List
            </MenuItem>
            <div className="my-1 border-t border-edge/60" />
            <MenuItem
              onClick={() => {
                setMenu(null);
                inputRef.current?.click();
              }}
            >
              Import media…
            </MenuItem>
          </div>
        </div>
      )}
      {itemMenu && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => setItemMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setItemMenu(null);
          }}
        >
          <div
            role="menu"
            className="absolute min-w-36 rounded border border-edge bg-neutral-900 py-1 text-xs shadow-xl"
            style={{ left: itemMenu.x, top: itemMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MenuItem
              onClick={() => {
                addMention(buildMediaMention(itemMenu.ref, itemMenu.name, itemMenu.kind));
                setItemMenu(null);
              }}
            >
              Add to chat
            </MenuItem>
            {itemMenu.offline && (
              <MenuItem
                onClick={() => {
                  const { ref, name } = itemMenu;
                  setItemMenu(null);
                  void linkMedia(ref, name);
                }}
              >
                Link Media…
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                const { ref } = itemMenu;
                setItemMenu(null);
                void copyIn(ref);
              }}
            >
              Copy into project
            </MenuItem>
          </div>
        </div>
      )}
      {toast && (
        <button
          type="button"
          onClick={() => setToast(null)}
          className="absolute inset-x-2 bottom-2 z-50 rounded border border-edge bg-neutral-900/95 px-2 py-1.5 text-left text-[11px] text-neutral-200 shadow-lg"
        >
          {toast}
        </button>
      )}
    </div>
  );
}

/** Start a library -> timeline drag. The lane it lands on reads the payload and places the clip;
 *  a release anywhere else is simply dropped. */
function dragToTimeline(e: React.PointerEvent, node: FileNode): void {
  beginDrag(e, { ref: node.path, name: node.name }, (target, x, y) => {
    const lane = target?.closest<HTMLElement>("[data-artdaddy-drop='track']");
    if (!lane) return;
    lane.dispatchEvent(
      new CustomEvent("artdaddy:clip-drop", {
        bubbles: false,
        detail: { ref: node.path, x, y },
      }),
    );
  });
}

function collectMedia(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  for (const n of nodes) {
    if (n.type === "dir") out.push(...collectMedia(n.children ?? []));
    else if (MEDIA_RE.test(n.name)) out.push(n);
  }
  return out;
}

function tileKind(name: string): string {
  return kindOf(name) ?? "video";
}

// One library clip as a thumbnail tile: the generated poster (video/image) or a
// kind icon, clickable to preview it in the source monitor and draggable to the
// timeline (same source payload as the list rows).
function LibraryTile({
  node,
  store,
  onItemMenu,
}: {
  node: FileNode;
  store: ProjectStoreAccess | null;
  onItemMenu?: (e: React.MouseEvent, node: FileNode) => void;
}) {
  const setSel = useEditor((s) => s.setSelectedLibraryRef);
  const selected = useEditor((s) => s.selectedLibraryRef);
  const isSel = selected === node.path;
  const kind = tileKind(node.name);
  return (
    <button
      onPointerDown={(e) => dragToTimeline(e, node)}
      onClick={() => setSel(node.path)}
      onContextMenu={(e) => onItemMenu?.(e, node)}
      title={node.name}
      className={cn(
        "group flex flex-col overflow-hidden rounded border text-left",
        isSel ? "border-accent ring-1 ring-accent" : "border-edge/60 hover:border-neutral-500",
      )}
    >
      <div className="relative flex aspect-video items-center justify-center bg-black/40 text-base">
        <span className="pointer-events-none">{fileIcon(node.name)}</span>
        {kind !== "audio" && store && !node.offline && (
          <ClipThumbnail
            store={store}
            clip={{ media_ref: node.path } as unknown as Clip}
            kind={kind}
          />
        )}
        {node.offline && (
          <span className="absolute inset-x-0 bottom-0 bg-red-900/80 px-1 py-0.5 text-center text-[9px] font-medium text-red-100">
            Media Offline
          </span>
        )}
      </div>
      <span
        className={cn(
          "truncate px-1 py-0.5 text-[10px] group-hover:text-neutral-200",
          node.offline ? "text-red-300" : "text-neutral-400",
        )}
      >
        {node.name}
      </span>
    </button>
  );
}

function MenuItem({
  children,
  checked,
  onClick,
}: {
  children: ReactNode;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-neutral-300 hover:bg-neutral-800"
    >
      <span className="w-3 text-accent">{checked ? "✓" : ""}</span>
      <span>{children}</span>
    </button>
  );
}

function Node({
  node,
  depth,
  onItemMenu,
}: {
  node: FileNode;
  depth: number;
  onItemMenu?: (e: React.MouseEvent, node: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const setSel = useEditor((s) => s.setSelectedLibraryRef);
  const selected = useEditor((s) => s.selectedLibraryRef);
  const pad = { paddingLeft: `${8 + depth * 12}px` };
  if (node.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          style={pad}
          className="flex w-full items-center gap-1 py-0.5 text-left text-neutral-300 hover:bg-neutral-800/50"
        >
          <span className="w-3 text-neutral-500">{open ? "▾" : "▸"}</span>
          <span>📁</span>
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          node.children?.map((c) => (
            <Node key={c.path} node={c} depth={depth + 1} onItemMenu={onItemMenu} />
          ))}
      </div>
    );
  }
  const media = MEDIA_RE.test(node.name);
  return (
    <div
      style={pad}
      onPointerDown={media ? (e) => dragToTimeline(e, node) : undefined}
      onClick={media ? () => setSel(node.path) : undefined}
      onContextMenu={media && onItemMenu ? (e) => onItemMenu(e, node) : undefined}
      className={cn(
        "flex items-center gap-1 py-0.5 text-neutral-400",
        media && "cursor-pointer hover:text-neutral-200",
        media && selected === node.path && "bg-accent/20 text-neutral-100",
      )}
      title={node.path}
    >
      <span className="w-3" />
      <span>{fileIcon(node.name)}</span>
      <span className={cn("truncate", node.offline && "text-red-300")}>{node.name}</span>
      {node.offline && (
        <span className="ml-1 shrink-0 rounded bg-red-900/70 px-1 text-[9px] text-red-100">
          offline
        </span>
      )}
      {typeof node.size === "number" && node.size > 0 && (
        <span className="ml-auto shrink-0 pr-2 text-[10px] text-neutral-600">
          {fmtSize(node.size)}
        </span>
      )}
    </div>
  );
}

function fileIcon(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const kind = kindOf(name);
  if (kind === "video") return "🎬";
  if (kind === "image") return "🖼";
  if (kind === "audio") return "🎵";
  if ([".json", ".jsonl"].includes(ext)) return "🧾";
  return "📄";
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}
