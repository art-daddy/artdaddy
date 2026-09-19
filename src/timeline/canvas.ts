// ONE canvas resolver, shared by set_project_settings (which mutates the ACTIVE
// timeline and then mirrors it into project.json) and new_project. There used to be
// TWO canvas tools resolving sizes independently, so a bound added to one silently
// missed the other: both accepted a 1x1 canvas, which is how the model destroyed a
// project and was told "ok". Worse, the project-settings one wrote a default that
// nothing read — it reported success while the video was unchanged.
//
// The governing rule: an omitted field KEEPS ITS CURRENT VALUE. The model sent
// `width: 0` (and then `1`) because it didn't know the size and we made it say
// something anyway — remove the need to guess and the bad values stop.
export type Args = Record<string, unknown>;

/** Aspect presets -> their canonical 1080-short-edge size. */
export const ASPECT: Record<string, [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:3": [1440, 1080],
  "2.4:1": [2560, 1080],
  "9:14": [1080, 1680],
};
/** Quality presets -> short-edge target px (mirrors other NLEs' QualityPreset). */
export const QUALITY_SHORT: Record<string, number> = {
  "720p": 720,
  "1080p": 1080,
  "2K": 1440,
  "4K": 2160,
};

export const MIN_EDGE = 64;
export const MAX_EDGE = 8192;
export const MIN_FPS = 1;
export const MAX_FPS = 120;

