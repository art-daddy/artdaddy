import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { Pane } from "./Pane";
import ProjectSidebar from "./ProjectSidebar";
import SourceMonitor from "./SourceMonitor";

// Left column (Premiere-style): the source monitor on top (previews the library
// clip selected in the file tree), the project list + file tree/library below,
// split by a draggable divider that persists its size.
export default function LeftColumn({ onHide }: { onHide?: () => void }) {
  return (
    <Pane title="Library" onHide={onHide} bodyClassName="overflow-hidden">
      <PanelGroup direction="vertical" className="h-full" autoSaveId="artdaddy-left-v2">
        <Panel defaultSize={50} minSize={15} className="min-h-0">
          <SourceMonitor />
        </Panel>
        <PanelResizeHandle className="h-1 cursor-row-resize bg-edge/40 transition-colors hover:bg-accent" />
        <Panel defaultSize={50} minSize={20} className="min-h-0">
          <ProjectSidebar />
        </Panel>
      </PanelGroup>
    </Pane>
  );
}
