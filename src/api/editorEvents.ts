// What a person does in the editor itself: the actions they take by hand, the files they bring in and whether it worked,
// and how the preview behaves.
//
// The agent's tool calls are traced, but nothing else was: a drop that did nothing, a video that never showed a picture, an
// hour of hand editing and a session that went wrong all left the same record as losing interest. This closes that gap with
// words and numbers only. No item can carry a file name, a path, what was typed or what the media shows: every text field is
// a word from a closed list below (written down again on the server, analytics.py, and a test there compares the two from
// THIS file) or a codec name from ffmpeg's own table. A flush says which project it was in by its id, the same id every
// other record carries.
//
// Held and sent in a flush of at most a minute, never one request per action: the analytics container shares the credit
// ledger's single RU pool and that ledger fails CLOSED, so a write per drag would let a busy minute of editing deny somebody
// else's paid request. Unsent items can still be lost on an outage or a forced exit; that is accepted, like the agent's.
//
// Carries NO identity: the server takes that from the authenticated request. Nothing recorded under one account is ever
// sent under another: a sign-out or a different account discards what is held.
import { apiBase } from "./config";
import { authedFetch, hasSession } from "./auth";
import { hostInfo } from "../platform/host";
import { useAuth } from "../store/auth";

export const EDITOR_EVENT_KINDS = ["edits", "import", "media", "preview"] as const;
export const EDIT_KINDS = [
  "add",
  "move",
  "trim",
  "split",
  "delete",
  "property",
  "effect",
  "text",
  "keyframe",
  "transition",
  "link",
  "track",
  "canvas",
  "undo",
  "redo",
] as const;
export const IMPORT_REASONS = [
  "unsupported_type",
  "image_too_large",
  "no_index",
  "file_missing",
  "permission",
  "disk_full",
  "file_in_use",
  "other",
] as const;
export const IMPORT_DOORS = ["reference", "copy", "recording", "export", "generation", "other"] as const;
export const MEDIA_KINDS = ["video", "image", "audio", "subtitle", "unknown"] as const;
export const PROXY_STATES = ["none", "built", "failed"] as const;
export const PREVIEW_WHATS = ["first_frame", "stall", "failure"] as const;
export const PREVIEW_FAILURES = [
  "no_track",
  "no_index",
  "read_failed",
  "decoder_error",
  "unsupported",
  "image_failed",
  "unresolved",
  "worker_failed",
  "other",
] as const;
/** The most the server accepts of each: a number past these refuses the whole flush, so every number is clamped to them here first. */
export const MAX_EDITOR_WINDOW_S = 3_600;
export const MAX_EDITOR_COUNT = 100_000;
export const MAX_EDITOR_DIM = 100_000;
export const MAX_EDITOR_SECONDS = 31_536_000;
export const MAX_EDITOR_MB = 10_000_000;
export const MAX_EDITOR_MS = 86_400_000;
export const MAX_EDITOR_ITEMS = 50;

export type EditorEventKind = (typeof EDITOR_EVENT_KINDS)[number];
export type EditKind = (typeof EDIT_KINDS)[number];
export type ImportReason = (typeof IMPORT_REASONS)[number];
export type ImportDoor = (typeof IMPORT_DOORS)[number];
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type ProxyState = (typeof PROXY_STATES)[number];
export type PreviewWhat = (typeof PREVIEW_WHATS)[number];
export type PreviewFailure = (typeof PREVIEW_FAILURES)[number];

export interface EditorItem {
  kind: EditorEventKind;
  /** Epoch seconds, the app's clock. */
  at: number;
  /** edits: how long the window was, and how many of each kind of action it held. */
  window_s?: number;
  counts?: Partial<Record<EditKind, number>>;
  /** import: whether it worked and, when not, why. */
  ok?: boolean;
  reason?: string;
  media?: MediaKind;
  via?: string;
  /** preview: which of the three, and (for a failure) the codec family of what could not be shown. */
  what?: PreviewWhat;
  /** media: what became of the file's preview copy. */
  proxy?: ProxyState;
  codec?: string;
  width?: number;
  height?: number;
  dur_s?: number;
  size_mb?: number;
  ms?: number;
}

