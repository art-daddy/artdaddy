// The app's look at the encoder for the settings on screen, copied from the 0.28.0 dialog (ExportDialog.tsx) with the same meaning, so that what Quality sends is what 0.28.0 sends. It says whether
// the app has answered for exactly these settings (`offered`) and which line, if any, tells the person the faster setting will be used. The old Mode row is never drawn by the Quality / Fast
// view, so nothing here reads a pick of it.
import { useCallback, useEffect, useReducer, useState } from "react";

import { useExportJob } from "../store/exportJob";
import { decideExportEncoder, type ExportEncoderDecision } from "../timeline/exportChoice";
import type { Levers } from "../timeline/exportChoiceView";
import { describeModeLines, type ModeView } from "../timeline/exportWords";
import type { RenderWorkload } from "../timeline/renderPlan";

/** What is known of the Graphics chip row: nothing yet (its first look has not answered), drawn, not drawn since the settings were shown, or drawn and gone since (the person moved to a
 *  picture size the chip does not serve). */
export type ChipRowSeen = "unknown" | "drawn" | "absent" | "left";

export interface EncoderLook {
  /** The answer on screen is one the person has been offered: the app has answered for exactly these settings and this history, and it is not one that wants a row while the chip row
   *  has not answered yet (then it is treated like an answer that has not come, and the app does not choose for them). */
  offered: boolean;
  /** The line for the processor's faster setting, only where the app will use it. */
  faster: string | null;
  chipRow: ChipRowSeen;
  /** For the chip row's `onDrawn`. */
  onChipRowDrawn: (drawn: boolean) => void;
  /** For the chip row's `onChange`: the app is asked again. */
  bumpChip: () => void;
}

/** `levers` are the SHOWN values (what Export sends), so the app is asked about the export that will run. No workload: no ask. */
export function useEncoderLook(
  workload: RenderWorkload | null,
  { resolution, quality, fps }: Levers,
): EncoderLook {
  const [chipRow, setChipRow] = useState<ChipRowSeen>("unknown");
  const onChipRowDrawn = useCallback((drawn: boolean) => {
    setChipRow((before) =>
      drawn ? "drawn" : before === "drawn" || before === "left" ? "left" : "absent",
    );
  }, []);
  // Counts what the person changes about the graphics chip (its switch, Try it again now): the app's answer is asked again.
  const [chipEpoch, bumpChip] = useReducer((n: number) => n + 1, 0);
  // The answer is kept with what it was decided for (the settings, and the history of this PC's exports), so an answer to a question the settings or the history have since changed is not
  // taken for the one on screen, and one that has not come, or never will (the look failed), is not mistaken for "no row".
  const askedFor = `${resolution}|${quality}|${fps ?? ""}|${workload ? JSON.stringify(workload) : ""}|${chipEpoch}`;
  const calibrations = useExportJob((s) => s.calibrations);
  const [answer, setAnswer] = useState<{
    readonly for: string;
    readonly history: typeof calibrations;
    readonly decision: ExportEncoderDecision | null;
  } | null>(null);
  const decision = answer?.decision ?? null;
  const answered = answer !== null && answer.for === askedFor && answer.history === calibrations;

  const view: ModeView | null = decision
    ? {
        showRow: decision.showRow,
        defaultMode: decision.defaultMode,
        reason: decision.reason,
        faster: decision.faster === true,
        fullSeconds: decision.fullSeconds,
        fastSeconds: decision.fastSeconds,
      }
    : null;
  const lines = describeModeLines(view, null);
  const offered = answered && decision !== null && !(decision.showRow && chipRow === "unknown");

  // Asked as the settings are shown and whenever they change (a chip's test, if it has not been done on this PC yet, runs now, in the seconds the person spends choosing). A look: the test's
  // results are left for the export.
  useEffect(() => {
    if (!workload) {
      setAnswer(null);
      return;
    }
    let stale = false;
    void decideExportEncoder({
      request: "auto",
      workload,
      settings: { resolution, quality, fps },
      history: calibrations,
      preview: true,
      waitMs: Infinity,
    })
      .then((decided) => {
        if (!stale) setAnswer({ for: askedFor, history: calibrations, decision: decided });
      })
      .catch(() => {
        if (!stale) setAnswer({ for: askedFor, history: calibrations, decision: null });
      });
    return () => {
      stale = true;
    };
  }, [workload, resolution, quality, fps, calibrations, askedFor]);

  return { offered, faster: lines.faster, chipRow, onChipRowDrawn, bumpChip };
}
