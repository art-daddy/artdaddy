// One `export` call can deliver SEPARATE files into a folder (UJ-023): library files copied as
// they are (`media_refs`), and timeline clips rendered over their own spans (`clip_ids`). A user
// asked for "the 19 separate clips in a dedicated folder"; the only exporter rendered the whole
// timeline, and the agent offered a zip of the project instead.
//
// All or nothing in the turn: every item is checked, named and planned before the folder is made
// or a job is queued, so one bad item never leaves a half-delivered folder. Then each file is its
// own job in the export queue (progress, Cancel), and the call wakes the agent once, after its last
// file settles.
import type { ClientToolContext } from "../tools/context";
import type { LibraryClip } from "../tools/store";
import { loadTimeline } from "./engine";
import { isDestinationReserved, sealExportBatch, submitExport } from "./exportQueue";
import type { ExportOptions } from "./exportOptions";
import { canvasFps } from "./frames";
import type { Timeline } from "./model";
import { missingClip } from "./operations";
import {
  buildRenderCommand,
  exportFolder,
  exportTimelineTool,
  freeName,
  loadForRender,
  offlineSources,
  queueRenderJob,
  safeName,
  stagingPathFor,
  type RenderPlan,
} from "./render";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;

/** Files one call may deliver. The real request was 19; this bounds a runaway list. */
export const MAX_EXPORT_ITEMS = 50;

/** The `export` tool: separate files when the call names any, else the whole timeline. */
export async function exportTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  return args.media_refs !== undefined || args.clip_ids !== undefined
    ? exportItemsTool(args, ctx)
    : exportTimelineTool(args, ctx);
}

type Planned =
  | { kind: "media"; ref: string; src: string; filename: string; path: string; stage: string }
  | {
      kind: "clip";
      clipId: string;
      seconds: number;
      filename: string;
      path: string;
      stage: string;
      plan: RenderPlan;
    };

