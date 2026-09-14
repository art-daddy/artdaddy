// Timeline data model — TS mirror of contract/timeline.schema.json.
// ALL times are INTEGER PROJECT FRAMES at canvas.fps (never seconds).
// The schema is additionalProperties:true, so interfaces carry index signatures.

/** A constant number OR a keyframe animation list. */
export type Animatable = number | Keyframe[];

export interface Keyframe {
  t: number; // clip-relative frame (0 = clip's first frame), strictly increasing
  v: number;
  ease?: "linear" | "hold" | "ease-in" | "ease-out" | "ease-in-out" | string;
  [k: string]: unknown;
}

export interface Canvas {
  width: number;
  height: number;
  fps: number;
}

export type TrackKind = "video" | "audio" | "text";
export type ClipKind = "video" | "image" | "audio" | "text";

export interface Position {
  x: Animatable;
  y: Animatable;
  [k: string]: unknown;
}

/** Normalized clip placement (industry-standard model): position the clip by its
 *  CENTRE in 0..1 canvas coords (0.5 = centre, 0/1 = the edges; outside slides it
 *  partly off-frame) with a scale multiplier (1.0 = full canvas). scale_x/scale_y
 *  for non-uniform. Mirrors renderer.py::_parse_transform. */
export interface Transform {
  position?: Position;
  scale?: Animatable;
  scale_x?: Animatable;
  scale_y?: Animatable;
  [k: string]: unknown;
}

export interface Crop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface Transition {
  kind: string;
  duration: number; // frames
  expr?: string;
  [k: string]: unknown;
}

export interface Clip {
  id?: string;
  kind?: ClipKind;
  media_ref?: string;
  source_in?: number;
  source_out?: number;
  timeline_in: number;
  timeline_out: number;
  speed?: number;
  transform?: Transform;
  fit?: "contain" | "cover" | "stretch" | Record<string, unknown>;
  rotate?: Animatable;
  opacity?: Animatable;
  crop?: Crop;
  flip?: { h?: boolean; v?: boolean };
  glow?: number | { amount?: number; opacity?: number };
  blend?: "normal" | "multiply" | "screen" | "overlay" | "add";
  color?: Record<string, unknown>;
  effects?: Array<{ type: string; [k: string]: unknown }>;
  transition_in?: Transition;
  volume?: Animatable;
  fade?: { in?: number; out?: number };
  duck?: { against: string; ratio?: number; threshold?: number };
  loop?: boolean;
  stretch?: boolean;
  audio_filter?: string;
  content?: string | Array<{ text: string; [k: string]: unknown }>;
  text?: string;
  style?: Record<string, unknown>;
  animation?: Record<string, unknown>;
  link_group?: string;
  /** Text clips created together by add_captions from one run of speech. Unlike `link_group`
   *  these do NOT move or trim together — the id exists so a whole caption track can be
   *  restyled, retargeted or removed in one call instead of by 200 clip ids. */
  caption_group?: string;
  /** Enable/disable (Premiere Shift+E): the clip keeps its place but neither draws nor sounds.
   *  Absent = enabled, so every existing document stays as it was. */
  disabled?: boolean;
  [k: string]: unknown;
}

export interface Track {
  id: string;
  kind: TrackKind;
  z?: number;
  clips?: Clip[];
  mute?: boolean;
  hidden?: boolean;
  /** Ripple edits shift this track along to keep cross-track alignment (Premiere
   *  "sync lock"). Absent = locked (default on); set false to exempt. */
  sync_locked?: boolean;
  /** Track lock: refuses EVERY edit to clips on this track. Distinct from `sync_locked`. */
  locked?: boolean;
  /** Solo: while any track is soloed, only soloed tracks render. */
  solo?: boolean;
  [k: string]: unknown;
}

export interface Timeline {
  units?: string; // "frames"
  canvas: Canvas;
  tracks: Track[];
  _schema_note?: string;
  failures?: unknown[];
  [k: string]: unknown;
}

export const DEFAULT_CANVAS: Canvas = { width: 1080, height: 1920, fps: 30 };

/** A valid, empty timeline: canvas + no tracks (mirrors empty_timeline_dict). */
export function emptyTimeline(
  width = DEFAULT_CANVAS.width,
  height = DEFAULT_CANVAS.height,
  fps = DEFAULT_CANVAS.fps,
): Timeline {
  return {
    units: "frames",
    canvas: { width: Math.trunc(width), height: Math.trunc(height), fps: Math.trunc(fps) },
    tracks: [],
    failures: [],
  };
}

/** Starter tracks: ONE video + ONE audio, both empty. Deliberately not Premiere's
 *  four — an empty lane is clutter the user has to scroll past, and both the agent and
 *  the UI create more on demand. `DEFAULT_VISUAL_TRACK` must name one of these, or the
 *  first placement conjures a track beside the empty starter. */
export function starterTracks(): Track[] {
  return [
    { id: "v1", kind: "video", z: 0, clips: [] },
    { id: "a1", kind: "audio", z: 0, clips: [] },
  ];
}
