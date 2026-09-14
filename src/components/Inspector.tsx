// The clip inspector (left column, above the project/files). Shows the selected
// clip's properties by kind (transform/playback/crop for visuals, audio for
// audio, text style for text) and writes them through the shared
// set_clip_properties op. With nothing selected it shows canvas settings.
import type { ReactNode } from "react";

import { useEditor } from "../store/editor";
import { sampleAnim } from "../timeline/anim";
import { findClip } from "../timeline/helpers";
import {
  isAnimated,
  keyframeAt,
  nextKeyframeTime,
  prevKeyframeTime,
  removeKeyframe,
  toConstant,
  toKeyframes,
  upsertKeyframe,
} from "../timeline/keyframe";
import type { Animatable, Clip } from "../timeline/model";
import { parseTransitionIn, TRANSITION_KINDS, TRANSITION_LABELS } from "../timeline/transition";
import { KeyframeLane } from "./KeyframeLane";
import { Pane, PaneSection } from "./Pane";
import { ScrubInput } from "./ScrubInput";
import { cn } from "./ui";

function asNum(v: unknown, d: number): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length && typeof (v[0] as { v?: unknown })?.v === "number")
    return (v[0] as { v: number }).v;
  return d;
}

// A numeric field with Premiere/CapCut-style keyframing: a stopwatch toggles the
// property between a constant and an animated curve, and when animated a diamond
// adds/removes a key at the playhead while ‹ › jump between keys. Editing the value
// while animated upserts a key at the playhead. All keyframe times are clip-relative frames.
interface KeyframeFieldProps {
  name: string;
  value: Animatable | undefined;
  fallback: number;
  relFrame: number;
  timelineIn: number;
  fps: number;
  setPlayhead: (sec: number) => void;
  write: (next: Animatable) => void;
  coerce?: (v: number) => number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
}