/** A window of actions is flushed this long after its first one. */
const WINDOW_MS = 60_000;
/** More items than this in one minute means a burst (a folder dropped at once) outran what a minute may carry: the rest are
 *  counted, not kept, and the next flush says how many. Ten full flushes, well inside the server's own per-person budget. */
const MAX_ITEMS_PER_MINUTE = 500;

const whole = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(Math.round(value), max)) : 0;

/** A codec name as ffmpeg's own table spells it (`hevc`, `h264`, `prores`, `pcm_s16le`) or a codec family of a stream header
 *  (`avc1`, `hev1`): never text from a file, so a short name of that alphabet is all there is to keep. Anything that is not one
 *  (a path, a sentence) is dropped whole, never trimmed into something that merely looks like one. */
export const codecName = (value: unknown, cap: number): string => {
  if (typeof value !== "string") return "";
  const name = value.trim().toLowerCase();
  return name.length <= cap && /^[a-z0-9][a-z0-9_.-]*$/.test(name) ? name : "";
};

const isWord = (value: unknown, words: readonly string[]): boolean =>
  typeof value === "string" && words.includes(value);

function word<T extends string>(value: unknown, words: readonly T[], fallback: T): T {
  return isWord(value, words) ? (value as T) : fallback;
}

/** A size or a length, rounded UP to the next step of a fixed ladder: a number as precise as a file's own would identify it,
 *  and a band says what analysis needs (a phone clip, a feature, a 4K master) and no more. Above the last step it is the last. */
const MB_LADDER = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144] as const;
const SECONDS_LADDER = [10, 30, 60, 300, 600, 1800, 3600, 7200, 14400, 43200, 86400] as const;
function ladderUp(value: number, ladder: readonly number[]): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return ladder.find((step) => value <= step) ?? ladder[ladder.length - 1];
}
export const bandMegabytes = (bytes: number): number => ladderUp(bytes / 1_048_576, MB_LADDER);
export const bandSeconds = (seconds: number): number => ladderUp(seconds, SECONDS_LADDER);

interface Queued {
  item: EditorItem;
  projectId: string;
}
interface Window {
  startedAt: number;
  counts: Partial<Record<EditKind, number>>;
}

let windows = new Map<string, Window>();
let queue: Queued[] = [];
let dropped = 0;
let budgetStart = 0;
let budgetUsed = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let offAuth: (() => void) | null = null;
const deliveries = new Set<AbortController>();
const inFlight = new Set<Promise<void>>();

function signedOut(): boolean {
  const session = useAuth.getState();
  return session.status === "locked" || (session.status === "offline" && !session.hasStoredSession);
}

function discardSessionEvents(): void {
  generation += 1;
  windows = new Map();
  queue = [];
  dropped = 0;
  budgetStart = 0;
  budgetUsed = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  for (const controller of deliveries) controller.abort();
}

/** What was held under one account is gone the moment the account changes or the person signs out. */
function watchSession(): void {
  if (offAuth) return;
  const initial = useAuth.getState();
  let owner = initial.profile?.user_id ?? "";
  let stored = initial.hasStoredSession;
  offAuth = useAuth.subscribe((state) => {
    const user = state.profile?.user_id ?? "";
    const out =
      state.status === "locked" || (state.status === "offline" && !state.hasStoredSession);
    if (out || (user && owner && user !== owner) || (stored && !state.hasStoredSession)) {
      discardSessionEvents();
    }
    if (out) owner = "";
    else if (user) owner = user;
    stored = state.hasStoredSession;
  });
}

function schedule(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => void flushEditorEvents(), WINDOW_MS);
  (flushTimer as { unref?: () => void }).unref?.();
}

function push(item: EditorItem, projectId: string, now = Date.now()): void {
  if (signedOut()) return;
  watchSession();
  if (now - budgetStart >= WINDOW_MS || now < budgetStart) {
    budgetStart = now;
    budgetUsed = 0;
  }
  if (budgetUsed >= MAX_ITEMS_PER_MINUTE) {
    dropped = Math.min(MAX_EDITOR_COUNT, dropped + 1);
    schedule(); // so the count is said within a minute even if nothing else is ever held
    return;
  }
  budgetUsed += 1;
  queue.push({ item, projectId });
  if (queue.length >= MAX_EDITOR_ITEMS) void flushEditorEvents();
  else schedule();
}

