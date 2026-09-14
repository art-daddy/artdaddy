// Which tools may run at the SAME TIME as their neighbours.
//
// The model now emits several calls per round. The client runs them in the order it was
// given and overlaps only consecutive READ-ONLY ones; every mutation runs alone. That is
// the whole safety story: two writes can never interleave, and a read can never observe a
// half-applied edit.
//
// Classification is by EFFECT ON USER STATE, not by cost or duration. `export` is slow and
// `web_search` is billed, but neither fact decides whether a neighbour may run beside it.
//
// A tool absent from this table is treated as a WRITE — the safe default — and the
// conformance test in toolEffect.test.ts fails until it is classified deliberately.

export type ToolEffect = "read" | "write";

/** Observes state without changing anything the user owns. Safe to overlap. */
const READS = new Set<string>([
  // Project + timeline reads
  "get_project_state",
  "get_timeline",
  "inspect_timeline",
  "get_transcript",
  "list_projects",
  "list_models",
  // Media inspection — spawns ffmpeg and may write scratch frames under internals/cache,
  // which are per-call temp artifacts, not project state.
  "inspect_media",
  "inspect_color",
  "probe_media",
  "video_get_metadata",
  "read_file",
  // Paid vision reads. Billed per call and gated for approval, but they only LOOK.
  "video_ask",
  "video_find_moment",
  "image_ask",
  "vision_describe",
  "find_content",
  // The outside world. Cannot touch the timeline at all.
  "web_search",
  "youtube_search",
  "get_page",
]);

/** Changes something the user owns: the timeline, the library, or a file on disk.
 *  Listed explicitly rather than inferred so the conformance test can tell a deliberate
 *  classification from a tool nobody thought about. */
const WRITES = new Set<string>([
  // Timeline structure
  "add_clips",
  "insert_clips",
  "add_text_clips",
  "add_captions",
  "update_text",
  "add_track",
  "remove_clips",
  "remove_tracks",
  "move_clips",
  "split_clips",
  "ripple_delete",
  "link_clips",
  "unlink_clips",
  // Clip + track properties
  "set_clip_properties",
  "set_keyframes",
  "set_track",
  "set_tracks",
  "set_transition",
  "apply_color",
  "apply_effects",
  // History
  "undo",
  "redo",
  // Library + media production. `get_page_image` reads a web page but REGISTERS the
  // capture as media, so it lands here with the other producers.
  "import_media",
  "download_video",
  "get_page_image",
  "library_op",
  "clip_video",
  "crop_image",
  "run_ffmpeg",
  "generate_image",
  "generate_video",
  "generate_music",
  "generate_voiceover",
  "extract_style",
  // Project lifecycle + output
  "new_project",
  "open_project",
  "duplicate_project",
  "rename_project",
  "pack_project",
  "set_project_settings",
  "export",
  // Listing is harmless, but cancelling destroys an in-flight render. Classified with the
  // writes so a control call that throws work away is never batched in with parallel reads.
  "manage_exports",
]);

export const READ_ONLY_TOOLS: ReadonlySet<string> = READS;
export const MUTATING_TOOLS: ReadonlySet<string> = WRITES;

/** An unclassified tool is a WRITE: it runs alone, which is never wrong — only slower. */
export function toolEffect(name: string): ToolEffect {
  return READS.has(name) ? "read" : "write";
}

/** How many reads may be in flight at once. Bounded because several of these spawn ffmpeg
 *  or a vision call; unbounded fan-out would have the model's own reads competing for the
 *  machine the render also needs. */
export const MAX_CONCURRENT_READS = 4;
