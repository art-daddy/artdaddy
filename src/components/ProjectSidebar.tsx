import { useParams } from "react-router-dom";

import { useContractVersion } from "../contract/useContractVersion";
import FileTree from "./FileTree";
import { Pane } from "./Pane";

// Library pane (top-left): the active project's media + file tree. Clicking a clip
// opens it as a tab beside the live preview. Project creation and switching live in
// the top menu bar (File → New / Open).
export default function ProjectSidebar({ onHide }: { onHide?: () => void }) {
  const { projectId } = useParams();
  const contractVer = useContractVersion();

  return (
    <Pane title="Library" onHide={onHide} bodyClassName="flex flex-col overflow-hidden">
      {projectId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <FileTree projectId={projectId} />
        </div>
      ) : (
        <p className="px-4 py-4 text-xs text-neutral-500">No project open — use File → Open.</p>
      )}

      <div className="shrink-0 border-t border-edge px-4 py-2 text-[10px] text-neutral-600">
        contract v{contractVer || "?"}
      </div>
    </Pane>
  );
}
