// The settings view of the Export dialog (design D2), drawn instead of the 0.28.0 one while the switch `quick_route` is on (ExportDialog.tsx hands it over). It mounts when the dialog is open and
// idle and unmounts when the dialog closes or a render starts, so every value it keeps is for one opening of the dialog and none survives into the next: Quality is the choice at every opening, and Fast
// is only ever picked by the person.
//
// What is on screen is what Export sends: the three shown values come from the pure model (`resolveChoice`), and the click works them out again from the project as it is at that moment.
import { useEffect, useRef, useState } from "react";

import { useEditor } from "../store/editor";
import { useExportJob } from "../store/exportJob";
import { holdExportAsk } from "../timeline/exportAsk";
import {
  clampOverrides,
  FAST_CHOICE_OFFERED,
  payloadFor,
  projectFacts,
  qualityEntries,
  rateEntriesFor,
  resolveChoice,
  sizeEntries,
  summaryFor,
  type Choice,
  type Overrides,
} from "../timeline/exportChoiceView";
import { D2_WORDS } from "../timeline/exportChoiceWords";
import type { ExportResolution } from "../timeline/exportOptions";
import type { ProjectFacts } from "../timeline/exportRoute";
import type { RenderWorkload } from "../timeline/renderPlan";
import AdvancedSettings from "./AdvancedSettings";
import ChoiceRow from "./ChoiceRow";
import type { ExportSettings } from "./ExportDialog";
import ExportQueuePane from "./ExportQueuePane";
import { Field, ghostCls, primaryCls, selectCls } from "./exportFields";
import { useEncoderLook } from "./useEncoderLook";

export interface ExportSettingsViewProps {
  /** The open project's size, rate and layers as they were when the dialog opened (its length is the one the view reads; the chip row's size basis). Absent: no project, no chip row. */
  workload: RenderWorkload | null;
  /** Cancel: the dialog's own dismiss (Hide, never an abort), the same door as the Escape key. */
  onCancel: () => void;
  /** Export: the settings the person chose, handed over exactly as ExportDialog's own button hands them in 0.28.0 (Fast adds the `route`). */
  onStart: (settings: ExportSettings) => void;
  /** Whether the Quality | Fast row and the line under the door are drawn (`FAST_CHOICE_OFFERED`). False: Quality alone, the view as it was before Fast was wired. */
  fastChoice?: boolean;
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
  fastChoice = FAST_CHOICE_OFFERED,
}: ExportSettingsViewProps): JSX.Element {
  const [picked, setPicked] = useState<Choice>("quality");
  const [overrides, setOverrides] = useState<Overrides>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Without the row the choice is Quality and nothing can change it.
  const choice: Choice = fastChoice ? picked : "quality";
  const latest = useRef({ choice, overrides });
  latest.current = { choice, overrides };
  // The choice row's tooltip belongs to a figure on Fast, and Fast shows none: nothing here asks it to close.
  const tipRef = useRef<(() => boolean) | null>(null);

  const width = useEditor((s) => s.timeline?.canvas?.width);
  const height = useEditor((s) => s.timeline?.canvas?.height);
  const fps = useEditor((s) => s.timeline?.canvas?.fps);
  const facts = factsOf(width, height, fps, workload);
  const { shown } = resolveChoice(choice, overrides, facts);
  const look = useEncoderLook(workload, shown);

  // A pick the project no longer holds is dropped for good, so it does not come back if the project grows again.
  useEffect(() => {
    const kept = clampOverrides(overrides, factsOf(width, height, fps, workload));
    if (kept !== overrides) setOverrides(kept);
  }, [overrides, width, height, fps, workload]);

  const pick = (change: Overrides) => setOverrides((before) => ({ ...before, ...change }));
  // Picking a choice puts that choice's own values back, the one already picked included.
  const pickChoice = (next: Choice) => {
    setPicked(next);
    setOverrides({});
  };

  const start = () => {
    holdExportAsk();
    useExportJob.getState().setModeRowOnScreen(false);
    const canvas = useEditor.getState().timeline?.canvas;
    const now = factsOf(canvas?.width, canvas?.height, canvas?.fps, workload);
    const { choice: chosen, overrides: set } = latest.current;
    const sent = resolveChoice(chosen, set, now);
    onStart(payloadFor(chosen, sent.shown, sent.kept, workload && look.offered ? null : "quality"));
  };

  const sizes = sizeEntries(facts);

  return (
    <>
      <div className="mt-3 space-y-3">
        {fastChoice && (
          <ChoiceRow choice={choice} figure={null} onPick={pickChoice} closeTip={tipRef} />
        )}
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
          summary={fastChoice ? summaryFor(shown, facts) : null}
          fasterLine={
            choice === "quality" && look.faster !== null ? D2_WORDS.lightCompressionLine : null
          }
          rates={rateEntriesFor(facts, fastChoice)}
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
