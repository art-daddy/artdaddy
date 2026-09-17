import { useParams } from "react-router-dom";

import { useContractVersion } from "../contract/useContractVersion";
import FileTree from "./FileTree";

// Library pane (top-left): the active project's media + file tree. Clicking a clip opens it as
// a tab beside the live preview. The tree renders its OWN header (it owns the import / record /
// refresh actions that belong next to it), so this adds no second one and hands it the hide
// button instead. Project creation and switching live in the top menu bar (File → New / Open).
export default function ProjectSidebar({ onHide }: { onHide?: () => void }) {
  const { projectId } = useParams();
  const contractVer = useContractVersion();

  return (
    <aside className="flex h-full w-full min-w-0 flex-col bg-panel" aria-label="Library">
      {projectId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <FileTree projectId={projectId} onHide={onHide} />
        </div>
      ) : (
        <p className="px-4 py-4 text-xs text-neutral-500">No project open — use File → Open.</p>
      )}

      <div className="shrink-0 border-t border-edge px-4 py-2 text-[10px] text-neutral-600">
        contract v{contractVer || "?"}
      </div>
    </aside>
  );
}
