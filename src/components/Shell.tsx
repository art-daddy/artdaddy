import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { projectDocuments } from "../project/documentRegistry";
import { asProjectId } from "../project/types";
import { projectPath, useCloseCoordinator } from "../store/closeCoordinator";
import { usePanes } from "../store/panes";
import { useProjects } from "../store/projects";
import ChatView from "./ChatView";
import Inspector from "./Inspector";
import ProjectPicker from "./ProjectPicker";
import ProjectSidebar from "./ProjectSidebar";
import StagePanel from "./StagePanel";
import TimelineEditor from "./TimelineEditor";
import { Empty } from "./ui";

// Resizable workspace: top row [library · tabbed preview · clip properties], full-width
// timeline below it, chat on the right. The source monitor is a TAB of the preview rather
// than a pane of its own, which is what frees the top-left for the library and lets the
// timeline span the whole window. Owns the per-project effects (open, load chat, load the
// editor timeline, start the local tool runtime) so they run once regardless of which panes
// re-render.
export default function Shell({ projectId }: { projectId: string | null }) {
  const open = useProjects((s) => s.open);
  const nav = useNavigate();
  // Message set when open() refuses the project (e.g. it was written by a newer
  // ArtDaddy). While set, we render it instead of the editor and load nothing.
  const [openError, setOpenError] = useState<string | null>(null);
  // The project whose data is actually LOADED into the stores. The panes render
  // only when this matches the routed projectId, so a switch never flashes the
  // previous project's editor/chat state during the open+load window (RF7).
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  useEffect(() => {
    setOpenError(null);
    // Clear the loaded marker on EVERY route change so `ready` can't stay true from a
    // PREVIOUS activation while this project reloads (an A->B->A where B never
    // committed would otherwise reveal the panes against a mid-reload store); it turns
    // true again only once THIS run commits its load below (R6-3).
    setLoadedProjectId(null);
    let cancelled = false;
    void (async () => {
      // Close-before-open: let the PREVIOUS project finish tearing down first. THEN, BEFORE opening or
      // persisting-active the target — and for EVERY destination INCLUDING the home route (null) — veto
      // if a previous close FAILED: route back to that project + raise the modal. This runs ahead of
      // open() so a vetoed switch never persists the target as the active project (findings #3/#4:
      // browser Back/Forward, a raw route change, or leaving to `/` all bypass the menu's
      // useProjectSwitch, and Shell's cleanup only fire-and-forgets the close).
      await projectDocuments.whenIdle();
      if (cancelled) return;
      const failed = projectDocuments.firstCloseFailed();
      if (failed && failed.id !== projectId) {
        useCloseCoordinator.getState().setPending({ failedId: failed.id, target: projectId });
        nav(projectPath(failed.id), { replace: true });
        return;
      }
      if (!projectId) return; // home route (and no failed close to recover) -> nothing to open
      const id = asProjectId(projectId);
      // Only NOW open the project. open() persists it as the active id (projects.ts setActive), so it
      // must run AFTER the veto — otherwise a switch we veto would still leave the target persisted as
      // active (finding #3). The refusal guard also clears BEFORE the document opens timeline/chat/host
      // (F14/R6); we then hold the panes on a placeholder until the stores commit (RF7).
      try {
        await open(projectId);
      } catch (e) {
        if (!cancelled) setOpenError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (cancelled) return;
      // ONE lifecycle owner: the registry opens the editor + chat + tool host as this project's
      // document children (single-flight; a close-during-open can't orphan it).
      try {
        await projectDocuments.open(id);
      } catch {
        // A failed open (missing/unreadable files) must not reveal a null / previous-project
        // workspace (Q2); the document already tore its partial open down.
        if (!cancelled)
          setOpenError("Couldn't open this project \u2014 its files may be missing or unreadable.");
        return;
      }
      if (cancelled) return; // a switch during open owns its own reveal; this run does nothing
      setLoadedProjectId(projectId); // the document holds THIS project -> reveal the panes
    })();
    return () => {
      cancelled = true;
      // Close the document on EVERY route change (incl. one whose open stalls/fails): the registry
      // retires the chat turn, disposes the editor instance, and evicts the tool host -- and tears
      // down even an open still in flight, so a fast switch can never leave an orphaned project
      // running paid calls + tools (R7-3, R11 f/u #2). No-op for the home route (nothing to close).
      if (projectId) void projectDocuments.close(asProjectId(projectId));
    };
  }, [projectId, open, nav]);

  // Reveal the panes only once THIS project's data is loaded (never mid-open).
  const ready = !!projectId && !openError && loadedProjectId === projectId;

  // other NLEs' rule: the library / inspector / assistant can be hidden; the preview and the timeline
  // cannot. Hidden panes are UNMOUNTED rather than collapsed to zero, so no orphan resize handle is
  // left behind; their state lives in stores, so nothing is lost by remounting.
  const visible = usePanes((s) => s.visible);
  const hide = usePanes((s) => s.setVisible);

  // No project -> no workspace. The library, source monitor, files tree, inspector and
  // timeline all describe a project; with none open they could only render as empty chrome,
  // which is what an alpha user was shown. Every hook above still runs (the effect owns the
  // failed-close veto for the home route) -- only the panes are withheld.
  if (!projectId) return <ProjectPicker />;

  return (
    <PanelGroup direction="horizontal" className="h-full" autoSaveId="artdaddy-layout-v4">
      <Panel defaultSize={80} minSize={40} className="min-w-0" order={1}>
        {openError ? (
          <Empty>{openError}</Empty>
        ) : !ready ? (
          <Empty>Opening project…</Empty>
        ) : (
          // Library, preview and clip properties share the top row; the timeline spans the
          // full width below all three.
          <PanelGroup direction="vertical" className="h-full" autoSaveId="artdaddy-main-v1">
            <Panel defaultSize={58} minSize={22} className="min-h-0">
              <PanelGroup direction="horizontal" className="h-full" autoSaveId="artdaddy-top-v1">
                {visible.library && (
                  <>
                    <Panel defaultSize={22} minSize={12} maxSize={42} className="min-w-0" order={1}>
                      <ProjectSidebar onHide={() => hide("library", false)} />
                    </Panel>
                    <Handle />
                  </>
                )}
                <Panel defaultSize={50} minSize={30} className="min-w-0" order={2}>
                  <StagePanel projectId={projectId} />
                </Panel>
                {visible.inspector && (
                  <>
                    <Handle />
                    <Panel defaultSize={28} minSize={16} maxSize={46} className="min-w-0" order={3}>
                      <Inspector onHide={() => hide("inspector", false)} />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </Panel>
            <RowHandle />
            <Panel
              defaultSize={42}
              minSize={14}
              className="flex min-h-0 flex-col border-t border-edge"
            >
              <TimelineEditor />
            </Panel>
          </PanelGroup>
        )}
      </Panel>
      {visible.chat && (
        <>
          <Handle />
          <Panel defaultSize={20} minSize={14} className="min-w-0" order={2}>
            {ready ? <ChatView onHide={() => hide("chat", false)} /> : null}
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}

function Handle() {
  return (
    <PanelResizeHandle className="w-1 cursor-col-resize bg-edge/40 transition-colors hover:bg-accent" />
  );
}

function RowHandle() {
  return (
    <PanelResizeHandle className="h-1 cursor-row-resize bg-edge/40 transition-colors hover:bg-accent" />
  );
}
