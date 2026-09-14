// Journey surface for the eval harness — deterministic stand-ins for the few
// NON-timeline tools a multi-step workflow needs (import, transcript, export).
//
// WHY STAND-INS: the harness is timeline-only precisely so an eval can never
// spend money or hit the network. A workflow eval asks a different question than
// the single-verb scenarios — can the model PLAN and SEQUENCE a job end to end? —
// and that question is answerable without real bytes. Whether ffmpeg actually
// burns the pixels is already proven by the pixel lane (caption.smoke.e2e.ts);
// duplicating it here would only add spend, minutes, and flakiness.
//
// Every stub mirrors the REAL tool's result shape (notably get_transcript's
// `word_format` rows in PROJECT FRAMES) so the model is never taught a fiction.
import type { ClientToolRegistry } from "../tools/registry";
import { kindOf } from "../media/formats";
import { exportDestination } from "../timeline/render";

/** One queued export, as the real tool reports it. */
export interface JourneyExport {
  job_id: string;
  saved_to: string;
  status: "exporting" | "queued" | "cancelled";
}

/** What the journey stubs recorded, for a scenario's `expectTrace` grader. */
export interface JourneyState {
  imported: { media_ref: string; kind: string }[];
  exports: JourneyExport[];
}

/** A fixed word-level transcript for the narration clip the journey seeds.
 *  Rows are [index, text, start_frame, end_frame] at the canvas fps — the real contract. */
export const JOURNEY_WORDS: [number, string, number, number][] = [
  [0, "Welcome", 30, 42],
  [1, "to", 45, 52],
  [2, "the", 55, 62],
  [3, "show", 70, 88],
  [4, "today", 95, 115],
  [5, "we", 120, 127],
  [6, "are", 130, 140],
  [7, "building", 145, 170],
  [8, "something", 175, 200],
  [9, "new", 205, 220],
];

/** The frame the last spoken word starts on (the "dead air starts here" mark). */
export const JOURNEY_LAST_WORD_FRAME = JOURNEY_WORDS[JOURNEY_WORDS.length - 1][2];

/** The media_ref the narration clip in a journey seed points at. */
export const JOURNEY_NARRATION_REF = "media_narration";

/** Register the workflow stand-ins. Timeline tools are registered separately and
 *  are the REAL implementations — only these three are stood in for. */
export function registerJourneyStubs(
  registry: ClientToolRegistry,
  state: JourneyState,
  fps = 30,
): void {
  registry.register("import_media", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const name =
      typeof a.name === "string" && a.name ? a.name : `asset_${state.imported.length + 1}`;
    const src = (a.source ?? {}) as Record<string, unknown>;
    const from = String(src.path ?? src.url ?? "bytes");
    const kind = kindOf(from) === "audio" ? "audio" : "video";
    const media_ref = `media_${String(name)
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase()}`;
    state.imported.push({ media_ref, kind });
    return { ok: true, media_ref, kind, filename: name, duration_s: 10 };
  });

  registry.register("get_transcript", async () => ({
    ok: true,
    fps,
    timing: "project_frames",
    word_format: ["index", "text", "start_frame", "end_frame"],
    clips: [{ clip_id: "narration", track_id: "v1", words: JOURNEY_WORDS }],
    word_count: JOURNEY_WORDS.length,
    truncated: false,
    script_preview: JOURNEY_WORDS.map((w) => w[1]).join(" "),
    script_chars: JOURNEY_WORDS.map((w) => w[1]).join(" ").length,
  }));

  // The REAL export is a QUEUED job: it returns `status:'exporting'` and a `job_id`, and the
  // file does not exist yet. A stub that answered "ok, saved_to: final.mp4" taught the model the
  // opposite — that the deliverable was already on disk — which is precisely the fiction that
  // makes the 4x-export verify loop impossible to reproduce here. The destination rules are not
  // re-implemented either: exportDestination is the real one, over a tiny in-memory store, so a
  // relative output_path is refused with the same message the user's app would give.
  const EXPORT_DIR = "C:/Users/eval/Downloads";
  const destStore = {
    projectDir: "C:/projects/eval-project",
    exportPath: async (filename: string) => `${EXPORT_DIR}/${filename}`,
    isDirectory: async (p: string) => p === EXPORT_DIR,
    // A cancelled export leaves nothing on disk — the queue removes the staged file and releases
    // the reservation — so its name is free again. Counting it de-duped the retry to "name 2.mp4"
    // and the model repeated that filename to the user.
    exists: async (p: string) =>
      state.exports.some((e) => e.status !== "cancelled" && `${EXPORT_DIR}/${e.saved_to}` === p),
  };

  registry.register("export", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (a.format === "fcpxml")
      return {
        ok: true,
        xml_path: "timeline.xml",
        report_path: "report.md",
        clips_mapped: 0,
        clips_total: 0,
        unmapped: [],
      };

    const dest = await exportDestination(destStore, {
      name: String(a.name ?? ""),
      outputPath: a.output_path,
    });
    if (!dest.ok) return { ok: false, error: dest.error };

    // One encode at a time, and nothing in the harness ever finishes one — which is exactly the
    // state the model has to reason about instead of exporting again to find out.
    const running = state.exports.filter((e) => e.status !== "cancelled").length;
    const job: JourneyExport = {
      job_id: `job_${state.exports.length + 1}`,
      saved_to: dest.filename,
      status: running > 0 ? "queued" : "exporting",
    };
    state.exports.push(job);
    return {
      ok: true,
      status: job.status,
      job_id: job.job_id,
      queue_position: running,
      format: "mp4",
      saved_to: job.saved_to,
      duration_s: 10,
      warnings: [],
      ...(dest.defaulted ? { note: "Saving to your Downloads folder." } : {}),
    };
  });

  // Registered so that CHECKING an export is a real option. Without it the only way for a model
  // to find out what happened to a render is to start another one, and the eval would be
  // grading a choice the model was never offered.
  registry.register("manage_exports", async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const action = String(a.action ?? "list");
    if (action === "list")
      return { ok: true, jobs: state.exports.map((e) => ({ ...e, tool: "export" })) };
    if (action === "cancel") {
      const job = state.exports.find((e) => e.job_id === a.job_id);
      if (!job) return { ok: false, error: `no export job '${String(a.job_id)}'.` };
      if (job.status === "cancelled") return { ok: false, error: "that export already finished." };
      job.status = "cancelled";
      return { ok: true, cancelled: job.job_id };
    }
    return { ok: false, error: `unknown action '${action}'.` };
  });
}
