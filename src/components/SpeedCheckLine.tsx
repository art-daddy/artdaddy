// The quiet line under the estimate that says what the PC's speed check found, and the one thing it offers: run it again. It says nothing where there is no check to talk about (never run, switched off, no check service)
// and while the check runs (the estimate line says that then).
import { CHECK_AGAIN_LABEL, describeCheckDay, describeSpeedCheck } from "../timeline/estimateWords";
import { checkThisPcAgain, type SpeedCheckView } from "./useSpeedCheck";

export default function SpeedCheckLine({ check }: { check: SpeedCheckView }): JSX.Element | null {
  if (!check.available || check.running) return null;
  const said = describeSpeedCheck(
    check.pcClass,
    check.madeAt === null ? "" : describeCheckDay(check.madeAt, Date.now()),
  );
  if (!said) return null;
  const tail = ` · ${CHECK_AGAIN_LABEL}`;
  const lead = said.endsWith(tail) ? said.slice(0, -tail.length) : said;
  return (
    <p data-testid="speed-check" className="text-[11px] leading-snug text-neutral-500">
      {lead} ·{" "}
      <button
        type="button"
        onClick={checkThisPcAgain}
        className="underline underline-offset-2 hover:text-neutral-300"
      >
        {CHECK_AGAIN_LABEL}
      </button>
    </p>
  );
}
