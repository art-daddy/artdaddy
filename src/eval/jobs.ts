// Background jobs for the studio stand-ins: generations and exports that are still running when the turn that started
// them ends, and that land (or fail) when a later user turn begins.
//
// In the app a generation returns a placeholder ref at once and its file lands a minute later; an export returns a job
// and writes the file later still. Meanwhile the ref is real and resolves to nothing: an image or a video can be placed
// (the clip fills in by itself), audio cannot be placed without a length, a look at the media says it "is still being
// generated", and an export refuses. When the work lands the app tells the agent in a message of its own (jobWake.ts).
// The plain studio stand-ins (studio.ts) land everything at once, so none of that can happen there; a case that sets
// `jobs` (types.ts JobPlan) gets these instead.
//
// What makes them honest:
//   - The library is the REAL one. A generation writes the same catalog row the app writes (tools/import.ts
//     registerPendingClip), so the REAL timeline tools answer as they do in the app: add_clips places a still-generating
//     image or video and refuses still-generating audio with no length, in the app's words. Landing flips the row the
//     way the app does after a restart (reconcilePendingMedia), and a failure marks it as the app does (failPendingClip).
//   - A look at a ref that has not landed, a video started from a frame that has not landed, and an export of a timeline
//     that holds one, answer with the app's own refusals (tools/refState.ts, timeline/render.ts).
//   - The clock is the conversation: a job lands at the first user turn at or after `landsAtTurn` that comes after the
//     turn that started it. A runner says when a turn begins (JobBoard.atTurn) before any call of that turn runs.
import { failPendingClip, reconcilePendingMedia, registerPendingClip } from "../tools/import";
import { ClientToolRegistry } from "../tools/registry";
import { unresolvedRefError } from "../tools/refState";
import { joinPath, type ProjectStoreAccess } from "../tools/store";
import { videoSeconds } from "../tools/genModels";
import { exportDestination, unresolvedMediaBlockers } from "../timeline/render";
import { plainFailure } from "../timeline/exportWords";
import type { ExportReasonCode } from "../api/exportReason";
import type { Timeline } from "../timeline/model";
import { registerStudioStubs, type StudioState } from "./studio";
import { STUDIO_PROJECT_NAME } from "./jobWake";
import type { JobPlan } from "./types";

/** How long a generated file runs once it has landed, in seconds: what the stand-in probe then answers for it. A video
 *  runs the length it was asked for, and a still has no length of its own. */
export const LANDED_SECONDS = { voiceover: 4, music: 30 } as const;

/** What a running export reports: how far it is and how long it says is left (manage_exports `time_left_s`). */
export const EXPORT_RUNNING = { progress_percent: 40, time_left_s: 45, elapsed_s: 30 } as const;

/** Where the export stand-in writes, as the app's Downloads folder. */
export const EXPORT_DIR = "C:/Users/eval/Downloads";

type GenTool = "generate_image" | "generate_video" | "generate_voiceover" | "generate_music";
type Kind = "image" | "video" | "audio";

interface Job {
  id: string;
  tool: GenTool | "export";
  startedTurn: number;
  state: "running" | "queued" | "done" | "failed" | "cancelled";
  /** A generation's refs, and what each will be once it lands. */
  refs: string[];
  kind?: Kind;
  seconds?: number;
  /** An export's file. */
  filename?: string;
  failure_code?: ExportReasonCode;
}

/** What a runner holds for a case with `jobs`. */
export interface JobBoard {
  /** User turn `turn` begins (0 is the request, 1.. each follow-up): every job due by then lands or fails. Call it before
   *  any tool call of that turn runs. Idempotent. */
  atTurn(turn: number): Promise<void>;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);

/** Register the job-aware stand-ins over the studio ones. Call it AFTER registerStudioStubs: each tool registered here
 *  replaces the studio one, and answers through it once nothing is pending. */
