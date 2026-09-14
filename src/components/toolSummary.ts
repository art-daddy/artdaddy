// What the chat says a tool call DID. The tool name is our vocabulary, not the user's --
// the same principle approvalCopy.ts already states for the approval bar -- so the
// transcript shows a sentence about the project instead of `set_clip_properties` and a
// blob of JSON. The raw arguments stay one click away; they are detail, not the story.
//
// Every phrase reads the RESULT where it can ("Added 3 clips"), because the arguments say
// what was asked for and the result says what happened, and those differ whenever the
// tool clamped, coerced or partially applied.
import type { TranscriptPart } from "../api/types";

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;

export interface SummaryContext {
  /** Track id -> the label the ruler shows (v1/a2/t1). */
  trackLabel: (id: string) => string;
}

interface Phrase {
  /** Bare verb phrase; becomes "Couldn't add clips" when the call fails. */
  bare: string;
  /** Shown while the call is still in flight. */
  ing: string;
  /** Shown once it returns. Reads the result first, the args only for what the result omits. */
  done: (a: Args, r: Result, c: SummaryContext) => string;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** First of `keys` the result actually carries, else the length of an args array. */
function count(r: Result, keys: string[], a?: Args, argKey?: string): number {
  for (const k of keys) {
    const n = num(r[k]);
    if (n !== undefined) return n;
    const v = r[k];
    if (Array.isArray(v)) return v.length;
  }
  if (a && argKey && Array.isArray(a[argKey])) return (a[argKey] as unknown[]).length;
  return 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** " to v1", or nothing when the track is unknown — never a raw id in prose. */
function onTrack(a: Args, r: Result, c: SummaryContext, prep = "to"): string {
  const id = s(r.track_id) || s(a.track_id) || s(a.track);
  if (!id) return "";
  return ` ${prep} ${c.trackLabel(id)}`;
}

/** The last path segment, so a summary never carries an absolute path. */
function fileName(v: unknown): string {
  const raw = s(v);
  if (!raw) return "";
  return raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
}

function quoted(v: unknown, max = 48): string {
  const raw = s(v).trim().replace(/\s+/g, " ");
  if (!raw) return "";
  return raw.length > max ? `“${raw.slice(0, max - 1)}…”` : `“${raw}”`;
}

const PHRASES: Record<string, Phrase> = {
  // ── placing media on the timeline ──
  add_clips: {
    bare: "add clips",
    ing: "Adding clips",
    done: (a, r, c) =>
      `Added ${plural(count(r, ["count", "created"], a, "entries"), "clip")}${onTrack(a, r, c)}`,
  },
  insert_clips: {
    bare: "insert clips",
    ing: "Inserting clips",
    done: (a, r, c) =>
      `Inserted ${plural(count(r, ["count", "created"], a, "entries"), "clip")}${onTrack(a, r, c, "into")}`,
  },
  add_text_clips: {
    bare: "add text",
    ing: "Adding text",
    done: (a, r, c) =>
      `Added ${plural(count(r, ["count", "created"], a, "entries"), "text clip")}${onTrack(a, r, c)}`,
  },
  add_captions: {
    bare: "add captions",
    ing: "Captioning the audio",
    done: (a, r, c) =>
      `Added ${plural(count(r, ["count", "created"], a, "entries"), "caption")}${onTrack(a, r, c)}`,
  },
  update_text: {
    bare: "restyle text",
    ing: "Updating text",
    done: (a, r) => `Updated ${plural(count(r, ["count", "updated"], a, "clip_ids"), "text clip")}`,
  },

  // ── structural edits ──
  split_clips: {
    bare: "split clips",
    ing: "Splitting clips",
    done: (a, r) => `Split ${plural(count(r, ["count", "new_clip_ids"], a, "splits"), "clip")}`,
  },
  remove_clips: {
    bare: "remove clips",
    ing: "Removing clips",
    done: (a, r) => `Removed ${plural(count(r, ["removed", "count"], a, "clip_ids"), "clip")}`,
  },
  move_clips: {
    bare: "move clips",
    ing: "Moving clips",
    done: (a, r) => `Moved ${plural(count(r, ["moved", "count"], a, "moves"), "clip")}`,
  },
  ripple_delete: {
    bare: "close the gap",
    ing: "Closing the gap",
    done: (a, r, c) => `Closed a gap${onTrack(a, r, c, "on")}`,
  },

  // ── clip properties + animation ──
  set_clip_properties: {
    bare: "update clips",
    ing: "Updating clips",
    done: (a, r) => `Updated ${plural(count(r, ["updated", "count"], a, "clip_ids"), "clip")}`,
  },
  set_keyframes: {
    bare: "animate a clip",
    ing: "Animating",
    done: (a, r) => {
      const prop = s(r.property) || s(a.property) || "a property";
      return r.cleared
        ? `Cleared the ${prop} animation`
        : `Animated ${prop} (${count(r, ["n"], a, "keyframes")} keys)`;
    },
  },
  apply_effects: {
    bare: "apply effects",
    ing: "Applying effects",
    done: (a, r) =>
      `Applied effects to ${plural(count(r, ["updated", "count"], a, "clip_ids"), "clip")}`,
  },
  apply_color: {
    bare: "adjust colour",
    ing: "Adjusting colour",
    done: (a, r) =>
      `Adjusted colour on ${plural(count(r, ["updated", "count"], a, "clip_ids"), "clip")}`,
  },
  set_transition: {
    bare: "set a transition",
    ing: "Adding a transition",
    done: (_a, r) => (r.removed ? "Removed a transition" : `Added a ${s(r.kind) || "transition"}`),
  },
  link_clips: {
    bare: "link clips",
    ing: "Linking clips",
    done: (a, r) => `Linked ${plural(count(r, ["linked", "count"], a, "clip_ids"), "clip")}`,
  },
  unlink_clips: {
    bare: "unlink clips",
    ing: "Unlinking clips",
    done: (a, r) => `Unlinked ${plural(count(r, ["unlinked", "count"], a, "clip_ids"), "clip")}`,
  },

  // ── tracks ──
  add_track: {
    bare: "add a track",
    ing: "Adding a track",
    done: (_a, r, c) => {
      const id = s(r.track_id);
      return id ? `Added track ${c.trackLabel(id)}` : "Added a track";
    },
  },
  remove_tracks: {
    bare: "remove tracks",
    ing: "Removing tracks",
    done: (a, r) => `Removed ${plural(count(r, ["removed", "count"], a, "track_ids"), "track")}`,
  },
  set_track: {
    bare: "update a track",
    ing: "Updating a track",
    done: (a, r, c) => `Updated ${onTrack(a, r, c).trim().replace(/^to /, "") || "a track"}`,
  },
  set_tracks: {
    bare: "update tracks",
    ing: "Updating tracks",
    done: (a, r) => `Updated ${plural(count(r, ["updated", "count"], a, "patches"), "track")}`,
  },

  // ── reading state ──
  get_timeline: {
    bare: "read the timeline",
    ing: "Reading the timeline",
    done: () => "Read the timeline",
  },
  inspect_timeline: {
    bare: "inspect the timeline",
    ing: "Inspecting the timeline",
    done: () => "Inspected the timeline",
  },
  get_transcript: {
    bare: "read the transcript",
    ing: "Reading the transcript",
    done: (_a, r) => {
      const n = count(r, ["segments", "clips"]);
      return n ? `Read the transcript (${plural(n, "segment")})` : "Read the transcript";
    },
  },
  get_project_state: {
    bare: "check the project",
    ing: "Checking the project",
    done: (_a, r) => `Checked the project${s(r.name) ? ` ${quoted(r.name)}` : ""}`,
  },
  list_projects: {
    bare: "list projects",
    ing: "Listing projects",
    done: (_a, r) => `Listed ${plural(count(r, ["projects"]), "project")}`,
  },
  list_models: {
    bare: "list models",
    ing: "Listing models",
    done: () => "Listed the available models",
  },
  probe_media: {
    bare: "probe media",
    ing: "Probing media",
    done: (a) => `Probed ${fileName(a.path) || "a file"}`,
  },
  inspect_media: {
    bare: "look at media",
    ing: "Looking at media",
    done: (a) => `Looked at ${fileName(a.media_ref) || s(a.clip_id) || "media"}`,
  },
  inspect_color: {
    bare: "measure colour",
    ing: "Measuring colour",
    done: () => "Measured the colour",
  },
  read_file: {
    bare: "read a file",
    ing: "Reading a file",
    done: (a) => `Read ${fileName(a.path) || "a file"}`,
  },
  video_get_metadata: {
    bare: "read video details",
    ing: "Reading video details",
    done: () => "Read the video details",
  },

  // ── looking + searching ──
  vision_describe: {
    bare: "look at the screen",
    ing: "Looking",
    done: () => "Described what it saw",
  },
  image_ask: {
    bare: "look at an image",
    ing: "Looking at an image",
    done: (a) => `Looked at an image${s(a.prompt) ? `: ${quoted(a.prompt)}` : ""}`,
  },
  video_ask: {
    bare: "watch a video",
    ing: "Watching a video",
    done: (a) =>
      `Watched a video${s(a.question) || s(a.prompt) ? `: ${quoted(a.question ?? a.prompt)}` : ""}`,
  },
  video_find_moment: {
    bare: "search a video",
    ing: "Searching a video",
    done: (a) => `Searched a video for ${quoted(a.query ?? a.find) || "a moment"}`,
  },
  find_content: {
    bare: "search your footage",
    ing: "Searching your footage",
    done: (_a, r) => `Found ${plural(count(r, ["locations", "matches"]), "match", "matches")}`,
  },
  extract_style: {
    bare: "analyse the style",
    ing: "Analysing the style",
    done: () => "Learned a style from your clips",
  },

  // ── generation ──
  generate_image: {
    bare: "generate an image",
    ing: "Generating an image",
    done: (a, r) => {
      const n = count(r, ["count"]);
      return n > 1
        ? `Generated ${plural(n, "image")}`
        : `Generated an image${s(a.prompt) ? `: ${quoted(a.prompt)}` : ""}`;
    },
  },
  generate_video: {
    bare: "generate a video",
    ing: "Generating a video",
    done: (a) => `Generated a video${s(a.prompt) ? `: ${quoted(a.prompt)}` : ""}`,
  },
  generate_music: {
    bare: "generate music",
    ing: "Generating music",
    done: (a) => `Generated music${s(a.prompt) ? `: ${quoted(a.prompt)}` : ""}`,
  },
  generate_voiceover: {
    bare: "generate a voiceover",
    ing: "Generating a voiceover",
    done: (a) => `Generated a voiceover${s(a.text) ? `: ${quoted(a.text)}` : ""}`,
  },

  // ── media in + out ──
  import_media: {
    bare: "import media",
    ing: "Importing media",
    done: (a, r) =>
      `Imported ${fileName(r.path) || fileName(a.path) || fileName(a.url) || "media"}`,
  },
  download_video: {
    bare: "download a video",
    ing: "Downloading a video",
    done: (a) => `Downloaded a video from ${hostOf(a.url) || "the internet"}`,
  },
  clip_video: { bare: "trim a video", ing: "Trimming a video", done: () => "Trimmed a video" },
  crop_image: { bare: "crop an image", ing: "Cropping an image", done: () => "Cropped an image" },
  run_ffmpeg: { bare: "run ffmpeg", ing: "Running ffmpeg", done: () => "Ran an ffmpeg command" },
  library_op: {
    bare: "update the library",
    ing: "Updating the library",
    done: (a, r) => {
      const op = s(a.op);
      if (op === "delete") return "Deleted media from the library";
      if (op === "list" || !op) return `Listed ${plural(count(r, ["clips"]), "library item")}`;
      return `Updated the library (${op})`;
    },
  },
  pack_project: {
    bare: "pack the project",
    ing: "Packing the project",
    done: () => "Packed the project",
  },
  export: {
    bare: "export the video",
    ing: "Exporting",
    // The file does not exist yet — "Exported" would be a lie the user could act on.
    done: (_a, r) =>
      r.status === "queued"
        ? `Queued ${fileName(r.saved_to) || "the video"} for export`
        : `Exporting ${fileName(r.saved_to) || "the video"}`,
  },
  manage_exports: {
    bare: "check on exports",
    ing: "Checking exports",
    done: (a, r) => {
      if (a.action === "cancel")
        return r.cancelled ? "Cancelled the export" : "That export had already finished";
      const n = Array.isArray(r.exports) ? r.exports.length : 0;
      return n ? `${plural(n, "export")} still running` : "No exports running";
    },
  },

  // ── projects ──
  new_project: {
    bare: "create a project",
    ing: "Creating a project",
    done: (a, r) => `Created ${quoted(r.name ?? a.name) || "a project"}`,
  },
  open_project: {
    bare: "open a project",
    ing: "Opening a project",
    done: () => "Opened the project",
  },
  rename_project: {
    bare: "rename the project",
    ing: "Renaming the project",
    done: (a, r) => `Renamed the project to ${quoted(r.name ?? a.name)}`,
  },
  duplicate_project: {
    bare: "duplicate the project",
    ing: "Duplicating the project",
    done: (a, r) => `Duplicated the project as ${quoted(r.name ?? a.name)}`,
  },
  set_project_settings: {
    bare: "change the project settings",
    ing: "Changing the project settings",
    done: (_a, r) => {
      const changed = Array.isArray(r.changed) ? (r.changed as unknown[]).map(String) : [];
      return changed.length ? `Changed ${changed.join(", ")}` : "Changed the project settings";
    },
  },

  // ── history ──
  undo: { bare: "undo", ing: "Undoing", done: () => "Undid the last change" },
  redo: { bare: "redo", ing: "Redoing", done: () => "Redid the last change" },

  // ── the web ──
  web_search: {
    bare: "search the web",
    ing: "Searching the web",
    done: (a) => `Searched the web for ${quoted(a.query)}`,
  },
  youtube_search: {
    bare: "search YouTube",
    ing: "Searching YouTube",
    done: (a) => `Searched YouTube for ${quoted(a.query)}`,
  },
  get_page: {
    bare: "read a page",
    ing: "Reading a page",
    done: (a) => `Read ${hostOf(a.url) || "a web page"}`,
  },
  get_page_image: {
    bare: "capture a page",
    ing: "Capturing a page",
    done: (a) => `Captured ${hostOf(a.url) || "a web page"}`,
  },
};

function hostOf(v: unknown): string {
  const raw = s(v);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw.slice(0, 40);
  }
}

/** Tool names this module deliberately phrases. Exported for the conformance test that
 *  walks the contract, so a newly added tool cannot ship as a bare identifier. */
export const PHRASED_TOOLS: ReadonlySet<string> = new Set(Object.keys(PHRASES));

/** A tool the vocabulary has never heard of: say something true rather than nothing.
 *  `set_clip_properties` -> "Set clip properties". */
function fallback(name: string): Phrase {
  const words = name.replace(/_/g, " ").trim() || "a step";
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  return { bare: words, ing: `${sentence}…`, done: () => sentence };
}

export interface ToolCallView {
  name: string;
  args: Args;
  result?: Result;
  /** One line, already inflected for running / done / failed. */
  text: string;
  running: boolean;
  ok: boolean;
  /** Started, never answered, and the turn is over — Stop, a supersede, or a crash. Distinct
   *  from `!ok`: nothing reported a failure, the answer simply never came. */
  interrupted?: boolean;
  /** The raw failure, kept for the expanded view rather than the summary line. */
  error?: string;
}

/** One line describing a single call, in whichever tense applies.
 *
 *  `live` is whether the TURN is still going. Without it a call with no result reads as
 *  "in flight" forever: Stop leaves the spinner turning, and reloading a project spins every
 *  unanswered call in the whole history. Only the turn still streaming can have one. */
export function summarizeCall(
  name: string,
  args: Args,
  result: Result | undefined,
  ctx: SummaryContext,
  live = true,
): { text: string; running: boolean; ok: boolean; interrupted?: boolean; error?: string } {
  const phrase = PHRASES[name] ?? fallback(name);
  if (!result) {
    if (live) return { text: phrase.ing, running: true, ok: true };
    return {
      text: `${phrase.ing.replace(/…$/, "")} — stopped`,
      running: false,
      ok: true,
      interrupted: true,
    };
  }
  const error = errorOf(result);
  if (error) {
    const bare = phrase.bare;
    return { text: `Couldn't ${bare}`, running: false, ok: false, error };
  }
  let text: string;
  try {
    text = phrase.done(args, result, ctx);
  } catch {
    // A malformed result must never blank the transcript.
    text = phrase.done({}, {}, ctx);
  }
  return { text, running: false, ok: true };
}

function errorOf(result: Result): string | undefined {
  if (result.ok === false) {
    const e = result.error;
    return s(e) || (e ? JSON.stringify(e) : "failed");
  }
  const e = (result as { error?: unknown }).error;
  return e ? s(e) || JSON.stringify(e) : undefined;
}

/** A row in the transcript: either an ordinary part, or a run of tool calls shown as one. */
export type TranscriptRow =
  | { kind: "part"; part: TranscriptPart; key: string }
  | { kind: "tools"; calls: ToolCallView[]; key: string };

/** How many DIFFERENT tools fold into one row before starting another. Repeats of a single
 *  tool are exempt: those merge into one true sentence ("Added 5 clips"), however many there
 *  are. Without this cap a whole turn collapsed into "Added 2 clips to v2 and 5 more", which
 *  is less use than the payloads it replaced. */
const MAX_MIXED_RUN = 3;

/** Pair each `tool_call` with its `tool_result` and fold consecutive calls into one row —
 *  the model's step-by-step is noise once it has happened, and the interesting thing is
 *  what changed. Anything that is not a tool call passes through untouched, so reasoning
 *  and prose keep breaking the run exactly where the model paused. */
export function buildRows(
  parts: TranscriptPart[],
  ctx: SummaryContext,
  live = true,
): TranscriptRow[] {
  const results = new Map<string, Result>();
  for (const p of parts) {
    if (p.kind === "tool_result") {
      const id = s(p.call_id);
      const r = (p.result ?? p) as Result;
      if (id) results.set(id, r);
    }
  }

  const rows: TranscriptRow[] = [];
  let run: ToolCallView[] = [];
  const flush = () => {
    if (run.length) {
      rows.push({ kind: "tools", calls: run, key: `tools-${rows.length}` });
      run = [];
    }
  };

  parts.forEach((p, i) => {
    if (p.kind === "tool_result") return; // folded into its call
    if (p.kind === "tool_call") {
      const name = s(p.name);
      const args = (p.args ?? p.arguments ?? {}) as Args;
      const result = results.get(s(p.call_id));
      const { text, running, ok, interrupted, error } = summarizeCall(
        name,
        args,
        result,
        ctx,
        live,
      );
      const view: ToolCallView = { name, args, result, text, running, ok, interrupted, error };

      // A failure is the headline, never a parenthetical inside someone else's sentence.
      if (!ok) {
        flush();
        run.push(view);
        flush();
        return;
      }
      const uniform = run.length > 0 && run.every((c) => c.name === name);
      if (run.length >= MAX_MIXED_RUN && !uniform) flush();
      run.push(view);
      return;
    }
    flush();
    rows.push({ kind: "part", part: p, key: `part-${i}` });
  });
  flush();
  return rows;
}

/** The single line shown for a folded run of calls.
 *
 *  The head clause covers the LEADING run of one tool, merged with its counts summed, so
 *  two `add_clips` behind a `set_transition` still read "Added 3 clips" rather than
 *  reporting only the first call's two. Whatever follows is counted, not narrated: a
 *  sentence spanning genuinely different actions would have to invent a relationship
 *  between them. */
export function rowSummary(calls: ToolCallView[], ctx: SummaryContext): string {
  if (calls.length === 0) return "";
  const running = calls.find((c) => c.running);
  if (running) return running.text;
  const stopped = calls.find((c) => c.interrupted);
  if (stopped) return stopped.text;
  if (calls.length === 1) return calls[0].text;

  let k = 1;
  while (k < calls.length && calls[k].name === calls[0].name && calls[k].ok) k++;
  const prefix = calls.slice(0, k);
  const merged = k > 1 && prefix.every((c) => c.ok) ? mergeSameTool(prefix, ctx) : null;
  // Only absorb the prefix when it genuinely merged. A tool with no count in its phrase
  // (undo, redo) cannot be summed, and swallowing the repeats would report two undos as one.
  const headCount = merged ? k : 1;
  const headText = merged ?? calls[0].text;

  const rest = calls.length - headCount;
  const failed = calls.filter((c) => !c.ok).length;
  if (rest === 0) return failed > 0 ? `${headText} (${failed} failed)` : headText;
  const tail = `${headText} and ${rest} more`;
  return failed > 0 ? `${tail} (${failed} failed)` : tail;
}

/** Re-run the tool's own phrase over the summed counts, so N calls of one tool read as one
 *  action. Returns null when the tool's phrase does not vary with a count, where summing
 *  would claim something the calls did not do. */
function mergeSameTool(calls: ToolCallView[], ctx: SummaryContext): string | null {
  const name = calls[0].name;
  const phrase = PHRASES[name];
  if (!phrase) return null;
  const keys = ["count", "removed", "moved", "updated", "linked", "unlinked", "n"];
  const totals: Result = {};
  let summed = false;
  for (const k of keys) {
    let total = 0;
    let seen = false;
    for (const c of calls) {
      const v = num(c.result?.[k]);
      if (v !== undefined) {
        total += v;
        seen = true;
      }
    }
    if (seen) {
      totals[k] = total;
      summed = true;
    }
  }
  if (!summed) return null;
  const first = calls[0];
  try {
    return phrase.done(first.args, { ...first.result, ...totals }, ctx);
  } catch {
    return null;
  }
}
