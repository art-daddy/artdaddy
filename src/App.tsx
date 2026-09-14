import { useEffect } from "react";
import { Route, Routes, useParams } from "react-router-dom";

import AuthProvider from "./components/AuthProvider";
import ProfilePage from "./components/ProfilePage";
import CloseFailedDialog from "./components/CloseFailedDialog";
import MenuBar from "./components/MenuBar";
import Shell from "./components/Shell";
import { UpdateBanner } from "./components/UpdateBanner";
import { startOsDropRouter, webOwnsFileDrops } from "./lib/osDrop";
import { initMcp } from "./mcp/service";
import { captureError } from "./observability/sentry";
import { platform } from "./platform";
import { projectDocuments } from "./project/documentRegistry";
import { asProjectId } from "./project/types";
import { useCloseCoordinator } from "./store/closeCoordinator";
import { useEditor } from "./store/editor";

function ShellRoute() {
  const { projectId } = useParams();
  return <Shell projectId={projectId ?? null} />;
}

export default function App() {
  // On desktop Tauri owns file drops, so they arrive as PATHS and are routed to whatever zone is
  // under the cursor — and the page must NOT claim the drag, or macOS delivers a preview image
  // to the webview instead of the file to Tauri. On web there is no such handler: keep blocking
  // the webview's default "navigate to the dropped file" so a stray drop can't throw the app away.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    if (webOwnsFileDrops()) {
      window.addEventListener("dragover", prevent);
      window.addEventListener("drop", prevent);
    }
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startOsDropRouter()
      .then((un) => (cancelled ? un() : (stop = un)))
      .catch(() => undefined);
    // The local MCP server, so Claude Code / Cursor / Codex can drive this project. Loopback
    // only, and a failure to start never blocks the editor.
    void initMcp();
    return () => {
      cancelled = true;
      stop?.();
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Desktop window close (guardrail 5): preventDefault FIRST, then close the open project through the
  // retryable coordinator. On a clean close the window is closed for real (re-entry flag); on a failed
  // save the Retry/Discard/Cancel modal appears and the app STAYS open (Cancel keeps editing).
  useEffect(() => {
    if (platform.name !== "tauri") return;
    let allow = false; // re-entry: once the guard clears, let the OS close go through
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      // Nothing below may leave the window open: `close()` is a permissioned command, and when
      // `core:window:allow-close` was missing it REJECTED here — after preventDefault had already
      // held the window — so the app could not be quit at all except by killing the process.
      const forceClose = async (): Promise<void> => {
        allow = true;
        try {
          await win.close();
        } catch (e) {
          captureError(e instanceof Error ? e : new Error(String(e)), { scope: "app.exit" });
          await win.destroy().catch(() => {}); // last resort: the save already ran
        }
      };
      useCloseCoordinator.getState().setExitHandler(() => void forceClose());
      const un = await win.onCloseRequested(async (event) => {
        if (allow) return; // the guard already resolved — let the OS close the window
        const currentId = useEditor.getState().projectId;
        if (!currentId) return; // nothing open — allow the close
        event.preventDefault(); // hold the window open while we save asynchronously
        // Unsaved edits: ask before quitting rather than deciding for the user. Autosave clears
        // `dirty` within a beat of the last edit, so this is the genuine "you have work in flight"
        // case, not a prompt on every quit.
        if (useEditor.getState().dirty) {
          useCloseCoordinator
            .getState()
            .setPending({ failedId: currentId, target: null, exit: true, kind: "unsaved" });
          return;
        }
        let outcome: { ok: boolean };
        try {
          outcome = await projectDocuments.close(asProjectId(currentId));
        } catch (e) {
          captureError(e instanceof Error ? e : new Error(String(e)), { scope: "app.exit" });
          outcome = { ok: false }; // an unexpected throw must offer recovery, never strand the window
        }
        if (outcome.ok) await forceClose();
        else
          useCloseCoordinator
            .getState()
            .setPending({ failedId: currentId, target: null, exit: true });
      });
      if (disposed) un();
      else unlisten = un;
    })();
    return () => {
      disposed = true;
      unlisten?.();
      useCloseCoordinator.getState().setExitHandler(null);
    };
  }, []);

  return (
    <AuthProvider>
      <div className="flex h-full flex-col">
        <MenuBar />
        <UpdateBanner />
        <div className="min-h-0 flex-1">
          <Routes>
            <Route path="/" element={<Shell projectId={null} />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/p/:projectId" element={<ShellRoute />} />
          </Routes>
        </div>
      </div>
      <CloseFailedDialog />
    </AuthProvider>
  );
}
