// The settings view of the Export dialog (design D2), drawn instead of the 0.28.0 one while the switch `quick_route` is on (ExportDialog.tsx hands it over). It mounts when the dialog is open and
// idle and unmounts when the dialog closes or a render starts, so every value it keeps is for one opening of the dialog and none survives into the next.
//
// SKELETON: this file holds only the contract (the props); the body is the work of lane helper B and replaces it.
import type { RenderWorkload } from "../timeline/renderPlan";
import type { ExportSettings } from "./ExportDialog";

export interface ExportSettingsViewProps {
  /** The open project's size, rate and layers as they were when the dialog opened (its length is the one the view reads; the chip row's size basis). Absent: no project, no chip row. */
  workload: RenderWorkload | null;
  /** Cancel: the dialog's own dismiss (Hide, never an abort), the same door as the Escape key. */
  onCancel: () => void;
  /** Export: the settings the person chose, handed over exactly as ExportDialog's own button hands them in 0.28.0. */
  onStart: (settings: ExportSettings) => void;
}

export default function ExportSettingsView(_props: ExportSettingsViewProps): JSX.Element | null {
  return null;
}
