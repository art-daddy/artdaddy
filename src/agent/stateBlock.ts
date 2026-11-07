// The project's state, read for the model BEFORE its first round.
//
// In the field 21 of 22 first turns of a conversation, and 27% of later ones, began with the model calling
// get_timeline or get_project_state: a whole model round (a median 9-14 s) spent learning what the app
// already knows. The app now makes those two reads itself, with its own code and no model, and hands the model
// the answers with its message. The block is the tools' own results (same words, same units) so nothing is
// re-described, and it is bounded: a project too big to list gets a labelled summary instead.
//
// The server's system prompt names STATE_BLOCK_MARK (turn/system_prompt.py), so changing it is a contract change.
import { agentEventContext, type ToolTrace } from "../api/agentEvents";
import type { ToolHost } from "../tools/host";
import { runBounded } from "./toolBound";

type Json = Record<string, unknown>;

/** What every state block starts with: the server's system prompt tells the model what it means. */
export const STATE_BLOCK_MARK = "[Project state";
/** The most the listing may be before a summary replaces it (~4k tokens). */
export const STATE_BLOCK_MAX_CHARS = 16_000;
/** A read that has not answered by now is given up on: the model reads for itself, as it always did. */
const STATE_READ_BOUND_MS = 4_000;
const STATE_READ_GRACE_MS = 500;
const MAX_TRACK_ROWS = 40;
const MAX_SELECTED_IDS = 20;
const MAX_KINDS = 8;

const FULL_HEAD =
  `${STATE_BLOCK_MARK} - read for you by the app just now: these are the results get_project_state and ` +
  `get_timeline return, so do not call either again before your first edit.]`;
const SUMMARY_HEAD =
  `${STATE_BLOCK_MARK} (summary) - read for you by the app just now, but too large to list in full. For ` +
  `clip-level detail call get_timeline (window it with start_frame and end_frame); for every asset call ` +
  `library_op with action list.]`;

const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const cut = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");

/** A read's payload without its `ok`, or null when the read did not succeed. */
function payload(read: unknown): Json | null {
  if (!isObject(read) || read.ok !== true) return null;
  const { ok: _ok, ...rest } = read;
  return rest;
}

/** A small value passes through; anything bigger is left out of a summary rather than cut in half. */
function small(v: unknown, limit = 400): unknown {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    return s !== undefined && s.length <= limit ? v : undefined;
  } catch {
    return undefined;
  }
}

function trackRow(track: unknown): Json {
  const t = isObject(track) ? track : {};
  const clips = Array.isArray(t.clips) ? t.clips.filter(isObject) : [];
  let first: number | null = null;
  let last: number | null = null;
  for (const c of clips) {
    const a = finite(c.timeline_in);
    const b = finite(c.timeline_out);
    if (a !== null && (first === null || a < first)) first = a;
    if (b !== null && (last === null || b > last)) last = b;
  }
  return {
    id: cut(t.id, 64),
    kind: cut(t.kind, 20),
    clips: finite(t.total_clips) ?? clips.length,
    ...(first !== null ? { first_frame: first } : {}),
    ...(last !== null ? { last_frame: last } : {}),
  };
}

function librarySummary(project: Json): Json {
  const library = Array.isArray(project.library) ? project.library.filter(isObject) : [];
  const kinds: Record<string, number> = {};
  const status: Record<string, number> = {};
  for (const a of library) {
    let kind = cut(a.kind, 20) || "unknown";
    if (!(kind in kinds) && Object.keys(kinds).length >= MAX_KINDS) kind = "other";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    // A shot that is still generating or has failed is the one thing the model must not place by accident.
    const s = cut(a.status, 20);
    if (s === "generating" || s === "failed") status[s] = (status[s] ?? 0) + 1;
  }
  return {
    library_count: finite(project.library_count) ?? library.length,
    library_kinds: kinds,
    ...(Object.keys(status).length ? { library_status: status } : {}),
  };
}

