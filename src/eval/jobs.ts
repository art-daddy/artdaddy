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
//   - Speech a case names (`words`) is transcribed in the background as the app does on the person's computer: until its
//     job lands, get_transcript lists it `in_progress` and add_captions refuses with the app's own reply
//     (tools/captionTranscript.ts); after, both answer from the case's words.
//   - The clock is the conversation: a job lands at the first user turn at or after `landsAtTurn` that comes after the
//     turn that started it. A runner says when a turn begins (JobBoard.atTurn) before any call of that turn runs.
import { failPendingClip, reconcilePendingMedia, registerPendingClip } from "../tools/import";
import { pendingCaptionsResult } from "../tools/captionTranscript";
import { ClientToolRegistry } from "../tools/registry";
import { unresolvedRefError } from "../tools/refState";
import { joinPath, type ProjectStoreAccess } from "../tools/store";
import { videoSeconds } from "../tools/genModels";
import { clipSourceSpanSeconds, clipSpanToFrames } from "../timeline/helpers";
import { exportDestination, unresolvedMediaBlockers } from "../timeline/render";
import { plainFailure } from "../timeline/exportWords";
import type { ExportReasonCode } from "../api/exportReason";
import type { Clip, Timeline } from "../timeline/model";
import { registerStudioStubs, timelineSeconds, type StudioState } from "./studio";
import { EXPORT_RUNNING, LANDED_SECONDS, STUDIO_PROJECT_NAME } from "./jobWake";
import type { JobPlan } from "./types";

export { EXPORT_RUNNING, LANDED_SECONDS } from "./jobWake";

/** Where the export stand-in writes: the person's Downloads folder, as far as the agent is told. */
const EXPORT_DIR = "D:/Downloads";

type GenTool = "generate_image" | "generate_video" | "generate_voiceover" | "generate_music";
type Kind = "image" | "video" | "audio";

interface Job {
  id: string;
  tool: GenTool | "export" | "words";
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
    if (job.tool === "words") {
      job.state = "done";
      return;
    }
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
      duration_s: timelineSeconds(await env.timeline()),
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

  // ── speech: its words are made in the background ─────────────────────────────────────────────────────────────
  if (plan.words)
    registerWordStubs(registry, studio, plan.words, fps, env.timeline, () => {
      const job = jobs.find((j) => j.tool === "words");
      if (job) return job.state === "done";
      // Told they are not ready, the app wakes the agent when they land (store/speechWakeHost.ts).
      jobs.push({ id: "words_1", tool: "words", startedTurn: turn, state: "running", refs: [] });
      return false;
    });

  return {
    async atTurn(next: number) {
      turn = Math.max(turn, next);
      for (const job of jobs)
        if (open(job) && turn >= landsAtTurn && turn > job.startedTurn) await land(job);
    },
  };
}

/** Register the speech stand-ins: get_transcript and add_captions answer from the case's words once they have landed,
 *  and say they are not ready (starting the job) before. */
