// Premiere-style numeric field: drag horizontally to scrub the value, or click
// to type. Pointer/commit math is simple and covered by tests; the drag uses
// window listeners so it keeps tracking outside the element.
//
// A drag commits ONCE, on release. TimelineSession.apply pushes an undo entry per call,
// so committing per pointermove buried the pre-drag state under one entry per pixel and
// made Ctrl+Z useless after touching a slider. The displayed number tracks the pointer
// from local state meanwhile, so it still feels live.
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "./ui";

export interface ScrubInputProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  suffix?: string;
  className?: string;
  "aria-label"?: string;
}

function clamp(v: number, min?: number, max?: number): number {
  if (min != null) v = Math.max(min, v);
  if (max != null) v = Math.min(max, v);
  return v;
}

export function ScrubInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  precision = 0,
  suffix = "",
  className,
  ...rest
}: ScrubInputProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onMoveRef = useRef<(e: PointerEvent) => void>();
  const onUpRef = useRef<() => void>();
  const winMove = useRef((e: PointerEvent) => onMoveRef.current?.(e)).current;
  const winUp = useRef(() => onUpRef.current?.()).current;

  const commit = useCallback(
    (v: number) => onChange(clamp(Number.isFinite(v) ? v : value, min, max)),
    [onChange, value, min, max],
  );

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 2) d.moved = true;
      setLive(clamp(d.start + dx * step, min, max));
    },
    [step, min, max],
  );
  const onUp = useCallback(() => {
    const d = drag.current;
    window.removeEventListener("pointermove", winMove);
    window.removeEventListener("pointerup", winUp);
    drag.current = null;
    setLive((pending) => {
      if (d?.moved && pending !== null) commit(pending);
      return null;
    });
    if (d && !d.moved) {
      setText(String(value));
      setEditing(true);
    }
  }, [winMove, winUp, value, commit]);

  // The window listeners are STABLE and dispatch to the latest handler through refs. Attaching
  // `onMove`/`onUp` directly meant every parent re-render gave them a new identity (the Inspector
  // passes an inline `onChange`), and the cleanup keyed on that identity tore the listeners off
  // MID-DRAG: the slider moved a few pixels and then froze. Same fix, and the same reason, as
  // TimelineEditor's scrub and StageOverlay's gestures.
  onMoveRef.current = onMove;
  onUpRef.current = onUp;

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", winMove);
      window.removeEventListener("pointerup", winUp);
    },
    [winMove, winUp],
  );
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          commit(parseFloat(text));
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(parseFloat(text));
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className={cn(
          "w-full rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-100 outline-none ring-1 ring-accent",
          className,
        )}
        {...rest}
      />
    );
  }
  return (
    <div
      role="spinbutton"
      aria-valuenow={live ?? value}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { x: e.clientX, start: value, moved: false };
        window.addEventListener("pointermove", winMove);
        window.addEventListener("pointerup", winUp);
      }}
      className={cn(
        "cursor-ew-resize select-none rounded bg-neutral-800 px-1.5 py-0.5 text-xs tabular-nums text-neutral-200 hover:bg-neutral-700",
        className,
      )}
      {...rest}
    >
      {(live ?? value).toFixed(precision)}
      {suffix}
    </div>
  );
}
