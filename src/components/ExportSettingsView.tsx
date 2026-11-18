// The settings view of the Export dialog (design D2), drawn instead of the 0.28.0 one while the switch `quick_route` is on (ExportDialog.tsx hands it over). It mounts when the dialog is open and
// idle and unmounts when the dialog closes or a render starts, so every value it keeps is for one opening of the dialog and none survives into the next.
//
// What is on screen is what Export sends: the three shown values come from the pure model (`resolveChoice`), and the click works them out again from the project as it is at that moment.
import { useEffect, useRef, useState } from "react";

import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { holdExportAsk } from "../timeline/exportAsk";
import {
  clampOverrides,
  payloadFor,
  projectFacts,
  qualityEntries,
  rateEntries,
  resolveChoice,
  sizeEntries,
  type Overrides,
} from "../timeline/exportChoiceView";
import { D2_WORDS } from "../timeline/exportChoiceWords";
import type { ExportResolution } from "../timeline/exportOptions";
import type { ProjectFacts } from "../timeline/exportRoute";
import type { RenderWorkload } from "../timeline/renderPlan";
import AdvancedSettings from "./AdvancedSettings";
import type { ExportSettings } from "./ExportDialog";
import ExportQueuePane from "./ExportQueuePane";
import { Field, ghostCls, primaryCls, selectCls } from "./exportFields";
import { useEncoderLook } from "./useEncoderLook";

export interface ExportSettingsViewProps {
  /** The open project's size, rate and layers as they were when the dialog opened (its length is the one the view reads; the chip row's size basis). Absent: no project, no chip row. */
  workload: RenderWorkload | null;
  /** Cancel: the dialog's own dismiss (Hide, never an abort), the same door as the Escape key. */
  onCancel: () => void;
  /** Export: the settings the person chose, handed over exactly as ExportDialog's own button hands them in 0.28.0. */
  onStart: (settings: ExportSettings) => void;
}

/** The project's facts: its canvas as it is now (all three numbers present), else the workload's size and rate; the length is always the workload's. */
function factsOf(
  width: number | undefined,
  height: number | undefined,
  fps: number | undefined,
  workload: RenderWorkload | null,
): ProjectFacts | null {
  const live = width !== undefined && height !== undefined && fps !== undefined;
  return projectFacts(live ? { width, height, fps } : workload, workload?.durationSeconds);
}

export default function ExportSettingsView({
  workload,
  onCancel,
  onStart,
}: ExportSettingsViewProps): JSX.Element {
  const [overrides, setOverrides] = useState<Overrides>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const latest = useRef(overrides);
  latest.current = overrides;

  const width = useEditor((s) => s.timeline?.canvas?.width);
  const height = useEditor((s) => s.timeline?.canvas?.height);
  const fps = useEditor((s) => s.timeline?.canvas?.fps);
  const facts = factsOf(width, height, fps, workload);
  const { shown } = resolveChoice("quality", overrides, facts);
  const look = useEncoderLook(workload, shown);

  // A pick the project no longer holds is dropped for good, so it does not come back if the project grows again.
  useEffect(() => {
    const kept = clampOverrides(overrides, factsOf(width, height, fps, workload));
    if (kept !== overrides) setOverrides(kept);
  }, [overrides, width, height, fps, workload]);

  const pick = (change: Overrides) => setOverrides((before) => ({ ...before, ...change }));

  const start = () => {
    holdExportAsk();
    useExportJob.getState().setModeRowOnScreen(false);
    const canvas = useEditor.getState().timeline?.canvas;
    const now = factsOf(canvas?.width, canvas?.height, canvas?.fps, workload);
    const sent = resolveChoice("quality", latest.current, now);
    onStart(
      payloadFor("quality", sent.shown, sent.kept, workload && look.offered ? null : "quality"),
    );
  };

  const sizes = sizeEntries(facts);

  return (
    <>
      <div className="mt-3 space-y-3">
        {sizes.length >= 2 && (
          <Field label={D2_WORDS.resolutionLabel}>
            <select
              aria-label={D2_WORDS.resolutionName}
              value={shown.resolution}
              onChange={(e) => pick({ resolution: e.target.value as ExportResolution })}
              className={selectCls}
            >
              {sizes.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <AdvancedSettings
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((before) => !before)}
          fasterLine={look.faster === null ? null : D2_WORDS.fasterSetting}
          rates={rateEntries(facts)}
          fps={shown.fps}
          onFps={(value) => pick({ fps: value })}
          qualities={qualityEntries()}
          quality={shown.quality}
          onQuality={(value) => pick({ quality: value })}
          chip={
            workload
              ? {
                  workload,
                  resolution: shown.resolution,
                  fps: shown.fps,
                  onChange: look.bumpChip,
                  onDrawn: look.onChipRowDrawn,
                }
              : null
          }
        />
      </div>

      <ExportQueuePane />

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={() => onCancel()} className={ghostCls}>
          {D2_WORDS.cancel}
        </button>
        <button type="button" onClick={start} className={primaryCls}>
          {D2_WORDS.exportAction}
        </button>
      </div>
    </>
  );
}
