// Frame math + the frames->seconds projection the validator works in.
// Ports src/akaru/v4/tools/timeline_ops.py (to_frames, to_seconds_view, ...).
import { OpError } from "./errors";
import type { Timeline } from "./model";

const COORD_KEYS = new Set(["source_in", "source_out", "timeline_in", "timeline_out", "duration"]);

export function isNum(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

export function canvasFps(timeline: Timeline): number {
  const fps = Number(timeline.canvas?.fps);
  return fps > 0 ? fps : 30;
}

/** Short, stable id for a clip/track (e.g. clip_3f9a1c2b). */
export function newId(prefix: string): string {
  let hex = "";
  while (hex.length < 8) hex += Math.floor(Math.random() * 0x100000000).toString(16);
  return `${prefix}_${hex.slice(0, 8)}`;
}

/** Parse a number or "MM:SS.sss" / "H:MM:SS.sss" time code to seconds. */
export function parseTimestamp(value: number | string): number {
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) throw new OpError(`bad time code: ${value}`);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n))) throw new OpError(`bad time code: ${value}`);
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

/** Normalise a caller-supplied time to an integer PROJECT FRAME (to_frames). */
export function toFrames(value: unknown, fps: number): number {
  if (typeof value === "boolean") {
    throw new OpError(`time value must be an integer frame count, got bool ${value}`);
  }
  if (typeof value === "number") return Math.round(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (s.includes(":")) return Math.round(parseTimestamp(s) * fps);
    if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
    throw new OpError(
      `time must be an integer frame count, got ${JSON.stringify(value)}. Times are PROJECT ` +
        `FRAMES at the canvas fps, not seconds — pass a whole number of frames (seconds x fps).`,
    );
  }
  throw new OpError(`time value must be an integer frame count, got ${typeof value}`);
}

function framesToSeconds(frames: unknown, fps: number): unknown {
  if (typeof frames === "boolean" || typeof frames !== "number") return frames;
  return frames / fps;
}

function convertCoords(node: unknown, fps: number): unknown {
  if (Array.isArray(node)) return node.map((x) => convertCoords(x, fps));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (COORD_KEYS.has(k) && isNum(v)) {
        out[k] = framesToSeconds(v, fps);
      } else if (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => x !== null && typeof x === "object" && "t" in (x as object))
      ) {
        out[k] = (v as Array<Record<string, unknown>>).map((x) => ({
          ...x,
          t: framesToSeconds(x.t, fps),
        }));
      } else {
        out[k] = convertCoords(v, fps);
      }
    }
    return out;
  }
  return node;
}

/** Deep copy of the timeline with frame coords -> seconds (the validator view).
 *  A timeline without units=="frames" is assumed already in seconds. */
export function toSecondsView(timeline: Timeline): Timeline {
  if (String(timeline.units ?? "").toLowerCase() !== "frames") return timeline;
  const fps = canvasFps(timeline);
  const view = convertCoords(timeline, fps) as Timeline;
  delete view.units;
  return view;
}
