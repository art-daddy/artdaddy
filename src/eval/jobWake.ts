// What the app tells the agent when background work it started has finished, for eval cases to give as a follow-up.
//
// A generation, an export or a transcript finishes after the turn that started it has ended. The app then sends the
// agent a message of its own, in the conversation, with what landed (store/jobNotes.ts collects the jobs and
// store/chat.ts `jobWakePrompt` words them; the labels are the ones each tool gives its job: tools/generation.ts,
// tools/audio.ts, timeline/exportQueue.ts, store/speechWakeHost.ts). A case gives that message, word for word, as the
// user turn after the job, so the model reads exactly what it would read in the app; over MCP nothing wakes an agent,
// and the follow-up is the only way such a case can run there. `scenarios.gap_async.test.ts` holds every message a case
// builds here to the app's own `jobWakePrompt`, so a change to the app's wording fails a test instead of silently
// leaving the cases on the old words.
//
// Pure on purpose: scenario files import it, and they must stay cheap to load.
import { JOB_WAKE_LEAD } from "../store/jobNotes";

/** One finished job, in the fields the app's message reads (store/jobNotes.ts SettledJob). */
export interface WakeJob {
  label: string;
  status: "done" | "failed";
  media_refs?: string[];
  /** For work that makes no library media (an export): what is said instead of refs. */
  detail?: string;
  error?: string;
  /** A failed export: the app's own sentence and its code, said instead of `error`. */
  failure?: string;
  failure_code?: string;
  /** The words of files the agent was told were not ready. */
  kind?: "words";
}

/** Every message a case built, with the jobs it was built from: what the drift test compares with the app's. */
export const WAKES_BUILT: { jobs: readonly WakeJob[]; text: string }[] = [];

function lineOf(j: WakeJob): string {
  if (j.status === "failed")
    return j.failure
      ? `- ${j.label} FAILED: ${j.failure}${j.failure_code ? ` (failure_code: ${j.failure_code})` : ""}`
      : `- ${j.label} FAILED: ${j.error ?? "unknown error"}`;
  const refs = (j.media_refs ?? []).join(", ");
  const suffix = refs ? ` (${refs})` : j.detail ? ` — ${j.detail}` : "";
  return `- ${j.label} ${j.kind === "words" ? "are" : "is"} ready${suffix}`;
}

/** The message the app sends when `jobs` have finished. */
export function wakeMessage(...jobs: WakeJob[]): string {
  const lines = jobs.map(lineOf);
  const text = jobs.every((j) => j.kind === "words" && j.status === "done")
    ? [JOB_WAKE_LEAD, ...lines, "", "Continue what you were doing if there is more to do."].join(
        "\n",
      )
    : [
        JOB_WAKE_LEAD,
        ...lines,
        "",
        "Continue what you were doing if there is more to do. If a job failed, say so and offer a",
        "way forward instead of silently retrying anything that costs money.",
      ].join("\n");
  WAKES_BUILT.push({ jobs, text });
  return text;
}

// ── the jobs, labelled as each tool labels its own ─────────────────────────────────────────────────────────────────

/** A generation that landed: its label and the refs it filled. */
export const landed = (label: string, ...refs: string[]): WakeJob => ({
  label,
  status: "done",
  media_refs: refs,
});

/** A generation that failed, with the reason the app gives. */
export const failedJob = (label: string, error: string): WakeJob => ({
  label,
  status: "failed",
  error,
});

/** The labels the generation tools give their jobs. */
export const LABEL = {
  image: (count = 1) => (count > 1 ? `${count} images` : "an image"),
  /** A video's label carries its length: 8 s unless the call asked for another (tools/genModels.ts videoSeconds). */
  video: (seconds = 8) => `a ${seconds}s video`,
  voiceover: "a voiceover",
  music: "a music bed",
  words: (files = 1) => `the words of ${files} file${files === 1 ? "" : "s"}`,
} as const;

/** An export that finished: the app names the file it wrote. */
export const exportDone = (filename: string): WakeJob => ({
  label: `the export ${filename}`,
  status: "done",
  detail: `saved as ${filename}`,
});

/** An export that failed: the app's own sentence for why, and its code (timeline/exportQueue.ts failureForAssistant). */
export const exportFailed = (filename: string, failure: string, failure_code: string): WakeJob => ({
  label: `the export ${filename}`,
  status: "failed",
  failure,
  failure_code,
});

/** What a provider returning nothing for an asset makes the app say (tools/genJobs.ts landOutputs): the ref, then why. */
export const providerReturnedNothing = (ref: string): string =>
  `${ref}: the provider returned nothing for this one — usually a content filter. Change the prompt ` +
  "(or the reference image, which is filtered separately) rather than retrying it unchanged";

/** The studio project's name (studio.ts get_project_state), and so the file an export of it is saved as when the
 *  request names none: the app names an export after its project (timeline/render.ts defaultExportStem). */
export const STUDIO_PROJECT_NAME = "Current cut";
export const STUDIO_EXPORT_FILE = `${STUDIO_PROJECT_NAME}.mp4`;
