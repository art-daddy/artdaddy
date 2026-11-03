// The canvas follows the first video clip (T-31, owner decisions D18).
//
// A project made with "Auto" starts at the default canvas and carries `canvas_auto: true` on its timeline,
// meaning nobody has chosen a canvas yet. The first VIDEO clip placed on its empty timeline sets the canvas to
// its own size (and, for the person, its frame rate), silently. Any explicit canvas change clears the flag
// (setCanvasTool), so a canvas somebody chose is never taken from them.
//
// Once the canvas is chosen, a clip placed on an EMPTY timeline that does not match it is not adopted:
//   - the person is asked ("Keep Current" / "Change to Match") by whoever called, through `ask`;
//   - the agent gets a note in the tool result and is told to ask the person. It never changes the canvas.
// A timeline that already has clips is never asked about and never changed.
//
// The agent adopts the SIZE only. It writes frame numbers it read from the canvas before it placed anything,
// and a frame rate that changed under it would make every one of them wrong, so the frame rate is reported in a
// note instead.
//
// Best effort: whatever fails here, the placement goes ahead on the canvas it has.
import type { ClientToolContext } from "../tools/context";
import { probePath } from "../tools/media";
import { isUnsafeAgentRef } from "../tools/store";
import { MAX_EDGE, MAX_FPS, MIN_EDGE, MIN_FPS } from "./canvas";
import { loadTimeline } from "./engine";
import { placeableKind } from "./helpers";
import type { Canvas, Timeline } from "./model";

/** What a source video looks like on screen, as the probe reports it. `fps` is null when it cannot be told. */
export interface ClipShape {
  width: number;
  height: number;
  fps: number | null;
}

/** The canvas a clip of this size would give: even edges (odd sizes break some encoders), the long edge within
 *  the canvas limit with the shape kept, and null when the clip is too small to be a canvas at all. */
export function canvasSizeFor(width: number, height: number): [number, number] | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    return null;
  const long = Math.max(width, height);
  const k = long > MAX_EDGE ? MAX_EDGE / long : 1;
  const even = (n: number): number => {
    const e = Math.round((n * k) / 2) * 2;
    return e > MAX_EDGE ? MAX_EDGE : e;
  };
  const [w, h] = [even(width), even(height)];
  return w < MIN_EDGE || h < MIN_EDGE ? null : [w, h];
}

/** A whole frame rate within what the canvas accepts: 29.97 is 30, 23.976 is 24, 59.94 is 60. */
export function wholeFps(fps: number): number {
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(fps)));
}

export interface CanvasDifference {
  /** The canvas "Change to Match" would make. */
  width: number;
  height: number;
  fps: number;
  sizeDiffers: boolean;
  fpsDiffers: boolean;
}

/** How a clip differs from the canvas, or null when it does not (or cannot be told apart). */
export function canvasDifference(cur: Canvas, clip: ClipShape): CanvasDifference | null {
  const size = canvasSizeFor(clip.width, clip.height);
  if (!size) return null;
  const fps = clip.fps !== null && Number.isFinite(clip.fps) ? wholeFps(clip.fps) : cur.fps;
  const sizeDiffers = size[0] !== cur.width || size[1] !== cur.height;
  const fpsDiffers = fps !== cur.fps;
  return sizeDiffers || fpsDiffers
    ? { width: size[0], height: size[1], fps, sizeDiffers, fpsDiffers }
    : null;
}

/** The person's question, in plain words. */
export function mismatchQuestion(cur: Canvas, d: CanvasDifference): string {
  const clip = `${d.width}x${d.height} at ${d.fps} fps`;
  const project = `${cur.width}x${cur.height} at ${cur.fps} fps`;
  return `The clip you are adding is ${clip}, and this project is ${project}.\n\nChange the project to match the clip?`;
}

function agentMismatchNote(cur: Canvas, d: CanvasDifference): string {
  return (
    `The clip is ${d.width}x${d.height} at ${d.fps} fps but the project canvas is ` +
    `${cur.width}x${cur.height} at ${cur.fps} fps. The canvas was NOT changed. If the person wants them to ` +
    `match, ask them first, then call set_project_settings and re-read get_timeline.`
  );
}

