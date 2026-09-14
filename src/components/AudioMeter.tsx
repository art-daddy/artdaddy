// A stereo peak meter. Two bars, a held peak tick, and a clip indicator you clear by clicking.
//
// The bars are written straight to the DOM from the pump's callback. Driving them through React
// state would be 60 renders a second per meter, which is the exact re-render storm that made the
// Inspector's sliders freeze mid-drag (S15) — a performance widget that causes jank is worse
// than no widget.
import { useCallback, useEffect, useRef } from "react";

import { CLIP_THRESHOLD, meterFraction } from "../preview/meter";
import { clearClipIndicators, subscribeMeter, type StereoMeter } from "../preview/meterPump";
import { cn } from "./ui";

export interface AudioMeterProps {
  /** Track id, or MASTER from meterPump. */
  channel: string;
  label: string;
  /** Horizontal reads better in a track header; vertical next to a preview. */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

export function AudioMeter({
  channel,
  label,
  orientation = "vertical",
  className,
}: AudioMeterProps): JSX.Element {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const leftPeakRef = useRef<HTMLDivElement>(null);
  const rightPeakRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLButtonElement>(null);
  const vertical = orientation === "vertical";

  useEffect(() => {
    const size = (el: HTMLDivElement | null, frac: number) => {
      if (!el) return;
      const pct = `${(frac * 100).toFixed(1)}%`;
      if (vertical) el.style.height = pct;
      else el.style.width = pct;
    };
    const mark = (el: HTMLDivElement | null, frac: number) => {
      if (!el) return;
      const pct = `${(frac * 100).toFixed(1)}%`;
      el.style.opacity = frac > 0 ? "1" : "0";
      if (vertical) el.style.bottom = pct;
      else el.style.left = pct;
    };
    const paint = (m: StereoMeter) => {
      size(leftRef.current, meterFraction(m.left.db));
      size(rightRef.current, meterFraction(m.right.db));
      mark(leftPeakRef.current, meterFraction(m.left.peakDb));
      mark(rightPeakRef.current, meterFraction(m.right.peakDb));
      const clipped = m.left.clipped || m.right.clipped;
      const el = clipRef.current;
      if (el) {
        el.dataset.clipped = clipped ? "true" : "false";
        el.style.opacity = clipped ? "1" : "0.25";
      }
    };
    return subscribeMeter(channel, paint);
  }, [channel, vertical]);

  const bar = (
    fill: React.RefObject<HTMLDivElement>,
    peak: React.RefObject<HTMLDivElement>,
    side: string,
  ) => (
    <div
      role="meter"
      aria-label={`${label} ${side}`}
      className={cn(
        "relative overflow-hidden rounded-[1px] bg-neutral-800",
        vertical ? "h-full w-1.5" : "h-1.5 w-full",
      )}
    >
      <div
        ref={fill}
        // Green under -18dB, amber approaching 0: the gradient is the scale, so the bar reads
        // as "how close to clipping" without needing tick labels next to it.
        className={cn(
          "absolute bg-gradient-to-t from-emerald-500 via-emerald-400 to-amber-400",
          vertical ? "bottom-0 left-0 w-full" : "bottom-0 left-0 h-full bg-gradient-to-r",
        )}
        style={vertical ? { height: "0%" } : { width: "0%" }}
      />
      <div
        ref={peak}
        aria-hidden
        className={cn(
          "absolute bg-neutral-200",
          vertical ? "left-0 h-px w-full" : "top-0 h-full w-px",
        )}
        style={{ opacity: 0, ...(vertical ? { bottom: "0%" } : { left: "0%" }) }}
      />
    </div>
  );

  return (
    <div
      aria-label={label}
      className={cn("flex items-stretch gap-0.5", vertical ? "flex-row" : "flex-col", className)}
    >
      {bar(leftRef, leftPeakRef, "left")}
      {bar(rightRef, rightPeakRef, "right")}
      <button
        ref={clipRef}
        type="button"
        onClick={useCallback(() => clearClipIndicators(), [])}
        aria-label={`${label} clip indicator`}
        title={`Clipping over ${CLIP_THRESHOLD} — click to reset`}
        data-clipped="false"
        style={{ opacity: 0.25 }}
        className={cn(
          "shrink-0 rounded-[1px] bg-red-500",
          vertical ? "h-1 w-1.5 self-start" : "h-1.5 w-1",
        )}
      />
    </div>
  );
}
