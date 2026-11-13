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
// PICTURES first (UJ-087, owner's answer of 13 Nov, Q2 = B): a batch with no video in it, placed on the empty timeline
// of an Auto project, does NOT take the canvas (a logo or a screenshot placed first must not set the shape by itself),
// but it is no longer silent: the pictures' majority shape (16:9, 9:16 or 1:1, from up to 12 of them, as they are SEEN
// upright) is compared with the canvas, and when they differ the person is asked the same question and the agent is told
// the canvas is a default nobody chose. A tie, or pictures that already fit, ask and say nothing; a canvas somebody chose
// is not asked about pictures (they adapt to it, as before). Disable-only server switch: `canvas_ask_stills`.
//
// The agent adopts the SIZE only. It writes frame numbers it read from the canvas before it placed anything,
// and a frame rate that changed under it would make every one of them wrong, so the frame rate is reported in a
// note instead.
//
// Best effort: whatever fails here, the placement goes ahead on the canvas it has.
import { exportFlag } from "../api/exportFlags";
import { stillPicture } from "../media/stillPicture";
import type { ClientToolContext } from "../tools/context";
import { probePath } from "../tools/media";
import { isUnsafeAgentRef } from "../tools/store";
import { ASPECT, MAX_EDGE, MAX_FPS, MIN_EDGE, MIN_FPS } from "./canvas";
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
  /** What the question is about: absent for a video clip, "pictures" for a pictures-first batch (the dialog's title follows it). */
  subject?: "pictures";
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

// --- Pictures first (UJ-087) ---------------------------------------------------------------------------------------------------------------

/** The shape a picture is cut for, among the three the project picker offers. */
export type PictureShape = "16:9" | "9:16" | "1:1";

/** How many pictures of a batch decide its shape: enough that one odd picture cannot, few enough that a 400-picture drop costs a dozen probes. */
export const PICTURE_SAMPLE = 12;

/** The shape of a picture of this size as it is SEEN (the probe gives it upright): width over height above 1.3 is landscape (so 4:3 and 3:2 photos are), below 0.77 is
 *  portrait, anything between is square. Null for a size that is no picture. */
export function pictureShape(width: number, height: number): PictureShape | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    return null;
  const ratio = width / height;
  return ratio > 1.3 ? "16:9" : ratio < 0.77 ? "9:16" : "1:1";
}

/** The shape most of the sample has, and how many have it; null for an empty sample and for a tie at the top (a half-and-half drop has no right answer). */
export function majorityShape(
  shapes: readonly PictureShape[],
): { shape: PictureShape; count: number } | null {
  const counts = new Map<PictureShape, number>();
  for (const s of shapes) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: { shape: PictureShape; count: number } | null = null;
  let tied = false;
  for (const [shape, count] of counts) {
    if (!best || count > best.count) {
      best = { shape, count };
      tied = false;
    } else if (count === best.count) tied = true;
  }
  return tied ? null : best;
}

const SHAPE_WORD: Record<PictureShape, string> = {
  "16:9": "landscape",
  "9:16": "portrait",
  "1:1": "square",
};

/** Who the sentence is about: one picture, all of them, or most of them. */
function pictureSubject(
  sample: number,
  count: number,
  singular: string,
  all: string,
  most: string,
): string {
  return sample === 1 ? singular : count === sample ? all : most;
}

/** The person's question about pictures, in plain words (the owner's sheet). */
export function picturesQuestion(
  cur: Canvas,
  shape: PictureShape,
  target: readonly [number, number],
  sample: number,
  count: number,
): string {
  const subject = pictureSubject(
    sample,
    count,
    `The picture you are adding is ${SHAPE_WORD[shape]}`,
    `The pictures you are adding are ${SHAPE_WORD[shape]}`,
    `Most of the pictures you are adding are ${SHAPE_WORD[shape]}`,
  );
  return (
    `${subject}, and this project is ${cur.width}x${cur.height} at ${cur.fps} fps (the default).\n\n` +
    `Change the project to ${target[0]}x${target[1]} to match ${sample === 1 ? "it" : "them"}?`
  );
}

/** What the agent is told when it places pictures on a canvas nobody chose: the facts, that nothing was changed, and what to do about it. The pictures are FITTED
 *  (not cropped), so what the person sees is bars; saying "cropped" would be false. */