/** Where the person is looking: the playhead and what they selected. Bounded, like everything here. */
function editorFocus(timeline: Json): Json {
  const out: Json = {};
  const frame = finite(timeline.current_frame);
  if (frame !== null) out.current_frame = frame;
  if (typeof timeline.current_timecode === "string")
    out.current_timecode = cut(timeline.current_timecode, 20);
  const ids = timeline.selected_clip_ids;
  if (Array.isArray(ids) && ids.length) {
    out.selected_clip_ids = ids.slice(0, MAX_SELECTED_IDS).map((id) => cut(id, 64));
    if (ids.length > MAX_SELECTED_IDS) out.selected_clip_count = ids.length;
  }
  for (const key of ["selected_range", "selected_gap"] as const) {
    const v = small(timeline[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function summarize(project: Json, timeline: Json): Json {
  const tl = timeline.timeline as Json;
  const tracks = Array.isArray(tl.tracks) ? tl.tracks : [];
  const rows = tracks.slice(0, MAX_TRACK_ROWS).map(trackRow);
  const canvas = small(project.canvas);
  const tlCanvas = small(tl.canvas);
  return {
    get_project_state: {
      project_id: cut(project.project_id, 80),
      name: cut(project.name, 120),
      ...(canvas !== undefined ? { canvas } : {}),
      ...librarySummary(project),
    },
    get_timeline: {
      timeline: {
        units: cut(tl.units, 20),
        ...(tlCanvas !== undefined ? { canvas: tlCanvas } : {}),
        tracks: rows,
        ...(tracks.length > rows.length ? { tracks_total: tracks.length } : {}),
      },
      ...editorFocus(timeline),
    },
  };
}

/** The block for the model's message, or null when either read did not succeed (the model then reads for
 *  itself, exactly as before). Whole when it fits `max`, otherwise a labelled summary: the model is never
 *  told a partial listing is the whole project. */
export function formatStateBlock(
  projectRead: unknown,
  timelineRead: unknown,
  max = STATE_BLOCK_MAX_CHARS,
): string | null {
  const project = payload(projectRead);
  const timeline = payload(timelineRead);
  if (!project || !timeline || !isObject(timeline.timeline)) return null;
  try {
    const whole = JSON.stringify({ get_project_state: project, get_timeline: timeline });
    if (whole.length <= max) return `${FULL_HEAD}\n${whole}`;
    return `${SUMMARY_HEAD}\n${JSON.stringify(summarize(project, timeline))}`;
  } catch {
    return null;
  }
}

/** A trace that records nothing: the app's own look is not a tool call the model made, and the analytics
 *  that count first-round reads must not count it. */
function silentTrace(): ToolTrace {
  return { context: agentEventContext(), result: () => undefined, error: () => undefined };
}

/** Can this host make the two reads? Checked before anything is awaited, so a host that cannot adds no wait. */
export function canReadState(host: Pick<ToolHost, "has">): boolean {
  return host.has("get_project_state") && host.has("get_timeline");
}

/** Read the project through the same two tools the model would have called, silently. Null on any failure,
 *  a Stop, or a read that does not answer in time: this never holds the first message hostage. */
export async function readStateBlock(
  host: Pick<ToolHost, "has" | "run">,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted || !canReadState(host)) return null;
  try {
    const trace = silentTrace();
    const read = await runBounded(
      async (own) => {
        const options = { surface: "app" as const, signal: own, trace };
        const project = await host.run("get_project_state", {}, options);
        const timeline = await host.run("get_timeline", {}, options);
        return { project, timeline };
      },
      { boundMs: STATE_READ_BOUND_MS, graceMs: STATE_READ_GRACE_MS, signal },
    );
    if (read.timedOut || signal?.aborted) return null;
    return formatStateBlock(read.value.project, read.value.timeline);
  } catch {
    return null;
  }
}
