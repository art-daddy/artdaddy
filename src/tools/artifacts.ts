// Artifact file I/O (client): read/write/patch project files on the shared
// store. Ports mechanical.py read_file/write_file/patch_file — the
// path-based subset (the server owns the TurnConfig key registry, so a
// register_as_key is accepted but not persisted here). Paths are constrained to
// the project dir; JSON/timeline content is parse-validated before writing.
import type { Timeline } from "../timeline/model";
import { validateTimeline } from "../timeline/validate";
import { withProjectLock } from "./coordinator";
import type { ClientToolContext } from "./context";
import type { ClientToolRegistry } from "./registry";

type Result = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };
const READ_CAP = 200_000;

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Project manifests are owned by the editor/timeline tools; a raw write/patch
// would bypass linked-audio sync, schema validation, and undo. Block anything
// under internals/ or named like a manifest (timeline/project/library/...).
const MANIFEST_RE =
  /(^|[/\\])internals([/\\]|$)|(^|[/\\])(timeline|project|library|history|transcript)\.json$/i;
function manifestError(path: string): string | null {
  return MANIFEST_RE.test(path.replace(/\\/g, "/"))
    ? "manifests (timeline.json, project.json, library.json, \u2026) are managed by the editor tools \u2014 change the timeline with add_clips/set_clip_properties/split_clips/etc., not write_file/patch_file"
    : null;
}

/** Parse-validate content destined for `rel` (JSON syntax + timeline schema). */
function validateContent(rel: string, content: string): string[] {
  if (!rel.toLowerCase().endsWith(".json")) return [];
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return [`invalid JSON: ${String(e)}`];
  }
  if (rel.replace(/\\/g, "/").endsWith("timeline.json")) {
    return validateTimeline(data as Timeline).slice(0, 20);
  }
  return [];
}

export async function readFileTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const ref = String(args.path_or_key ?? "").trim();
  if (!ref) return { ok: false, error: "path_or_key is required" };
  const full = ctx.store.resolveWritable(ref);
  if (!full) return { ok: false, error: `path escapes the project or is invalid: ${ref}` };
  if (!(await ctx.store.exists(full))) return { ok: false, error: `file not found: ${ref}` };
  const raw = await ctx.store.readText(full);
  const total = raw.length;
  const truncated = total > READ_CAP;
  return {
    ok: true,
    path: ctx.store.toRef(full),
    content: truncated ? raw.slice(0, READ_CAP) : raw,
    truncated,
    total_chars: total,
  };
}

export async function writeFileTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const rel = String(args.relative_path ?? "").trim();
  const content = typeof args.content === "string" ? args.content : "";
  if (!rel) return { ok: false, error: "relative_path is required" };
  const full = ctx.store.resolveWritable(rel);
  if (!full)
    return {
      ok: false,
      error: `relative_path must stay inside the project (no .. / escape): ${rel}`,
    };
  const mErr = manifestError(rel) ?? manifestError(full);
  if (mErr) return { ok: false, error: mErr };
  const errors = validateContent(rel, content);
  if (errors.length)
    return {
      ok: false,
      error: "content validation failed — not written",
      validation_errors: errors,
    };
  // Serialize the write on the per-project lock (R10).
  await withProjectLock(ctx.store.projectDir, () => ctx.store.writeProjectText(full, content));
  return { ok: true, path: ctx.store.toRef(full), bytes: byteLen(content) };
}

export async function patchFileTool(
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Result> {
  if (!ctx) return NOT_READY;
  const ref = String(args.path_or_key ?? "").trim();
  const oldStr = typeof args.old_string === "string" ? args.old_string : "";
  const newStr = typeof args.new_string === "string" ? args.new_string : "";
  const expected = typeof args.expected_replacements === "number" ? args.expected_replacements : 1;
  if (!ref) return { ok: false, error: "path_or_key is required" };
  if (!oldStr) return { ok: false, error: "old_string is required" };
  const full = ctx.store.resolveWritable(ref);
  if (!full) return { ok: false, error: `path escapes the project or is invalid: ${ref}` };
  const mErr = manifestError(ref) ?? manifestError(full);
  if (mErr) return { ok: false, error: mErr };
  // Serialize the read-modify-write on the per-project lock (R10) so two patches
  // to the same file can't lose an update.
  return withProjectLock(ctx.store.projectDir, async () => {
    if (!(await ctx.store.exists(full))) return { ok: false, error: `file not found: ${ref}` };
    const content = await ctx.store.readText(full);
    const actual = content.split(oldStr).length - 1;
    if (actual !== expected) {
      return {
        ok: false,
        error: `expected ${expected} occurrence(s) of old_string, found ${actual}`,
        matches_found: actual,
      };
    }
    const patched = content.split(oldStr).join(newStr); // actual === expected, so this replaces exactly `expected`
    const errors = validateContent(ref, patched);
    if (errors.length)
      return {
        ok: false,
        error: "patched content failed validation — not written",
        validation_errors: errors,
      };
    await ctx.store.writeProjectText(full, patched);
    const before = byteLen(content);
    const after = byteLen(patched);
    return {
      ok: true,
      path: ctx.store.toRef(full),
      applied: expected,
      bytes_before: before,
      bytes_after: after,
      bytes_delta: after - before,
    };
  });
}

export function registerFileTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("read_file", (args) => readFileTool(args, getCtx()));
  // write_file / patch_file are DISABLED (removed from the contract 2026-07-21):
  // legacy direct-file-edit tools from the pre-client-owned era. writeFileTool /
  // patchFileTool above are kept dormant (still unit-tested) for an easy re-enable
  // — re-register them here + re-add the Tool() specs in the server definitions.
}
