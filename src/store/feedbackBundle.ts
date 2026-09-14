// Assemble the opt-in diagnostic snapshot for /telemetry/feedback: the
// conversation transcript, the live timeline, and the small project manifests
// (project.json + library.json). Client-owned JSON only — never media bytes.
// Size-capped so a big project can't exceed the server's per-item limit.
import type { FeedbackBundle } from "../api/feedback";
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "../tools/store";

// Stay well under the server's per-item cap; shed optional parts to fit.
const MAX_BYTES = 1_500_000;

async function readJson(
  store: ProjectStoreAccess,
  segments: string[],
): Promise<unknown | undefined> {
  try {
    const p = joinPath(store.projectDir, ...segments);
    if (!(await store.exists(p))) return undefined;
    return JSON.parse(await store.readText(p)) as unknown;
  } catch {
    return undefined; // missing/corrupt manifest — skip it
  }
}

/** Build the (size-capped) feedback bundle. Reads manifests best-effort; drops
 *  the heaviest parts first (manifests, then timeline, then trims the
 *  transcript) so the payload always fits. */
export async function buildFeedbackBundle(
  store: ProjectStoreAccess | null,
  transcript: unknown[],
  timeline: unknown,
): Promise<FeedbackBundle> {
  const manifests: Record<string, unknown> = {};
  if (store) {
    const project = await readJson(store, [INTERNAL_DIR, "project.json"]);
    if (project !== undefined) manifests.project = project;
    const library = await readJson(store, ["library.json"]);
    if (library !== undefined) manifests.library = library;
  }
  const bundle: FeedbackBundle = {
    transcript,
    timeline: timeline ?? undefined,
    manifests: Object.keys(manifests).length ? manifests : undefined,
  };
  const tooBig = () => JSON.stringify(bundle).length > MAX_BYTES;
  if (tooBig()) delete bundle.manifests;
  if (tooBig()) delete bundle.timeline;
  if (tooBig() && Array.isArray(transcript)) bundle.transcript = transcript.slice(-20);
  return bundle;
}