export function registerJobStubs(
  registry: ClientToolRegistry,
  state: StudioState,
  plan: JobPlan,
  env: {
    store: ProjectStoreAccess;
    timeline: () => Promise<Timeline>;
    fps?: number;
  },
): JobBoard {
  const { store } = env;
  const fps = env.fps ?? 30;
  const landsAtTurn = plan.landsAtTurn ?? 1;
  // The refusals a still-generating ref gets are the app's, in the words the in-app agent is given (the same words the
  // REAL timeline tools give here, whose context names no surface either).
  const ctx = { store, surface: undefined };
  // The studio stand-ins, kept to answer once nothing in the way is pending.
  const studio = new ClientToolRegistry();
  registerStudioStubs(studio, state, fps, env.timeline);

  const jobs: Job[] = [];
  let turn = 0;
  const counters = new Map<string, number>();
  const nextRef = (stem: string): string => {
    const n = (counters.get(stem) ?? 0) + 1;
    counters.set(stem, n);
    return `media_gen_${stem}_${n}`;
  };

  async function pend(ref: string, kind: Kind, seconds?: number): Promise<void> {
    const ext = kind === "image" ? ".png" : kind === "audio" ? ".mp3" : ".mp4";
    await registerPendingClip(store, {
      id: ref,
      filename: `${ref}${ext}`,
      kind,
      ...(seconds ? { duration_s: seconds } : {}),
    });
  }

  async function land(job: Job): Promise<void> {
    if (job.tool === "export") {
      job.state = plan.fail?.export ? "failed" : "done";
      if (plan.fail?.export) job.failure_code = plan.fail.export as ExportReasonCode;
      return;
    }
    const failure = plan.fail?.[job.tool];
    if (failure) {
      for (const ref of job.refs) await failPendingClip(store, ref, failure);
      job.state = "failed";
      return;
    }
    // The bytes first, then the row, as the app lands a job whose row could not be flipped at once.
    for (const ref of job.refs) {
      const row = (await store.listClips()).find((c) => c.id === ref);
      if (!row) continue;
      await store.writeTextAtomic(
        joinPath(store.projectDir, String(row.path)),
        "(eval) stand-in for generated media",
      );
    }
    await reconcilePendingMedia(store);
    for (const ref of job.refs) {
      const abs = await store.resolveRef(ref);
      // The stand-in probe answers a file's length from this list (harness.ts probeWithImports).
      if (abs && job.seconds)
        state.imported.push({ media_ref: abs, kind: job.kind ?? "video", duration_s: job.seconds });
    }
    job.state = "done";
  }

  async function start(
    tool: GenTool,
    refs: string[],
    kind: Kind,
    prompt: string,
    seconds?: number,
  ): Promise<void> {
    for (const ref of refs) {
      await pend(ref, kind, kind === "video" ? seconds : undefined);
      state.generated.push({ media_ref: ref, kind, prompt });
    }
    jobs.push({
      id: `gen_${jobs.length + 1}`,
      tool,
      startedTurn: turn,
      state: "running",
      refs,
      kind,
      seconds,
    });
  }

  /** The app's refusal for a ref that has not landed (or failed), or null when it is not one of ours in flight. */
  async function notLanded(ref: string, use?: string): Promise<Record<string, unknown> | null> {
    if (!ref || !(await store.pendingMedia(ref).catch(() => null))) return null;
    return unresolvedRefError(ctx, ref, `media not found: ${ref}`, Date.now(), use);
  }

  async function subjectRef(a: Record<string, unknown>): Promise<string> {
    if (typeof a.clip_id === "string" && a.clip_id) {
      const clips = ((await env.timeline()).tracks ?? []).flatMap((t) => t.clips ?? []);
      return String(clips.find((c) => c.id === a.clip_id)?.media_ref ?? "");
    }
    return str(a.media_ref);
  }

  // ── generation ──────────────────────────────────────────────────────────────────────────────────────────────────
  registry.register("generate_image", async (args) => {
    const a = args ?? {};
    const count = Math.max(1, Math.min(4, Math.trunc(Number(a.count ?? 1)) || 1));
    const refs = Array.from({ length: count }, () => nextRef("image"));
    await start("generate_image", refs, "image", str(a.prompt, "an image"));
    return {
      ok: true,
      model: str(a.model, "gemini-image"),
      status: "generating",
      count,
      assets: refs.map((media_ref) => ({ media_ref, kind: "image" })),
    };
  });

  registry.register("generate_video", async (args) => {
    const a = args ?? {};
    const references = Array.isArray(a.reference_images) ? a.reference_images.map(String) : [];
    // A frame that has not landed cannot be animated yet: the app says so as it is (tools/generation.ts).
    for (const ref of [str(a.start_frame), str(a.end_frame), ...references]) {
      const refused = await notLanded(ref);
      if (refused) return refused;
    }
    const seconds = videoSeconds(a.duration, references.length > 0);
    const ref = nextRef("video");
    await start("generate_video", [ref], "video", str(a.prompt, "a video"), seconds);
    return {
      ok: true,
      model: str(a.model, "veo-video"),
      kind: "video",
      status: "generating",
      media_ref: ref,
    };
  });

  registry.register("generate_voiceover", async (args) => {
    const a = args ?? {};
    const ref = nextRef("voiceover");
    await start(
      "generate_voiceover",
      [ref],
      "audio",
      str(a.text, "a voiceover"),
      LANDED_SECONDS.voiceover,
    );
    return {
      ok: true,
      status: "generating",
      voice: str(a.voice, "Charon"),
      model: str(a.model, "tts-1"),
      style: a.style ?? null,
      language: a.language ?? null,
      media_ref: ref,
    };
  });

  registry.register("generate_music", async (args) => {
    const a = args ?? {};
    const ref = nextRef("music");
    const prompt = str(a.prompt, "a music bed");
    await start("generate_music", [ref], "audio", prompt, LANDED_SECONDS.music);
    return {
      ok: true,
      model: str(a.model, "music-1"),
      prompt,
      instrumental: a.instrumental !== false,
      seed: null,
      status: "generating",
      media_ref: ref,
    };
  });

  // ── looks at media: nothing to read until it lands ─────────────────────────────────────────────────────────────
  for (const name of ["inspect_media", "video_ask", "video_find_moment", "inspect_color"]) {
    registry.register(name, async (args) => {
      const refused = await notLanded(await subjectRef(args ?? {}));
      return refused ?? studio.run(name, args ?? {});
    });
  }

  // ── the library lists generated media, with status:'generating' until it lands ─────────────────────────────────
  registry.register("library_op", async (args) => {
    const out = (await studio.run("library_op", args ?? {})) as Record<string, unknown>;
    if (str((args ?? {}).action, "list") !== "list" || !Array.isArray(out.clips)) return out;
    const generated = (await store.listClips())
      .filter((c) => c.added_by === "generation")
      .map((c) => ({
        id: c.id,
        filename: c.filename,
        path: c.path,
        kind: c.kind,
        folder: "",
        ...(c.status ? { status: c.status } : {}),
        ...(c.error ? { error: c.error } : {}),
      }));
    return { ...out, clips: [...out.clips, ...generated] };
  });

  // ── export: refused while generated media is pending; runs past the turn; one at a time ────────────────────────
  const destStore = {
    projectDir: "C:/projects/eval-project",
    // The project's title names an export the request did not name, as in the app.
    readJson: async <T>(): Promise<T> => ({ name: STUDIO_PROJECT_NAME }) as T,
    exportPath: async (filename: string) => `${EXPORT_DIR}/${filename}`,
    isDirectory: async (p: string) => p === EXPORT_DIR,
    exists: async (p: string) =>
      jobs.some(
        (j) =>
          j.tool === "export" && j.state !== "cancelled" && `${EXPORT_DIR}/${j.filename}` === p,
      ),
  };
  const exportsOf = () => jobs.filter((j) => j.tool === "export");
  const open = (j: Job) => j.state === "running" || j.state === "queued";

  registry.register("export", async (args) => {
    const a = args ?? {};
    if (a.format === "fcpxml") return studio.run("export", a);
    // The app refuses before any work (timeline/render.ts prepareRender), naming the clips.
    const unresolved = await unresolvedMediaBlockers(store, await env.timeline());
    if (unresolved.length) {
      const names = unresolved.map((u) => u.clip_id || u.media_ref).join(", ");
      const stillGoing = unresolved.some((u) => u.status === "generating");
      return {
        ok: false,
        error: stillGoing
          ? `still generating — ${names} ${unresolved.length === 1 ? "is" : "are"} not ready yet. Export once it finishes.`
          : `generation failed for ${names}; replace or remove ${unresolved.length === 1 ? "it" : "them"} before exporting.`,
        unresolved_media: unresolved,
      };
    }
    const dest = await exportDestination(destStore, {
      name: String(a.name ?? ""),
      outputPath: a.output_path,
    });
    if (!dest.ok) return { ok: false, error: dest.error };
    const ahead = exportsOf().filter(open).length;
    const job: Job = {
      id: `job_${exportsOf().length + 1}`,
      tool: "export",
      startedTurn: turn,
      state: ahead > 0 ? "queued" : "running",
      refs: [],
      filename: dest.filename,
    };
    jobs.push(job);
    state.exports.push({
      job_id: job.id,
      saved_to: dest.filename,
      status: ahead > 0 ? "queued" : "exporting",
    });
    return {
      ok: true,
      status: ahead > 0 ? "queued" : "exporting",
      job_id: job.id,
      queue_position: ahead,
      format: "mp4",
      saved_to: dest.filename,
      duration_s: 10,
      warnings: [],
      ...(dest.defaulted ? { note: "Saving to your Downloads folder." } : {}),
    };
  });

  registry.register("manage_exports", async (args) => {
    const a = args ?? {};
    const action = str(a.action, "list");
    if (action === "list") {
      const only = str(a.job_id);
      const rows = exportsOf().filter((j) => !only || j.id === only);
      if (only && !rows.length)
        return {
          ok: false,
          error: `no export with job_id '${only}' in this session; manage_exports action='list' shows them`,
        };
      const waiting = exportsOf().filter((j) => j.state === "queued");
      const exports = rows.map((j) => ({
        job_id: j.id,
        filename: j.filename,
        state: j.state,
        ...(j.state === "done" ? { duration_s: 12.5 } : {}),
        ...(open(j) ? { elapsed_s: EXPORT_RUNNING.elapsed_s } : {}),
        ...(j.state === "running"
          ? {
              stage: "rendering",
              progress_percent: EXPORT_RUNNING.progress_percent,
              time_left_s: EXPORT_RUNNING.time_left_s,
            }
          : {}),
        ...(j.state === "queued" ? { queue_position: waiting.indexOf(j) + 1 } : {}),
        ...(j.state === "failed" && j.failure_code
          ? { failure_code: j.failure_code, failure: plainFailure(j.failure_code) }
          : {}),
      }));
      const unfinished = rows.filter(open).length;
      const waited = typeof a.wait_seconds === "number" && a.wait_seconds > 0;
      const what = unfinished === 1 ? "1 export is" : `${unfinished} exports are`;
      return {
        ok: true,
        exports,
        ...(unfinished
          ? {
              retry_after_s: waited ? 60 : 15,
              note: waited
                ? `${what} still unfinished after waiting ${Math.round(Math.min(Number(a.wait_seconds), 60))} s. Do other work, or call manage_exports again with wait_seconds: it answers the moment they end.`
                : `${what} unfinished. Do not call this in a loop: pass wait_seconds (up to 60) and it answers the moment they end.`,
            }
          : {}),
      };
    }
    if (action !== "cancel")
      return { ok: false, error: `unknown action '${action}'; use 'list' or 'cancel'` };
    const id = str(a.job_id);
    if (!id) return { ok: false, error: "job_id is required to cancel an export" };
    const job = exportsOf().find((j) => j.id === id);
    if (!job)
      return {
        ok: false,
        error: `no export with job_id '${id}' in this session; manage_exports action='list' shows them`,
      };
    if (open(job)) {
      job.state = "cancelled";
      const rec = state.exports.find((e) => e.job_id === id);
      if (rec) rec.status = "cancelled";
      return { ok: true, cancelled: true };
    }
    const note =
      job.state === "done"
        ? "that export had already finished; nothing to cancel"
        : job.state === "failed"
          ? "that export had already failed; nothing to cancel"
          : "that export was already cancelled";
    return { ok: true, cancelled: false, state: job.state, note };
  });

  return {
    async atTurn(next: number) {
      turn = Math.max(turn, next);
      for (const job of jobs)
        if (open(job) && turn >= landsAtTurn && turn > job.startedTurn) await land(job);
    },
  };
}
