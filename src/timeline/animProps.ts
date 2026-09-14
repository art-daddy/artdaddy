// The animatable properties, and how to read/write one on a clip.
//
// Paths are dotted and can be ANY depth, because the model is not flat: `rotate`, `opacity` and
// `volume` sit on the clip, while scale and position live under `clip.transform`. Getting that
// wrong is invisible until you look — a lane keyed on the wrong path simply shows nothing for
// those properties, which reads as "the user hasn't animated them yet" rather than as a bug.
//
// Every editor of keyframes -- the Inspector's stopwatch, the lane, the volume rubber band on the
// clip -- goes through here, so "which properties animate" and "where each one lives" have exactly
// one answer.
import type { Animatable, Clip } from "./model";

export interface AnimProp {
  /** Dotted path into the clip, e.g. `transform.position.x`. */
  path: string;
  label: string;
  /** Grouping for the lane's display order. */
  group: "transform" | "video" | "audio";
  /** Value used when the property is absent — also what a fresh curve starts from. */
  fallback: number;
  min?: number;
  max?: number;
  /** UI step for a scrub/drag of this property. */
  step: number;
}

export const ANIM_PROPS: AnimProp[] = [
  {
    path: "transform.position.x",
    label: "Position X",
    group: "transform",
    fallback: 0.5,
    step: 0.005,
  },
  {
    path: "transform.position.y",
    label: "Position Y",
    group: "transform",
    fallback: 0.5,
    step: 0.005,
  },
  { path: "transform.scale", label: "Scale", group: "transform", fallback: 1, min: 0, step: 0.01 },
  {
    path: "transform.scale_x",
    label: "Scale X",
    group: "transform",
    fallback: 1,
    min: 0,
    step: 0.01,
  },
  {
    path: "transform.scale_y",
    label: "Scale Y",
    group: "transform",
    fallback: 1,
    min: 0,
    step: 0.01,
  },
  { path: "rotate", label: "Rotation", group: "transform", fallback: 0, step: 0.5 },
  { path: "opacity", label: "Opacity", group: "video", fallback: 1, min: 0, max: 1, step: 0.01 },
  { path: "volume", label: "Volume", group: "audio", fallback: 1, min: 0, max: 2, step: 0.01 },
];

export const ANIM_PROP_BY_PATH: Record<string, AnimProp> = Object.fromEntries(
  ANIM_PROPS.map((p) => [p.path, p]),
);

/** Which properties make sense for a clip of this kind. */
export function animPropsFor(kind: string): AnimProp[] {
  if (kind === "audio") return ANIM_PROPS.filter((p) => p.group === "audio");
  return ANIM_PROPS.filter((p) => p.group !== "audio");
}

/** The current value at `path`, animated or constant, or undefined when unset. */
export function readAnim(clip: Clip, path: string): Animatable | undefined {
  let node: unknown = clip;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node as Animatable | undefined;
}

/** The property patch that writes `value` at `path`, preserving every sibling along the way.
 *  Dropping one is how animating X quietly recentres Y, or wipes `fit` off the transform. */
export function writeAnim(clip: Clip, path: string, value: Animatable): Record<string, unknown> {
  const keys = path.split(".");
  const build = (node: unknown, i: number): unknown => {
    if (i === keys.length) return value;
    const base = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
    return { ...base, [keys[i]]: build(base[keys[i]], i + 1) };
  };
  // Only the TOP-level key is returned: setClipProperties patches clip fields, not the whole clip.
  const top = keys[0];
  return { [top]: (build(clip, 0) as Record<string, unknown>)[top] };
}
