// Premiere-style top menu bar (File / Edit / View / Window / Help). Lives above
// the routed workspace, so it uses the URL (not route params) for the active
// project and drives the projects + editor stores. New/Open/About open modals.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { apiBase, defaultApiBase, isApiBaseOverridden, setApiBase } from "../api/config";
import { BRAND, PACKAGE_EXT } from "../brand";
import AccountMenu from "./AccountMenu";
import { useContractVersion } from "../contract/useContractVersion";
import { requestExit } from "../lib/appExit";
import { desktopStore } from "../lib/desktop";
import { lastExportDir, rememberExportDir } from "../lib/exportDir";
import { copyIntoProject } from "../lib/mediaLink";
import { importFileByReference, MEDIA_EXTS, uploadFiles } from "../lib/upload";
import { platform } from "../platform";
import { useChat } from "../store/chat";
import { useProjectSwitch, useCloseCoordinator } from "../store/closeCoordinator";
import { useEditor } from "../store/editor";
import { exportRunning, useExportJob } from "../store/exportJob";
import { useMcpPanel } from "../store/mcpPanel";
import { usePanes, type PaneId } from "../store/panes";
import { useProjectNotice } from "../store/projectNotice";
import { withImportJob } from "../store/importJobs";
import { useProjects } from "../store/projects";
import ExportDialog, { type ExportSettings } from "./ExportDialog";
import RecordDialog from "./RecordDialog";
import { useRecordPanel } from "../store/recordPanel";
import ImportProgress from "./ImportProgress";
import McpPanel from "./McpPanel";
import { NewProjectDialog, OpenProjectDialog } from "./ProjectDialogs";
import { ShortcutSheet } from "./ShortcutSheet";
import { shortcutLabel as sc } from "../timeline/shortcuts";
import ReportProblemDialog from "./ReportProblemDialog";
import { Button, cn, Overlay } from "./ui";

type Item = "sep" | { label: string; shortcut?: string; onClick: () => void; disabled?: boolean };