function agentPicturesNote(
  cur: Canvas,
  shape: PictureShape,
  target: readonly [number, number],
  sample: number,
  count: number,
): string {
  const subject = pictureSubject(
    sample,
    count,
    "The picture is",
    "The pictures are",
    "Most of the pictures are",
  );
  const they = sample === 1 ? "it sits" : "they sit";
  return (
    `${subject} ${SHAPE_WORD[shape]}, but the project canvas is still the default ${cur.width}x${cur.height} at ${cur.fps} fps that nobody chose, and it was NOT changed: ` +
    `${they} small inside it with black bars. If the person wants the canvas to match (${target[0]}x${target[1]}), ask them first, then call set_project_settings with width and height ` +
    `and re-read get_timeline.`
  );
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
      // Media still being made has no file to read a picture size from, so there is nothing to probe.
      if (await ctx.store.pendingMedia(raw)) continue;
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

/** The shapes of the first PICTURE_SAMPLE pictures of `refs`, as they are seen. A ref that is not a picture, cannot be read, is still being made or is a path the agent may not
 *  name is passed over (placing it will say what is wrong with it), so an unreadable picture shrinks the sample and never decides it. At most four are measured at once. */
async function pictureShapes(
  ctx: ClientToolContext,
  refs: readonly string[],
): Promise<PictureShape[]> {
  const files: string[] = [];
  for (const ref of refs) {
    if (files.length >= PICTURE_SAMPLE) break;
    const raw = String(ref ?? "").trim();
    if (!raw || isUnsafeAgentRef(raw)) continue;
    try {
      if (await ctx.store.pendingMedia(raw)) continue;
      const abs = (await ctx.store.resolveMediaRef(raw)) ?? raw;
      if (placeableKind(abs) === "image") files.push(abs);
    } catch {
      continue;
    }
  }
  const shapes: Array<PictureShape | null> = new Array(files.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < files.length; i = next++) {
      try {
        // A HEIF-family still is measured as its decoded picture: probed directly, a tiled iPhone photo reports one 512 px tile.
        const picture = await stillPicture(ctx.store, ctx.runner, files[i], ctx.signal);
        const size = "path" in picture ? await probeClipShape(ctx, picture.path) : null;
        shapes[i] = size ? pictureShape(size.width, size.height) : null;
      } catch {
        shapes[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  return shapes.filter((s): s is PictureShape => s !== null);
}

/** The pictures-first rule (see the top of the file). The person is asked; the agent is told; nothing else ever happens to the canvas here. */
async function picturesFirst(
  ctx: ClientToolContext,
  tl: Timeline,
  refs: readonly string[],
  agent: boolean,
  ask?: (message: string, difference: CanvasDifference) => Promise<boolean>,
): Promise<CanvasPrep> {
  // A disable-only server switch: off is the app as it was, no question and no note.
  if (!exportFlag("canvas_ask_stills")) return {};
  // The person is never told anything, only asked; with no way to ask (a direct call, the second pass of a drag that already asked) there is nothing to measure.
  if (!agent && !ask) return {};
  const sample = await pictureShapes(ctx, refs);
  const winner = majorityShape(sample);
  if (!winner) return {};
  const target = ASPECT[winner.shape];
  if (!target || (target[0] === tl.canvas.width && target[1] === tl.canvas.height)) return {}; // they already fit
  if (agent)
    return {
      note: agentPicturesNote(tl.canvas, winner.shape, target, sample.length, winner.count),
    };
  if (ask) {
    const difference: CanvasDifference = {
      width: target[0],
      height: target[1],
      fps: tl.canvas.fps,
      sizeDiffers: true,
      fpsDiffers: false,
      subject: "pictures",
    };
    await askThenApply(
      ctx,
      ask,
      picturesQuestion(tl.canvas, winner.shape, target, sample.length, winner.count),
      difference,
      tl,
      { width: target[0], height: target[1] }, // a picture has no frame rate: it stays
      true,
    );
  }
  return {};
}

/** Put the person's question and, when they say "Change to Match", change the canvas, ONLY if the project is still as it was when it was asked.
 *  The dialog is modal for the person but not for the agent, which can place clips, or change the canvas itself, while it is open; applying the answer to a
 *  project that moved on would reshape clips the person never saw the question about. So the timeline is read again after the answer and immediately before
 *  the one write: any clip now on it, a different canvas, or (`needsAuto`) a project that is no longer Auto, and nothing changes. */
async function askThenApply(
  ctx: ClientToolContext,
  ask: (message: string, difference: CanvasDifference) => Promise<boolean>,
  message: string,
  difference: CanvasDifference,
  asked: Timeline,
  args: { width: number; height: number; fps?: number },
  needsAuto: boolean,
): Promise<void> {
  if (!(await ask(message, difference))) return;
  const now = await loadTimeline(ctx.store);
  if (hasClips(now)) return;
  if (needsAuto && now.canvas_auto !== true) return;
  if (
    now.canvas.width !== asked.canvas.width ||
    now.canvas.height !== asked.canvas.height ||
    now.canvas.fps !== asked.canvas.fps
  )
    return;
  await applyCanvas(ctx, args);
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
    // No video in the batch: on an Auto project the pictures' shape is asked about (the person) or reported (the agent), and the
    // canvas is never taken from them (UJ-087); anywhere else nothing happens, as before.
    if (!shape) return auto ? await picturesFirst(ctx, tl, refs, agent, ask) : {};
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
    if (ask)
      await askThenApply(
        ctx,
        ask,
        mismatchQuestion(tl.canvas, d),
        d,
        tl,
        { width: d.width, height: d.height, fps: d.fps },
        false,
      );
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