/** One action the person took by hand. Counted, not kept: a window holds how many of each kind, and nothing of what was edited. */
export function recordEdit(kind: EditKind, projectId = "", now = Date.now()): void {
  if (signedOut()) return;
  watchSession();
  let window = windows.get(projectId);
  if (!window) {
    window = { startedAt: now, counts: {} };
    windows.set(projectId, window);
  }
  window.counts[kind] = Math.min(MAX_EDITOR_COUNT, (window.counts[kind] ?? 0) + 1);
  schedule();
}

export interface ImportFacts {
  ok: boolean;
  /** Why it did not come in: a word of IMPORT_REASONS (anything else is `other`). Ignored when it did. */
  reason?: string;
  media?: string;
  /** How it came in: a word of IMPORT_DOORS (anything else is `other`, so nothing a caller or a model typed can ride here). */
  via?: string;
  bytes?: number;
  ms?: number;
}

/** One file that was brought in, or refused. */
export function recordImport(facts: ImportFacts, projectId = "", now = Date.now()): void {
  push(
    {
      kind: "import",
      at: now / 1000,
      ok: facts.ok,
      ...(facts.ok ? {} : { reason: word(facts.reason, IMPORT_REASONS, "other") }),
      media: word(facts.media, MEDIA_KINDS, "unknown"),
      via: word(facts.via, IMPORT_DOORS, "other"),
      size_mb: bandMegabytes(facts.bytes ?? 0),
      ms: whole(facts.ms, MAX_EDITOR_MS),
    },
    projectId,
    now,
  );
}

export interface MediaFacts {
  media?: string;
  /** The video stream's codec name (`hevc`, `h264`...). */
  codec?: string;
  width?: number;
  height?: number;
  seconds?: number;
  bytes?: number;
  proxy: ProxyState;
  /** How long making the preview copy took, when one was made. */
  ms?: number;
}

/** The facts of a file once the app has looked at it to make its preview: rounded, and never its name. */
export function recordMedia(facts: MediaFacts, projectId = "", now = Date.now()): void {
  if (!isWord(facts.proxy, PROXY_STATES)) return;
  push(
    {
      kind: "media",
      at: now / 1000,
      media: word(facts.media, MEDIA_KINDS, "unknown"),
      codec: codecName(facts.codec, 20),
      width: whole(facts.width, MAX_EDITOR_DIM),
      height: whole(facts.height, MAX_EDITOR_DIM),
      dur_s: bandSeconds(facts.seconds ?? 0),
      size_mb: bandMegabytes(facts.bytes ?? 0),
      proxy: facts.proxy,
      ms: whole(facts.ms, MAX_EDITOR_MS),
    },
    projectId,
    now,
  );
}

export interface PreviewFacts {
  what: PreviewWhat;
  ms?: number;
  /** A failure: why, as a word of PREVIEW_FAILURES, and the codec family of what could not be shown (`avc1`, `hev1`...). */
  reason?: string;
  codec?: string;
}

/** How the preview behaved: the first picture, a stretch where it stood still, or a video it could not show. */
export function recordPreview(facts: PreviewFacts, projectId = "", now = Date.now()): void {
  if (!isWord(facts.what, PREVIEW_WHATS)) return;
  push(
    {
      kind: "preview",
      at: now / 1000,
      what: facts.what,
      ms: whole(facts.ms, MAX_EDITOR_MS),
      ...(facts.what === "failure"
        ? { reason: word(facts.reason, PREVIEW_FAILURES, "other"), codec: codecName(facts.codec, 12) }
        : {}),
    },
    projectId,
    now,
  );
}

