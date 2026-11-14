// The slow-export banner, as the chat card and the Export dialog show it: what the view-model says while a render is going much slower than it was said to, or has stopped moving, and the buttons that go with it. It draws the
// view and answers the buttons; what to say and when is the view-model's, and what the person has already answered is kept by the exporter's watch.
import { useState } from "react";

import type { HelpView } from "../timeline/exportHelp";
import type { KeepGoingResult } from "../timeline/exportHelpWatch";
import { BANNER_BUTTON_LABELS, KEEP_GOING_NOTE, type BannerButton } from "../timeline/routeWords";
import { cn } from "./ui";

const quiet = "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800";
const primary =
  "rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-white";

export interface SlowBannerProps {
  view: HelpView;
  /** The person already said keep going and no banner is up: one quiet line says so. */
  keptGoing?: boolean;
  /** Keep going was pressed. An answer that refuses it (the export is already finishing or has ended) is said in a line of its own. */
  onKeepGoing: () => KeepGoingResult | void;
  onCancel: () => void;
  /** Starts the export again as a Quick export. Without it the button is not drawn, whatever the view says. */
  onSwitchToQuick?: () => void;
}

export default function SlowBanner({
  view,
  keptGoing = false,
  onKeepGoing,
  onCancel,
  onSwitchToQuick,
}: SlowBannerProps): JSX.Element | null {
  const [refusal, setRefusal] = useState<string | null>(null);
  if (view.kind === "none")
    return keptGoing ? (
      <div data-testid="slow-banner-kept" className="mt-0.5 text-[11px] text-neutral-500">
        {KEEP_GOING_NOTE}
      </div>
    ) : null;

  const [headline, ...rest] = view.lines;
  const press = (button: BannerButton): void => {
    if (button === "cancel") return onCancel();
    if (button === "switch_to_quick") return onSwitchToQuick?.();
    try {
      const answer = onKeepGoing();
      if (answer && answer.ok === false) setRefusal(answer.line);
    } catch {
      // the banner is advice: a click it cannot take is not worth a failure on screen
    }
  };
  const buttons = view.buttons.filter(
    (button) =>
      (button !== "switch_to_quick" || onSwitchToQuick !== undefined) &&
      (refusal === null || button === "cancel"),
  );
  return (
    <div
      role="group"
      aria-label={view.kind === "slow" ? "slow export" : "export stopped moving"}
      data-testid="slow-banner"
      className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
    >
      <div className="font-medium text-neutral-100">{headline}</div>
      {rest.map((line, index) => (
        <div key={index} className="mt-0.5 text-neutral-300">
          {line}
        </div>
      ))}
      {refusal !== null && <div className="mt-1.5 text-amber-300">{refusal}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {buttons.map((button) => (
          <button
            key={button}
            type="button"
            onClick={() => press(button)}
            className={cn(
              button === "switch_to_quick" ? primary : quiet,
              button === "cancel" && "hover:text-red-400",
            )}
          >
            {BANNER_BUTTON_LABELS[button]}
          </button>
        ))}
      </div>
    </div>
  );
}
