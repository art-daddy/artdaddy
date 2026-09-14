// Direct manipulation on the preview stage — drag a clip to move it, its corners to
// scale it, its edges (in crop mode) to crop it.
//
// A DOM layer over the canvas rather than something drawn inside it: the composite lives
// in a Worker-owned OffscreenCanvas, so handles have to be real elements anyway, and this
// way they stay crisp and hit-testable for free.
//
// GESTURE MODEL (matches TimelineEditor's clip drag, not the Inspector's sliders): the
// outline follows the pointer from local state and NOTHING is written until pointerup,
// which then makes exactly ONE setClipProperties call. TimelineSession.apply pushes an
// undo entry per call, so committing per pointermove would bury the previous state under
// a hundred of them.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useEditor } from "../store/editor";
import { isAnimated, upsertKeyframe } from "../timeline/keyframe";
import { clipKind } from "../timeline/helpers";
import { boxShrinkFactor } from "../timeline/magnification";
import type { Animatable, Clip, Crop, Timeline } from "../timeline/model";
import { resolveFit } from "../timeline/renderPlan";
import { assetDims, assetDimsVersion, subscribeAssetDims } from "../preview/assetDims";
import {
  angleFromCentre,
  canvasRectInView,
  clampedRect,
  croppedFractions,
  growBox,
  handleOrigin,
  handlePositions,
  hitTest,
  movedBox,
  normBoxToView,
  pictureBoxOf,
  resizedBox,
  rotationHandlePoint,
  snapDegrees,
  viewDeltaToNorm,
  type Corner,
  type CropEdge,
  type NormBox,
} from "../preview/stageGeometry";
import type { Rect } from "../preview/scene";
import { cn } from "./ui";

const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
const EDGES: CropEdge[] = ["left", "right", "top", "bottom"];
const SNAP_PX = 8;
const HANDLE_PX = 10;
/** How far beyond the top edge the rotate knob sits, and how close to a 15° stop it snaps. */
const ROTATE_ARM_PX = 22;
const ROTATE_SNAP_STEP = 15;
const ROTATE_SNAP_TOL = 4;

type Gesture =
  | { kind: "move"; startBox: NormBox }
  | { kind: "scale"; corner: Corner; startBox: NormBox }
  | { kind: "rotate"; startDeg: number; grabDeg: number }
  | { kind: "crop"; edge: CropEdge; startCrop: Crop | undefined };
/** `shrink` is captured at pointerdown: the gesture runs in PICTURE space (what the user
 *  sees and grabs) and converts back to a transform box to commit. */
type ActiveGesture = Gesture & { x: number; y: number; shrink: { sw: number; sh: number } };

/** Visible, transformable clips at `frame`, topmost last. Audio has no picture and text
 *  is positioned by its own layout, so neither is grabbable here. */
function stageClips(timeline: Timeline | null, frame: number): { clip: Clip; z: number }[] {
  const out: { clip: Clip; z: number }[] = [];
  for (const track of timeline?.tracks ?? []) {
    const kind = String(track.kind ?? "video");
    if (kind === "audio" || kind === "text") continue;
    for (const clip of track.clips ?? []) {
      const k = clipKind(clip);
      if (k !== "image" && k !== "video") continue;
      const tin = Number(clip.timeline_in) || 0;
      const tout = Number(clip.timeline_out) || 0;
      if (frame < tin || frame >= tout) continue;
      out.push({ clip, z: Number(track.z) || 0 });
    }
  }
  return out;
}

function writeAnim(cur: Animatable | undefined, next: number, relFrame: number): Animatable {
  // Animated -> stamp a key at the playhead; static -> plain value. Mirrors KeyframeField,
  // so dragging on the canvas can never silently flatten an animation the user built.
  return isAnimated(cur) ? upsertKeyframe(cur, relFrame, next) : next;
}

