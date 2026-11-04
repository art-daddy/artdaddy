// The bar an export's progress is drawn with. One component for the Export dialog and the chat card, so
// the two cannot drift: the same fill, the same colours, the same way of saying "not known yet".
import { cn } from "./ui";

export default function ExportProgressBar({
  fraction,
  state = "running",
  label = "export progress",
}: {
  /** 0..1, or null while ffmpeg has not reported a position yet. */
  fraction: number | null;
  state?: "running" | "done" | "failed";
  label?: string;
}): JSX.Element {
  const done = state === "done";
  const known = fraction !== null && Number.isFinite(fraction);
  const pct = done ? 1 : known ? Math.min(1, Math.max(0, fraction)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      // Indeterminate until ffmpeg reports a position: an aria value of 0 would claim
      // "nothing has happened", which is a different statement from "not known yet".
      aria-valuenow={!known && !done ? undefined : Math.round(pct * 100)}
      className="h-1.5 w-full overflow-hidden rounded bg-neutral-800"
    >
      <div
        className={cn(
          "h-full transition-[width] duration-200",
          state === "failed" ? "bg-red-500" : done ? "bg-emerald-500" : "bg-accent",
          !known && !done && "animate-pulse",
        )}
        style={{ width: `${Math.round((!known && !done ? 0.06 : pct) * 100)}%` }}
      />
    </div>
  );
}
