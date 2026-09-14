// The client half of the effect registry: the SAME ranges/defaults the model was
// shown, read from the bundled contract (src/contract/catalog.json).
//
// Why this exists: apply_effects used to accept any {type} with any keys, write it
// verbatim, and report success — so `{type:"glow"}` (no amount) was stored, dropped
// by the renderer, and reported as done. Resolution now happens HERE, once, so a
// stored effect is always renderable.
import { allEffects } from "../contract";

export type EffectKind = "video" | "audio";

interface RegistryParam {
  key: string;
  type: string;
  minimum: number | null;
  maximum: number | null;
  default: number | string | null;
}
interface RegistryEffect {
  id: string;
  display: string;
  category: string;
  kind: string;
  params: RegistryParam[];
}

const EFFECTS = allEffects() as unknown as RegistryEffect[];

/** Audio clips carry `audio_effects`; everything else uses the video table. */
export const kindForClip = (clipKind: unknown): EffectKind =>
  clipKind === "audio" ? "audio" : "video";

export function findEffect(type: string, kind: EffectKind): RegistryEffect | undefined {
  return EFFECTS.find((e) => e.id === type && e.kind === kind);
}

/** Every `type` valid for this kind — used to build actionable rejection text. */
export const typesFor = (kind: EffectKind): string[] =>
  EFFECTS.filter((e) => e.kind === kind)
    .map((e) => e.id)
    .sort();

/** The grade knobs apply_color accepts, from the same registry the model was shown. */
const COLOR_PARAMS: RegistryParam[] = EFFECTS.filter((e) => e.kind === "color").flatMap(
  (e) => e.params,
);

export const colorKnobs = (): string[] => COLOR_PARAMS.map((p) => p.key);

/**
 * Validate + clamp a whole grade patch. Unknown knobs are rejected rather than
 * silently dropped, and numeric knobs are clamped to the registry range — the tool
 * description has always promised clamping, but nothing implemented it.
 * Neutral defaults are NOT filled in: an unset grade knob means "don't touch".
 */
export function resolveGrade(patch: Record<string, unknown>): {
  grade?: Record<string, unknown>;
  error?: string;
} {
  const known = new Map(COLOR_PARAMS.map((p) => [p.key, p]));
  const unknown = Object.keys(patch).filter((k) => !known.has(k));
  if (unknown.length) {
    return {
      error:
        `unknown colour knob ${unknown.map((u) => `'${u}'`).join(", ")}. ` +
        `Valid knobs: ${colorKnobs().join(", ")}`,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const spec = known.get(key)!;
    if (spec.type !== "number") {
      out[key] = raw;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { error: `${key} must be a number (got ${JSON.stringify(raw)})` };
    }
    let v = spec.minimum !== null ? Math.max(spec.minimum, n) : n;
    if (spec.maximum !== null) v = Math.min(spec.maximum, v);
    out[key] = v;
  }
  return { grade: out };
}

export interface ResolveResult {
  effect?: Record<string, unknown>;
  error?: string;
}

/**
 * Validate one authored effect against the registry and return the STORED form:
 * unknown params rejected, out-of-range clamped, omitted params filled from the
 * clip's current value then the registry default. `previous` is the clip's existing
 * entry of the same type, so a partial update keeps what it doesn't mention.
 *
 * Input, stored, and echoed shape are all `{type, params, enabled?}` — one shape, so
 * copying a look between clips is passing the echoed array straight back.
 */
export function resolveEffect(
  raw: Record<string, unknown>,
  kind: EffectKind,
  previous?: Record<string, unknown>,
): ResolveResult {
  const type = String(raw.type ?? "");
  const def = findEffect(type, kind);
  if (!def) {
    return {
      error: `unknown ${kind} effect '${type}'. Valid ${kind} effects: ${typesFor(kind).join(", ")}`,
    };
  }

  const authoredParams =
    raw.params && typeof raw.params === "object"
      ? (raw.params as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const priorParams =
    previous?.params && typeof previous.params === "object"
      ? (previous.params as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const allowed = new Set(def.params.map((p) => p.key));
  const unknown = Object.keys(authoredParams).filter((k) => !allowed.has(k));
  if (unknown.length) {
    return {
      error:
        `${type} does not take ${unknown.map((u) => `'${u}'`).join(", ")}. ` +
        `Its params are: ${[...allowed].join(", ") || "(none)"}`,
    };
  }

  const params: Record<string, unknown> = {};
  for (const p of def.params) {
    const authored = authoredParams[p.key];
    const carried = priorParams[p.key];
    let value = authored !== undefined && authored !== null ? authored : carried;

    if (value === undefined || value === null) {
      if (p.default === null || p.default === undefined) continue; // genuinely optional
      value = p.default;
    }

    if (p.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        return { error: `${type}.${p.key} must be a number (got ${JSON.stringify(value)})` };
      }
      // Clamp rather than reject: a plausible-but-hot value should still land.
      value = p.minimum !== null ? Math.max(p.minimum, n) : n;
      if (p.maximum !== null) value = Math.min(p.maximum, value as number);
    } else {
      value = String(value);
    }
    params[p.key] = value;
  }

  // Never store an effect that would render nothing. An all-zero (or empty) stack
  // entry is the shape that made `{type:"glow"}` report success and emit no pixels;
  // for knob-only effects like eq/pan there is no sane default, so refuse instead.
  const keys = Object.keys(params);
  const inert =
    keys.length === 0 ||
    keys.every((k) => (typeof params[k] === "number" ? params[k] === 0 : String(params[k]) === ""));
  if (inert) {
    return {
      error:
        `${type} would render nothing. Give it a value (${def.params.map((p) => p.key).join(", ")}), ` +
        `or use remove:["${type}"] / enabled:false to turn it off.`,
    };
  }

  const out: Record<string, unknown> = { type, params };
  if (raw.enabled === false) out.enabled = false;
  return { effect: out };
}