function intOr(v: unknown, fallback: unknown): number {
  if (typeof v === "number" && !Number.isNaN(v)) return Math.trunc(v);
  const n = Number(fallback);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

/** Round to an even integer >= 2 (odd frame sizes break some video encoders). */
function evenDim(n: number): number {
  const i = Math.round(n);
  return Math.max(2, i - (i % 2));
}

/** Scale (w,h) so the SHORT edge hits `target` px, preserving aspect. */
function scaleShortEdge(w: number, h: number, target: number): [number, number] {
  return w <= h
    ? [evenDim(target), evenDim((target * h) / w)]
    : [evenDim((target * w) / h), evenDim(target)];
}

const aspectRatioOf = (label: string): number | null => {
  const [a, b] = label.split(":").map(Number);
  return a > 0 && b > 0 ? a / b : null;
};

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export function aspectLabel(w: number, h: number): string {
  const g = gcd(w, h) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

export interface ResolvedCanvas {
  width: number;
  height: number;
  fps: number;
  note?: string;
}

/**
 * Resolve a requested canvas against the CURRENT one.
 *
 * Conflicts are NOT hard errors: explicit width+height are the most specific, so
 * they win and a disagreeing preset is dropped with a loud note. Rejecting instead
 * makes weaker models loop re-sending the same conflict — the thrash this whole
 * change exists to remove. Genuinely unusable input (out of range, unknown preset,
 * nothing to change) still fails, with the current values in the message so the
 * model never has to guess them.
 */
export function resolveCanvas(
  args: Args,
  cur: { width: number; height: number; fps: number },
): ResolvedCanvas | { error: string } {
  // The contract nests the sizing knobs under `size` so "leave the canvas alone" is ONE
  // null instead of four independent blank-or-fill decisions — flat-per-knob, both
  // models volunteered an aspect_ratio on a frame-rate-only request and reshaped the
  // video. The manual editor still calls this with flat args, so accept both.
  const nested = args.size;
  if (nested !== undefined) {
    // A "1080x1920" STRING is accepted because it is the form this tool REPORTS the canvas back
    // in (`resolution`), and read-then-write-it-back is the obvious round-trip. Refusing it with
    // "must be object" made the tool disagree with its own output.
    const wh =
      typeof nested === "string" ? /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/.exec(nested) : null;
    args = wh
      ? { ...args, width: Number(wh[1]), height: Number(wh[2]) }
      : nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? { ...args, ...(nested as Args) }
        : args;
    if (typeof nested === "string" && !wh)
      return {
        error: `size '${nested}' is not a canvas. Pass "WIDTHxHEIGHT" (e.g. "1080x1920") or {width, height}.`,
      };
  }
  const has = (k: string): boolean => args[k] !== undefined && args[k] !== null;
  if (!has("width") && !has("height") && !has("aspect_ratio") && !has("quality") && !has("fps"))
    return { error: "pass at least one of: fps, width+height, aspect_ratio, quality" };

  let fps = cur.fps;
  if (has("fps")) {
    const f = intOr(args.fps, cur.fps);
    if (f < MIN_FPS || f > MAX_FPS)
      return { error: `fps must be between ${MIN_FPS} and ${MAX_FPS} (got ${String(args.fps)})` };
    fps = f;
  }

  const aspect = typeof args.aspect_ratio === "string" ? args.aspect_ratio : undefined;
  const quality = typeof args.quality === "string" ? args.quality : undefined;
  // hasOwn, not truthiness: ASPECT["__proto__"] is Object.prototype, which is truthy,
  // so a bare lookup let an inherited key past this guard and then blew up destructuring it.
  if (aspect && !Object.hasOwn(ASPECT, aspect))
    return {
      error: `unknown aspect_ratio '${aspect}' (use one of: ${Object.keys(ASPECT).join(", ")})`,
    };
  if (quality && !Object.hasOwn(QUALITY_SHORT, quality))
    return {
      error: `unknown quality '${quality}' (use one of: ${Object.keys(QUALITY_SHORT).join(", ")})`,
    };

  let width: number;
  let height: number;
  let note: string | undefined;

  if (has("width") && has("height")) {
    width = intOr(args.width, cur.width);
    height = intOr(args.height, cur.height);
    const conflicts: string[] = [];
    if (aspect) {
      const target = aspectRatioOf(aspect) ?? ASPECT[aspect][0] / ASPECT[aspect][1];
      if (Math.abs(width / height - target) / target > 0.05)
        conflicts.push(`aspect_ratio "${aspect}"`);
    }
    if (
      quality &&
      Math.abs(Math.min(width, height) - QUALITY_SHORT[quality]) / QUALITY_SHORT[quality] > 0.05
    )
      conflicts.push(`quality "${quality}"`);
    if (conflicts.length)
      note = `used your explicit ${width}x${height}; ignored ${conflicts.join(" and ")} — they disagreed.`;
  } else if (aspect) {
    if (has("width") || has("height"))
      note = "used aspect_ratio; ignored the lone width/height — pass BOTH for an exact size.";
    const base = ASPECT[aspect];
    const t = quality ? QUALITY_SHORT[quality] : undefined;
    [width, height] = t ? scaleShortEdge(base[0], base[1], t) : base;
  } else if (quality) {
    if (has("width") || has("height"))
      note = "used quality; ignored the lone width/height — pass BOTH for an exact size.";
    [width, height] = scaleShortEdge(cur.width, cur.height, QUALITY_SHORT[quality]);
  } else if (has("width") !== has("height")) {
    return {
      error:
        `width and height must be given together (got only ${has("width") ? "width" : "height"}). ` +
        `Omit both to keep the current ${cur.width}x${cur.height}, or use aspect_ratio/quality.`,
    };
  } else {
    width = cur.width;
    height = cur.height;
  }

  if (!Number.isFinite(width) || !Number.isFinite(height))
    return { error: "width and height must be numbers" };
  if (width < MIN_EDGE || height < MIN_EDGE || width > MAX_EDGE || height > MAX_EDGE)
    return {
      error:
        `canvas must be ${MIN_EDGE}..${MAX_EDGE}px on each edge (got ${width}x${height}). ` +
        `Omit width/height to keep the current ${cur.width}x${cur.height}, or use aspect_ratio/quality.`,
    };
  return { width, height, fps, ...(note ? { note } : {}) };
}
