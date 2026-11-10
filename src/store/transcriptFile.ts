// Client-owned session transcript access. Step 1 of decoupling the server from
// the project dir: on desktop the client reads the conversation transcript
// straight from the co-located file (no server round-trip), so the UI no longer
// depends on the server to DISPLAY a session. The server still writes the file
// today; later slices flip write-ownership + undo to the client.
import { storeForProject } from "../lib/desktop";
import type { SessionState, TranscriptRequest } from "../api/types";
import { withProjectLock } from "../tools/coordinator";
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "../tools/store";
import { chatFilePath, chatFileId, chatMetaPath, isChatId, readChatDir } from "./chatFiles";
import { chatTitle, isRestoreRecord, type RestoreRecord } from "./chatTranscript";

/** Co-located session transcript, relative to the project dir. */
export const TRANSCRIPT_REL = `${INTERNAL_DIR}/chat/transcript.json`;

/** Read the transcript requests directly from the co-located project dir.
 *  Returns `[]` when the file doesn't exist yet (fresh session) and `null` when
 *  it's unreadable/corrupt so the caller can fall back to the server. */
export async function readLocalTranscript(
  store: ProjectStoreAccess,
): Promise<TranscriptRequest[] | null> {
  const p = joinPath(store.projectDir, TRANSCRIPT_REL);
  try {
    if (!(await store.exists(p))) return [];
    const data = JSON.parse(await store.readText(p)) as { requests?: TranscriptRequest[] };
    return Array.isArray(data.requests) ? data.requests : [];
  } catch {
    return null;
  }
}

/** Transcript requests for a project, read from the co-located project dir. */
export async function loadTranscriptRequests(projectId: string): Promise<TranscriptRequest[]> {
  const store = await storeForProject(projectId);
  if (!store) return [];
  return (await readLocalTranscript(store)) ?? [];
}

/** The client-OWNED session: the conversation transcript + the provider
 *  continuity snapshot (Azure's previous_response_id chain). The client persists
 *  this and passes it to the server each turn, so the server keeps no session
 *  state on disk. */
export interface ClientSession {
  requests: TranscriptRequest[];
  providerSnapshot: Record<string, unknown> | null;
  /** Stable id for THIS conversation (persisted), for log correlation. */
  transcriptId?: string;
  /** Last session state (cost/tokens) so the running total survives a reopen. */
  session?: SessionState | null;
  /** The chat's last Restore Checkpoint, kept until its next message so it can be undone. */
  restore?: RestoreRecord | null;
}

/** Client-owned session file (hidden from the user, inside `internals/`). */
export const SESSION_REL = `${INTERNAL_DIR}/transcript.json`;

/** Load the client-owned session from `internals/`, migrating a legacy
 *  server-written `history/transcript.json` when that's all that exists. Empty
 *  when neither is present. */
export async function loadSession(store: ProjectStoreAccess): Promise<ClientSession> {
  for (const rel of [SESSION_REL, TRANSCRIPT_REL]) {
    const p = joinPath(store.projectDir, rel);
    // Corrupt transcript -> bytes preserved to <path>.corrupt-<ts>, degrade to the
    // next candidate / empty (a half-written transcript must not vanish silently).
    const data = await store.readJson<{
      requests?: TranscriptRequest[];
      provider_snapshot?: Record<string, unknown> | null;
      session?: SessionState | null;
      id?: string;
      restore?: unknown;
    } | null>(p, null);
    if (data && Array.isArray(data.requests)) {
      return {
        requests: data.requests,
        providerSnapshot: data.provider_snapshot ?? null,
        transcriptId: data.id,
        session: data.session ?? null,
        ...(isRestoreRecord(data.restore) ? { restore: data.restore } : {}),
      };
    }
  }
  return { requests: [], providerSnapshot: null };
}

/** The JSON a chat file holds. The open chat and a put-away one share it, so a chat moves between
 *  them without being translated; `extra` is the put-away chat's title and time, written after the id. */
