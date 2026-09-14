// The EFFECT class of every model-facing tool — the runtime boundary its execution REQUIRES (Step 4
// of the ProjectDocument refactor). This is the SINGLE SOURCE OF TRUTH the tool host will route each
// run through, so a tool can never forget to go through the gate / job scope. A drift guard
// (effects.test.ts) keeps this map in lockstep with the served contract: every contract tool is
// classified and nothing here is a phantom, so a tool added/removed via `npm run codegen` fails the
// build until it is classified.
//
// A tool's class describes what it DOES; the enforcement slice maps each class to its runtime:
//   read             — no durable project change (may be paid/async); TURN-scoped, served with NO
//                      project lease. Cancelled via the turn's abort signal, not the job scope.
//   project-mutation — changes the open document's authoritative state (timeline / library / settings);
//                      MUST commit through the project's mutation boundary (timeline MutationGate, or the
//                      per-project write lock for the catalog/settings files).
//   project-job      — long-running work that produces a DURABLE project asset (download / generate /
//                      import / heavy ffmpeg); runs under the document's ProjectJobScope so close cancels
//                      it deterministically instead of relying on the turn signal alone.
//   derived-job      — long-running work that produces a REBUILDABLE derived cache (transcription today;
//                      proxy / index / thumbnail later); also under the ProjectJobScope, but its output
//                      is not authoritative project state.
//   app-operation    — app-level project-registry / lifecycle (list / new / open / rename / duplicate);
//                      NOT scoped to the open document — runs on the app-level registry lock.
//   deliverable      — export to a user destination OUTSIDE the project package, from an immutable
//                      snapshot (export / pack); runs on the app-level export path.

export type ToolEffect =
  "read" | "project-mutation" | "project-job" | "derived-job" | "app-operation" | "deliverable";

/** The complete, authoritative tool → effect classification. Kept in sync with the served contract
 *  (src/contract/tools.snapshot.json) by effects.test.ts. */
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  // ── reads: no durable project change; turn-scoped (paid AI reads included) ──
  get_timeline: "read",
  inspect_timeline: "read",
  inspect_media: "read",
  inspect_color: "read",
  read_file: "read",
  get_project_state: "read",
  list_models: "read",
  probe_media: "read",
  video_get_metadata: "read",
  youtube_search: "read",
  web_search: "read",
  get_page: "read",
  get_page_image: "read",
  video_ask: "read",
  video_find_moment: "read",
  vision_describe: "read",
  image_ask: "read",
  find_content: "read",

  // ── derived-jobs: rebuildable derived cache, under the job scope ──
  get_transcript: "derived-job", // may run whisper to build the (rebuildable) transcript cache

  // ── project mutations: the open document's authoritative state ──
  add_track: "project-mutation",
  remove_tracks: "project-mutation",
  set_track: "project-mutation",
  set_tracks: "project-mutation",
  undo: "project-mutation",
  redo: "project-mutation",
  add_clips: "project-mutation",
  insert_clips: "project-mutation",
  add_text_clips: "project-mutation",
  add_captions: "project-mutation",
  update_text: "project-mutation",
  move_clips: "project-mutation",
  split_clips: "project-mutation",
  remove_clips: "project-mutation",
  ripple_delete: "project-mutation",
  set_clip_properties: "project-mutation",
  set_keyframes: "project-mutation",
  apply_effects: "project-mutation",
  apply_color: "project-mutation",
  set_transition: "project-mutation",
  link_clips: "project-mutation",
  unlink_clips: "project-mutation",
  library_op: "project-mutation", // catalog/folder mutations (per-project write lock, not the timeline gate)
  set_project_settings: "project-mutation",

  // ── project-jobs: durable project asset; long-running under the job scope ──
  download_video: "project-job",
  import_media: "project-job", // links/probes media into the library (I/O-heavy) — see judgment note below
  generate_image: "project-job",
  generate_video: "project-job",
  generate_voiceover: "project-job",
  generate_music: "project-job",
  extract_style: "project-job",
  run_ffmpeg: "project-job",
  clip_video: "project-job",
  crop_image: "project-job",

  // ── app-operations: project registry / lifecycle; NOT the open document ──
  list_projects: "app-operation",
  new_project: "app-operation",
  open_project: "app-operation",
  rename_project: "app-operation",
  duplicate_project: "app-operation",

  // ── deliverables: export outside the package, from an immutable snapshot ──
  export: "deliverable",
  pack_project: "deliverable",
  // Reads/stops the export queue — it writes no project state and produces no deliverable
  // of its own, so it is turn-scoped like any other read.
  manage_exports: "read",
};

/** The effect class of `name`, or undefined if it isn't a classified contract tool. */
export function toolEffect(name: string): ToolEffect | undefined {
  return TOOL_EFFECTS[name];
}

/** True when a tool's effect requires the document's ProjectJobScope (so close cancels it). */
export function isJobEffect(effect: ToolEffect): boolean {
  return effect === "project-job" || effect === "derived-job";
}

/** True when a tool's effect changes the open document's authoritative state. */
export function isMutationEffect(effect: ToolEffect): boolean {
  return effect === "project-mutation";
}
