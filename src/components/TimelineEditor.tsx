// Interactive NLE timeline: ruler + tracks + clips you can select, drag to move
// (within/across tracks), and trim by the edges — with snapping (S toggles it),
// zoom (Ctrl+wheel / buttons / Fit), and Premiere-style keyboard shortcuts.
// Alt is the OVERRIDE key, as in Premiere and other NLEs: Alt+drag duplicates, acts on one
// half of a linked pair, and ignores the trim handles.
// Driven entirely by the editor store; all pixel<->frame math lives in the
// tested timeline/geometry module, so the handlers here stay thin.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useChat } from "../store/chat";
import { _zoomBounds, useEditor } from "../store/editor";
import {
  frameToX,
  snapFrame,
  snapMoveIn,
  snapTargets,
  totalFrames,
  xToFrame,
} from "../timeline/geometry";
import { gapAt } from "../timeline/gaps";
import { linkGroupIds } from "../timeline/helpers";
import { hit } from "../timeline/shortcuts";
import { clampFadeFrames } from "../timeline/clamp";
import { bandFrac, bandGain } from "../timeline/volumeBand";
import { keyframeTimes } from "../timeline/keyframe";
import { buildClipMention, buildPlayheadMention, buildRangeMention } from "../timeline/mentions";
import type { Clip, Track } from "../timeline/model";
import { maxSpanFrames } from "../timeline/sourceLength";
import { parseTransitionIn } from "../timeline/transition";
import { zoomPan, zoomResize, zoomThumb } from "../timeline/zoombar";
import { confirmDestructive } from "../lib/confirm";
import { onOsDragOver, onOsDrop, webOwnsFileDrops } from "../lib/osDrop";
import { useProjectNotice } from "../store/projectNotice";
import { withImportJob } from "../store/importJobs";
import { onDragPoint } from "../lib/dragSource";
import { importFileByReference, MEDIA_RE, uploadFiles } from "../lib/upload";
import { ClipThumbnail } from "./ClipThumbnail";
import { ClipWaveform } from "./ClipWaveform";
import { AudioMeter } from "./AudioMeter";
import { cn } from "./ui";
import { VZoom } from "./timeline/VZoom";
import {
  idsInBox,
  isMarqueeDrag,
  normalizeBox,
  razorFrame,
  reorderZ,
  type Box,
  type Span,
} from "./timeline/interact";
import { clipId, clipLabel, findClipWithTrack, trackLabels } from "./timeline/labels";

const ROW_H = 52; // label + lane
const LANE_H = 38;
const LABEL_H = ROW_H - LANE_H; // fixed label strip above each lane
const SNAP_PX = 12;
const TRIM_W = 8;
const MIN_LEN = 1; // frames
const EDGE_PX = 40; // pointer this close to the viewport edge -> pan toward it
const EDGE_SPEED = 14; // px per frame at the very edge

/** Fields every drag mode shares. `moved` is the one that decides whether the gesture writes:
 *  a press with no movement is not an edit, whatever it was aimed at. `startY` is filled in by
 *  `startDrag` so no call site can forget it. */
interface DragCommon {
  startX: number;
  startY?: number;
  moved?: boolean;
  /** Every clip this gesture will move. Snap targets exclude all of them, so a travelling
   *  companion can never offer the gesture its own starting edges. */
  movingIds?: string[];
}

type DragData =
  | (DragCommon & {
      mode: "move";
      clipId: string;
      trackId: string;
      origIn: number;
      len: number;
      kind: string;
      /** Set by the slip/slide TOOLS (Y/U), never by a modifier — see D9. */
      variant?: "slip" | "slide";
      /** Alt at pointer-down: place a COPY at the target and leave the original. */
      duplicate?: boolean;
      /** Alt at pointer-down: act on this clip alone, leaving its link partner behind. */
      ignoreLinks?: boolean;
    })
  | (DragCommon & {
      mode: "trim-l" | "trim-r";
      clipId: string;
      origIn: number;
      origOut: number;
      /** Shift = ripple: the edge moves AND everything after it follows. */
      ripple?: boolean;
      /** null when the clip has NO source window (a still, which has no length of its
       *  own). Writing one edge of a window that doesn't exist is what made an image's
       *  tail-drag fail validation and snap back, so null must stay null. */
      sIn: number | null;
      sOut: number | null;
      speed: number;
      /** Longest span the real footage allows, once probed; null = unbounded,
       *  undefined = not known yet. The commit clamps regardless — this only keeps the
       *  ghost from promising a length the media cannot deliver. */
      maxSpan?: number | null;
    })
  | (DragCommon & {
      mode: "fade-in" | "fade-out";
      clipId: string;
      origIn: number;
      origOut: number;
    })
  | (DragCommon & {
      mode: "volume-key";
      clipId: string;
      origIn: number;
      origOut: number;
      /** Clip-relative frame of the key as it currently sits; a drag replaces it. */
      keyT: number;
      /** Band geometry captured at grab time so the level maps the same way all drag long. */
      bandTop: number;
      bandH: number;
    })
  | { mode: "scrub" };

interface Preview {
  clipId: string;
  in: number;
  out: number;
  trackId?: string;
  sIn?: number | null;
  sOut?: number | null;
  /** Frames of fade the ghost is promising; the commit clamps to the same rail. */
  fadeIn?: number;
  fadeOut?: number;
  /** Volume key being dragged: clip-relative frame + gain, and the frame it started at. */
  volT?: number;
  volV?: number;
  volFrom?: number;
}

// ponytail: VZoom + the pure label helpers now live in ./timeline/*. The drag /
// zoom / ruler / transition pointer state machines below stay inline — they are
// tightly coupled through shared refs (with documented subtle re-render bugs) and
// would need the vitest suite green to extract into hooks safely.

/** A clip's source window for a trim drag. A still has none, and `Number(undefined)||0`
 *  used to turn that absence into a real 0 — the drag then wrote half a window and the
 *  edit was rejected, so the image visibly snapped back. Absence stays absent. */
function sourceWindowOf(c: Clip): { sIn: number | null; sOut: number | null; speed: number } {
  const has = typeof c.source_in === "number";
  return {
    sIn: has ? (c.source_in as number) : null,
    sOut: typeof c.source_out === "number" ? c.source_out : null,
    speed: Number(c.speed ?? 1) || 1,
  };
}
/** The volume rubber band drawn across an audio clip: a level line, a handle per keyframe, and
 *  Cmd/Ctrl+click to add one. Premiere and other NLEs both spend Cmd here (other NLEs'
 *  `isCommand, clip.mediaType == .audio` runs before its selection path), so on an audio clip
 *  Cmd+click adds a key rather than extending the selection — the cost of the binding, taken
 *  deliberately and only on audio.
 *
 *  The line's points and the handles read the SAME `bandFrac`, so a handle can never sit off
 *  the line it is supposed to be on. */
function VolumeBand({
  clip,
  clipId,
  inF,
  outF,
  preview,
  onGrab,
  onAdd,
  toFrame,
}: {
  clip: Clip;
  clipId: string;
  inF: number;
  outF: number;
  preview: Preview | null;
  onGrab: (keyT: number, bandTop: number, bandH: number, ev: React.PointerEvent) => void;
  onAdd: (at: number, gain: number) => void;
  toFrame: (clientX: number) => number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const span = Math.max(1, outF - inF);
  const raw = clip.volume;
  const kfs: Array<{ t: number; v: number }> = Array.isArray(raw)
    ? raw.map((k) => ({ t: Number(k.t) || 0, v: Number(k.v) || 0 }))
    : [];
  // The dragged key follows the pointer while the document still holds its old position.
  const live =
    preview && preview.clipId === clipId && preview.volT !== undefined
      ? kfs.map((k) =>
          k.t === preview.volFrom ? { t: preview.volT as number, v: preview.volV as number } : k,
        )
      : kfs;
  const pts = [...live].sort((a, b) => a.t - b.t);
  const constant = Number.isFinite(Number(raw)) ? Number(raw) : 1;
  const yOf = (v: number) => `${bandFrac(v) * 100}%`;
  const xOf = (t: number) => `${(t / span) * 100}%`;

  return (
    <div
      ref={ref}
      data-testid="volume-band"
      className="absolute inset-x-0 inset-y-0"
      onPointerDown={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return; // plain drags still move the clip
        const box = ref.current?.getBoundingClientRect();
        if (!box || box.height <= 0) return;
        e.preventDefault();
        e.stopPropagation();
        const at = Math.max(0, Math.min(span, toFrame(e.clientX) - inF));
        onAdd(at, bandGain((e.clientY - box.top) / box.height));
      }}
    >
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <polyline
          points={
            pts.length
              ? [
                  `0,${bandFrac(pts[0].v)}`,
                  ...pts.map((k) => `${k.t / span},${bandFrac(k.v)}`),
                  `1,${bandFrac(pts[pts.length - 1].v)}`,
                ].join(" ")
              : `0,${bandFrac(constant)} 1,${bandFrac(constant)}`
          }
          vectorEffect="non-scaling-stroke"
          className="fill-none stroke-white/80"
          strokeWidth={1.5}
        />
      </svg>
      {pts.map((k) => (
        <span
          key={k.t}
          role="slider"
          aria-label="volume key"
          aria-valuenow={k.v}
          data-t={k.t}
          data-v={k.v}
          tabIndex={-1}
          onPointerDown={(e) => {
            const box = ref.current?.getBoundingClientRect();
            if (!box) return;
            e.stopPropagation();
            onGrab(k.t, box.top, box.height, e);
          }}
          className="absolute z-30 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-move border border-neutral-900 bg-white"
          style={{ left: xOf(k.t), top: yOf(k.v) }}
        />
      ))}
    </div>
  );
}