function windowItem(window: Window, now: number): EditorItem {
  const counts: Partial<Record<EditKind, number>> = {};
  for (const kind of EDIT_KINDS) {
    const n = window.counts[kind];
    if (n) counts[kind] = Math.min(n, MAX_EDITOR_COUNT);
  }
  return {
    kind: "edits",
    at: window.startedAt / 1000,
    window_s: Math.max(1, whole(Math.ceil((now - window.startedAt) / 1000), MAX_EDITOR_WINDOW_S)),
    counts,
  };
}

/** Send whatever is held. Never throws and never blocks anything the person is doing. */
export async function flushEditorEvents(now = Date.now()): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  for (const [projectId, window] of windows) queue.push({ item: windowItem(window, now), projectId });
  windows = new Map();
  if (queue.length === 0 && dropped === 0) return;
  // Taken BEFORE the await so what is recorded during the request joins the next flush instead of being lost to this one.
  const pending = queue;
  queue = [];
  const lost = dropped;
  dropped = 0;
  const groups = new Map<string, EditorItem[]>();
  for (const { item, projectId } of pending) groups.set(projectId, [...(groups.get(projectId) ?? []), item]);
  const requests: { projectId: string; events: EditorItem[]; dropped: number }[] = [];
  for (const [projectId, items] of groups)
    for (let at = 0; at < items.length; at += MAX_EDITOR_ITEMS)
      requests.push({ projectId, events: items.slice(at, at + MAX_EDITOR_ITEMS), dropped: 0 });
  // A burst that outran the minute says so even when nothing else was held to carry the number.
  if (requests.length === 0) requests.push({ projectId: "", events: [], dropped: lost });
  else requests[0].dropped = lost;
  const delivery = deliver(requests, generation);
  inFlight.add(delivery);
  try {
    await delivery;
  } finally {
    inFlight.delete(delivery);
  }
}

async function deliver(
  requests: { projectId: string; events: EditorItem[]; dropped: number }[],
  sentUnder: number,
): Promise<void> {
  const controller = new AbortController();
  deliveries.add(controller);
  const timeout = setTimeout(() => controller.abort(), 10_000);
  (timeout as { unref?: () => void }).unref?.();
  try {
    // Nobody to attribute it to: the server takes identity from the request, so an unauthenticated flush is a guaranteed
    // 401 carrying data we could not file anyway.
    if (!(await hasSession()) || controller.signal.aborted) return;
    const { os, arch } = hostInfo();
    for (const request of requests)
      await authedFetch(
        `${apiBase()}/telemetry/editor`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            events: request.events,
            project_id: request.projectId,
            ...(request.dropped ? { dropped: request.dropped } : {}),
            os,
            arch,
            app_version: __ARTDADDY_RELEASE__,
          }),
          signal: controller.signal,
        },
        (url, init) => {
          // Checked after the last await, at the moment it would leave: a different account may have signed in since.
          if (controller.signal.aborted || sentUnder !== generation)
            throw new Error("editor session ended before delivery");
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          return fetch(url, { ...init, body: JSON.stringify({ ...body, sent_at: Date.now() / 1000 }) });
        },
      );
  } catch {
    // Offline, signed out, server down. A trace is never worth a visible failure, and retrying would grow unboundedly in
    // exactly the conditions that caused the failure.
  } finally {
    clearTimeout(timeout);
    deliveries.delete(controller);
  }
}

/** Flush what is held, waiting a moment for it to leave (the app is about to close). */
export async function flushEditorEventsForExit(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    await flushEditorEvents();
    while (inFlight.size) {
      await Promise.all([...inFlight]);
      await flushEditorEvents();
    }
  };
  try {
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          for (const controller of deliveries) controller.abort();
          resolve();
        }, 2_000);
        (timeout as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Tests only. */
export function __resetEditorEvents(): void {
  offAuth?.();
  offAuth = null;
  discardSessionEvents();
  inFlight.clear();
}

/** Tests only: what is held, windows included, as the flush would send it. */
export function __heldEditorItems(now = Date.now()): { projectId: string; item: EditorItem }[] {
  return [
    ...queue.map((q) => ({ projectId: q.projectId, item: { ...q.item } })),
    ...[...windows].map(([projectId, window]) => ({ projectId, item: windowItem(window, now) })),
  ];
}
