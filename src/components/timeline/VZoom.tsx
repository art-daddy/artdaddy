import { useCallback, useRef } from "react";

// A vertical zoom bar for one track group (video or audio) — same look as the
// horizontal zoom navigator (a grey track + draggable grey thumb). Drag up to
// grow the group's row height, down to shrink; double-click resets to 1x.
export function VZoom({
  icon,
  value,
  onChange,
  kind,
}: {
  icon: string;
  value: number;
  onChange: (v: number) => void;
  kind: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const frac = Math.min(1, Math.max(0, (value - 0.5) / 2.5)); // 0.5..3x -> 0..1 (top = biggest)
  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const apply = (clientY: number) => {
        const f = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / (rect.height || 1)));
        onChange(0.5 + f * 2.5);
      };
      apply(e.clientY);
      const move = (ev: PointerEvent) => apply(ev.clientY);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onChange],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-1">
      <span className="pointer-events-none text-[10px] leading-none">{icon}</span>
      <div
        ref={barRef}
        role="slider"
        aria-label={`${kind} track height`}
        aria-valuenow={Math.round(value * 100)}
        title={`${kind} track height (double-click to reset)`}
        onPointerDown={startDrag}
        onDoubleClick={() => onChange(1)}
        className="group relative w-3 min-h-0 flex-1 cursor-grab rounded bg-neutral-800/60"
      >
        <div
          className="pointer-events-none absolute inset-x-0 h-5 -translate-y-1/2 rounded bg-neutral-600/80 group-hover:bg-neutral-500"
          style={{ top: `${(1 - frac) * 100}%` }}
        >
          <span className="absolute inset-x-0 top-0 h-1.5 rounded-t bg-neutral-300/80" />
          <span className="absolute inset-x-0 bottom-0 h-1.5 rounded-b bg-neutral-300/80" />
        </div>
      </div>
    </div>
  );
}
