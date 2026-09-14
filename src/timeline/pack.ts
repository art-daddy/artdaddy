// Portable project bundle: zip the whole project into ONE self-contained
// `<name>.<PACKAGE_EXT>` that can be moved / shared and re-opened elsewhere. Every
// resolvable media file — including EXTERNAL (referenced-in-place) clips — is
// COLLECTED into the bundle under `library/`, and the catalog is rewritten so
// every ref is project-relative (other NLEs' "collect media" export). Missing
// media is reported + skipped rather than failing the pack.
//
// Nothing READS the infix — the open dialog filters on plain `zip` — so bundles
// written under an earlier name still open.
import { zipSync } from "fflate";

import { PACKAGE_EXT } from "../brand";

/** Ceiling on a bundle's media. The archive is built in memory (fflate takes buffers), so this
 *  is a real limit, not a preference; streaming zip would lift it. */
const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024;

import type { ClientToolContext } from "../tools/context";
import type { ClientToolRegistry } from "../tools/registry";
import { INTERNAL_DIR, joinPath, type LibraryClip, type ProjectStoreAccess } from "../tools/store";
import { projectAggregate } from "./aggregate";

export interface PackReport {
  /** Catalog clips considered. */
  clips: number;
  /** External clips pulled INTO the bundle (were referenced in place). */
  collected: number;
  /** Media that couldn't be resolved/read — reported, not packed. */
  missing: Array<{ id: string; path: string }>;
  /** Total media bytes written into the bundle. */
  bytes: number;
}

export interface PackResult {
  /** The zip archive bytes. */
  zip: Uint8Array;
  report: PackReport;
  /** Suggested base name (project name), sans extension. */
  name: string;
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "project";
}
function extOf(name: string): string {
  const m = /\.[a-z0-9]+$/i.exec(name.replace(/\\/g, "/"));
  return m ? m[0].toLowerCase() : "";
}

/** Build a self-contained `.zip` of the project: `internals/{project,timeline,
 *  library}.json` (+ thumbnail if present) and every resolvable media file under
 *  `library/`. External clips are collected in and the rewritten catalog points
 *  every clip at its project-relative `library/<id><ext>`. Pure over the store's
 *  fs — no side effects; the caller decides where to write the bytes. */
export async function packProject(store: ProjectStoreAccess): Promise<PackResult> {
  const files: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();

  // ONE point-in-time read model (the flat consistency bridge): the timeline is the OPEN document's
  // in-memory authority when a project is open + edited (via loadTimeline), so the bundle captures
  // UNSAVED edits — not a stale timeline.json; the library + settings are the atomic on-disk copy.
  const agg = await projectAggregate(store);

  // internals/project.json (settings) + internals/timeline.json (the reconciled in-memory-or-disk
  // timeline) go into the bundle so a re-open sees exactly what the editor currently shows.
  if (agg.project)
    files[`${INTERNAL_DIR}/project.json`] = enc.encode(JSON.stringify(agg.project, null, 2));
  files[`${INTERNAL_DIR}/timeline.json`] = enc.encode(JSON.stringify(agg.timeline, null, 2));

  // Project name (for the zip filename) from settings, else the dir.
  let name = baseName(store.projectDir);
  const pjName = typeof agg.project?.name === "string" ? agg.project.name.trim() : "";
  if (pjName) name = pjName;

  // Collect media: resolve each catalog clip to its absolute path (project OR
  // external), read the bytes, and stage it project-relative under library/.
  const cat = agg.library;
  const clips = Array.isArray(cat.clips) ? cat.clips : [];
  const report: PackReport = { clips: clips.length, collected: 0, missing: [], bytes: 0 };
  const rewritten: LibraryClip[] = [];

  for (const clip of clips) {
    const abs = await store.resolveRef(clip.id);
    let bytes: Uint8Array | null = null;
    if (abs) {
      // The zip writer needs whole buffers, so this is the one place that reads media into the
      // heap. A TOTAL budget bounds it: a project too big to pack must say so with a number,
      // not silently omit the media that did not fit, and not die trying.
      const size = (await store.byteSize(abs)) ?? 0;
      if (report.bytes + size > MAX_PACK_BYTES) {
        throw new Error(
          `this project's media is too large to bundle (over ${(MAX_PACK_BYTES / 1e9).toFixed(1)} GB). ` +
            `Packing builds the archive in memory, so the limit is real rather than a preference.`,
        );
      }
      try {
        bytes = await store.readBytesForArchive(abs);
      } catch {
        bytes = null;
      }
    }
    if (!bytes) {
      report.missing.push({ id: clip.id, path: String(clip.path) });
      continue;
    }
    const ext = extOf(String(clip.filename ?? clip.path)) || extOf(abs ?? "") || "";
    const rel = `library/${clip.id}${ext}`;
    files[rel] = bytes;
    report.bytes += bytes.length;
    if (clip.external) report.collected += 1;
    // Rewrite: project-relative path, drop the external flag (now bundled in).
    const { external: _external, ...rest } = clip;
    rewritten.push({ ...rest, path: rel });
  }

  files[`${INTERNAL_DIR}/library.json`] = enc.encode(
    JSON.stringify({ ...cat, clips: rewritten }, null, 2),
  );

  // Thumbnail (best-effort) so the picker shows the bundle's look after re-open.
  const thumb = joinPath(store.projectDir, INTERNAL_DIR, "thumbnail.jpg");
  if (await store.exists(thumb)) {
    try {
      files[`${INTERNAL_DIR}/thumbnail.jpg`] = await store.readBytes(thumb);
    } catch {
      /* skip */
    }
  }

  return { zip: zipSync(files, { level: 6 }), report, name };
}

/** Pack the project and write the `.zip` to the OS Downloads dir (NLE-style:
 *  deliverables never land inside the project). Returns the written path + the
 *  collect-media report. */
export async function packProjectToDownloads(
  store: ProjectStoreAccess,
): Promise<{ path: string; report: PackReport }> {
  const { zip, report, name } = await packProject(store);
  const dir = (await store.downloadDir()) ?? store.projectDir;
  const safe = name.replace(/[^\w.\- ]+/g, "_").trim() || "project";
  const dest = joinPath(dir, `${safe}.${PACKAGE_EXT}`);
  await store.writeBytes(dest, zip);
  return { path: dest, report };
}

// ── agent tool: pack_project ─────────────────────────────────────────

/** pack_project: export the project as a portable, self-contained bundle
 *  in the user's Downloads (all media collected in, refs rewritten). No params. */
export async function packProjectTool(
  _args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Record<string, unknown>> {
  if (!ctx) return { ok: false, error: "client tool runtime not ready" };
  try {
    const { path, report } = await packProjectToDownloads(ctx.store);
    return {
      ok: true,
      path,
      clips: report.clips,
      collected: report.collected,
      missing: report.missing,
      bytes: report.bytes,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerPackTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("pack_project", (args) => packProjectTool(args, getCtx()));
}