export default function TimelineEditor() {
  const timeline = useEditor((s) => s.timeline);
  const selectedIds = useEditor((s) => s.selectedIds);
  const playhead = useEditor((s) => s.playhead);
  const zoom = useEditor((s) => s.zoom);
  const select = useEditor((s) => s.select);
  const selectAll = useEditor((s) => s.selectAll);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setZoom = useEditor((s) => s.setZoom);
  const trackScale = useEditor((s) => s.trackScale);
  const setTrackScale = useEditor((s) => s.setTrackScale);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);
  const moveClip = useEditor((s) => s.moveClip);
  const trimClip = useEditor((s) => s.trimClip);
  const clipSourceFrames = useEditor((s) => s.clipSourceFrames);
  const splitClip = useEditor((s) => s.splitClip);
  const deleteClips = useEditor((s) => s.deleteClips);
  const nudgeClips = useEditor((s) => s.nudgeClips);
  const setClipEnabled = useEditor((s) => s.setClipEnabled);
  const trimToPlayhead = useEditor((s) => s.trimToPlayhead);
  const rippleTrim = useEditor((s) => s.rippleTrim);
  const selectForward = useEditor((s) => s.selectForward);
  const rollEdit = useEditor((s) => s.rollEdit);
  const slipClip = useEditor((s) => s.slipClip);
  const slideClip = useEditor((s) => s.slideClip);
  const moveSelectionBy = useEditor((s) => s.moveSelectionBy);
  const rippleDeleteClip = useEditor((s) => s.rippleDeleteClip);
  const rippleDeleteGap = useEditor((s) => s.rippleDeleteGap);
  const selectGap = useEditor((s) => s.selectGap);
  const selectedGap = useEditor((s) => s.selectedGap);
  const duplicateClip = useEditor((s) => s.duplicateClip);
  const linkClips = useEditor((s) => s.linkClips);
  const unlinkClips = useEditor((s) => s.unlinkClips);
  const copyClip = useEditor((s) => s.copyClip);
  const pasteClip = useEditor((s) => s.pasteClip);
  const clipboard = useEditor((s) => s.clipboard);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const addClip = useEditor((s) => s.addClip);
  const addClips = useEditor((s) => s.addClips);
  const store = useEditor((s) => s.store);
  const addTrack = useEditor((s) => s.addTrack);
  const removeTrack = useEditor((s) => s.removeTrack);
  const setTrack = useEditor((s) => s.setTrack);
  const setTracks = useEditor((s) => s.setTracks);
  const setTransition = useEditor((s) => s.setTransition);
  const setClipProperties = useEditor((s) => s.setClipProperties);
  const setKeyframe = useEditor((s) => s.setKeyframe);
  const setSelectedRange = useEditor((s) => s.setSelectedRange);
  const selectMany = useEditor((s) => s.selectMany);
  const selectedRange = useEditor((s) => s.selectedRange);
  const mediaNames = useEditor((s) => s.mediaNames);
  const mediaStatus = useEditor((s) => s.mediaStatus);
  const addMention = useChat((s) => s.addMention);

  const fps = Number(timeline?.canvas?.fps) || 30;
  const tracks = useMemo<Track[]>(() => (timeline?.tracks ?? []) as Track[], [timeline]);
  const labels = useMemo(() => trackLabels(tracks), [tracks]);
  // Premiere-style vertical order: visual (video/text) tracks stacked on top with the
  // HIGHEST z topmost, audio below in natural order. Ordering by z (not array index) is
  // what lets a drag-reorder actually move the row — z is the compositing authority, so
  // sorting by anything else lets the label and the picture disagree. Labels stay indexed
  // by the ORIGINAL array position (ti), so a track keeps its identity (v1 stays "v1"
  // wherever it is drawn).
  const displayTracks = useMemo(() => {
    const meta = tracks.map((tr, ti) => ({ tr, ti }));
    const visual = meta.filter((m) => m.tr.kind !== "audio");
    const audio = meta.filter((m) => m.tr.kind === "audio");
    visual.sort((a, b) => (Number(b.tr.z) || 0) - (Number(a.tr.z) || 0));
    return [...visual, ...audio];
  }, [tracks]);
  const laneHFor = useCallback(
    (kind: string) => Math.round(LANE_H * (kind === "audio" ? trackScale.audio : trackScale.video)),
    [trackScale],
  );
  const rowHFor = useCallback((kind: string) => LABEL_H + laneHFor(kind), [laneHFor]);
  const total = timeline ? totalFrames(timeline) : 0;
  const playheadFrame = Math.round(playhead * fps);
  // The gap is stored as a POINT and resolved here, by the same function the delete calls — so
  // the highlight cannot outlive the gap it is drawn over.
  const gapBox = useMemo(
    () => (selectedGap ? gapAt(timeline, selectedGap.trackId, selectedGap.atFrame) : null),
    [timeline, selectedGap],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const zoomBarRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const dragRef = useRef<DragData | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const [preview, setPreviewState] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  /** Where a dragged library item would land. Frame is SNAPPED with the same targets a move
   *  uses, so the ghost cannot promise a position the drop will not honour. */
  const [dropGhost, setDropGhost] = useState<{ trackId: string; frame: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  // Premiere's modal tools: V pointer, C razor. The razor cuts where you CLICK — that is
  // the whole point of it, since the S key already splits at the playhead.
  const [tool, setTool] = useState<"pointer" | "razor" | "slip" | "slide" | "roll">("pointer");
  const [snapping, setSnapping] = useState(true);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const [transPreview, setTransPreview] = useState<{ clipId: string; duration: number } | null>(
    null,
  );
  const [, setTick] = useState(0);

  const setPreview = useCallback((p: Preview | null) => {
    previewRef.current = p;
    setPreviewState(p);
  }, []);

  /** Every clip a move gesture will carry: the grabbed clip's link group, and — when the grab
   *  lands inside a multi-selection — every selected clip's group too. */
  const travellingWith = useCallback(
    (clipId: string): string[] => {
      const seeds = selectedIds.includes(clipId) && selectedIds.length > 1 ? selectedIds : [clipId];
      const out = new Set<string>();
      for (const id of seeds) for (const g of linkGroupIds(timeline, id)) out.add(g);
      return [...out];
    },
    [selectedIds, timeline],
  );

  // Content width in px: whichever is larger, the timeline or the viewport.
  const contentW = Math.max(frameToX(total, fps, zoom) + 200, 600);

  // ONE time origin. `localX` measures from the lanes CONTAINER, and the playhead, the
  // range overlay and the marquee are all positioned in that same space — so a lane must
  // not carry a horizontal offset of its own. A 12px `mx-3` on the lane put every clip
  // 12px right of the frame it claimed: the playhead never lined up with a cut, and every
  // absolute pointer read (razor, trim) landed ~9 frames late at the default zoom and ~90
  // zoomed out. Move drags were immune because they use a delta, which is how it survived.
  const localX = useCallback((clientX: number): number => {
    const el = lanesRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return clientX - rect.left + el.scrollLeft;
  }, []);

  /** Every clip's rect in lane-local px, for marquee hit-testing. Rows are laid out in
   *  DISPLAY order (video reversed above audio), so this walks displayTracks, not tracks. */
  const clipSpans = useCallback((): Span[] => {
    const spans: Span[] = [];
    let y = 0;
    for (const { tr, ti } of displayTracks) {
      const kind = String(tr.kind ?? "video");
      const laneTop = y + LABEL_H;
      const laneBottom = laneTop + laneHFor(kind);
      (tr.clips ?? []).forEach((c, ci) => {
        const inF = Number(c.timeline_in) || 0;
        const outF = Number(c.timeline_out) || 0;
        spans.push({
          id: clipId(c, `${labels[ti]}:${ci}`),
          x0: frameToX(inF, fps, zoom),
          x1: frameToX(outF, fps, zoom),
          y0: laneTop,
          y1: laneBottom,
        });
      });
      y += rowHFor(kind);
    }
    return spans;
  }, [displayTracks, labels, laneHFor, rowHFor, fps, zoom]);

  const trackIndexAtY = useCallback(
    (clientY: number): number => {
      const el = lanesRef.current;
      if (!el) return -1;
      const rect = el.getBoundingClientRect();
      let y = clientY - rect.top + el.scrollTop;
      for (const m of displayTracks) {
        const h = rowHFor(String(m.tr.kind ?? "video"));
        if (y < h) return m.ti;
        y -= h;
      }
      return -1;
    },
    [displayTracks, rowHFor],
  );

  // ── drag lifecycle ───────────────────────────────────────────────────────
  // Window pointer listeners attach via these STABLE wrappers, which call the
  // latest handler through refs. Without this, a re-render mid-drag (setPlayhead
  // while scrubbing recreates onDragMove) made the cleanup effect below detach
  // the listeners — so scrubbing died after the first frame (click-only seek).
  const onDragMoveRef = useRef<(e: PointerEvent) => void>();
  const onDragUpRef = useRef<() => void>();
  const winMove = useRef((e: PointerEvent) => onDragMoveRef.current?.(e)).current;
  const winUp = useRef(() => onDragUpRef.current?.()).current;

  // Edge autoscroll. A held-still pointer fires no pointermove, so the pump re-runs the
  // LAST one after scrolling — otherwise the view would slide out from under a frozen ghost.
  const edgeVel = useRef(0);
  const edgeRaf = useRef<number | null>(null);
  const lastPointer = useRef<PointerEvent | null>(null);
  const pumpEdgeScroll = useRef((): void => {
    const el = scrollRef.current;
    const v = edgeVel.current;
    if (el && v && dragRef.current) {
      const before = el.scrollLeft;
      el.scrollLeft += v;
      if (el.scrollLeft !== before) {
        if (lastPointer.current) onDragMoveRef.current?.(lastPointer.current);
        setTick((t) => t + 1); // keep the zoom navigator's thumb honest while it pans
      }
    }
    edgeRaf.current = dragRef.current ? requestAnimationFrame(pumpEdgeScroll) : null;
  }).current;

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !timeline) return;
      lastPointer.current = e;
      // Pan when the pointer reaches the viewport edge, so a clip wider than the window
      // can actually be dragged to its end (Premiere both do this).
      const sc = scrollRef.current;
      if (sc && d.mode !== "scrub") {
        const r = sc.getBoundingClientRect();
        const over =
          e.clientX < r.left + EDGE_PX
            ? (e.clientX - (r.left + EDGE_PX)) / EDGE_PX
            : e.clientX > r.right - EDGE_PX
              ? (e.clientX - (r.right - EDGE_PX)) / EDGE_PX
              : 0;
        edgeVel.current = Math.max(-1, Math.min(1, over)) * EDGE_SPEED;
      }
      const x = localX(e.clientX);
      const frame = xToFrame(x, fps, zoom);

      if (d.mode === "scrub") {
        setPlayhead(Math.max(0, frame) / fps);
        return;
      }
      // A press is not an edit. `startDrag` calls this once at pointer-DOWN to seed the ghost, so
      // "did the user actually drag?" has to be asked against the grab point, and `onDragUp`
      // refuses to commit until it is true.
      //
      // The test is per-MODE because the modes do not consume the same axes. A trim can only
      // change along X, so vertical jitter must not arm it: the trim path follows the pointer's
      // ABSOLUTE frame and a handle's centre sits a few pixels INSIDE the clip's edge, so a click
      // on the tail handle used to commit a several-frame trim. (It looked correct only because
      // snapping pulled the edge back onto itself; with snapping off it wrote every time.)
      // A move consumes BOTH axes — dragging a clip straight down to another track moves X not at
      // all — so an X-only test silently refused every cross-track drag.
      const dx = Math.abs(x - d.startX);
      const dy = typeof d.startY === "number" ? Math.abs(e.clientY - d.startY) : 0;
      if (dx > 0.5 || (d.mode === "move" && dy > 0.5)) d.moved = true;
      // Snapping is a TOGGLE (S), as in Premiere. It used to be "held Alt bypasses", which put our
      // own invention on the one key Premiere and other NLEs both reserve for overriding a default
      // (duplicate instead of move, ignore the link group, ignore the trim handle). Shift is the
      // momentary bypass instead: it overrides nothing else DURING a drag.
      //
      // Every clip that TRAVELS is excluded, not just the grabbed one. A linked pair sits at the
      // same frames as its partner, so leaving the partner in offered the clip its own starting
      // edges and every small drag snapped straight back to where it began.
      const live = snapping && !e.shiftKey;
      const targets = live
        ? snapTargets(timeline, { excludeIds: d.movingIds ?? [d.clipId], playheadFrame })
        : [];
      const snap = (f: number) => (live ? snapFrame(f, targets, fps, zoom, SNAP_PX) : f);

      if (d.mode === "move") {
        const dframes = xToFrame(x, fps, zoom) - xToFrame(d.startX, fps, zoom);
        const newIn = live
          ? snapMoveIn(d.origIn + dframes, d.len, targets, fps, zoom, SNAP_PX)
          : Math.max(0, d.origIn + dframes);
        const ti = trackIndexAtY(e.clientY);
        const target = tracks[ti];
        const toTrack = target && String(target.kind) === d.kind ? String(target.id) : d.trackId;
        setPreview({ clipId: d.clipId, in: newIn, out: newIn + d.len, trackId: toTrack });
      } else if (d.mode === "fade-in" || d.mode === "fade-out") {
        // A fade is a LENGTH measured inward from the clip's own edge, so the pointer's frame
        // maps to it by distance from that edge. `clampFadeFrames` is the rail the commit
        // applies, called here so the ghost stops exactly where the write would.
        const span = d.origOut - d.origIn;
        const raw = d.mode === "fade-in" ? snap(frame) - d.origIn : d.origOut - snap(frame);
        const frames = clampFadeFrames(Math.round(raw), span);
        setPreview({
          clipId: d.clipId,
          in: d.origIn,
          out: d.origOut,
          ...(d.mode === "fade-in" ? { fadeIn: frames } : { fadeOut: frames }),
        });
      } else if (d.mode === "volume-key") {
        // 2D: the frame comes from the pointer, the level from its height in the band. Clamped
        // to the clip, because a clip-relative key outside its own span cannot render.
        const t = Math.max(0, Math.min(d.origOut - d.origIn, snap(frame) - d.origIn));
        const v = bandGain(d.bandH > 0 ? (e.clientY - d.bandTop) / d.bandH : 0);
        setPreview({
          clipId: d.clipId,
          in: d.origIn,
          out: d.origOut,
          volT: t,
          volV: v,
          volFrom: d.keyT,
        });
      } else if (d.mode === "trim-l") {
        // Head rail: you cannot pull the start earlier than source frame 0.
        const headRail =
          d.sIn === null ? 0 : Math.max(0, d.origIn - Math.floor(d.sIn / (d.speed || 1)));
        const newIn = Math.min(d.origOut - MIN_LEN, Math.max(headRail, snap(frame)));
        setPreview({
          clipId: d.clipId,
          in: newIn,
          out: d.origOut,
          sIn:
            d.sIn === null
              ? null
              : Math.max(0, d.sIn + Math.round((newIn - d.origIn) * (d.speed || 1))),
        });
      } else if (d.mode === "trim-r") {
        // Tail rail: the clip can be no longer than the footage left after its in-point.
        const capped =
          typeof d.maxSpan === "number" ? d.origIn + d.maxSpan : Number.POSITIVE_INFINITY;
        const newOut = Math.min(capped, Math.max(d.origIn + MIN_LEN, snap(frame)));
        setPreview({
          clipId: d.clipId,
          in: d.origIn,
          out: newOut,
          sOut: d.sOut === null ? null : d.sOut + Math.round((newOut - d.origOut) * (d.speed || 1)),
        });
      }
    },
    [
      timeline,
      fps,
      zoom,
      playheadFrame,
      snapping,
      tracks,
      localX,
      trackIndexAtY,
      setPlayhead,
      setPreview,
    ],
  );

  const onDragUp = useCallback(() => {
    const d = dragRef.current;
    const p = previewRef.current;
    window.removeEventListener("pointermove", winMove);
    window.removeEventListener("pointerup", winUp);
    dragRef.current = null;
    edgeVel.current = 0;
    lastPointer.current = null;
    setDragging(false);
    if (d && p && d.mode !== "scrub" && d.moved) {
      if (d.mode === "move") {
        const delta = p.in - d.origIn;
        const group = d.movingIds ?? [d.clipId];
        const crossTrack = !!p.trackId && p.trackId !== d.trackId;
        if (d.variant === "slip") {
          void slipClip(d.clipId, delta).finally(() => endGesture());
        } else if (d.variant === "slide") {
          void slideClip(d.clipId, delta).finally(() => endGesture());
        } else if (group.length > 1 && !crossTrack && !d.duplicate) {
          // A multi-clip selection travels as one. Cross-track is deliberately left to the
          // single-clip path: there is no ghost showing where the OTHER clips would land.
          void moveSelectionBy(group, delta).finally(() => endGesture());
        } else {
          void moveClip(d.clipId, {
            toTimelineIn: p.in,
            toTrack: p.trackId && p.trackId !== d.trackId ? p.trackId : undefined,
            duplicate: d.duplicate,
            ignoreLinks: d.ignoreLinks,
          }).finally(() => endGesture());
        }
      } else if (d.mode === "fade-in" || d.mode === "fade-out") {
        // Send only the edge that was dragged; the other keeps whatever it had.
        const cur = findClipWithTrack(tracks, d.clipId)?.clip;
        const other =
          d.mode === "fade-in" ? Number(cur?.fade?.out) || 0 : Number(cur?.fade?.in) || 0;
        const frames = d.mode === "fade-in" ? (p.fadeIn ?? 0) : (p.fadeOut ?? 0);
        void setClipProperties(d.clipId, {
          fade: d.mode === "fade-in" ? { in: frames, out: other } : { in: other, out: frames },
        }).finally(() => endGesture());
      } else if (d.mode === "volume-key") {
        void setKeyframe(d.clipId, "volume", p.volT ?? d.keyT, p.volV ?? 1, {
          fromT: d.keyT,
        }).finally(() => endGesture());
      } else if (d.mode === "trim-l") {
        if (d.ripple) {
          void rippleTrim(d.clipId, "head", p.in).finally(() => endGesture());
        } else {
          // A still has no window: sending a lone source edge would half-write one and the
          // whole edit gets rejected. Send the span only.
          void trimClip(d.clipId, {
            timeline_in: p.in,
            ...(typeof p.sIn === "number" ? { source_in: Math.max(0, p.sIn) } : {}),
          }).finally(() => endGesture());
        }
      } else if (d.mode === "trim-r") {
        if (d.ripple) {
          void rippleTrim(d.clipId, "tail", p.out).finally(() => endGesture());
        } else {
          void trimClip(d.clipId, {
            timeline_out: p.out,
            ...(typeof p.sOut === "number" ? { source_out: p.sOut } : {}),
          }).finally(() => endGesture());
        }
      }
    } else {
      endGesture();
    }
    setPreview(null);
  }, [
    winMove,
    winUp,
    moveClip,
    moveSelectionBy,
    trimClip,
    setClipProperties,
    setKeyframe,
    tracks,
    endGesture,
    setPreview,
  ]);

  onDragMoveRef.current = onDragMove;
  onDragUpRef.current = onDragUp;

  const startDrag = useCallback(
    (d: DragData, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (d.mode !== "scrub") d.startY = e.clientY;
      dragRef.current = d;
      setDragging(true);
      if (d.mode !== "scrub") beginGesture();
      // The rail the ghost must stop at. Probed async (ffprobe, cached after the first
      // ask) — until it lands the ghost is unbounded, but the COMMIT clamps regardless,
      // so the worst case is a ghost that corrects itself, never a bad write.
      if ((d.mode === "trim-l" || d.mode === "trim-r") && d.sIn !== null) {
        void clipSourceFrames(d.clipId).then((total) => {
          if (dragRef.current === d) d.maxSpan = maxSpanFrames(total, d.sIn ?? 0, d.speed);
        });
      }
      window.addEventListener("pointermove", winMove);
      window.addEventListener("pointerup", winUp);
      if (edgeRaf.current === null) edgeRaf.current = requestAnimationFrame(pumpEdgeScroll);
      onDragMove(e.nativeEvent);
    },
    [beginGesture, onDragMove, winMove, winUp, clipSourceFrames, pumpEdgeScroll],
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", winMove);
      window.removeEventListener("pointerup", winUp);
      if (edgeRaf.current !== null) cancelAnimationFrame(edgeRaf.current);
      edgeRaf.current = null;
    };
  }, [winMove, winUp]);

  /** Roll the cut at `cutFrame`, whose outgoing clip is `leftClipId`.
   *
   *  Its own pointer loop rather than a DragData mode: a roll edits TWO clips and moves no clip
   *  box, so the move/trim ghost would describe something that isn't happening. */
  const startRoll = useCallback(
    (leftClipId: string, cutFrame: number, e: React.PointerEvent) => {
      const startX = localX(e.clientX);
      beginGesture();
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointerup", up);
        const to = cutFrame + Math.round(xToFrame(localX(ev.clientX) - startX, fps, zoom));
        if (to !== cutFrame) void rollEdit(leftClipId, to).finally(() => endGesture());
        else endGesture();
      };
      window.addEventListener("pointerup", up);
    },
    [beginGesture, endGesture, localX, fps, zoom, rollEdit],
  );

  // ── keyboard (Premiere-style) ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      // Only TEXT entry should swallow shortcuts. Clicking a clip doesn't move focus
      // off the transport slider (a div isn't focusable), so treating every INPUT as
      // typing meant "scrub, select a clip, press S" silently did nothing.
      const typing =
        tag === "TEXTAREA" ||
        el?.isContentEditable === true ||
        (tag === "INPUT" &&
          !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test(
            (el as HTMLInputElement).type || "text",
          ));
      if (typing) return;
      const st = useEditor.getState();
      const sel = st.selection;
      const ids = st.selectedIds.length ? st.selectedIds : sel ? [sel] : [];
      if (hit(e, "selectAll")) {
        e.preventDefault();
        selectAll();
      } else if (hit(e, "undo") || hit(e, "redo")) {
        e.preventDefault();
        void (hit(e, "redo") ? redo() : undo());
      } else if (hit(e, "duplicate")) {
        if (!sel) return;
        e.preventDefault();
        void duplicateClip(sel);
      } else if (hit(e, "copy")) {
        if (!sel) return;
        e.preventDefault();
        copyClip(sel);
      } else if (hit(e, "paste")) {
        e.preventDefault();
        void pasteClip();
      } else if (hit(e, "cut")) {
        if (!sel) return;
        e.preventDefault();
        // Copy is UI-only clipboard state, so the removal is the single document change and the
        // whole cut is already one undo entry.
        copyClip(sel);
        void deleteClips(ids);
      } else if (hit(e, "delete")) {
        // Exactly one target: the store keeps a clip selection and a gap selection mutually
        // exclusive, so this reads as a plain either/or rather than a precedence rule.
        // Shift is accepted too — Premiere closes a gap on plain Delete, other NLEs on Shift+Delete,
        // and there is nothing else either chord could mean while a gap is selected.
        if (st.selectedGap) {
          e.preventDefault();
          void rippleDeleteGap();
          return;
        }
        if (!ids.length) return;
        e.preventDefault();
        void (e.shiftKey && sel ? rippleDeleteClip(sel) : deleteClips(ids));
      } else if (hit(e, "split")) {
        if (!sel) return;
        e.preventDefault();
        void splitClip(sel, Math.round(st.playhead * fps));
      } else if (hit(e, "snapping")) {
        e.preventDefault();
        setSnapping((v) => !v);
      } else if (hit(e, "selectForwardTrack") || hit(e, "selectForwardAll")) {
        if (!sel) return;
        e.preventDefault();
        selectForward(hit(e, "selectForwardAll") ? "all" : "track");
      } else if (hit(e, "toggleEnabled")) {
        if (!ids.length) return;
        e.preventDefault();
        // Toggle from the ANCHOR, so a mixed selection lands in one state rather than inverting
        // each clip and leaving the user to guess what they now have.
        const anchor = (st.timeline?.tracks ?? [])
          .flatMap((tr) => tr.clips ?? [])
          .find((c) => String(c.id) === sel);
        void setClipEnabled(ids, anchor?.disabled === true);
      } else if (hit(e, "trimHead")) {
        if (!sel) return;
        e.preventDefault();
        void trimToPlayhead(sel, "head");
      } else if (hit(e, "trimTail")) {
        if (!sel) return;
        e.preventDefault();
        void trimToPlayhead(sel, "tail");
      } else if (hit(e, "toolRazor")) {
        e.preventDefault();
        setTool("razor");
      } else if (hit(e, "toolSlip")) {
        e.preventDefault();
        setTool("slip");
      } else if (hit(e, "toolSlide")) {
        e.preventDefault();
        setTool("slide");
      } else if (hit(e, "toolRoll")) {
        e.preventDefault();
        setTool("roll");
      } else if (hit(e, "toolPointer")) {
        e.preventDefault();
        setTool("pointer");
      } else if (hit(e, "deselect")) {
        select(null);
        setTool("pointer");
      } else if (hit(e, "play")) {
        e.preventDefault();
        window.dispatchEvent(new Event("artdaddy:toggle-play"));
      } else if (hit(e, "goStart")) {
        e.preventDefault();
        setPlayhead(0);
      } else if (hit(e, "goEnd")) {
        e.preventDefault();
        setPlayhead(total / fps);
      } else if (hit(e, "zoomIn")) {
        e.preventDefault();
        setZoom(useEditor.getState().zoom * 1.3);
      } else if (hit(e, "zoomOut")) {
        e.preventDefault();
        setZoom(useEditor.getState().zoom / 1.3);
      } else if (hit(e, "nudge") || hit(e, "step")) {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const step = e.shiftKey ? 5 : 1;
        // Alt moves the CLIP (Premiere's nudge); without it the arrows walk the playhead.
        if (e.altKey && ids.length) void nudgeClips(ids, dir * step);
        else setPlayhead(Math.max(0, st.playhead + (dir * step) / fps));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    fps,
    total,
    undo,
    redo,
    deleteClips,
    rippleDeleteClip,
    splitClip,
    duplicateClip,
    copyClip,
    pasteClip,
    nudgeClips,
    setClipEnabled,
    trimToPlayhead,
    setPlayhead,
    selectAll,
    select,
    selectForward,
    setZoom,
  ]);

  // ── wheel navigation (native scrollbars are hidden) ────────────────────────
  // Plain wheel pans along time (and slides the zoom navigator); Shift+wheel pans
  // across tracks; Ctrl/Cmd+wheel zooms. Non-passive so we own the gesture and the
  // view never double-scrolls against the browser default.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const z = useEditor.getState().zoom;
        setZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      } else if (e.shiftKey) {
        el.scrollTop += e.deltaY;
      } else {
        el.scrollLeft += e.deltaY + e.deltaX;
      }
      setTick((t) => t + 1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    const durSec = total / fps;
    if (!el || durSec <= 0) return;
    setZoom((el.clientWidth - 24) / durSec);
  }, [total, fps, setZoom]);

  // ── zoom scrollbar (Premiere-style navigator) ─────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setTick((t) => t + 1);
    el.addEventListener("scroll", onScroll, { passive: true });
    setTick((t) => t + 1); // initial measure once refs are attached
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [zoom]);
  const startZoomDrag = useCallback(
    (mode: "pan" | "l" | "r", e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bar = zoomBarRef.current;
      const scroll = scrollRef.current;
      if (!bar || !scroll) return;
      const barW = bar.clientWidth || 1;
      const barLeft = bar.getBoundingClientRect().left;
      const startView = {
        scrollLeft: scroll.scrollLeft,
        clientWidth: scroll.clientWidth,
        zoom: useEditor.getState().zoom,
        totalSec: total / fps,
      };
      const startThumb = zoomThumb(startView);
      const startClientX = e.clientX;
      const move = (ev: PointerEvent) => {
        if (mode === "pan") {
          scroll.scrollLeft = zoomPan(
            startView,
            startThumb.left + (ev.clientX - startClientX) / barW,
          );
          setTick((t) => t + 1);
        } else {
          const r = zoomResize(
            startView,
            mode,
            (ev.clientX - barLeft) / barW,
            _zoomBounds.MIN_ZOOM,
            _zoomBounds.MAX_ZOOM,
          );
          pendingScroll.current = r.scrollLeft;
          setZoom(r.zoom);
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [total, fps, setZoom],
  );

  const onRulerDown = useCallback(
    (e: React.PointerEvent) => {
      // Shift+drag on the ruler marks a half-open [start, end) time range (for
      // "Add to chat" + ambient context); a plain drag scrubs the playhead.
      if (e.shiftKey) {
        e.preventDefault();
        const startFrame = Math.max(0, xToFrame(localX(e.clientX), fps, zoom));
        const move = (ev: PointerEvent) => {
          setSelectedRange({
            startFrame,
            endFrame: Math.max(0, xToFrame(localX(ev.clientX), fps, zoom)),
          });
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return;
      }
      startDrag({ mode: "scrub" }, e);
    },
    [startDrag, localX, fps, zoom, setSelectedRange],
  );

  // Import OS files dropped onto a lane (upload -> inputs/uploads), then add each
  // as a clip at the drop frame. Non-media files are ignored.
  const importFiles = useCallback(
    async (files: File[], trackId: string, frame: number) => {
      const pid = useEditor.getState().projectId;
      const media = files.filter((f) => MEDIA_RE.test(f.name));
      if (!pid || !media.length) return;
      const uploaded = await uploadFiles(pid, media);
      // Use the PROJECT-RELATIVE source so it resolves against the client's
      // project dir; the server's absolute upload path is the sandboxed
      // Store-Python %APPDATA% location the desktop app can't read.
      for (const u of uploaded) {
        // Poster + (for non-web codecs like HEVC) an H.264 preview proxy first,
        // so the clip previews and shows a thumbnail as soon as it appears.
        await useEditor.getState().processImport(u.rel);
      }
      // Place by CATALOG ID. `rel` is the entry's path, and for a LINKED import that is an
      // ABSOLUTE system path, which resolveRef rejects as an unsafe agent ref — so every OS
      // drop onto a lane imported the file and then silently placed nothing.
      await addClips(
        uploaded.map((u) => u.id),
        trackId,
        frame,
      );
    },
    [addClips],
  );

  // Import OS files LINKED IN PLACE (desktop): the drop carries real paths, so nothing is copied.
  const linkPaths = useCallback(
    async (paths: string[], trackId: string, frame: number) => {
      const pid = useEditor.getState().projectId;
      const media = paths.filter((p) => MEDIA_RE.test(p));
      if (!pid || !media.length) return;
      const linked: string[] = [];
      for (const p of media) {
        try {
          const u = await withImportJob(p, () => importFileByReference(pid, p));
          // Index by PATH (indexSource matches on the extension, so an id indexes nothing)
          // but place by ID — the two want different things from the same import.
          await useEditor.getState().processImport(u.rel);
          linked.push(u.id);
        } catch (e) {
          // Keep the rest of the drop, but do not let a file vanish without a word.
          useProjectNotice
            .getState()
            .notify(
              `Couldn't import ${p.split(/[\\/]/).pop()}: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
      }
      if (linked.length) await addClips(linked, trackId, frame);
    },
    [addClips],
  );

  // A lane is a drop target for BOTH gestures now: OS files (paths, routed by osDrop) and the
  // library's pointer drag. Registered per element so the drop lands on the lane under the cursor
  // rather than on whichever one React rendered last.
  /** Where a drop at this screen X lands. The ghost and the COMMIT both ask this, so the
   *  preview cannot show one frame and the drop write another. */
  const landingFrame = useCallback(
    (clientX: number): number => {
      const raw = Math.max(0, xToFrame(localX(clientX), fps, zoom));
      if (!snapping || !timeline) return raw;
      return Math.max(
        0,
        snapFrame(raw, snapTargets(timeline, { playheadFrame }), fps, zoom, SNAP_PX),
      );
    },
    [localX, fps, zoom, snapping, timeline, playheadFrame],
  );

  // Live landing preview while a library item is dragged over the lanes.
  useEffect(() => {
    return onDragPoint((p) => {
      if (!p) {
        setDropGhost(null);
        return;
      }
      const lane = document
        .elementFromPoint(p.x, p.y)
        ?.closest<HTMLElement>("[data-artdaddy-drop='track']");
      const trackId = lane?.dataset.trackId ?? "";
      if (!trackId) {
        setDropGhost(null);
        setDropTrack(null);
        return;
      }
      setDropTrack(trackId);
      setDropGhost({ trackId, frame: landingFrame(p.x) });
    });
  }, [landingFrame]);

  const lanes = useRef(new Map<HTMLElement, string>());
  const registerLane = useCallback((el: HTMLElement | null, trackId: string) => {
    if (el) lanes.current.set(el, trackId);
  }, []);

  useEffect(() => {
    const onClipDrop = (e: Event) => {
      const el = e.currentTarget as HTMLElement;
      const trackId = lanes.current.get(el);
      const { ref, x } = (e as CustomEvent<{ ref: string; x: number }>).detail;
      if (!trackId || !ref) return;
      setDropTrack(null);
      setDropGhost(null);
      void addClip(ref, trackId, landingFrame(x));
    };
    const els = [...lanes.current.keys()];
    for (const el of els) el.addEventListener("artdaddy:clip-drop", onClipDrop);
    return () => {
      for (const el of els) el.removeEventListener("artdaddy:clip-drop", onClipDrop);
    };
  }, [addClip, landingFrame, tracks]);

  useEffect(() => {
    const off = onOsDrop("track", (d) => {
      const trackId = d.element ? lanes.current.get(d.element) : undefined;
      if (!trackId) return;
      setDropTrack(null);
      setDropGhost(null);
      void linkPaths(d.paths, trackId, landingFrame(d.x));
    });
    // Files dragged from the OS get the same landing preview as a library drag; without it the
    // lane highlight says WHICH track but nothing about where along it.
    const offOver = onOsDragOver((d) => {
      if (!d || d.target !== "track") {
        setDropTrack(null);
        setDropGhost(null);
        return;
      }
      const lane = document
        .elementFromPoint(d.x, d.y)
        ?.closest<HTMLElement>("[data-artdaddy-drop='track']");
      const trackId = lane?.dataset.trackId ?? "";
      if (!trackId) return;
      setDropTrack(trackId);
      setDropGhost({ trackId, frame: landingFrame(d.x) });
    });
    return () => {
      off();
      offOver();
    };
  }, [linkPaths, landingFrame]);

  // Drag EITHER edge of the centered transition to resize it symmetrically
  // (Premiere-style, both sides grabbable); commit on release (bus deferred).
  const startTransResize = useCallback(
    (
      e: React.PointerEvent,
      clipId: string,
      kind: string,
      expr: string | undefined,
      cutPx: number,
      side: "l" | "r",
      maxDur: number,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      beginGesture();
      let curDur = 0;
      const move = (ev: PointerEvent) => {
        // The transition is centred on the cut: each edge sits dur/2 from it, so
        // grabbing either side sets dur = 2 x that edge's distance to the cut.
        const half = side === "l" ? cutPx - localX(ev.clientX) : localX(ev.clientX) - cutPx;
        curDur = Math.max(
          1,
          Math.min(maxDur, Math.round(2 * xToFrame(Math.max(0, half), fps, zoom))),
        );
        setTransPreview({ clipId, duration: curDur });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        // Keep the gesture OPEN until the write's bus event lands (buffered into
        // _pending), then endGesture() applies it — same as the move/trim commit.
        // Ending synchronously dropped the resize (the write hadn't emitted yet),
        // so the transition snapped back to its original duration.
        if (curDur > 0)
          void setTransition(clipId, { kind, duration: curDur, expr }).finally(() => endGesture());
        else endGesture();
        setTransPreview(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [beginGesture, endGesture, localX, fps, zoom, setTransition],
  );

  if (!timeline) {
    return (
      <div className="px-4 py-3 text-xs text-neutral-600">
        No timeline yet — ask the agent or import media.
      </div>
    );
  }

  const headPx = frameToX(playheadFrame, fps, zoom);
  const thumb = zoomThumb({
    scrollLeft: scrollRef.current?.scrollLeft ?? 0,
    clientWidth: scrollRef.current?.clientWidth ?? 0,
    zoom,
    totalSec: total / fps,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-neutral-900/40">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5 text-[11px] text-neutral-400">
        <span className="uppercase tracking-wider text-neutral-500">Timeline</span>
        <span>
          {tracks.length} tracks · {tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0)} clips
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => void addTrack("video")}
            title="Add video track"
            className="rounded px-1.5 hover:bg-neutral-800"
          >
            +V
          </button>
          <button
            onClick={() => void addTrack("audio")}
            title="Add audio track"
            className="rounded px-1.5 hover:bg-neutral-800"
          >
            +A
          </button>
          <button
            onClick={() => void addTrack("text")}
            title="Add text track"
            className="rounded px-1.5 hover:bg-neutral-800"
          >
            +T
          </button>
          <span className="mx-1 h-3 w-px bg-edge" />
          <button
            aria-label="pointer tool"
            aria-pressed={tool === "pointer"}
            onClick={() => setTool("pointer")}
            title="Pointer (V)"
            className={cn(
              "rounded px-1.5",
              tool === "pointer" ? "bg-accent text-white" : "hover:bg-neutral-800",
            )}
          >
            ⭠
          </button>
          <button
            aria-label="razor tool"
            aria-pressed={tool === "razor"}
            onClick={() => setTool((t) => (t === "razor" ? "pointer" : "razor"))}
            title="Razor (C) — click a clip to cut it there"
            className={cn(
              "rounded px-1.5",
              tool === "razor" ? "bg-accent text-white" : "hover:bg-neutral-800",
            )}
          >
            ✂
          </button>
          {(
            [
              [
                "slip tool",
                "slip",
                "Slip (Y) — drag the body to move the CONTENT, not the clip",
                "⇹",
              ],
              [
                "slide tool",
                "slide",
                "Slide (U) — drag the body; the neighbours absorb the move",
                "⇥",
              ],
              ["roll tool", "roll", "Roll (N) — drag a cut to move it between two clips", "⇎"],
            ] as const
          ).map(([label, id, title, glyph]) => (
            <button
              key={id}
              aria-label={label}
              aria-pressed={tool === id}
              onClick={() => setTool((t) => (t === id ? "pointer" : id))}
              title={title}
              className={cn(
                "rounded px-1.5",
                tool === id ? "bg-accent text-white" : "hover:bg-neutral-800",
              )}
            >
              {glyph}
            </button>
          ))}
          {/* Snapping is modal, so it needs to be VISIBLE — a mode you can only discover by
              pressing S and noticing the drag behaved differently is a mode users fight. */}
          <button
            aria-label="snapping"
            aria-pressed={snapping}
            onClick={() => setSnapping((v) => !v)}
            title="Snapping (S) — align edges to clips and the playhead"
            className={cn(
              "rounded px-1.5",
              snapping ? "bg-accent text-white" : "hover:bg-neutral-800",
            )}
          >
            ⇥|
          </button>
          <span className="mx-1 h-3 w-px bg-edge" />
          <button
            onClick={() => setZoom(zoom / 1.3)}
            title="Zoom out"
            className="rounded px-1.5 hover:bg-neutral-800"
          >
            −
          </button>
          <button onClick={fit} title="Fit" className="rounded px-2 hover:bg-neutral-800">
            Fit
          </button>
          <button
            onClick={() => setZoom(zoom * 1.3)}
            title="Zoom in"
            className="rounded px-1.5 hover:bg-neutral-800"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div style={{ width: contentW }}>
            {/* ruler */}
            <div
              role="slider"
              aria-label="timeline scrubber"
              aria-valuenow={Math.round(playhead)}
              tabIndex={0}
              onPointerDown={onRulerDown}
              onContextMenu={(e) => {
                e.preventDefault();
                setBgMenu({ x: e.clientX, y: e.clientY });
              }}
              className={cn(
                "sticky top-0 z-20 h-5 select-none border-b border-edge bg-neutral-800/70",
                dragging ? "cursor-grabbing" : "cursor-grab",
              )}
            >
              <div
                className="pointer-events-none absolute top-0 h-full w-px bg-red-400"
                style={{ left: `${headPx}px` }}
              >
                <div className="absolute -left-1.5 -top-0.5 h-3 w-3 rounded-full border border-neutral-900 bg-red-400" />
              </div>
            </div>

            {/* lanes */}
            <div
              ref={lanesRef}
              className="relative"
              onPointerDown={(e) => {
                // Only an empty-lane press starts a marquee; a clip stops propagation first.
                if (e.button !== 0 || tool === "razor") return;
                const el = lanesRef.current;
                if (!el) return;
                const r = el.getBoundingClientRect();
                const origin = { x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top };
                marqueeStart.current = origin;
                setMarquee(null);
                const move = (ev: PointerEvent) => {
                  const o = marqueeStart.current;
                  if (!o) return;
                  setMarquee(
                    normalizeBox(o.x, o.y, ev.clientX - r.left + el.scrollLeft, ev.clientY - r.top),
                  );
                };
                const up = (ev: PointerEvent) => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  const o = marqueeStart.current;
                  marqueeStart.current = null;
                  setMarquee(null);
                  if (!o) return;
                  const box = normalizeBox(
                    o.x,
                    o.y,
                    ev.clientX - r.left + el.scrollLeft,
                    ev.clientY - r.top,
                  );
                  // A plain click clears the selection; only a real sweep selects.
                  if (!isMarqueeDrag(box)) {
                    // ...unless it landed in a gap, which Premiere makes selectable so Delete
                    // can close it. `selectGap` is a no-op off a gap and clears the clip
                    // selection on one, so this stays a single "what did you click" decision.
                    const ti = trackIndexAtY(ev.clientY);
                    const track = tracks[ti];
                    if (track) selectGap(String(track.id), xToFrame(localX(ev.clientX), fps, zoom));
                    else select(null);
                    return;
                  }
                  selectMany(idsInBox(clipSpans(), box));
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setBgMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {marquee && (
                <div
                  data-testid="marquee"
                  className="pointer-events-none absolute z-20 border border-accent bg-accent/20"
                  style={{
                    left: marquee.x0,
                    top: marquee.y0,
                    width: marquee.x1 - marquee.x0,
                    height: marquee.y1 - marquee.y0,
                  }}
                />
              )}
              {displayTracks.map(({ tr, ti }) => (
                <div
                  key={String(tr.id ?? ti)}
                  style={{ height: rowHFor(String(tr.kind ?? "video")) }}
                >
                  <div
                    className="flex items-center gap-1 px-3 pt-1 text-[10px] text-neutral-500"
                    onPointerDown={(e) => {
                      // Drag the label strip to restack. Only within the same kind: video
                      // never interleaves with audio, and z is what the compositor reads.
                      if (e.button !== 0) return;
                      const target = e.target as HTMLElement;
                      if (target.closest("button")) return; // mute/hide/lock/delete
                      e.preventDefault();
                      const kind = String(tr.kind ?? "video");
                      const group = displayTracks
                        .filter((m) => String(m.tr.kind ?? "video") === kind)
                        .map((m) => ({ id: String(m.tr.id), z: Number(m.tr.z) || 0 }));
                      const up = (ev: PointerEvent) => {
                        window.removeEventListener("pointerup", up);
                        const idx = trackIndexAtY(ev.clientY);
                        const dropped = tracks[idx];
                        if (!dropped || String(dropped.kind ?? "video") !== kind) return;
                        const to = group.findIndex((g) => g.id === String(dropped.id));
                        const changed = reorderZ(group, String(tr.id), to);
                        // ONE op: a restack that issued one set_track per track cost one
                        // Ctrl+Z per track to put back.
                        if (changed.length)
                          void setTracks(changed.map((c) => ({ trackId: c.id, z: c.z })));
                      };
                      window.addEventListener("pointerup", up);
                    }}
                  >
                    {/* Sticky: the header strip lives INSIDE the horizontal scroller, so
                        without this the name and the mute/hide/lock/delete controls slide
                        out of view and are only clickable at the far right of the content. */}
                    <span className="sticky left-0 z-10">
                      {tr.kind === "audio" ? "🎵" : tr.kind === "text" ? "🅣" : "🎬"}
                    </span>
                    <span className="sticky left-4 z-10">{labels[ti]}</span>
                    <div className="sticky right-0 z-10 ml-auto flex items-center gap-0.5">
                      {tr.kind === "audio" && (
                        <AudioMeter
                          channel={String(tr.id)}
                          label={`${labels[ti]} level`}
                          orientation="horizontal"
                          className="mr-1 w-8 shrink-0"
                        />
                      )}
                      {tr.kind === "audio" ? (
                        <button
                          aria-label={`mute ${labels[ti]}`}
                          aria-pressed={!!tr.mute}
                          title={tr.mute ? "Unmute" : "Mute"}
                          onClick={() => void setTrack(String(tr.id), { mute: !tr.mute })}
                          className={cn(
                            "rounded px-1 leading-none",
                            tr.mute ? "text-red-400" : "hover:text-neutral-200",
                          )}
                        >
                          {tr.mute ? "🔇" : "🔊"}
                        </button>
                      ) : (
                        <button
                          aria-label={`hide ${labels[ti]}`}
                          aria-pressed={!!tr.hidden}
                          title={tr.hidden ? "Show" : "Hide"}
                          onClick={() => void setTrack(String(tr.id), { hidden: !tr.hidden })}
                          className={cn(
                            "rounded px-1 leading-none",
                            tr.hidden ? "text-red-400" : "hover:text-neutral-200",
                          )}
                        >
                          {tr.hidden ? "🙈" : "👁"}
                        </button>
                      )}
                      <button
                        aria-label={`sync lock ${labels[ti]}`}
                        aria-pressed={tr.sync_locked !== false}
                        title={
                          tr.sync_locked !== false
                            ? "Sync locked: ripple edits shift this track to stay aligned — click to release"
                            : "Sync released: ripple edits leave this track in place — click to lock"
                        }
                        onClick={() =>
                          void setTrack(String(tr.id), { sync_locked: tr.sync_locked === false })
                        }
                        className={cn(
                          "rounded px-1 leading-none",
                          tr.sync_locked !== false
                            ? "text-neutral-500 hover:text-neutral-200"
                            : "text-amber-400",
                        )}
                      >
                        {tr.sync_locked !== false ? "🔒" : "🔓"}
                      </button>
                      <button
                        aria-label={`lock ${labels[ti]}`}
                        aria-pressed={tr.locked === true}
                        title={
                          tr.locked === true
                            ? "Locked: every edit on this track is refused — click to unlock"
                            : "Lock the track (refuses every edit to its clips)"
                        }
                        onClick={() => void setTrack(String(tr.id), { locked: tr.locked !== true })}
                        className={cn(
                          "rounded px-1 leading-none",
                          tr.locked === true ? "text-red-400" : "hover:text-neutral-200",
                        )}
                      >
                        {tr.locked === true ? "🔏" : "✎"}
                      </button>
                      <button
                        aria-label={`solo ${labels[ti]}`}
                        aria-pressed={tr.solo === true}
                        title={tr.solo === true ? "Soloed" : "Solo this track"}
                        onClick={() => void setTrack(String(tr.id), { solo: tr.solo !== true })}
                        className={cn(
                          "rounded px-1 leading-none",
                          tr.solo === true ? "text-amber-300" : "hover:text-neutral-200",
                        )}
                      >
                        S
                      </button>
                      <button
                        aria-label={`delete ${labels[ti]}`}
                        title="Delete track"
                        onClick={() => {
                          void (async () => {
                            const n = tr.clips?.length ?? 0;
                            if (
                              n > 0 &&
                              !(await confirmDestructive(
                                `Delete ${labels[ti]} and its ${n} clip(s)?`,
                              ))
                            )
                              return;
                            await removeTrack(String(tr.id));
                          })();
                        }}
                        className="rounded px-1 leading-none hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div
                    className={cn(
                      "relative bg-neutral-800/40",
                      dropTrack === String(tr.id) && "ring-1 ring-accent",
                    )}
                    data-track-id={String(tr.id)}
                    data-track-kind={String(tr.kind ?? "video")}
                    data-artdaddy-drop="track"
                    ref={(el) => registerLane(el, String(tr.id))}
                    style={{ height: laneHFor(String(tr.kind ?? "video")) }}
                    onDragOver={(e) => {
                      // Web only: on desktop the page must not claim the drag (see osDrop).
                      if (!webOwnsFileDrops()) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDropTrack(String(tr.id));
                    }}
                    onDragLeave={() => setDropTrack((t) => (t === String(tr.id) ? null : t))}
                    onDrop={(e) => {
                      // Web only: on desktop Tauri owns file drops. In-app drags are pointer-based
                      // on BOTH platforms, so there is no dataTransfer payload to read here.
                      if (!webOwnsFileDrops()) return;
                      e.preventDefault();
                      setDropTrack(null);
                      const files = [...(e.dataTransfer.files ?? [])];
                      if (!files.length) return;
                      const frame = Math.max(0, xToFrame(localX(e.clientX), fps, zoom));
                      void importFiles(files, String(tr.id), frame);
                    }}
                  >
                    {dropGhost && dropGhost.trackId === String(tr.id) && (
                      <div
                        data-testid="drop-ghost"
                        data-frame={dropGhost.frame}
                        className="pointer-events-none absolute inset-y-0 z-20"
                        style={{ left: frameToX(dropGhost.frame, fps, zoom) }}
                      >
                        {/* The landing EDGE is exact; the extent is dashed because the clip's
                            length is not known until it is probed on drop. */}
                        <div
                          className="absolute inset-y-0 left-0 rounded-sm border-2 border-dashed border-accent bg-accent/20"
                          style={{ width: frameToX(Math.round(fps * 3), fps, zoom) }}
                        />
                        <div className="absolute inset-y-0 left-0 w-0.5 bg-accent shadow-[0_0_6px_2px_rgba(99,102,241,.7)]" />
                        <div className="absolute -top-0.5 left-0 h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-accent" />
                      </div>
                    )}
                    {gapBox && gapBox.trackId === String(tr.id) && (
                      <div
                        data-testid="gap-selection"
                        data-track-id={gapBox.trackId}
                        data-start={gapBox.start}
                        data-end={gapBox.end}
                        className="pointer-events-none absolute inset-y-0 border border-accent bg-accent/25"
                        style={{
                          left: frameToX(gapBox.start, fps, zoom),
                          width: Math.max(
                            2,
                            frameToX(gapBox.end, fps, zoom) - frameToX(gapBox.start, fps, zoom),
                          ),
                        }}
                      />
                    )}
                    {(tr.clips ?? []).map((c, ci) => {
                      const id = clipId(c, `${labels[ti]}:${ci}`);
                      const pv = preview && preview.clipId === id ? preview : null;
                      const inF = pv ? pv.in : Number(c.timeline_in) || 0;
                      const outF = pv ? pv.out : Number(c.timeline_out) || 0;
                      const left = frameToX(inF, fps, zoom);
                      const width = Math.max(2, frameToX(outF, fps, zoom) - left);
                      const isSel = selectedIds.includes(id);
                      return (
                        <div
                          key={id}
                          data-clip-id={id}
                          onPointerDown={(e) => {
                            if (tool === "razor") {
                              e.preventDefault();
                              e.stopPropagation();
                              const at = razorFrame(c, xToFrame(localX(e.clientX), fps, zoom));
                              if (at !== null) void splitClip(id, at);
                              return;
                            }
                            // Slip / slide / roll are TOOLS, not modifiers: Alt already means
                            // "no snap" on a move and Ctrl already means additive select, so
                            // binding them to modifiers silently hijacked both.
                            if (tool === "roll") {
                              e.preventDefault();
                              e.stopPropagation();
                              const at = xToFrame(localX(e.clientX), fps, zoom);
                              const tin = Number(c.timeline_in) || 0;
                              const tout = Number(c.timeline_out) || 0;
                              const cut = at - tin < tout - at ? tin : tout;
                              const outgoing = (tr.clips ?? []).find(
                                (o) => (Number(o.timeline_out) || 0) === cut,
                              );
                              if (outgoing?.id) startRoll(String(outgoing.id), cut, e);
                              return;
                            }
                            startDrag(
                              {
                                mode: "move",
                                clipId: id,
                                trackId: String(tr.id ?? ""),
                                startX: localX(e.clientX),
                                origIn: Number(c.timeline_in) || 0,
                                len: (Number(c.timeline_out) || 0) - (Number(c.timeline_in) || 0),
                                kind: String(tr.kind ?? "video"),
                                variant:
                                  tool === "slip" ? "slip" : tool === "slide" ? "slide" : undefined,
                                duplicate: e.altKey,
                                ignoreLinks: e.altKey,
                                movingIds: e.altKey ? [id] : travellingWith(id),
                              },
                              e,
                            );
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (tool === "razor") return;
                            // Premiere adds to a selection with Shift; Ctrl/Cmd stays for anyone
                            // who has already learned it here.
                            select(id, { additive: e.shiftKey || e.ctrlKey || e.metaKey });
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!selectedIds.includes(id)) select(id);
                            setMenu({ x: e.clientX, y: e.clientY, clipId: id });
                          }}
                          style={{ left: `${left}px`, width: `${width}px` }}
                          title={clipLabel(c, mediaNames)}
                          className={cn(
                            "group absolute inset-y-0.5 cursor-grab overflow-hidden rounded border text-left text-[10px] leading-7 text-neutral-100",
                            isSel
                              ? "z-10 border-white bg-accent/50 ring-1 ring-white"
                              : "border-accent/40 bg-accent/25 hover:bg-accent/40",
                          )}
                        >
                          {tr.kind === "audio" ? (
                            <ClipWaveform
                              store={store}
                              source={String(c.media_ref ?? "")}
                              inSec={(Number(c.source_in) || 0) / fps}
                              outSec={
                                (Number(c.source_out) > (Number(c.source_in) || 0)
                                  ? Number(c.source_out)
                                  : (Number(c.source_in) || 0) +
                                    Math.max(0, Number(c.timeline_out) - Number(c.timeline_in))) /
                                fps
                              }
                            />
                          ) : (
                            <ClipThumbnail
                              store={store}
                              clip={c}
                              kind={String(tr.kind ?? "")}
                              status={mediaStatus?.[String(c.media_ref ?? "")]}
                            />
                          )}
                          {tr.kind !== "text" && (
                            <span className="pointer-events-none relative block truncate px-2">
                              {clipLabel(c, mediaNames)}
                            </span>
                          )}
                          {tr.kind === "audio" && (
                            <VolumeBand
                              clip={c}
                              clipId={id}
                              inF={inF}
                              outF={outF}
                              preview={pv}
                              onGrab={(keyT, bandTop, bandH, ev) =>
                                startDrag(
                                  {
                                    mode: "volume-key",
                                    clipId: id,
                                    startX: localX(ev.clientX),
                                    origIn: inF,
                                    origOut: outF,
                                    keyT,
                                    bandTop,
                                    bandH,
                                  },
                                  ev,
                                )
                              }
                              onAdd={(at, gain) => void setKeyframe(id, "volume", at, gain)}
                              toFrame={(clientX) => xToFrame(localX(clientX), fps, zoom)}
                            />
                          )}
                          {(() => {
                            // The fade RAMP and its knob read the same frames, so the wedge can
                            // never disagree with where the handle sits. The ghost wins mid-drag.
                            const span = Math.max(1, outF - inF);
                            const fin = pv?.fadeIn ?? (Number(c.fade?.in) || 0);
                            const fout = pv?.fadeOut ?? (Number(c.fade?.out) || 0);
                            const pxOf = (f: number) => (f / span) * width;
                            // The clip box is `overflow-hidden`, so a knob that hangs over the
                            // edge is half unhittable — the pointer lands on the lane behind it
                            // and the drag silently never starts. Keep the whole knob inside.
                            const KNOB = 10;
                            // ...and keep it clear of the TRIM_W strip the trim handles own. The
                            // knob is z-20 and the trim handle is not, so a knob resting at 0 (the
                            // resting place of EVERY un-faded clip) covered the top of the trim
                            // strip: the same edge, the same ew-resize cursor, two different
                            // gestures, and nothing on screen saying which one you had. Hovering
                            // there also lit the trim strip's highlight — through the knob — so it
                            // read as a dot that isn't clickable sitting on the trim edge.
                            const inset = (px: number) =>
                              Math.max(TRIM_W, Math.min(width - KNOB - TRIM_W, px - KNOB / 2));
                            // Below this there is no room for two knobs plus both trim strips;
                            // drawing them anyway just puts the collision back.
                            const roomForKnobs = width >= 2 * (TRIM_W + KNOB);
                            return (
                              <>
                                {fin > 0 && (
                                  <span
                                    aria-hidden
                                    className="pointer-events-none absolute inset-y-0 left-0 bg-neutral-950/55"
                                    style={{
                                      width: `${pxOf(fin)}px`,
                                      clipPath: "polygon(0 0, 100% 0, 0 100%)",
                                    }}
                                  />
                                )}
                                {fout > 0 && (
                                  <span
                                    aria-hidden
                                    className="pointer-events-none absolute inset-y-0 right-0 bg-neutral-950/55"
                                    style={{
                                      width: `${pxOf(fout)}px`,
                                      clipPath: "polygon(100% 0, 100% 100%, 0 0)",
                                    }}
                                  />
                                )}
                                {roomForKnobs &&
                                  (["in", "out"] as const).map((edge) => (
                                    <span
                                      key={edge}
                                      role="slider"
                                      aria-label={`fade ${edge}`}
                                      aria-valuenow={edge === "in" ? fin : fout}
                                      tabIndex={-1}
                                      title={
                                        edge === "in"
                                          ? "Drag right for a fade in"
                                          : "Drag left for a fade out"
                                      }
                                      onPointerDown={(ev) => {
                                        ev.stopPropagation();
                                        startDrag(
                                          {
                                            mode: edge === "in" ? "fade-in" : "fade-out",
                                            clipId: id,
                                            startX: localX(ev.clientX),
                                            origIn: inF,
                                            origOut: outF,
                                          },
                                          ev,
                                        );
                                      }}
                                      className={cn(
                                        "absolute top-0 z-20 h-2.5 w-2.5 cursor-ew-resize rounded-full border border-white/80 bg-neutral-900/80 hover:border-white hover:bg-accent",
                                        // A knob on every edge of every clip is just noise when
                                        // there is no fade to see. Show it when it MEANS something
                                        // (a fade exists, or the clip is selected), and otherwise
                                        // only once the pointer is on the clip and about to reach
                                        // for it.
                                        (edge === "in" ? fin : fout) > 0 || isSel
                                          ? "opacity-100"
                                          : "opacity-0 group-hover:opacity-100",
                                      )}
                                      style={
                                        edge === "in"
                                          ? { left: `${inset(pxOf(fin))}px` }
                                          : { right: `${inset(pxOf(fout))}px` }
                                      }
                                    />
                                  ))}
                              </>
                            );
                          })()}
                          <span
                            role="separator"
                            aria-label="trim start"
                            onPointerDown={(e) =>
                              // Alt suppresses the trim handle entirely (other NLEs'
                              // `trimEdge = isOption ? nil : ...`): the drag becomes a duplicate,
                              // which is what stops an Alt+drag near an edge trimming by accident.
                              e.altKey
                                ? startDrag(
                                    {
                                      mode: "move",
                                      clipId: id,
                                      trackId: String(tr.id ?? ""),
                                      startX: localX(e.clientX),
                                      origIn: inF,
                                      len: outF - inF,
                                      kind: String(tr.kind ?? "video"),
                                      duplicate: true,
                                      ignoreLinks: true,
                                    },
                                    e,
                                  )
                                : startDrag(
                                    {
                                      mode: "trim-l",
                                      clipId: id,
                                      startX: localX(e.clientX),
                                      origIn: inF,
                                      origOut: outF,
                                      ripple: e.shiftKey,
                                      ...sourceWindowOf(c),
                                    },
                                    e,
                                  )
                            }
                            style={{ width: TRIM_W }}
                            className="absolute inset-y-0 left-0 cursor-ew-resize bg-white/0 hover:bg-white/30"
                          />
                          <span
                            role="separator"
                            aria-label="trim end"
                            onPointerDown={(e) =>
                              e.altKey
                                ? startDrag(
                                    {
                                      mode: "move",
                                      clipId: id,
                                      trackId: String(tr.id ?? ""),
                                      startX: localX(e.clientX),
                                      origIn: inF,
                                      len: outF - inF,
                                      kind: String(tr.kind ?? "video"),
                                      duplicate: true,
                                      ignoreLinks: true,
                                    },
                                    e,
                                  )
                                : startDrag(
                                    {
                                      mode: "trim-r",
                                      clipId: id,
                                      startX: localX(e.clientX),
                                      origIn: inF,
                                      origOut: outF,
                                      ripple: e.shiftKey,
                                      ...sourceWindowOf(c),
                                    },
                                    e,
                                  )
                            }
                            style={{ width: TRIM_W }}
                            className="absolute inset-y-0 right-0 cursor-ew-resize bg-white/0 hover:bg-white/30"
                          />
                          {isSel &&
                            keyframeTimes([c.rotate, c.opacity, c.volume]).map((t) => (
                              <span
                                key={`kf-${t}`}
                                role="button"
                                aria-label={`keyframe at ${t}`}
                                title={`Keyframe @ frame ${inF + t}`}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPlayhead((inF + t) / fps);
                                }}
                                style={{ left: `${frameToX(t, fps, zoom)}px` }}
                                className="absolute bottom-0.5 h-2 w-2 -translate-x-1/2 rotate-45 cursor-pointer bg-amber-300 ring-1 ring-neutral-900 hover:bg-amber-200"
                              />
                            ))}
                        </div>
                      );
                    })}
                    {(tr.clips ?? []).map((c, ci) => {
                      // Premiere-style transition: a widget CENTRED on the cut with
                      // two grabbable edges (both resize the duration symmetrically).
                      const trans = parseTransitionIn(c);
                      if (!trans) return null;
                      const id = clipId(c, `${labels[ti]}:${ci}`);
                      const pvw = preview && preview.clipId === id ? preview : null;
                      const cutPx = frameToX(pvw ? pvw.in : Number(c.timeline_in) || 0, fps, zoom);
                      const transDur =
                        transPreview?.clipId === id ? transPreview.duration : trans.duration;
                      const cs = [...(tr.clips ?? [])].sort(
                        (a, b) => (Number(a.timeline_in) || 0) - (Number(b.timeline_in) || 0),
                      );
                      const prev = cs[cs.indexOf(c) - 1];
                      const cl = (Number(c.timeline_out) || 0) - (Number(c.timeline_in) || 0);
                      const pl = prev
                        ? (Number(prev.timeline_out) || 0) - (Number(prev.timeline_in) || 0)
                        : 0;
                      const maxTransF = Math.max(1, Math.min(cl, pl));
                      const halfPx = frameToX(transDur / 2, fps, zoom);
                      return (
                        <div
                          key={`trans-${id}`}
                          className="pointer-events-none absolute inset-y-1 z-30"
                          style={{
                            left: `${cutPx - halfPx}px`,
                            width: `${Math.max(6, halfPx * 2)}px`,
                          }}
                        >
                          <div className="absolute inset-0 overflow-hidden rounded-sm border border-sky-300/70 bg-sky-500/20">
                            <span
                              className="absolute inset-0 opacity-80"
                              style={{
                                background:
                                  "linear-gradient(to top right, transparent calc(50% - 0.5px), rgba(186,230,253,0.9) 50%, transparent calc(50% + 0.5px)), linear-gradient(to bottom right, transparent calc(50% - 0.5px), rgba(186,230,253,0.9) 50%, transparent calc(50% + 0.5px))",
                              }}
                            />
                          </div>
                          <span
                            role="separator"
                            aria-label="transition resize start"
                            title={`${trans.kind} · ${transDur}f — drag either edge`}
                            onPointerDown={(e) =>
                              startTransResize(e, id, trans.kind, trans.expr, cutPx, "l", maxTransF)
                            }
                            className="pointer-events-auto absolute inset-y-0 left-0 flex w-2 -translate-x-1/2 cursor-ew-resize justify-center"
                          >
                            <span className="h-full w-1 rounded bg-sky-200" />
                          </span>
                          <span
                            role="separator"
                            aria-label="transition resize end"
                            title={`${trans.kind} · ${transDur}f — drag either edge`}
                            onPointerDown={(e) =>
                              startTransResize(e, id, trans.kind, trans.expr, cutPx, "r", maxTransF)
                            }
                            className="pointer-events-auto absolute inset-y-0 right-0 flex w-2 translate-x-1/2 cursor-ew-resize justify-center"
                          >
                            <span className="h-full w-1 rounded bg-sky-200" />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {tracks.length === 0 && (
                <p className="px-3 py-2 text-xs text-neutral-600">Empty — no tracks.</p>
              )}
              {selectedRange && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-0 border-x border-accent/60 bg-accent/15"
                  style={{
                    left: `${frameToX(selectedRange.startFrame, fps, zoom)}px`,
                    width: `${Math.max(2, frameToX(selectedRange.endFrame, fps, zoom) - frameToX(selectedRange.startFrame, fps, zoom))}px`,
                  }}
                />
              )}
              <div
                className="pointer-events-none absolute inset-y-0 z-10 w-px bg-red-400/80"
                style={{ left: `${headPx}px` }}
              />
            </div>
          </div>
        </div>
        <div
          className="flex w-9 shrink-0 flex-col items-stretch gap-1 border-l border-edge bg-neutral-900/40 py-1"
          title="Track height (video / audio)"
        >
          <VZoom
            kind="video"
            icon="🎬"
            value={trackScale.video}
            onChange={(v) => setTrackScale("video", v)}
          />
          <VZoom
            kind="audio"
            icon="🎵"
            value={trackScale.audio}
            onChange={(v) => setTrackScale("audio", v)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-edge px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-neutral-600">Zoom</span>
        <div ref={zoomBarRef} className="relative h-3 flex-1 rounded bg-neutral-800/60">
          <div
            role="scrollbar"
            aria-label="timeline zoom"
            aria-valuenow={Math.round(thumb.width * 100)}
            onPointerDown={(e) => startZoomDrag("pan", e)}
            className="absolute inset-y-0 cursor-grab rounded bg-neutral-600/80 hover:bg-neutral-500"
            style={{ left: `${thumb.left * 100}%`, width: `${thumb.width * 100}%` }}
          >
            <span
              aria-label="zoom start"
              onPointerDown={(e) => startZoomDrag("l", e)}
              className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l bg-neutral-300/80"
            />
            <span
              aria-label="zoom end"
              onPointerDown={(e) => startZoomDrag("r", e)}
              className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-neutral-300/80"
            />
          </div>
        </div>
      </div>
      {menu && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            role="menu"
            className="absolute min-w-32 rounded border border-edge bg-neutral-800 py-1 text-xs text-neutral-200 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                const ids =
                  selectedIds.includes(menu.clipId) && selectedIds.length
                    ? selectedIds
                    : [menu.clipId];
                for (const cid of ids) {
                  const f = findClipWithTrack(tracks, cid);
                  if (f) addMention(buildClipMention(f.clip, f.trackId));
                }
                setMenu(null);
              }}
            >
              Add to chat
            </button>
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                void splitClip(menu.clipId, playheadFrame);
                setMenu(null);
              }}
            >
              Split at playhead
            </button>
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                void duplicateClip(menu.clipId);
                setMenu(null);
              }}
            >
              Duplicate
            </button>
            {selectedIds.length >= 2 && (
              <button
                role="menuitem"
                className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
                onClick={() => {
                  void linkClips(selectedIds);
                  setMenu(null);
                }}
              >
                Link {selectedIds.length} clips
              </button>
            )}
            {findClipWithTrack(tracks, menu.clipId)?.clip.link_group && (
              <button
                role="menuitem"
                className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
                onClick={() => {
                  void unlinkClips([menu.clipId]);
                  setMenu(null);
                }}
              >
                Unlink
              </button>
            )}
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                copyClip(menu.clipId);
                setMenu(null);
              }}
            >
              Copy
            </button>
            {clipboard && (
              <button
                role="menuitem"
                className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
                onClick={() => {
                  void pasteClip();
                  setMenu(null);
                }}
              >
                Paste
              </button>
            )}
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                void deleteClips([menu.clipId]);
                setMenu(null);
              }}
            >
              Delete
            </button>
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                void rippleDeleteClip(menu.clipId);
                setMenu(null);
              }}
            >
              Ripple delete
            </button>
          </div>
        </div>
      )}
      {bgMenu && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => setBgMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setBgMenu(null);
          }}
        >
          <div
            role="menu"
            className="absolute min-w-44 rounded border border-edge bg-neutral-800 py-1 text-xs text-neutral-200 shadow-lg"
            style={{ left: bgMenu.x, top: bgMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
              onClick={() => {
                addMention(buildPlayheadMention(playheadFrame, fps));
                setBgMenu(null);
              }}
            >
              Add playhead to chat
            </button>
            {selectedRange && (
              <button
                role="menuitem"
                className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
                onClick={() => {
                  addMention(
                    buildRangeMention(selectedRange.startFrame, selectedRange.endFrame, fps),
                  );
                  setBgMenu(null);
                }}
              >
                Add selected range to chat
              </button>
            )}
            {selectedRange && (
              <button
                role="menuitem"
                className="block w-full px-3 py-1 text-left text-neutral-400 hover:bg-neutral-700"
                onClick={() => {
                  setSelectedRange(null);
                  setBgMenu(null);
                }}
              >
                Clear range
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