function sessionJson(session: ClientSession, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      version: 1,
      id: session.transcriptId,
      ...extra,
      requests: session.requests,
      provider_snapshot: session.providerSnapshot ?? null,
      session: session.session ?? null,
      ...(session.restore ? { restore: session.restore } : {}),
    },
    null,
    2,
  );
}

/** Persist the client-owned session atomically into `internals/transcript.json`. */
export async function persistSession(
  store: ProjectStoreAccess,
  session: ClientSession,
): Promise<boolean> {
  const full = joinPath(store.projectDir, SESSION_REL);
  const body = sessionJson(session);
  // Guard the transcript write with the SAME session-liveness the timeline uses, so a persist
  // that races a project close is ABANDONED (returns false) instead of landing in the folder of
  // the project the user already left (the audit's unguarded-transcript gap).
  return store.writeProjectText(full, body, () => store.sessionLive());
}

// ── Coalesced, serialized session persistence (R10) ────────────────────────
// Turn completion fires a persist WITHOUT awaiting it, and several can pile up
// (a burst of turns, or reload+persist). Two atomic writes could otherwise land
// out of order and leave STALE bytes on disk (atomic ≠ ordered). Route every
// fire-and-forget write through the per-project lock (the TS analog of other NLEs'
// ProjectPackageCoordinator) so writes can't reorder, and COALESCE a burst to the
// LATEST snapshot — only the newest session state needs to reach disk, matching
// NSDocument-style autosave coalescing.
const pendingSession = new Map<string, { store: ProjectStoreAccess; session: ClientSession }>();
const persisting = new Set<string>();
const idleWaiters = new Map<string, Array<() => void>>();
/** Durability of the LAST write the queue performed for a project, so a close-time flush can REPORT
 *  whether the newest snapshot actually reached disk (finding #1: the final save must fail-report, not
 *  silently swallow like the fire-and-forget path). Reset when a new close-final snapshot is enqueued. */
const lastResult = new Map<string, boolean>();

function persistKey(projectDir: string): string {
  return projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
}

function settleIfIdle(key: string): void {
  if (persisting.has(key) || pendingSession.has(key)) return;
  const waiters = idleWaiters.get(key);
  if (!waiters) return;
  idleWaiters.delete(key);
  for (const resolve of waiters) resolve();
}

function drainSession(key: string): void {
  if (persisting.has(key)) return; // a write is in flight; its finally re-drains
  const next = pendingSession.get(key);
  if (!next) {
    settleIfIdle(key);
    return;
  }
  pendingSession.delete(key);
  persisting.add(key);
  // Serialize the actual write behind the project lock (ordered even across the
  // timeline/library/registry writers); a failure must not wedge the queue, so
  // record its durability (for a close-time flush to report) and keep draining.
  void withProjectLock(next.store.projectDir, () => persistSession(next.store, next.session))
    .then((ok) => lastResult.set(key, ok))
    .catch(() => lastResult.set(key, false)) // a thrown write is NOT durable
    .finally(() => {
      persisting.delete(key);
      drainSession(key); // flush any snapshot that arrived during this write
    });
}

/** Non-blocking session persist: the LATEST snapshot per project always wins and
 *  writes never overlap or reorder. Prefer this over calling {@link persistSession}
 *  directly from a fire-and-forget path (e.g. turn completion). */
export function persistSessionSoon(store: ProjectStoreAccess, session: ClientSession): void {
  const key = persistKey(store.projectDir);
  pendingSession.set(key, { store, session }); // latest wins (coalesce a burst)
  drainSession(key);
}

/** Persist `session` as the LATEST snapshot through the SAME ordered queue as {@link persistSessionSoon}
 *  and REPORT whether it reached disk. The document close SAVE phase uses this AFTER stopping transcript
 *  producers (finding #1): routing the final snapshot through the queue — rather than a side write —
 *  means a still-queued older snapshot can NEVER flush on top of it (coalescing makes the newest win),
 *  and the returned boolean surfaces a real disk failure so close() offers Retry/Discard/Cancel. Callers
 *  MUST have quiesced producers first, else a later producer snapshot could supersede this one. */