export default function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  // "mcp" is deliberately NOT one of these: the chat controls and the assistant's empty state
  // open it too, so its visibility belongs to the store rather than to this menu.
  const [dialog, setDialog] = useState<null | "new" | "open" | "about" | "shortcuts">(null);
  const mcpOpen = useMcpPanel((s) => s.open);
  const openMcp = useMcpPanel((s) => s.openPanel);
  const closeMcp = useMcpPanel((s) => s.closePanel);
  const [reportOpen, setReportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const notice = useProjectNotice((s) => s.message);
  const clearNotice = useProjectNotice((s) => s.clear);
  const barRef = useRef<HTMLDivElement>(null);
  const switchTo = useProjectSwitch();
  const loc = useLocation();
  const projectId = loc.pathname.startsWith("/p/")
    ? decodeURIComponent(loc.pathname.slice(3))
    : null;

  const importInputRef = useRef<HTMLInputElement>(null);
  const onImportPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (projectId && files.length) void uploadFiles(projectId, files);
  };

  // Subscribe so menu items enable/disable live.
  const selection = useEditor((s) => s.selection);
  const clipboard = useEditor((s) => s.clipboard);
  const dirty = useEditor((s) => s.dirty);
  const editorStore = useEditor((s) => s.store);
  const recordOpen = useRecordPanel((s) => s.open);
  const openRecorder = useRecordPanel((s) => s.openRecorder);
  const closeRecorder = useRecordPanel((s) => s.closeRecorder);
  const panes = usePanes((s) => s.visible);
  const togglePane = usePanes((s) => s.toggle);
  const showAllPanes = usePanes((s) => s.showAll);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ed = () => useEditor.getState();
  const hasProject = Boolean(projectId);
  const hasSel = Boolean(selection);

  const splitAtPlayhead = () => {
    const s = ed();
    if (!s.selection) return;
    const fps = Number(s.timeline?.canvas?.fps) || 30;
    void s.splitClip(s.selection, Math.round(s.playhead * fps));
  };
  const resetLayout = () => {
    try {
      for (const k of Object.keys(localStorage))
        if (k.startsWith("react-resizable-panels:")) localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
    location.reload();
  };

  // other NLEs' View-menu shortcuts, on the Windows modifiers: the media/inspector/agent panes toggle,
  // the preview and timeline never do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // e.code, not e.key: on macOS Option is a TEXT modifier, so Option+A arrives as "å" and
      // Option+0 as "º" — matching on e.key meant these never fired there at all.
      const code = e.code;
      const id: PaneId | null =
        e.altKey && code === "KeyA"
          ? "chat"
          : code === "Digit0" || code === "Numpad0"
            ? e.altKey
              ? "inspector"
              : "library"
            : null;
      if (!id) return;
      e.preventDefault();
      usePanes.getState().toggle(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reportProblem = async (note: string): Promise<boolean> => {
    const ok = await useChat.getState().sendFeedback("report", { note });
    if (!ok) return false;
    setReportOpen(false);
    setToast("Report sent — thank you");
    window.setTimeout(() => setToast(null), 3000);
    return true;
  };

  // Open the OS Save As dialog for a video export, pre-filled with the folder the user
  // exported into last (or Downloads, the tool's own default) and the same filename stem
  // the tool would have chosen. Returns null when the user cancels.
  const chooseExportPath = async (): Promise<string | null> => {
    const store = ed().store;
    if (!store) return null;
    const { defaultExportStem } = await import("../timeline/render");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { joinPath } = await import("../tools/store");
    const name = `${defaultExportStem(store.projectDir)}.mp4`;
    const dir = lastExportDir() ?? (await store.downloadDir());
    return await save({
      title: "Export video",
      defaultPath: dir ? joinPath(dir, name) : name,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
  };

  // Renders through the SAME `export` tool the agent calls, via the same project
  // tool host — so the menu and the agent can never drift into two renderers.
  const exportVideo = async (settings: ExportSettings) => {
    if (!projectId) return;
    // Two renders would race for the same output path and interleave their progress. The dialog
    // shows the running one instead of starting a second.
    if (exportRunning()) return;
    // Ask WHERE before starting the job: cancelling the save dialog must leave nothing behind —
    // no render, and no job stuck in "preparing" with no ffmpeg attached to it.
    let outputPath: string | null = null;
    if (platform.name === "tauri") {
      try {
        outputPath = await chooseExportPath();
      } catch (e) {
        useExportJob
          .getState()
          .finish({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!outputPath) return; // user cancelled
      rememberExportDir(outputPath);
    }
    const job = useExportJob.getState();
    // The render is cancellable from the dialog even after it is dismissed, so the controller
    // lives with the job rather than in this component's state.
    const controller = new AbortController();
    job.begin(() => controller.abort());
    try {
      const { openToolHost } = await import("../tools/host");
      const res = (await openToolHost(projectId).run(
        "export",
        {
          resolution: settings.resolution,
          quality: settings.quality,
          ...(settings.fps === null ? {} : { fps: settings.fps }),
          ...(outputPath ? { output_path: outputPath } : {}),
        },
        controller.signal,
      )) as {
        ok?: boolean;
        error?: string;
        saved_to?: string;
        warnings?: string[];
      } | null;
      if (controller.signal.aborted) {
        useExportJob.getState().finish({ phase: "cancelled" });
      } else if (!res?.ok) {
        useExportJob.getState().finish({ phase: "failed", error: res?.error ?? "unknown error" });
      } else {
        useExportJob
          .getState()
          // The tool returns a bare filename (it must not leak paths to the model). The menu
          // already knows the folder the user picked, so report the real destination.
          .finish({
            phase: "done",
            fraction: 1,
            etaSec: 0,
            savedTo: outputPath ?? res.saved_to ?? null,
          });
      }
    } catch (e) {
      useExportJob
        .getState()
        .finish({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const exportBundle = async () => {
    const store = ed().store;
    if (!store) return;
    setToast("Packing project…");
    try {
      const { packProject } = await import("../timeline/pack");
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { zip, report, name } = await packProject(store);
      const safe = name.replace(/[^\w.\- ]+/g, "_").trim() || "project";
      const dest = await save({
        title: "Export project bundle",
        defaultPath: `${safe}.${PACKAGE_EXT}`,
        filters: [{ name: `${BRAND.displayName} project bundle`, extensions: ["zip"] }],
      });
      if (!dest) {
        setToast(null);
        return;
      }
      await store.writeBytes(dest, zip);
      const miss = report.missing.length ? `, ${report.missing.length} missing` : "";
      setToast(`Saved ${dest.split(/[\\/]/).pop()} (${report.clips} clips${miss})`);
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    window.setTimeout(() => setToast(null), 4000);
  };

  /** Pick media with the OS dialog and LINK each file in place. Returns the media ids. */
  const pickAndLink = async (title: string): Promise<string[]> => {
    if (!projectId) return [];
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title,
        // The ONE media list (src/media/formats.ts). Hard-coding a second copy here is how the
        // picker came to reject avi/tiff/heic/opus that the rest of the app imports happily.
        filters: [{ name: "Media", extensions: [...MEDIA_EXTS] }],
      });
      if (!picked) return [];
      const paths = Array.isArray(picked) ? picked : [picked];
      setToast(`Importing ${paths.length} file(s)…`);
      const ids: string[] = [];
      for (const p of paths) {
        try {
          ids.push((await withImportJob(p, () => importFileByReference(projectId, p))).id);
        } catch {
          /* skip a file we cannot read, keep the rest */
        }
      }
      return ids;
    } catch (e) {
      setToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      window.setTimeout(() => setToast(null), 3000);
      return [];
    }
  };

  const addMediaByReference = async () => {
    const ids = await pickAndLink("Link media (referenced in place — not copied)");
    setToast(`Linked ${ids.length} file(s)`);
    window.setTimeout(() => setToast(null), 3000);
  };

  /** Human "Import Media": on DESKTOP link the picked files in place (parity with established NLEs — a local import
   *  is never copied; use Export Bundle to collect). On web fall back to the byte-copy `<input
   *  type=file>` — a browser File exposes no path to link. Clipboard / web-download / generated media
   *  stay COPIED (they have no stable on-disk source to reference). */
  const importMedia = async () => {
    if (!projectId) return;
    if (platform.name === "tauri") await addMediaByReference();
    else importInputRef.current?.click();
  };

  /** The copy-in variant of Import Media. An OS file picker cannot carry a checkbox, so the
   *  choice is a second menu item: link first (one tested path), then pull the bytes in. */
  const importMediaCopied = async () => {
    if (!projectId) return;
    const store = desktopStore(projectId);
    if (!store) return;
    const linked = await pickAndLink("Import media (copied into the project)");
    if (!linked.length) return;
    let ok = 0;
    for (const id of linked) {
      if ((await copyIntoProject(store, id)).ok) ok += 1;
    }
    setToast(`Copied ${ok}/${linked.length} file(s) into the project`);
    window.setTimeout(() => setToast(null), 3000);
  };

  // Save As: copy the project to a folder the user picks and continue editing THERE, with
  // the original left on disk (Premiere). The project is CLOSED first so its in-memory
  // timeline is flushed — the copy is then plainly whatever is on disk — and reopened after,
  // which is also what re-resolves every id→directory hop onto the new location.
  const saveProjectAs = async () => {
    if (!projectId) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const current = useProjects.getState().active;
    const suggested = (current?.name || projectId).replace(/[^\w.\- ]+/g, "_").trim();
    const dest = await save({ title: "Save project as", defaultPath: suggested });
    if (!dest) return;
    setToast("Saving project…");
    await switchTo(null); // flush + close; a failed close raises Retry/Discard/Cancel
    if (useCloseCoordinator.getState().pending) {
      setToast(null);
      return; // close refused — the project is untouched and still open
    }
    try {
      await useProjects.getState().saveAs(projectId, dest);
      await switchTo(projectId);
      setToast(`Saved to ${dest}`);
    } catch (e) {
      // The copy failed: the registry still points at the original, so reopening there
      // gets the user back exactly where they were rather than to a half-written folder.
      await switchTo(projectId);
      setToast(`Save As failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    window.setTimeout(() => setToast(null), 4000);
  };

  const menus: Record<string, Item[]> = {
    File: [
      { label: "New Project…", shortcut: "Ctrl+N", onClick: () => setDialog("new") },
      { label: "Open Project…", shortcut: "Ctrl+O", onClick: () => setDialog("open") },
      {
        label: "Save Project As…",
        onClick: () => void saveProjectAs(),
        disabled: !hasProject || platform.name !== "tauri",
      },
      "sep",
      { label: "Import Media…", onClick: () => void importMedia(), disabled: !hasProject },
      {
        label: "Import Media (copy into project)…",
        onClick: () => void importMediaCopied(),
        disabled: !hasProject || platform.name !== "tauri",
      },
      "sep",
      {
        label: "Export Video (.mp4)…",
        onClick: () => setExportOpen(true),
        disabled: !hasProject,
      },
      {
        label: "Export Project Bundle (.zip)…",
        onClick: () => void exportBundle(),
        disabled: !hasProject,
      },
      "sep",
      { label: "Close Project", onClick: () => void switchTo(null), disabled: !hasProject },
      ...(platform.name === "tauri"
        ? ([
            "sep",
            { label: "Exit", shortcut: "Alt+F4", onClick: () => void requestExit() },
          ] as Item[])
        : []),
    ],
    Edit: [
      {
        label: "Undo",
        shortcut: sc("undo"),
        onClick: () => void ed().undo(),
        disabled: !hasProject,
      },
      {
        label: "Redo",
        shortcut: sc("redo"),
        onClick: () => void ed().redo(),
        disabled: !hasProject,
      },
      "sep",
      {
        label: "Cut",
        shortcut: sc("cut"),
        onClick: () => {
          const s = ed();
          if (s.selection) {
            s.copyClip(s.selection);
            void s.deleteClips([s.selection]);
          }
        },
        disabled: !hasSel,
      },
      {
        label: "Copy",
        shortcut: sc("copy"),
        onClick: () => ed().selection && ed().copyClip(ed().selection!),
        disabled: !hasSel,
      },
      {
        label: "Paste",
        shortcut: sc("paste"),
        onClick: () => void ed().pasteClip(),
        disabled: !clipboard,
      },
      {
        label: "Delete",
        shortcut: sc("delete"),
        onClick: () => ed().selection && void ed().deleteClips([ed().selection!]),
        disabled: !hasSel,
      },
      "sep",
      {
        label: "Duplicate",
        shortcut: sc("duplicate"),
        onClick: () => ed().selection && void ed().duplicateClip(ed().selection!),
        disabled: !hasSel,
      },
      {
        label: "Split at Playhead",
        shortcut: sc("split"),
        onClick: splitAtPlayhead,
        disabled: !hasSel,
      },
      "sep",
      { label: "Keyboard Shortcuts…", onClick: () => setDialog("shortcuts") },
    ],
    View: [
      {
        label: `${panes.library ? "Hide" : "Show"} Library`,
        shortcut: sc("paneLibrary"),
        onClick: () => togglePane("library"),
      },
      {
        label: `${panes.inspector ? "Hide" : "Show"} Inspector`,
        shortcut: sc("paneInspector"),
        onClick: () => togglePane("inspector"),
      },
      {
        label: `${panes.chat ? "Hide" : "Show"} Assistant`,
        shortcut: sc("paneAssistant"),
        onClick: () => togglePane("chat"),
      },
      "sep",
      {
        label: "Zoom In",
        shortcut: sc("zoomIn"),
        onClick: () => ed().setZoom(ed().zoom * 1.3),
        disabled: !hasProject,
      },
      {
        label: "Zoom Out",
        shortcut: sc("zoomOut"),
        onClick: () => ed().setZoom(ed().zoom / 1.3),
        disabled: !hasProject,
      },
    ],
    Window: [
      { label: "Show All Panels", onClick: showAllPanes },
      { label: "Reset Panel Layout", onClick: resetLayout },
    ],
    Help: [
      { label: "Report a Problem…", onClick: () => setReportOpen(true), disabled: !hasProject },
      { label: "Connect an AI Agent (MCP)…", onClick: openMcp },
      { label: `About ${BRAND.displayName}`, onClick: () => setDialog("about") },
    ],
  };

  return (
    <>
      <input
        ref={importInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={onImportPick}
      />
      <div
        ref={barRef}
        className="flex h-7 shrink-0 items-center gap-0.5 border-b border-edge bg-neutral-950 px-2 text-[12px] text-neutral-300 select-none"
      >
        {Object.entries(menus).map(([name, items]) => (
          <div key={name} className="relative">
            <button
              onClick={() => setOpen((o) => (o === name ? null : name))}
              onPointerEnter={() => open && setOpen(name)}
              className={cn(
                "rounded px-2 py-0.5 hover:bg-neutral-800",
                open === name && "bg-neutral-800",
              )}
            >
              {name}
            </button>
            {open === name && (
              <div className="absolute left-0 top-full z-50 mt-0.5 min-w-[220px] rounded-md border border-edge bg-neutral-900 py-1 shadow-xl">
                {items.map((it, i) =>
                  it === "sep" ? (
                    <div key={i} className="my-1 h-px bg-edge" />
                  ) : (
                    <button
                      key={i}
                      disabled={it.disabled}
                      onClick={() => {
                        setOpen(null);
                        it.onClick();
                      }}
                      className="flex w-full items-center justify-between gap-6 px-3 py-1 text-left hover:bg-accent/80 hover:text-white disabled:cursor-default disabled:text-neutral-600 disabled:hover:bg-transparent"
                    >
                      <span>{it.label}</span>
                      {it.shortcut && (
                        <span className="text-[11px] text-neutral-500">{it.shortcut}</span>
                      )}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <ExportBadge onClick={() => setExportOpen(true)} />
          {hasProject && (
            <button
              onClick={openRecorder}
              aria-label="Record video"
              title="Record from your camera"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
              Record
            </button>
          )}
          {hasProject && (
            <button
              onClick={() => setExportOpen(true)}
              aria-label="Export video"
              title="Export video"
              className="rounded px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              Export
            </button>
          )}
          {hasProject && dirty && (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-amber-400"
              title="Unsaved changes — saving automatically"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
              Unsaved
            </span>
          )}
          <AccountMenu />
        </div>
      </div>

      {dialog === "new" && (
        <NewProjectDialog onClose={() => setDialog(null)} onDone={(id) => void switchTo(id)} />
      )}
      {dialog === "open" && (
        <OpenProjectDialog
          activeId={projectId}
          onClose={() => setDialog(null)}
          onOpen={(id) => void switchTo(id)}
        />
      )}
      {dialog === "about" && <AboutDialog onClose={() => setDialog(null)} />}
      {mcpOpen && (
        <Overlay title="Connect an AI agent" onClose={closeMcp}>
          <McpPanel />
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setDialog(null)}>
              Close
            </Button>
          </div>
        </Overlay>
      )}
      {dialog === "shortcuts" && (
        <Overlay title="Keyboard shortcuts" onClose={() => setDialog(null)}>
          <ShortcutSheet />
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setDialog(null)}>
              Close
            </Button>
          </div>
        </Overlay>
      )}
      <ReportProblemDialog
        open={reportOpen}
        onCancel={() => setReportOpen(false)}
        onSubmit={reportProblem}
      />
      <ExportDialog
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        onStart={(s) => void exportVideo(s)}
      />
      <RecordDialog
        open={recordOpen}
        projectDir={editorStore?.projectDir ?? null}
        onClose={closeRecorder}
      />
      <ImportProgress />
      {notice && (
        <div
          role="status"
          className="fixed bottom-16 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-md border border-amber-700/60 bg-amber-950/90 px-4 py-2 text-xs text-amber-100 shadow-xl"
        >
          {notice}
          <button className="text-amber-300 hover:text-white" onClick={() => clearNotice()}>
            Dismiss
          </button>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-md border border-edge bg-neutral-900 px-4 py-2 text-xs text-neutral-200 shadow-xl">
          {toast}
        </div>
      )}
    </>
  );
}

/** A live percentage while a render runs, so a dismissed dialog still leaves the job visible.
 *  Without it, "non-blocking" would mean "invisible". */
function ExportBadge({ onClick }: { onClick: () => void }): JSX.Element | null {
  const phase = useExportJob((s) => s.phase);
  const fraction = useExportJob((s) => s.fraction);
  if (phase !== "preparing" && phase !== "rendering") return null;
  return (
    <button
      onClick={onClick}
      aria-label="export progress"
      title="Exporting — click to show details"
      className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-accent hover:bg-neutral-800"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
      {fraction === null ? "Exporting…" : `Exporting ${Math.round(fraction * 100)}%`}
    </button>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const contractVer = useContractVersion();
  const [showServer, setShowServer] = useState(false);
  const [server, setServer] = useState(apiBase());
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverNotice, setServerNotice] = useState<string | null>(null);

  const saveServer = () => {
    setServerError(null);
    setServerNotice(null);
    try {
      const trimmed = server.trim();
      setApiBase(trimmed === defaultApiBase() ? null : trimmed);
      setServer(apiBase());
      setServerNotice(`Now using ${apiBase()} — sign in again.`);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "That server address isn't valid.");
    }
  };

  return (
    <Overlay title={`About ${BRAND.displayName}`} onClose={onClose}>
      <p className="text-sm text-neutral-300">
        {BRAND.displayName} — {BRAND.tagline}.
      </p>
      <p className="mt-2 text-xs text-neutral-500">Timeline contract v{contractVer || "?"}</p>
      <div className="mt-4 border-t border-neutral-800 pt-3">
        <button
          type="button"
          onClick={() => setShowServer((v) => !v)}
          className="flex w-full items-center justify-between text-xs text-neutral-500 hover:text-neutral-300"
        >
          <span>Server</span>
          <span className="truncate pl-2 text-neutral-600">
            {isApiBaseOverridden() ? apiBase() : "default"}
          </span>
        </button>
        {showServer && (
          <div className="mt-2">
            <input
              type="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              spellCheck={false}
              placeholder="https://your-server.example.com"
              aria-label="Server address"
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-accent"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={saveServer}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-500"
              >
                Use this server
              </button>
              <button
                type="button"
                onClick={() => {
                  setApiBase(null);
                  setServer(apiBase());
                  setServerNotice(`Back to the default server (${apiBase()}).`);
                }}
                className="rounded-md px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300"
              >
                Reset
              </button>
            </div>
            {serverError && <p className="mt-2 text-xs text-red-400">{serverError}</p>}
            {serverNotice && <p className="mt-2 text-xs text-emerald-400">{serverNotice}</p>}
            <p className="mt-2 text-xs text-neutral-600">
              Changing this signs you out — your login belongs to one server.
            </p>
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Overlay>
  );
}