async function exportItemsTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  if (typeof args.output_path === "string" && args.output_path.trim())
    return {
      ok: false,
      error: "output_path names ONE file; separate files go into output_dir, a folder.",
    };
  const refs: string[] = [];
  const clipIds: string[] = [];
  for (const [key, out] of [
    ["media_refs", refs],
    ["clip_ids", clipIds],
  ] as const) {
    const v = args[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim()))
      return { ok: false, error: `${key} must be a list of ids.` };
    if (!v.length)
      return { ok: false, error: `${key} is empty; omit it to export the whole timeline.` };
    for (const s of v as string[]) if (!out.includes(s.trim())) out.push(s.trim());
  }
  if (refs.length + clipIds.length > MAX_EXPORT_ITEMS)
    return {
      ok: false,
      error: `one export delivers at most ${MAX_EXPORT_ITEMS} files (asked for ${refs.length + clipIds.length}); split the request.`,
    };
  const folder = await exportFolder(ctx.store, args.output_dir);
  if (!folder.ok) return folder;
  const rows = await ctx.store.listClips();

  // Library files: each one the library knows, and on disk now.
  const media: { ref: string; src: string; stem: string; ext: string }[] = [];
  for (const ref of refs) {
    const pending = await ctx.store.pendingMedia(ref);
    if (pending)
      return {
        ok: false,
        error:
          pending.status === "generating"
            ? `${ref} is still being generated; export it once it lands.`
            : `${ref} failed to generate, so there is nothing to deliver.`,
      };
    const src = await ctx.store.resolveMediaRef(ref);
    if (!src) {
      const known = rows.some((c) => c.id === ref || c.filename === ref);
      return {
        ok: false,
        error: known
          ? `${ref} is offline: its file was moved or deleted. Relink it in the library, then export again.`
          : `${ref} is not in the library. media_refs take library ids (media_...); import a file first.`,
      };
    }
    const id = await ctx.store.toMediaRef(src);
    const display = String(rows.find((c) => c.id === id)?.filename ?? src.split(/[\\/]/).pop());
    media.push({
      ref,
      src,
      stem: safeName(display.replace(/\.[^.]+$/, ""), "media"),
      ext: src.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "",
    });
  }

  // Timeline clips: one snapshot, checked the way an export of the whole timeline is checked.
  const clips: { clipId: string; from: number; to: number; stem: string }[] = [];
  let loaded: { seconds: Timeline; branding?: import("./branding").Branding; warnings: string[] } | null =
    null;
  let fps = 30;
  if (clipIds.length) {
    const raw = await loadTimeline(ctx.store).catch(() => null);
    // A stale id is the more specific problem, so it is named before any check of the whole.
    if (raw) {
      const ids = new Set((raw.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.id)));
      const gone = clipIds.find((id) => !ids.has(id));
      if (gone) return { ok: false, error: missingClip(gone).message };
    }
    const offline = await offlineSources(ctx, raw);
    if (offline.length)
      return {
        ok: false,
        error:
          `${offline.length} media file${offline.length > 1 ? "s are" : " is"} offline ` +
          `(${offline.join(", ")}). Relink ${offline.length > 1 ? "them" : "it"} in the library, then export again.`,
      };
    const l = await loadForRender(ctx, "deliverable");
    if (!l.ok) return l.result;
    loaded = l;
    fps = Math.trunc(canvasFps(l.seconds));
    const all = (l.seconds.tracks ?? []).flatMap((t) => t.clips ?? []);
    for (const id of clipIds) {
      const c = all.find((x) => x.id === id);
      if (!c) return { ok: false, error: missingClip(id).message };
      const from = Math.round(Number(c.timeline_in) * fps);
      const to = Math.round(Number(c.timeline_out) * fps);
      clips.push({ clipId: id, from, to, stem: safeName(await clipName(ctx, c, rows), "clip") });
    }
  }

  // Names: numbered in the order asked when the call delivers more than one file.
  const total = media.length + clips.length;
  const width = Math.max(2, String(total).length);
  const numbered = (i: number, stem: string): string =>
    total > 1 ? `${String(i + 1).padStart(width, "0")} ${stem}` : stem;
  const taken = new Set<string>();
  const planned: Planned[] = [];
  const stageOf = (path: string): string => (ctx.store.canRename ? stagingPathFor(path) : path);
  let i = 0;
  for (const m of media) {
    const { filename, path } = await freeName(ctx.store, folder.dir, numbered(i++, m.stem), m.ext, taken);
    if (isDestinationReserved(path)) return busy(filename);
    planned.push({ kind: "media", ref: m.ref, src: m.src, filename, path, stage: stageOf(path) });
  }
  for (const c of clips) {
    const { filename, path } = await freeName(ctx.store, folder.dir, numbered(i++, c.stem), ".mp4", taken);
    if (isDestinationReserved(path)) return busy(filename);
    const stage = stageOf(path);
    // The owner's rule for a clip on its own: the watermark, and no end card.
    const branding = loaded!.branding
      ? { ...loaded!.branding, endcard: null, endcardDuration: 0 }
      : undefined;
    const plan = buildRenderCommand(loaded!.seconds, stage, {
      resolution: args.resolution as ExportOptions["resolution"],
      quality: args.quality as ExportOptions["quality"],
      fps: typeof args.fps === "number" ? args.fps : undefined,
      branding,
      range: { from: c.from, to: c.to },
    });
    plan.warnings.push(...loaded!.warnings);
    planned.push({
      kind: "clip",
      clipId: c.clipId,
      seconds: (c.to - c.from) / fps,
      filename,
      path,
      stage,
      plan,
    });
  }

  if (typeof args.output_dir === "string" && args.output_dir.trim()) {
    try {
      await ctx.store.ensureDir(folder.dir);
    } catch (e) {
      return { ok: false, error: `could not make the folder ${folder.label}: ${String(e)}` };
    }
  }

  const batch = `exports_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const delivered: Result[] = [];
  try {
    for (const p of planned) {
      const sub =
        p.kind === "media"
          ? await submitExport({
              store: ctx.store,
              destPath: p.path,
              stagePath: p.stage,
              filename: p.filename,
              origin: ctx.origin,
              copyOf: p.ref,
              batch,
              run: async () => {
                await ctx.store.copyFile(p.src, p.stage);
                return { warnings: [] };
              },
            })
          : await queueRenderJob(ctx, {
              plan: p.plan,
              destPath: p.path,
              stagePath: p.stage,
              filename: p.filename,
              quality: String(args.quality ?? ""),
              batch,
            });
      delivered.push({
        job_id: sub.job_id,
        saved_to: p.filename,
        ...(p.kind === "media"
          ? { media_ref: p.ref }
          : { clip_id: p.clipId, duration_s: Math.round(p.seconds * 1000) / 1000 }),
        queue_position: sub.queue_position,
      });
    }
  } finally {
    sealExportBatch(batch);
  }

  const rendered = planned.filter((p) => p.kind === "clip");
  const note = [
    `Saving ${planned.length} file${planned.length > 1 ? "s" : ""} to ${folder.label}.`,
    rendered.length < planned.length ? "Library files are copied as they are." : "",
    rendered.length && loaded?.branding
      ? "Each clip from the timeline carries the ArtDaddy watermark (no end card)."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ok: true,
    status: Number(delivered[0]?.queue_position ?? 0) > 0 ? "queued" : "exporting",
    exports: delivered,
    folder: folder.label,
    warnings: [...new Set(rendered.flatMap((p) => p.plan.warnings))],
    note,
  };
}

function busy(filename: string): Result {
  return {
    ok: false,
    error: `an export to ${filename} is already queued or running; wait for it, or check it with manage_exports.`,
  };
}

/** What a clip is called: its media's library name, or the words of a caption. */
async function clipName(
  ctx: ClientToolContext,
  c: Record<string, unknown>,
  rows: LibraryClip[],
): Promise<string> {
  if (c.kind === "text") {
    const words = Array.isArray(c.content)
      ? c.content.map((x) => String((x as { text?: unknown }).text ?? "")).join(" ")
      : String(c.text ?? "");
    return words.trim().split(/\s+/).slice(0, 6).join(" ");
  }
  const ref = String(c.media_ref ?? "");
  const id = await ctx.store.toMediaRef(ref);
  const name = String(rows.find((r) => r.id === id)?.filename ?? ref.split(/[\\/]/).pop() ?? "");
  return name.replace(/\.[^.]+$/, "");
}
