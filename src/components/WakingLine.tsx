import { Spinner } from "./ui";
import { clockText } from "./waitStatus";
import type { WakingLine as Line } from "./waking";

/** The plain line the launch screens show while the server is waking: what is happening, for how long it can last, that nothing is wrong. */
export default function WakingLine({
  line,
  className = "mt-4",
}: {
  line: Line;
  className?: string;
}) {
  return (
    <div className={`${className} flex flex-col items-center gap-0.5 text-xs`}>
      <div className="flex items-center gap-2">
        <Spinner />
        <span role="status" className="shimmer">
          {line.label}…
        </span>
        <span aria-hidden className="tabular-nums text-neutral-500">
          {clockText(line.elapsedS)}
        </span>
      </div>
      <p className="max-w-[270px] text-[11px] leading-snug text-neutral-500">{line.hint}</p>
    </div>
  );
}