function agentAdoptedNote(cur: Canvas, d: CanvasDifference): string {
  const parts: string[] = [];
  if (d.sizeDiffers)
    parts.push(`Set the canvas to ${d.width}x${d.height} to match the first video clip.`);
  if (d.fpsDiffers)
    parts.push(
      `The clip is ${d.fps} fps and the canvas stays at ${cur.fps} fps, so frames are counted at ` +
        `${cur.fps} fps. To change that, call set_project_settings with fps and re-read get_timeline.`,
    );
  return parts.join(" ");
}

/** The agent (the in-app one, or an outside one over MCP) rather than the person at the editor. */
export function isAgentCall(ctx: ClientToolContext): boolean {
  return ctx.origin !== undefined || ctx.surface === "mcp";
}

const hasClips = (tl: Timeline): boolean => (tl.tracks ?? []).some((t) => (t.clips ?? []).length);

const probedShape = new Map<string, ClipShape | null>();

/** Test hook: forget what was probed. */
export function clearClipShapeCache(): void {
  probedShape.clear();
}

/** The picture size and frame rate of a video file, or null for anything that is not one. */
async function probeClipShape(ctx: ClientToolContext, abs: string): Promise<ClipShape | null> {
  const hit = probedShape.get(abs);
  if (hit !== undefined) return hit;
  let shape: ClipShape | null = null;
  try {
    const r = await probePath(ctx.runner, abs);
    const v = (r.ok ? r.video : null) as Record<string, unknown> | null;
    const [w, h] = [Number(v?.width), Number(v?.height)];
    if (v && w > 0 && h > 0) {
      // The average rate first: a phone's variable-rate file reports a nominal rate far from what it plays at.
      const rate = [v.avg_fps, v.fps].map(Number).find((f) => f >= MIN_FPS && f <= MAX_FPS + 0.5);
      shape = { width: w, height: h, fps: rate ?? null };
    }
  } catch {
    shape = null;
  }
  probedShape.set(abs, shape);
  return shape;
}

/** The first of `refs` that is a video, with its shape. A ref that cannot be read is passed over: placing it
 *  will say what is wrong with it. */
async function firstVideo(
  ctx: ClientToolContext,
  refs: readonly string[],
): Promise<ClipShape | null> {
  for (const ref of refs) {
    const raw = String(ref ?? "").trim();
    if (!raw || isUnsafeAgentRef(raw)) continue;
    try {
      const abs = (await ctx.store.resolveMediaRef(raw)) ?? raw;
      if (placeableKind(abs) !== "video") continue;
      const shape = await probeClipShape(ctx, abs);
      if (shape) return shape;
    } catch {
      continue;
    }
  }
  return null;
}

export interface CanvasPrep {
  /** For the agent: what happened to the canvas, or why it was left alone. */
  note?: string;
}

/** Settle the canvas before clips are placed. Never throws. See the top of the file for the rules.
 *
 *  `ask` is the person's question: it gets the words and answers true to change the project to match. Without
 *  one the canvas is left as it is. */
export async function prepareCanvas(
  ctx: ClientToolContext,
  refs: readonly string[],
  ask?: (message: string, difference: CanvasDifference) => Promise<boolean>,
): Promise<CanvasPrep> {
  try {
    const agent = isAgentCall(ctx);
    const tl = await loadTimeline(ctx.store);
    if (hasClips(tl)) return {};
    const auto = tl.canvas_auto === true;
    const shape = await firstVideo(ctx, refs);
    if (!shape) return {};
    const d = canvasDifference(tl.canvas, shape);
    if (!d) {
      // Nothing to change, but the canvas now matches the first clip: the choice has been made.
      if (auto) await applyCanvas(ctx, { width: tl.canvas.width, height: tl.canvas.height });
      return {};
    }
    if (auto) {
      await applyCanvas(ctx, {
        width: d.width,
        height: d.height,
        ...(agent ? {} : { fps: d.fps }),
      });
      return agent ? { note: agentAdoptedNote(tl.canvas, d) } : {};
    }
    if (agent) return { note: agentMismatchNote(tl.canvas, d) };
    if (ask && (await ask(mismatchQuestion(tl.canvas, d), d)))
      await applyCanvas(ctx, { width: d.width, height: d.height, fps: d.fps });
    return {};
  } catch {
    return {};
  }
}

/** The one canvas tool, which also syncs the project's saved default. Loaded on use: it reaches the tools that
 *  place clips, so a static import would be a cycle. */
async function applyCanvas(
  ctx: ClientToolContext,
  args: { width: number; height: number; fps?: number },
): Promise<void> {
  const { setProjectSettingsTool } = await import("../tools/project");
  await setProjectSettingsTool(args, ctx);
}
