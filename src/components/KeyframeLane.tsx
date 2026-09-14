// The keyframe lane: one row per animated property, diamonds on the clip's own timeline.
//
// other NLEs' `KeyframesLane` and Premiere's Effect Controls mini-timeline are the same shape, and
// both live in the inspector panel rather than under the clip. The lane spans the CLIP, 0 to its
// length, so it reads the same whatever the timeline zoom is doing.
//
// Every edit goes through `setKeyframe`, the one door the volume rubber band on the clip uses too
// — two editors of the same data with two commit paths is how they drift.
import { useCallback, useEffect, useRef, useState } from "react";

import { useEditor } from "../store/editor";
import { animPropsFor, readAnim, writeAnim } from "../timeline/animProps";
import { isAnimated } from "../timeline/keyframe";
import type { Clip, Keyframe } from "../timeline/model";
import { cn } from "./ui";

const EASES: { value: string; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "hold", label: "Hold (step)" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-out", label: "Ease out" },
  { value: "ease-in-out", label: "Ease in-out" },
];

/** Diamonds sit at a fraction of the lane's width; a lane with no length would stack them all
 *  at 0, so a degenerate clip shows an empty lane rather than a pile. */
const xOf = (t: number, dur: number) => (dur > 0 ? Math.min(1, Math.max(0, t / dur)) : 0);

export interface KeyframeLaneProps {
  clip: Clip;
  clipId: string;
  kind: string;
  /** Clip length in frames. */
  duration: number;
  /** Playhead, clip-relative frames. */
  relFrame: number;
  onSeek: (relFrame: number) => void;
}

export function KeyframeLane({
  clip,
  clipId,
  kind,
  duration,
  relFrame,
  onSeek,
}: KeyframeLaneProps): JSX.Element | null {
  const setKeyframe = useEditor((s) => s.setKeyframe);
  const setClipProperties = useEditor((s) => s.setClipProperties);
  const [menu, setMenu] = useState<{ path: string; t: number; x: number; y: number } | null>(null);

  // Only properties that actually carry keys get a row: an eight-row lane of empty tracks is
  // noise. The Inspector's stopwatch is how a property joins the lane.
  const rows = animPropsFor(kind)
    .map((p) => ({ prop: p, keys: readAnim(clip, p.path) }))
    .filter((r): r is { prop: (typeof r)["prop"]; keys: Keyframe[] } => isAnimated(r.keys));

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const setEase = useCallback(
    (path: string, t: number, ease: string) => {
      const cur = readAnim(clip, path);
      if (!isAnimated(cur)) return;
      const key = cur.find((k) => Number(k.t) === t);
      if (!key) return;
      void setKeyframe(clipId, path, t, Number(key.v), { fromT: t, ease });
      setMenu(null);
    },
    [clip, clipId, setKeyframe],
  );

  const removeKey = useCallback(
    (path: string, t: number) => {
      const cur = readAnim(clip, path);
      if (!isAnimated(cur)) return;
      const rest = cur.filter((k) => Number(k.t) !== t);
      // The last key is not a curve. Dropping it returns the property to a plain constant at that
      // value, which is what the stopwatch shows as "not animated".
      const next = rest.length ? rest : Number(cur[0]?.v ?? 0);
      void setClipProperties(clipId, writeAnim(clip, path, next));
      setMenu(null);
    },
    [clip, clipId, setClipProperties],
  );

  if (rows.length === 0) return null;

  return (
    <div className="border-b border-edge px-3 py-2" data-testid="keyframe-lane">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          Keyframes
        </span>
        <span className="text-[10px] text-neutral-600">right-click a key</span>
      </div>
      <div className="space-y-0.5">
        {rows.map(({ prop, keys }) => (
          <Row
            key={prop.path}
            label={prop.label}
            path={prop.path}
            keys={keys}
            duration={duration}
            relFrame={relFrame}
            onSeek={onSeek}
            onContext={(t, x, y) => setMenu({ path: prop.path, t, x, y })}
          />
        ))}
      </div>
      {menu && (
        <div
          role="menu"
          aria-label="keyframe options"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed z-[90] min-w-[150px] rounded-md border border-edge bg-neutral-900 py-1 text-xs shadow-xl"
        >
          {EASES.map((e) => (
            <button
              key={e.value}
              role="menuitem"
              onClick={() => setEase(menu.path, menu.t, e.value)}
              className="block w-full px-3 py-1 text-left text-neutral-200 hover:bg-accent/80 hover:text-white"
            >
              {e.label}
            </button>
          ))}
          <div className="my-1 h-px bg-edge" />
          <button
            role="menuitem"
            onClick={() => removeKey(menu.path, menu.t)}
            className="block w-full px-3 py-1 text-left text-red-400 hover:bg-red-500/10"
          >
            Delete keyframe
          </button>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  path,
  keys,
  duration,
  relFrame,
  onSeek,
  onContext,
}: {
  label: string;
  path: string;
  keys: Keyframe[];
  duration: number;
  relFrame: number;
  onSeek: (t: number) => void;
  onContext: (t: number, x: number, y: number) => void;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 truncate text-[10px] text-neutral-500" title={label}>
        {label}
      </span>
      <div
        ref={trackRef}
        role="group"
        aria-label={`${label} keyframes`}
        // Clicking the empty track SEEKS rather than adding a key: the Inspector's diamond adds
        // at the playhead, so the lane's job is navigation plus per-key editing.
        onPointerDown={(e) => {
          const r = trackRef.current?.getBoundingClientRect();
          if (!r || r.width <= 0) return;
          onSeek(Math.round(((e.clientX - r.x) / r.width) * duration));
        }}
        className="relative h-4 flex-1 cursor-pointer rounded-sm bg-neutral-800/60"
      >
        {/* The playhead, so a key's position reads against where you actually are. */}
        <div
          aria-hidden
          className="absolute top-0 h-full w-px bg-accent/70"
          style={{ left: `${xOf(relFrame, duration) * 100}%` }}
        />
        {keys.map((k) => {
          const t = Number(k.t) || 0;
          const held = k.ease === "hold";
          return (
            <button
              key={t}
              aria-label={`${label} keyframe at ${t}`}
              title={`frame ${t}${k.ease ? ` · ${k.ease}` : ""}`}
              data-ease={k.ease ?? "linear"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSeek(t)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContext(t, e.clientX, e.clientY);
              }}
              style={{ left: `${xOf(t, duration) * 100}%` }}
              className={cn(
                "absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 border border-neutral-900",
                // A held key is square: the shape says "steps here" without needing a legend.
                held ? "bg-amber-300" : "rotate-45 bg-neutral-200",
                Math.round(relFrame) === t && "ring-1 ring-accent",
              )}
            />
          );
        })}
      </div>
      <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-neutral-600">
        {keys.length}
      </span>
      <span className="sr-only">{path}</span>
    </div>
  );
}