export function persistSessionNow(
  store: ProjectStoreAccess,
  session: ClientSession,
): Promise<boolean> {
  const key = persistKey(store.projectDir);
  lastResult.delete(key); // don't report a stale prior write's result
  pendingSession.set(key, { store, session }); // enqueue as the latest (supersedes any older pending)
  drainSession(key);
  // Wait for the queue to fully drain, then report the LAST write's durability. With producers
  // quiesced, THIS snapshot is the last one written, so its result is the one reported.
  return flushPendingSession(store.projectDir).then(() => lastResult.get(key) ?? false);
}

/** Resolves once the coalescing queue for a project has fully drained (nothing in flight and
 *  nothing pending) — the latest transcript snapshot has reached disk. ProjectDocument.close awaits
 *  this (via the registry) BEFORE the editor dispose bumps the session generation, so a pending
 *  transcript write is FLUSHED on close/switch rather than dropped. */
export function flushPendingSession(projectDir: string): Promise<void> {
  const key = persistKey(projectDir);
  if (!persisting.has(key) && !pendingSession.has(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = idleWaiters.get(key) ?? [];
    waiters.push(resolve);
    idleWaiters.set(key, waiters);
  });
}

/** Test alias of {@link flushPendingSession}. */
export const _persistIdle = flushPendingSession;

/** The client-owned session for a project: the `internals/` file (with a legacy
 *  `history/` migration). Empty when neither is present. */
export async function loadClientSession(projectId: string): Promise<ClientSession> {
  const store = await storeForProject(projectId);
  if (store) return loadSession(store);
  return { requests: [], providerSnapshot: null };
}

// ── Put-away chats ─────────────────────────────────────────────────────────
// A project has ONE open chat (`internals/transcript.json`, above) and any number put away, one file
// each (chatFiles.ts). The order that keeps a conversation from being lost is the callers': put a chat
// away BEFORE anything replaces it on screen or in the open file, and take the put-away copy off disk
// only AFTER the open file holds that chat. A crash between two steps leaves the same chat in both
// places, never in neither; the open chat wins and the stale copy is hidden from the list.

/** One line of the chat list. */
export interface ChatSummary {
  id: string;
  title: string;
  /** ISO time the chat was put away; what the list is ordered by. */
  updatedAt: string;
}

/** Put `session` away under `id`. True once the chat file is on disk; the summary beside it is a cache,
 *  so its failing costs nothing. False when the write was abandoned (the project session closed). */
export async function archiveSession(
  store: ProjectStoreAccess,
  id: string,
  session: ClientSession,
  updatedAt: string,
): Promise<boolean> {
  if (!isChatId(id)) return false;
  const title = chatTitle(session.requests.map((r) => r.message?.text ?? ""));
  const body = sessionJson({ ...session, transcriptId: id }, { title, updated_at: updatedAt });
  const summary = JSON.stringify({ version: 1, id, title, updated_at: updatedAt });
  const live = () => store.sessionLive();
  // Under the project lock, like every other writer of the project folder, so it cannot interleave
  // with the open chat's own queued write.
  return withProjectLock(store.projectDir, async () => {
    if (!(await store.writeProjectText(chatFilePath(store.projectDir, id), body, live)))
      return false;
    try {
      await store.writeProjectText(chatMetaPath(store.projectDir, id), summary, live);
    } catch {
      /* a cache: it is rebuilt from the chat file when it is missing */
    }
    return true;
  });
}

function summaryFrom(raw: unknown, id: string): ChatSummary | null {
  const m = raw as { title?: unknown; updated_at?: unknown } | null;
  if (!m || typeof m.title !== "string" || typeof m.updated_at !== "string") return null;
  return { id, title: m.title, updatedAt: m.updated_at };
}

