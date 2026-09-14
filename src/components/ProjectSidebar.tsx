import { useParams } from "react-router-dom";

import { useContractVersion } from "../contract/useContractVersion";
import FileTree from "./FileTree";

// Files pane (left/bottom): the active project's file tree. Project creation and
// switching live in the top menu bar (File → New / Open) now.
export default function ProjectSidebar() {
  const { projectId } = useParams();
  const contractVer = useContractVersion();

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-edge bg-panel">
      <div className="flex items-center px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Files</h2>
      </div>

      {projectId ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-edge">
          <FileTree projectId={projectId} />
        </div>
      ) : (
        <p className="border-t border-edge px-4 py-4 text-xs text-neutral-500">
          No project open — use File → Open.
        </p>
      )}

      <div className="border-t border-edge px-4 py-2 text-[10px] text-neutral-600">
        contract v{contractVer || "?"}
      </div>
    </aside>
  );
}
