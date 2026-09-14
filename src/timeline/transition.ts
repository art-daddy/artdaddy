// Transition presets + parsing, per contract/timeline.schema.json (the source
// of truth). A clip's `transition_in` is an INCOMING crossfade from the PREVIOUS
// clip on the SAME track. The two clips ABUT (Premiere model B): the crossfade is
// a render-side blend CENTRED ON THE CUT — a `duration`-frame window running from
// duration/2 BEFORE this clip's start to duration/2 after — with the outgoing clip
// holding its last frame underneath. Clips are NOT shifted, so resizing a transition
// never moves clips or breaks a neighbour. Both callers map their own window onto the
// [0, duration] domain below (render.ts via `T - (tin - leadIn)`, scene.ts via
// `tFrame - tin + leadF`); this helper itself knows nothing about centring. Pure + tested.
import type { Clip } from "./model";

/** The transition kinds the schema allows. `custom` carries a raw `expr`. */
export const TRANSITION_KINDS = [
  "crossfade",
  "dip-to-black",
  "dip-to-white",
  "whip",
  "wipe-l",
  "wipe-r",
  "custom",
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** Human labels for the inspector dropdown. */
export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  crossfade: "Crossfade",
  "dip-to-black": "Dip to black",
  "dip-to-white": "Dip to white",
  whip: "Whip",
  "wipe-l": "Wipe left",
  "wipe-r": "Wipe right",
  custom: "Custom (expr)",
};

/** Compile-time exhaustiveness guard. A `default: assertNever(kind)` in a switch over `TransitionKind`
 *  stops type-checking the moment a kind is added to `TRANSITION_KINDS` without a render branch, so a
 *  new contract transition kind can never silently fall through to the wrong path in the exporter or the
 *  preview. Unreachable at runtime (the plan coerces any unknown kind to `crossfade` before dispatch). */
export function assertNever(x: never): never {
  throw new Error(`unhandled transition kind: ${String(x)}`);
}

export interface TransitionIn {
  kind: string;
  duration: number; // project frames
  expr?: string;
}

/** Parse a clip's `transition_in`, or null when absent/malformed. */
export function parseTransitionIn(clip: Clip | null | undefined): TransitionIn | null {
  const t = clip?.transition_in as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return null;
  const kind = typeof t.kind === "string" ? t.kind : "";
  const duration = typeof t.duration === "number" ? t.duration : NaN;
  if (!kind || !Number.isFinite(duration) || duration <= 0) return null;
  const expr = typeof t.expr === "string" ? t.expr : undefined;
  return expr ? { kind, duration, expr } : { kind, duration };
}

/** Transition progress at clip-relative frame `rel` (0 at this clip's first
 *  frame): a value in [0,1] across the `duration`-frame window, or null when
 *  outside the window (or no transition). The preview blends the incoming clip
 *  over the previous one by this factor. */
export function transitionProgress(t: TransitionIn | null, rel: number): number | null {
  if (!t || t.duration <= 0) return null;
  if (rel < 0 || rel > t.duration) return null;
  return Math.max(0, Math.min(1, rel / t.duration));
}