/** The summary a chat's `.meta.json` holds, or null when it is missing or does not read. Read without
 *  the corrupt-file recovery: a cache is rebuilt, not preserved. */
async function readSummary(store: ProjectStoreAccess, id: string): Promise<ChatSummary | null> {
  try {
    return summaryFrom(JSON.parse(await store.readText(chatMetaPath(store.projectDir, id))), id);
  } catch {
    return null;
  }
}

/** Rebuild a chat's summary from the chat file itself (a crash fell between the two writes, or an
 *  older build left none), and put the cache back. Null when the chat file does not read. */
async function rebuildSummary(store: ProjectStoreAccess, id: string): Promise<ChatSummary | null> {
  const data = await store.readJson<{
    title?: unknown;
    updated_at?: unknown;
    requests?: TranscriptRequest[];
  } | null>(chatFilePath(store.projectDir, id), null);
  if (!data || !Array.isArray(data.requests)) return null;
  const summary: ChatSummary = {
    id,
    title:
      typeof data.title === "string"
        ? data.title
        : chatTitle(data.requests.map((r) => r.message?.text ?? "")),
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : "",
  };
  const cache = JSON.stringify({
    version: 1,
    id,
    title: summary.title,
    updated_at: summary.updatedAt,
  });
  await withProjectLock(store.projectDir, () =>
    store.writeProjectText(chatMetaPath(store.projectDir, id), cache, () => store.sessionLive()),
  ).catch(() => false);
  return summary;
}

/** The put-away chats, newest first. `exceptId` is the open chat: while a crash left its copy here as
 *  well, the open chat wins and the copy is not listed. A chat file that does not read is left out. */
export async function listArchivedSessions(
  store: ProjectStoreAccess,
  exceptId?: string | null,
): Promise<ChatSummary[]> {
  const entries = await readChatDir(store);
  if (!entries) return [];
  const names = new Set(entries.filter((e) => !e.isDirectory).map((e) => e.name));
  const found = await Promise.all(
    [...names].map(async (name) => {
      const id = chatFileId(name);
      if (!id || id === exceptId) return null;
      const cached = names.has(`${id}.meta.json`) ? await readSummary(store, id) : null;
      return cached ?? (await rebuildSummary(store, id));
    }),
  );
  return found
    .filter((c): c is ChatSummary => c !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** A put-away chat, whole. Null when there is no such chat or its file does not read (a corrupt file
 *  is kept aside by the read, as for the open chat). */
export async function readArchivedSession(
  store: ProjectStoreAccess,
  id: string,
): Promise<ClientSession | null> {
  if (!isChatId(id)) return null;
  const data = await store.readJson<{
    requests?: TranscriptRequest[];
    provider_snapshot?: Record<string, unknown> | null;
    session?: SessionState | null;
    restore?: unknown;
  } | null>(chatFilePath(store.projectDir, id), null);
  if (!data || !Array.isArray(data.requests)) return null;
  return {
    requests: data.requests,
    providerSnapshot: data.provider_snapshot ?? null,
    transcriptId: id,
    session: data.session ?? null,
    ...(isRestoreRecord(data.restore) ? { restore: data.restore } : {}),
  };
}

/** Take a put-away chat off disk. The chat file goes first: it is what makes the chat exist, so a crash
 *  after it leaves at most a stray summary, never a chat that half-exists. True once it is gone. */
export async function deleteArchivedSession(
  store: ProjectStoreAccess,
  id: string,
): Promise<boolean> {
  if (!isChatId(id)) return false;
  const chat = chatFilePath(store.projectDir, id);
  return withProjectLock(store.projectDir, async () => {
    try {
      await store.remove(chat);
    } catch {
      /* already gone, or it refused: the check below decides */
    }
    try {
      await store.remove(chatMetaPath(store.projectDir, id));
    } catch {
      /* a stray summary without its chat is never listed */
    }
    return !(await store.exists(chat));
  });
}