function KeyframeField({
  name,
  value,
  fallback,
  relFrame,
  timelineIn,
  fps,
  setPlayhead,
  write,
  coerce,
  ...scrub
}: KeyframeFieldProps) {
  const animated = isAnimated(value);
  const round = coerce ?? ((v: number) => v);
  const shown = animated ? sampleAnim(value, relFrame, fallback) : asNum(value, fallback);
  const hasKey = keyframeAt(value, relFrame) !== undefined;
  const seek = (t: number | undefined) => {
    if (t !== undefined) setPlayhead((timelineIn + t) / fps);
  };
  const toggleKey = () => {
    if (hasKey) {
      const next = removeKeyframe(value, relFrame);
      if (next !== undefined) write(next);
    } else {
      write(upsertKeyframe(value, relFrame, round(shown)));
    }
  };
  return (
    <>
      <ScrubInput
        aria-label={name}
        className="flex-1"
        value={shown}
        onChange={(v) => write(animated ? upsertKeyframe(value, relFrame, round(v)) : round(v))}
        {...scrub}
      />
      <button
        type="button"
        aria-label={`keyframe ${name}`}
        aria-pressed={animated}
        title={animated ? "Disable keyframes" : "Enable keyframes"}
        onClick={() =>
          write(
            animated
              ? round(toConstant(value, relFrame, fallback))
              : toKeyframes(value, relFrame, fallback),
          )
        }
        className={cn(
          "shrink-0 rounded px-1 text-[11px] leading-none",
          animated ? "text-accent" : "text-neutral-500 hover:text-neutral-300",
        )}
      >
        ⏱
      </button>
      {animated && (
        <span className="flex shrink-0 items-center text-[11px] leading-none">
          <button
            type="button"
            aria-label={`prev keyframe ${name}`}
            title="Previous keyframe"
            onClick={() => seek(prevKeyframeTime(value, relFrame))}
            className="px-0.5 text-neutral-500 hover:text-neutral-200"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label={`toggle keyframe ${name}`}
            aria-pressed={hasKey}
            title={hasKey ? "Remove keyframe" : "Add keyframe"}
            onClick={toggleKey}
            className={cn(
              "px-0.5",
              hasKey ? "text-accent" : "text-neutral-500 hover:text-neutral-200",
            )}
          >
            {hasKey ? "◆" : "◇"}
          </button>
          <button
            type="button"
            aria-label={`next keyframe ${name}`}
            title="Next keyframe"
            onClick={() => seek(nextKeyframeTime(value, relFrame))}
            className="px-0.5 text-neutral-500 hover:text-neutral-200"
          >
            ›
          </button>
        </span>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  // `min-w-0` is load-bearing: without it a flex child refuses to shrink below its
  // content width, so the controls overflow the panel and stop being hit-testable
  // (they still report a correct getBoundingClientRect, so only a real click finds
  // it). `flex-wrap` + a basis lets the control drop under its label instead of
  // being squeezed out when the panel is dragged narrow.
  return (
    <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 basis-24 items-center gap-1">{children}</div>
    </label>
  );
}
// Sections remember whether they are open, keyed by title — panel groups in other NLEs, which is a
// SECTION container in their inspector rather than their window splitter.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PaneSection title={title} id={`inspector.${title}`}>
      {children}
    </PaneSection>
  );
}
const fieldCls =
  "w-full rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-100 outline-none";

export default function Inspector({ onHide }: { onHide?: () => void } = {}) {
  const timeline = useEditor((s) => s.timeline);
  const selection = useEditor((s) => s.selection);
  const setClipProperties = useEditor((s) => s.setClipProperties);
  const setCanvas = useEditor((s) => s.setCanvas);
  const setTransition = useEditor((s) => s.setTransition);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  const canvas = timeline?.canvas;
  const found = timeline && selection ? findClip(timeline, selection) : null;

  if (!found || !canvas) {
    return (
      <Pane title="Inspector" onHide={onHide}>
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
          Project
        </div>
        {canvas ? (
          <Section title="Canvas">
            <Row label="Width">
              <ScrubInput
                aria-label="canvas width"
                value={canvas.width}
                min={16}
                step={2}
                onChange={(v) => void setCanvas({ width: Math.round(v) })}
              />
            </Row>
            <Row label="Height">
              <ScrubInput
                aria-label="canvas height"
                value={canvas.height}
                min={16}
                step={2}
                onChange={(v) => void setCanvas({ height: Math.round(v) })}
              />
            </Row>
            <Row label="FPS">
              <ScrubInput
                aria-label="canvas fps"
                value={canvas.fps}
                min={1}
                max={120}
                onChange={(v) => void setCanvas({ fps: Math.round(v) })}
              />
            </Row>
          </Section>
        ) : (
          <p className="px-3 py-2 text-xs text-neutral-600">No clip selected.</p>
        )}
      </Pane>
    );
  }

  const [track, clip] = found;
  const kind = String(track.kind ?? "video");
  const id = String(clip.id);
  const update = (props: Record<string, unknown>) => void setClipProperties(id, props);

  const fps = Number(canvas.fps) || 30;
  const tin = Number(clip.timeline_in) || 0;
  const dur = Math.max(0, (Number(clip.timeline_out) || 0) - tin);
  const relFrame = Math.min(Math.max(0, Math.round(playhead * fps) - tin), dur);
  const kf = (p: Omit<KeyframeFieldProps, "relFrame" | "timelineIn" | "fps" | "setPlayhead">) => (
    <KeyframeField
      {...p}
      relFrame={relFrame}
      timelineIn={tin}
      fps={fps}
      setPlayhead={setPlayhead}
    />
  );

  // Normalized transform: position the clip by its CENTRE in 0..1 canvas coords
  // with a scale multiplier (1.0 = full canvas). `fit` is a sibling. setPosition
  // keeps sibling transform values RAW so editing X doesn't drop scale.
  const transform = (
    clip.transform && typeof clip.transform === "object" ? clip.transform : {}
  ) as {
    position?: { x?: unknown; y?: unknown };
    scale?: unknown;
    [k: string]: unknown;
  };
  const fit = typeof clip.fit === "string" ? clip.fit : "contain";
  const setTransform = (patch: Record<string, unknown>) =>
    update({ transform: { ...transform, ...patch } });
  const setPosition = (patch: Record<string, unknown>) =>
    update({ transform: { ...transform, position: { ...(transform.position ?? {}), ...patch } } });
  const crop = {
    left: asNum(clip.crop?.left, 0),
    top: asNum(clip.crop?.top, 0),
    right: asNum(clip.crop?.right, 0),
    bottom: asNum(clip.crop?.bottom, 0),
  };
  const setCrop = (patch: Partial<typeof crop>) => update({ crop: { ...crop, ...patch } });
  const fade = { in: asNum(clip.fade?.in, 0), out: asNum(clip.fade?.out, 0) };
  const setFade = (patch: Partial<typeof fade>) => update({ fade: { ...fade, ...patch } });
  const style = (clip.style && typeof clip.style === "object" ? clip.style : {}) as Record<
    string,
    unknown
  >;
  const setStyle = (patch: Record<string, unknown>) => update({ style: { ...style, ...patch } });
  const rawColor = (clip.color && typeof clip.color === "object" ? clip.color : {}) as Record<
    string,
    unknown
  >;
  const setColor = (patch: Record<string, unknown>) => update({ color: { ...rawColor, ...patch } });

  // Transition: an inbound crossfade from the previous same-track clip. Only
  // possible when there IS a preceding clip; duration <= both clips' lengths.
  const trans = parseTransitionIn(clip);
  const trackClips = [...(track.clips ?? [])].sort(
    (a, b) => (Number(a.timeline_in) || 0) - (Number(b.timeline_in) || 0),
  );
  const prevClip = trackClips[trackClips.findIndex((c) => String(c.id) === id) - 1] ?? null;
  const clipLenF = (Number(clip.timeline_out) || 0) - (Number(clip.timeline_in) || 0);
  const prevLenF = prevClip
    ? (Number(prevClip.timeline_out) || 0) - (Number(prevClip.timeline_in) || 0)
    : 0;
  const maxTransF = Math.max(1, Math.min(clipLenF, prevLenF));

  return (
    <Pane title="Inspector" onHide={onHide}>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
        <span>{kind === "audio" ? "🎵" : kind === "text" ? "🅣" : "🎬"}</span>
        <span className="truncate normal-case text-neutral-300">{clipTitle(clip)}</span>
      </div>

      <KeyframeLane
        clip={clip}
        clipId={id}
        kind={kind}
        duration={dur}
        relFrame={relFrame}
        onSeek={(rel) => setPlayhead((tin + Math.max(0, Math.min(dur, rel))) / fps)}
      />

      {kind === "text" && (
        <Section title="Text">
          <textarea
            aria-label="text content"
            value={typeof clip.text === "string" ? clip.text : ""}
            onChange={(e) => update({ text: e.target.value })}
            rows={2}
            className="mb-1 w-full resize-none rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 outline-none"
          />
          <Row label="Font">
            <input
              aria-label="font"
              value={String(style.font ?? "sans-serif")}
              onChange={(e) => setStyle({ font: e.target.value })}
              className={fieldCls}
            />
          </Row>
          <Row label="Size">
            <ScrubInput
              aria-label="font size"
              value={asNum(style.size, Math.round(canvas.height * 0.06))}
              min={1}
              onChange={(v) => setStyle({ size: Math.round(v) })}
            />
          </Row>
          <Row label="Color">
            <input
              type="color"
              aria-label="color"
              value={String(style.color ?? "#ffffff")}
              onChange={(e) => setStyle({ color: e.target.value })}
              className="h-6 w-full rounded bg-neutral-800"
            />
          </Row>
          <Row label="Align">
            <select
              aria-label="align"
              value={String(style.align ?? "center")}
              onChange={(e) => setStyle({ align: e.target.value })}
              className={fieldCls}
            >
              <option value="left">left</option>
              <option value="center">center</option>
              <option value="right">right</option>
            </select>
          </Row>
        </Section>
      )}

      {kind !== "audio" && (
        <Section title="Transform">
          <Row label="Pos X">
            {kf({
              name: "px",
              value: transform.position?.x as number | undefined,
              fallback: 0.5,
              min: 0,
              max: 1,
              step: 0.01,
              precision: 3,
              write: (next) => setPosition({ x: next }),
            })}
          </Row>
          <Row label="Pos Y">
            {kf({
              name: "py",
              value: transform.position?.y as number | undefined,
              fallback: 0.5,
              min: 0,
              max: 1,
              step: 0.01,
              precision: 3,
              write: (next) => setPosition({ y: next }),
            })}
          </Row>
          <Row label="Scale">
            {kf({
              name: "scale",
              value: transform.scale as number | undefined,
              fallback: 1,
              min: 0.01,
              step: 0.01,
              precision: 3,
              write: (next) => setTransform({ scale: next }),
            })}
          </Row>
          {/* Per-axis scale multiplies the uniform one, so a squash/stretch is a separate
              intent from "make it bigger". Both were agent-only until now. */}
          <Row label="Scale X">
            {kf({
              name: "scale x",
              value: transform.scale_x as number | undefined,
              fallback: 1,
              min: 0.01,
              step: 0.01,
              precision: 3,
              write: (next) => setTransform({ scale_x: next }),
            })}
          </Row>
          <Row label="Scale Y">
            {kf({
              name: "scale y",
              value: transform.scale_y as number | undefined,
              fallback: 1,
              min: 0.01,
              step: 0.01,
              precision: 3,
              write: (next) => setTransform({ scale_y: next }),
            })}
          </Row>
          <Row label="Fit">
            <select
              aria-label="fit"
              value={fit}
              onChange={(e) => update({ fit: e.target.value })}
              className={fieldCls}
            >
              <option value="contain">contain</option>
              <option value="cover">cover</option>
              <option value="stretch">stretch</option>
            </select>
          </Row>
          <Row label="Rotate">
            {kf({
              name: "rotate",
              value: clip.rotate,
              fallback: 0,
              suffix: "°",
              write: (next) => update({ rotate: next }),
            })}
          </Row>
          <Row label="Opacity">
            {kf({
              name: "opacity",
              value: clip.opacity,
              fallback: 1,
              min: 0,
              max: 1,
              step: 0.02,
              precision: 2,
              write: (next) => update({ opacity: next }),
            })}
          </Row>
        </Section>
      )}

      {kind !== "audio" && kind !== "text" && (
        <>
          <Section title="Playback">
            <Row label="Speed">
              <ScrubInput
                aria-label="speed"
                value={asNum(clip.speed, 1)}
                min={0.1}
                step={0.05}
                precision={2}
                suffix="x"
                onChange={(v) => update(speedProps(clip, v))}
              />
            </Row>
          </Section>
          <Section title="Crop">
            <Row label="Left">
              <ScrubInput
                aria-label="crop left"
                value={crop.left}
                min={0}
                max={0.99}
                step={0.01}
                precision={2}
                onChange={(v) => setCrop({ left: v })}
              />
            </Row>
            <Row label="Right">
              <ScrubInput
                aria-label="crop right"
                value={crop.right}
                min={0}
                max={0.99}
                step={0.01}
                precision={2}
                onChange={(v) => setCrop({ right: v })}
              />
            </Row>
            <Row label="Top">
              <ScrubInput
                aria-label="crop top"
                value={crop.top}
                min={0}
                max={0.99}
                step={0.01}
                precision={2}
                onChange={(v) => setCrop({ top: v })}
              />
            </Row>
            <Row label="Bottom">
              <ScrubInput
                aria-label="crop bottom"
                value={crop.bottom}
                min={0}
                max={0.99}
                step={0.01}
                precision={2}
                onChange={(v) => setCrop({ bottom: v })}
              />
            </Row>
          </Section>
          <Section title="Color">
            <Row label="Bright">
              <ScrubInput
                aria-label="brightness"
                value={asNum(clip.color?.brightness, 0)}
                min={-1}
                max={1}
                step={0.02}
                precision={2}
                onChange={(v) => setColor({ brightness: v })}
              />
            </Row>
            <Row label="Contrast">
              <ScrubInput
                aria-label="contrast"
                value={asNum(clip.color?.contrast, 1)}
                min={0}
                max={4}
                step={0.02}
                precision={2}
                onChange={(v) => setColor({ contrast: v })}
              />
            </Row>
            <Row label="Sat">
              <ScrubInput
                aria-label="saturation"
                value={asNum(clip.color?.saturation, 1)}
                min={0}
                max={4}
                step={0.02}
                precision={2}
                onChange={(v) => setColor({ saturation: v })}
              />
            </Row>
            <Row label="Gamma">
              <ScrubInput
                aria-label="gamma"
                value={asNum(clip.color?.gamma, 1)}
                min={0.1}
                max={4}
                step={0.02}
                precision={2}
                onChange={(v) => setColor({ gamma: v })}
              />
            </Row>
            <button
              type="button"
              onClick={() => update({ color: null })}
              className="mt-1 w-full rounded bg-neutral-800 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-700"
            >
              Reset color
            </button>
          </Section>
          <Section title="Transition">
            {prevClip ? (
              <>
                <Row label="In">
                  <select
                    aria-label="transition kind"
                    value={trans?.kind ?? ""}
                    onChange={(e) => {
                      const k = e.target.value;
                      if (!k) void setTransition(id, null);
                      else
                        void setTransition(id, {
                          kind: k,
                          duration: trans?.duration ?? Math.min(15, maxTransF),
                          expr: trans?.expr,
                        });
                    }}
                    className={fieldCls}
                  >
                    <option value="">None</option>
                    {TRANSITION_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {TRANSITION_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Row>
                {trans && (
                  <Row label="Length">
                    <ScrubInput
                      aria-label="transition duration"
                      value={trans.duration}
                      min={1}
                      max={maxTransF}
                      suffix="f"
                      onChange={(v) =>
                        void setTransition(id, {
                          kind: trans.kind,
                          duration: Math.round(v),
                          expr: trans.expr,
                        })
                      }
                    />
                  </Row>
                )}
                {trans && trans.kind === "custom" && (
                  <Row label="Expr">
                    <input
                      aria-label="transition expr"
                      value={trans.expr ?? ""}
                      onChange={(e) =>
                        void setTransition(id, {
                          kind: "custom",
                          duration: trans.duration,
                          expr: e.target.value,
                        })
                      }
                      className={fieldCls}
                    />
                  </Row>
                )}
              </>
            ) : (
              <p className="px-1 py-0.5 text-[10px] text-neutral-600">
                Needs a clip before it on the same track.
              </p>
            )}
          </Section>
        </>
      )}

      {kind === "audio" && (
        <Section title="Audio">
          <Row label="Volume">
            {kf({
              name: "volume",
              value: clip.volume,
              fallback: 1,
              min: 0,
              max: 2,
              step: 0.02,
              precision: 2,
              write: (next) => update({ volume: next }),
            })}
          </Row>
          <Row label="Fade in">
            <ScrubInput
              aria-label="fade in"
              value={fade.in}
              min={0}
              suffix="f"
              onChange={(v) => setFade({ in: Math.round(v) })}
            />
          </Row>
          <Row label="Fade out">
            <ScrubInput
              aria-label="fade out"
              value={fade.out}
              min={0}
              suffix="f"
              onChange={(v) => setFade({ out: Math.round(v) })}
            />
          </Row>
        </Section>
      )}
    </Pane>
  );
}

function clipTitle(clip: Clip): string {
  if (clip.kind === "text") return typeof clip.text === "string" ? clip.text : "text";
  const s = String(clip.media_ref ?? clip.id ?? "clip");
  return s.split(/[\\/]/).pop() ?? s;
}

// Changing speed must preserve the render invariant
// (source_out - source_in) / speed == timeline duration. Keep the clip's
// timeline length fixed and adjust the source window it consumes.
function speedProps(clip: Clip, speed: number): Record<string, unknown> {
  if (clip.source_in == null || clip.source_out == null) return { speed };
  const sIn = asNum(clip.source_in, 0);
  const tIn = Number(clip.timeline_in) || 0;
  const tOut = Number(clip.timeline_out) || 0;
  return { speed, source_out: sIn + Math.max(1, Math.round((tOut - tIn) * speed)) };
}