export default function StageOverlay({ cropMode = false }: { cropMode?: boolean }) {
  const timeline = useEditor((s) => s.timeline);
  const playhead = useEditor((s) => s.playhead);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const setClipProperties = useEditor((s) => s.setClipProperties);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);

  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [ghost, setGhost] = useState<NormBox | null>(null);
  const [ghostDeg, setGhostDeg] = useState<number | null>(null);
  const [guides, setGuides] = useState({ x: false, y: false });
  const gestureRef = useRef<ActiveGesture | null>(null);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setView({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fps = Number(timeline?.canvas?.fps) || 30;
  const frame = Math.round(playhead * fps);
  const canvasW = Number(timeline?.canvas?.width) || 1;
  const canvasH = Number(timeline?.canvas?.height) || 1;
  const canvasRect: Rect = canvasRectInView(view.w, view.h, canvasW, canvasH);
  // Re-render when the compositor learns an asset's real size — the picture box, and so
  // every handle position, depends on it.
  useSyncExternalStore(subscribeAssetDims, assetDimsVersion, assetDimsVersion);
  const visible = stageClips(timeline, frame);
  /** Where a clip's PICTURE lands, asked of the compositor's own layout rule. */
  const pictureOf = useCallback(
    (clip: Clip) =>
      pictureBoxOf(
        clip,
        frame - (Number(clip.timeline_in) || 0),
        canvasW,
        canvasH,
        assetDims(typeof clip.media_ref === "string" ? clip.media_ref : undefined),
      ),
    [frame, canvasW, canvasH],
  );
  const selected = visible.find((v) => v.clip.id === selection)?.clip ?? null;
  const relFrame = selected ? frame - (Number(selected.timeline_in) || 0) : 0;
  const live = selected ? pictureOf(selected) : null;
  const shownBox = ghost ?? live?.pic ?? null;
  const rect = shownBox ? normBoxToView(shownBox, canvasRect) : null;
  // ONE clamped shape for the outline, the corner handles and the crop handles. They used
  // to clamp differently, which is what detached the dots from the lines.
  const shape = rect ? clampedRect(rect, canvasRect) : null;
  // The angle the user is LOOKING at: the drag's ghost while rotating, else the document's.
  const shownRad = ghostDeg !== null ? (ghostDeg * Math.PI) / 180 : (live?.box.rotate ?? 0);
  const clampPoint = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(p.x, canvasRect.x), canvasRect.x + canvasRect.w),
    y: Math.min(Math.max(p.y, canvasRect.y), canvasRect.y + canvasRect.h),
  });

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const host = hostRef.current?.getBoundingClientRect();
    return { x: e.clientX - (host?.left ?? 0), y: e.clientY - (host?.top ?? 0) };
  }, []);

  // Click empty space (or an unselected clip) -> select what is under the pointer.
  const onBackgroundDown = useCallback(
    (e: React.PointerEvent) => {
      const p = localPoint(e);
      const entries = visible.map((v) => ({
        id: v.clip.id as string,
        z: v.z,
        rect: normBoxToView(pictureOf(v.clip).pic, canvasRect),
      }));
      const hit = hitTest(entries, p.x, p.y);
      select(hit ? hit.id : null);
    },
    [visible, canvasRect, localPoint, pictureOf, select],
  );

  const commit = useCallback(
    async (g: ActiveGesture, pic: NormBox | null, crop: Crop | null, deg?: number) => {
      if (!selected?.id) return;
      const id = String(selected.id);
      if (g.kind === "crop" && crop) {
        await setClipProperties(id, { crop });
        return;
      }
      if (g.kind === "rotate") {
        // `rotate` is a clip property, not part of the transform box — same field the agent
        // and the Inspector write, and the same one the exporter compiles.
        await setClipProperties(id, { rotate: writeAnim(selected.rotate, deg ?? 0, relFrame) });
        return;
      }
      if (!pic) return;
      // The gesture moved the PICTURE; `transform` describes the box it sits in.
      const box = growBox(pic, g.shrink);
      const t = selected.transform ?? {};
      const props: Record<string, unknown> = {
        transform: {
          ...t,
          position: {
            ...(t.position ?? {}),
            x: writeAnim(t.position?.x, box.cx, relFrame),
            y: writeAnim(t.position?.y, box.cy, relFrame),
          },
          ...(g.kind === "scale"
            ? {
                scale_x: writeAnim(t.scale_x ?? t.scale, box.w, relFrame),
                scale_y: writeAnim(t.scale_y ?? t.scale, box.h, relFrame),
              }
            : {}),
        },
      };
      await setClipProperties(id, props);
    },
    [selected, relFrame, setClipProperties],
  );

  // Window listeners so a fast drag that leaves the stage still tracks and still commits.
  // They attach in `start` and call the LATEST handler through refs — a re-render mid-drag
  // would otherwise swap the function identity and detach them (the bug TimelineEditor
  // already documents for its own scrub).
  const onMoveRef = useRef<(e: PointerEvent) => void>();
  const onUpRef = useRef<(e: PointerEvent) => void>();
  const winMove = useRef((e: PointerEvent) => onMoveRef.current?.(e)).current;
  const winUp = useRef((e: PointerEvent) => onUpRef.current?.(e)).current;

  const aspectOf = useCallback(
    () => (live && live.pic.h > 0 ? live.pic.w / live.pic.h : undefined),
    [live],
  );
  const snapNorm = canvasRect.w > 0 ? SNAP_PX / canvasRect.w : 0;

  /** Stop a resize ghost at the zoom the source can actually carry — the SAME bound the commit
   *  enforces, so the drag rails there instead of snapping back after the write. Shrinks about the
   *  corner `resizedBox` holds still, or the clip would slide away as it railed. */
  const railPic = useCallback(
    (pic: NormBox, corner: Corner, shrink: { sw: number; sh: number }): NormBox => {
      if (!selected) return pic;
      const box = growBox(pic, shrink);
      const k = boxShrinkFactor(
        { w: box.w * canvasW, h: box.h * canvasH },
        assetDims(typeof selected.media_ref === "string" ? selected.media_ref : undefined),
        resolveFit(selected.fit),
      );
      if (k >= 1) return pic;
      const holdsRight = corner === "tl" || corner === "bl";
      const holdsBottom = corner === "tl" || corner === "tr";
      const ax = holdsRight ? pic.cx + pic.w / 2 : pic.cx - pic.w / 2;
      const ay = holdsBottom ? pic.cy + pic.h / 2 : pic.cy - pic.h / 2;
      const w = pic.w * k;
      const h = pic.h * k;
      return {
        ...pic,
        w,
        h,
        cx: holdsRight ? ax - w / 2 : ax + w / 2,
        cy: holdsBottom ? ay - h / 2 : ay + h / 2,
      };
    },
    [selected, canvasW, canvasH],
  );

  /** Degrees for a rotate gesture with the pointer at `p`. ONE function, so the ghost the user
   *  drags and the value that gets written cannot disagree — the drag carries the offset between
   *  where they grabbed and where the knob was, so the clip does not jump on the first pixel. */
  const rotateFrom = useCallback(
    (g: { startDeg: number; grabDeg: number }, p: { x: number; y: number }): number => {
      if (!rect) return g.startDeg;
      const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const raw = g.startDeg + (angleFromCentre(centre, p) - g.grabDeg);
      return snapDegrees(raw, ROTATE_SNAP_STEP, ROTATE_SNAP_TOL);
    },
    [rect],
  );

  onMoveRef.current = (e: PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const p = localPoint(e);
    const d = viewDeltaToNorm(p.x - g.x, p.y - g.y, canvasRect);
    if (g.kind === "move") {
      const r = movedBox(g.startBox, d.dx, d.dy, snapNorm);
      setGhost(r.box);
      setGuides({ x: r.guideX, y: r.guideY });
    } else if (g.kind === "scale") {
      setGhost(
        railPic(
          resizedBox(g.startBox, g.corner, d.dx, d.dy, { aspect: aspectOf() }),
          g.corner,
          g.shrink,
        ),
      );
    } else if (g.kind === "rotate" && rect) {
      setGhostDeg(rotateFrom(g, p));
    }
  };

  onUpRef.current = (e: PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    window.removeEventListener("pointermove", winMove);
    window.removeEventListener("pointerup", winUp);
    setGuides({ x: false, y: false });
    if (!g) return;
    const p = localPoint(e);
    const d = viewDeltaToNorm(p.x - g.x, p.y - g.y, canvasRect);
    const finish = () => {
      setGhost(null);
      setGhostDeg(null);
      endGesture();
    };
    // A click that never moved is a selection, not an edit — no write, no undo entry.
    if (Math.abs(p.x - g.x) <= 1 && Math.abs(p.y - g.y) <= 1) {
      finish();
      return;
    }
    if (g.kind === "crop") {
      const along = g.edge === "left" || g.edge === "right" ? d.dx : d.dy;
      void commit(g, null, croppedFractions(g.startCrop, g.edge, along)).finally(finish);
      return;
    }
    if (g.kind === "rotate") {
      void commit(g, null, null, rotateFrom(g, p)).finally(finish);
      return;
    }
    const box =
      g.kind === "move"
        ? movedBox(g.startBox, d.dx, d.dy, snapNorm).box
        : railPic(
            resizedBox(g.startBox, g.corner, d.dx, d.dy, { aspect: aspectOf() }),
            g.corner,
            g.shrink,
          );
    void commit(g, box, null).finally(finish);
  };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", winMove);
      window.removeEventListener("pointerup", winUp);
    },
    [winMove, winUp],
  );

  const start = useCallback(
    (g: Gesture, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const p = localPoint(e);
      gestureRef.current = { ...g, x: p.x, y: p.y, shrink: live?.shrink ?? { sw: 1, sh: 1 } };
      beginGesture();
      setGhost(null);
      window.addEventListener("pointermove", winMove);
      window.addEventListener("pointerup", winUp);
    },
    [localPoint, beginGesture, winMove, winUp, live],
  );

  if (!timeline) return <div ref={hostRef} className="absolute inset-0" />;

  return (
    <div
      ref={hostRef}
      data-testid="stage-overlay"
      className="absolute inset-0"
      onPointerDown={onBackgroundDown}
    >
      {guides.x && rect && (
        <div
          className="pointer-events-none absolute w-px bg-amber-400/70"
          style={{ left: canvasRect.x + canvasRect.w / 2, top: canvasRect.y, height: canvasRect.h }}
        />
      )}
      {guides.y && rect && (
        <div
          className="pointer-events-none absolute h-px bg-amber-400/70"
          style={{ left: canvasRect.x, top: canvasRect.y + canvasRect.h / 2, width: canvasRect.w }}
        />
      )}
      {selected && shape && (
        <div
          data-testid="stage-box"
          data-clip-id={String(selected.id)}
          data-rotate={((shownRad * 180) / Math.PI).toFixed(2)}
          className={cn(
            "absolute border",
            cropMode ? "border-amber-400" : "border-accent",
            ghost ? "border-dashed" : "",
            // Rotated, the axis-aligned div is only the DRAG TARGET; the polygon below traces
            // the picture. Two visible rectangles disagreeing is exactly the bug this file
            // exists to avoid, so only one of them is ever drawn.
            shownRad !== 0 ? "border-transparent" : "",
          )}
          style={{ left: shape.x, top: shape.y, width: shape.w, height: shape.h }}
          onPointerDown={(e) => !cropMode && live && start({ kind: "move", startBox: live.pic }, e)}
        >
          {cropMode &&
            EDGES.map((edge) => (
              <div
                key={edge}
                data-testid={`stage-crop-${edge}`}
                aria-label={`crop ${edge}`}
                className="absolute bg-amber-400"
                style={{
                  left: edge === "left" ? -3 : edge === "right" ? undefined : "25%",
                  right: edge === "right" ? -3 : undefined,
                  top: edge === "top" ? -3 : edge === "bottom" ? undefined : "25%",
                  bottom: edge === "bottom" ? -3 : undefined,
                  width: edge === "left" || edge === "right" ? 6 : "50%",
                  height: edge === "top" || edge === "bottom" ? 6 : "50%",
                  cursor: edge === "left" || edge === "right" ? "ew-resize" : "ns-resize",
                }}
                onPointerDown={(e) => start({ kind: "crop", edge, startCrop: selected.crop }, e)}
              />
            ))}
        </div>
      )}
      {/* The rotated outline: a polygon through the very points the handles are drawn at, so
          the lines and the dots are the same four corners by construction. */}
      {selected && rect && shownRad !== 0 && (
        <svg
          data-testid="stage-outline"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <polygon
            points={(() => {
              const p = handlePositions(rect, canvasRect, shownRad);
              return [p.tl, p.tr, p.br, p.bl].map((q) => `${q.x},${q.y}`).join(" ");
            })()}
            className={cn("fill-none", cropMode ? "stroke-amber-400" : "stroke-accent")}
            strokeWidth={1}
            strokeDasharray={ghost || ghostDeg !== null ? "4 3" : undefined}
          />
        </svg>
      )}
      {/* Corners of the SAME shape as the outline (handlePositions clamps the ROTATED corners),
          so a handle can never detach from the box it belongs to. Only the handle's own box is
          nudged inward, so a frame-filling clip still outlines the frame. */}
      {selected &&
        rect &&
        live &&
        !cropMode &&
        (() => {
          const pts = handlePositions(rect, canvasRect, shownRad);
          const knob = handleOrigin(
            clampPoint(rotationHandlePoint(rect, shownRad, ROTATE_ARM_PX)),
            canvasRect,
            HANDLE_PX,
          );
          return (
            <>
              {CORNERS.map((corner) => {
                const o = handleOrigin(pts[corner], canvasRect, HANDLE_PX);
                return (
                  <div
                    key={corner}
                    data-testid={`stage-handle-${corner}`}
                    aria-label={`scale ${corner}`}
                    className="absolute bg-accent"
                    style={{
                      left: o.x,
                      top: o.y,
                      width: HANDLE_PX,
                      height: HANDLE_PX,
                      cursor: corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize",
                    }}
                    onPointerDown={(e) => start({ kind: "scale", corner, startBox: live.pic }, e)}
                  />
                );
              })}
              <div
                data-testid="stage-handle-rotate"
                aria-label="rotate"
                title="Drag to rotate — snaps every 15°"
                className="absolute rounded-full border border-white bg-accent"
                style={{ left: knob.x, top: knob.y, width: HANDLE_PX, height: HANDLE_PX }}
                onPointerDown={(e) => {
                  const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
                  start(
                    {
                      kind: "rotate",
                      startDeg: (live.box.rotate * 180) / Math.PI,
                      grabDeg: angleFromCentre(centre, localPoint(e)),
                    },
                    e,
                  );
                }}
              />
            </>
          );
        })()}
    </div>
  );
}