function registerWordStubs(
  registry: ClientToolRegistry,
  studio: ClientToolRegistry,
  speech: NonNullable<JobPlan["words"]>,
  fps: number,
  timeline: () => Promise<Timeline>,
  ready: () => boolean,
): void {
  /** The clips that play the speech, in timeline order. */
  const speaking = async (clipId?: string) => {
    const out: { clip: Clip; track: string }[] = [];
    for (const t of (await timeline()).tracks ?? [])
      for (const c of t.clips ?? [])
        if (String(c.media_ref ?? "") === speech.media_ref && (!clipId || c.id === clipId))
          out.push({ clip: c, track: String(t.id) });
    return out.sort((x, y) => Number(x.clip.timeline_in) - Number(y.clip.timeline_in));
  };
  /** The project's frame rate now: the words are project frames at the case's own canvas rate. */
  const rateNow = async () => {
    const rate = Number((await timeline()).canvas?.fps);
    return rate > 0 ? rate : fps;
  };
  /** The words a clip plays, as [text, start_frame, end_frame]: a word the clip does not play is not heard. */
  const heard = (clip: Clip, rate: number): [string, number, number][] => {
    const [from, to] = clipSourceSpanSeconds(clip, rate);
    const out: [string, number, number][] = [];
    for (const [text, s, e] of speech.words) {
      if (e <= from || s >= to) continue;
      const span = clipSpanToFrames(clip, s, e, rate);
      if (span) out.push([text, span[0], span[1]]);
    }
    return out;
  };
  const waiting = (hosts: { clip: Clip; track: string }[]) =>
    hosts.map((h) => ({ clip_id: String(h.clip.id), track_id: h.track }));

  registry.register("get_transcript", async (args) => {
    const a = args ?? {};
    const hosts = await speaking(str(a.clip_id) || undefined);
    const rate = await rateNow();
    const empty = {
      ok: true,
      fps: rate,
      timing: "project_frames",
      word_format: ["index", "text", "start_frame", "end_frame"],
      clips: [] as unknown[],
      word_count: 0,
      truncated: false,
      script_preview: "",
      script_chars: 0,
    };
    if (!hosts.length) return empty;
    if (!ready())
      return {
        ...empty,
        in_progress: waiting(hosts),
        note: `No words yet for ${hosts.length} clip(s) in in_progress: they are being transcribed in the background, only the parts the clips play. Call get_transcript again for them; their absence here is not silence.`,
      };
    const from = typeof a.start_frame === "number" ? a.start_frame : 0;
    const to = typeof a.end_frame === "number" ? a.end_frame : Infinity;
    let index = 0;
    const clips = hosts
      .map((h) => ({
        clip_id: String(h.clip.id),
        track_id: h.track,
        words: heard(h.clip, rate)
          .filter(([, s]) => s >= from && s < to)
          .map(([text, s, e]) => [index++, text, s, e]),
      }))
      .filter((c) => c.words.length);
    const script = clips.flatMap((c) => c.words.map((w) => String(w[1]))).join(" ");
    return {
      ...empty,
      clips,
      word_count: index,
      script_preview: script.slice(0, 600),
      script_chars: script.length,
    };
  });

  registry.register("add_captions", async (args) => {
    const a = args ?? {};
    const hosts = a.subtitle_media_ref ? [] : await speaking();
    // Nothing of the case's speech to caption: the studio's answer (no audio to transcribe).
    if (!hosts.length) return studio.run("add_captions", a);
    if (!ready())
      return pendingCaptionsResult(waiting(hosts), {
        status: "in_progress",
        stage: "transcribing",
        waited_s: 15,
        eta_s: 40,
        note: "",
      });
    // Caption-sized phrases on word boundaries: a sentence end, a pause, or four words closes one.
    const rate = await rateNow();
    const entries: Record<string, unknown>[] = [];
    for (const h of hosts) {
      let phrase: [string, number, number][] = [];
      const close = () => {
        if (!phrase.length) return;
        entries.push({
          timeline_in: phrase[0][1],
          timeline_out: phrase[phrase.length - 1][2],
          content: phrase.map((w) => w[0]).join(" "),
        });
        phrase = [];
      };
      const words = heard(h.clip, rate);
      words.forEach((w, i) => {
        phrase.push(w);
        const next = words[i + 1];
        if (/[.!?]$/.test(w[0]) || phrase.length >= 4 || !next || next[1] - w[2] > rate / 2)
          close();
      });
      close();
    }
    if (!entries.length) return studio.run("add_captions", a);
    const placed = (await registry.run("add_text_clips", { entries })) as Record<string, unknown>;
    if (placed?.ok === false) return placed;
    const created = Array.isArray(placed.created) ? placed.created : [];
    return {
      ok: true,
      created,
      count: created.length,
      caption_group: "cap_1",
      source_track: hosts[0].track,
    };
  });
}
