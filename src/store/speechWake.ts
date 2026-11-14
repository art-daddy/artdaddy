// The batches of "the words are not ready" answers, and when a batch may bring the assistant back.
//
// A BATCH is the files the assistant was told were not ready in ONE of its turns. A file belongs to the
// newest batch that mentions it (a later look moves it), so a re-look never wakes the chat twice for one
// file. A batch is OPEN while its turn runs, SEALED when that turn ends normally (any other ending drops
// it: the person took over), and RELEASED, once, as soon as every file of it has settled: its words
// landed, it was read, it failed, or it was cancelled. Only a file that never settles needs the clock: 30
// minutes without new words ends the wait for it. A release is DATA: the host decides, at the moment it
// would act, whether a wake may start (flag, credits, cap, draft). Nothing in here starts anything.
//
// Pure on purpose: no timers, no storage, no stores and no clock of its own; every call is given `now`.
import type { TranscriptFailureReason } from "../tools/speechFailure";

/** A backstop only: a batch whose files all settle is released at that moment. */
export const BATCH_DEADLINE_MS = 30 * 60_000;

export type EntryState = "pending" | "landed" | "fetched" | "failed" | "cancelled" | "expired";

/** Why a file failed. A person's Cancel is not a failure: it settles as `cancelled`, whichever way it arrives. */
export type WakeFailureReason = Exclude<TranscriptFailureReason, "cancelled">;

export type SettleOutcome =
  { kind: "landed" } | { kind: "failed"; reason: TranscriptFailureReason } | { kind: "cancelled" };

/** How a turn ended. Only a normal end seals its batch. */
export type TurnEnd = "done" | "stopped" | "error" | "abandoned";

export interface ChatKey {
  readonly dir: string;
  readonly session: string;
}

/** A stretch of a file in source seconds. `end` may be Infinity: to the end of the file. */
export interface SpanWindow {
  readonly start: number;
  readonly end: number;
}

/** Seconds of slack when a span read is compared with the span wanted: a look is rounded to what a clip plays. */
const SPAN_SLACK_S = 0.05;

/** Do the words of `read` hold everything `wanted` is waiting for? Null is the whole file: it holds any part,
 *  and a part never holds the whole. */
export function spanCovers(read: SpanWindow | null, wanted: SpanWindow | null): boolean {
  if (read === null) return true;
  if (wanted === null) return false;
  return read.start <= wanted.start + SPAN_SLACK_S && read.end >= wanted.end - SPAN_SLACK_S;
}

export interface RegisterInput extends ChatKey {
  /** The turn (execution token) whose answer this is. */
  exec: number;
  /** One per transcript wanted: the key `waitForRun` uses. */
  key: string;
  /** The media file the words are of: its media_ref when it has one, else its path. A later read of the
   *  same source marks the entry read, when what it read holds the stretch this entry is waiting for. */
  source: string;
  /** The media_ref or clip_id the assistant used, as the wake names it to the model. */
  ref: string | null;
  audioS: number | null;
  /** The stretch of the file the words are of; absent or null is the whole file. */
  window?: SpanWindow | null;
  /** The file's absolute path, when the tool knows it: how a speech job that transcribes it is found. */
  path?: string | null;
}

export interface Entry {
  readonly key: string;
  readonly source: string;
  readonly ref: string | null;
  readonly audioS: number | null;
  readonly window: SpanWindow | null;
  readonly path: string | null;
  readonly state: EntryState;
  readonly failure: WakeFailureReason | null;
}

export interface Release {
  readonly batchId: string;
  readonly dir: string;
  readonly session: string;
  readonly exec: number;
  /** Words ready that nobody has read yet, in the order the files were registered. */
  readonly landed: readonly Entry[];
  readonly failed: ReadonlyArray<{ reason: WakeFailureReason; count: number }>;
  readonly expired: number;
  readonly cancelled: number;
  /** Every file the batch held: landed, read, failed, cancelled or expired. */
  readonly size: number;
}

export interface RegistryView {
  /** Files of the chat's open and sealed batches that still count: pending, landed or read. */
  readonly total: number;
  /** Of those, the files whose words have landed or have been read. */
  readonly done: number;
  readonly pending: readonly Entry[];
  /** Words landed and unread in batches that were released and not yet resolved by the host. */
  readonly readyUnread: number;
}

interface EntryRec {
  id: string;
  chat: string;
  batch: string;
  key: string;
  source: string;
  ref: string | null;
  audioS: number | null;
  window: SpanWindow | null;
  path: string | null;
  state: EntryState;
  failure: WakeFailureReason | null;
}

interface BatchRec {
  id: string;
  chat: string;
  dir: string;
  dirKey: string;
  session: string;
  exec: number;
  phase: "open" | "sealed" | "released";
  lastProgressAt: number;
  /** Entry ids in the order the files were registered. */
  members: string[];
}

const SEP = "\u0000";

/** The directory as the wake queue keys it: one spelling for a project, whatever slashes it came with. */
export function dirKey(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "");
}

const chatId = (chat: ChatKey): string => `${dirKey(chat.dir)}${SEP}${chat.session}`;

const snapshot = (e: EntryRec): Entry => ({
  key: e.key,
  source: e.source,
  ref: e.ref,
  audioS: e.audioS,
  window: e.window,
  path: e.path,
  state: e.state,
  failure: e.failure,
});

export class WakeRegistry {
  private readonly entries = new Map<string, EntryRec>();
  private readonly batches = new Map<string, BatchRec>();
  /** The turn each chat is running now. Only that turn's answers register: a straggler from a turn that
   *  ended or was superseded finds its number is no longer the live one and is ignored. */
  private readonly live = new Map<string, number>();

  constructor(private readonly deadlineMs: number = BATCH_DEADLINE_MS) {}

  /** The turn `exec` of `chat` begins. */
  beginTurn(chat: ChatKey, exec: number): void {
    const c = chatId(chat);
    this.live.set(c, exec);
    // A turn number that comes round again means the chat was reopened and counts from 1: whatever an
    // older numbering left under this number is stale, and must neither block nor join the new turn.
    const stale = this.batches.get(`${c}${SEP}${exec}`);
    if (stale) this.drop(stale);
  }

  /** The assistant was told the words of `input.source` are not ready. The file joins this turn's batch,
   *  leaving any older batch that held it. Answers of a turn that is not the live one are ignored. */
  register(input: RegisterInput, now: number): Release[] {
    const chat = chatId(input);
    if (this.live.get(chat) !== input.exec) return [];
    const batchId = `${chat}${SEP}${input.exec}`;
    let batch = this.batches.get(batchId);
    if (batch && batch.phase !== "open") return [];
    const id = `${chat}${SEP}${input.key}`;
    const old = this.entries.get(id);
    // Words that exist are never taken back to "pending" by a late or repeated answer.
    if (old && (old.state === "landed" || old.state === "fetched")) return [];
    if (old && old.batch === batchId) {
      // The same turn asked again (two looks at one file, or one after a failure): the entry stays.
      if (old.state !== "pending") {
        old.state = "pending";
        old.failure = null;
      }
      return [];
    }
    const out = old ? this.remove(old, now) : [];
    if (!batch) {
      batch = {
        id: batchId,
        chat,
        dir: input.dir,
        dirKey: dirKey(input.dir),
        session: input.session,
        exec: input.exec,
        phase: "open",
        lastProgressAt: now,
        members: [],
      };
      this.batches.set(batchId, batch);
    }
    this.entries.set(id, {
      id,
      chat,
      batch: batchId,
      key: input.key,
      source: input.source,
      ref: input.ref,
      audioS: input.audioS,
      window: input.window ?? null,
      path: input.path ?? null,
      state: "pending",
      failure: null,
    });
    batch.members.push(id);
    return out;
  }

  /** The run behind `key` ended. Only a pending file settles: a file that expired, was cancelled or was
   *  read stays as it is. */
  settle(chat: ChatKey, key: string, outcome: SettleOutcome, now: number): Release[] {
    const e = this.entries.get(`${chatId(chat)}${SEP}${key}`);
    if (!e || e.state !== "pending") return [];
    const batch = this.batches.get(e.batch);
    if (outcome.kind === "landed") {
      e.state = "landed";
      if (batch) batch.lastProgressAt = now;
    } else if (outcome.kind === "failed" && outcome.reason !== "cancelled") {
      e.state = "failed";
      e.failure = outcome.reason;
    } else {
      e.state = "cancelled";
    }
    return batch ? this.evaluate(batch, now) : [];
  }

  /** Some tool gave the assistant the words of `source`, of the stretch `window` of it (null: the whole file):
   *  whatever this chat was waiting to tell it about words that stretch holds is read. A file whose words were
   *  asked for another stretch is still waited for. This can only make a wake rarer, never extra. */
  fetched(chat: ChatKey, source: string, now: number, window: SpanWindow | null = null): Release[] {
    const c = chatId(chat);
    const touched = new Set<BatchRec>();
    for (const e of this.entries.values()) {
      if (e.chat !== c || e.source !== source || !spanCovers(window, e.window)) continue;
      if (e.state !== "pending" && e.state !== "landed") continue;
      const wasPending = e.state === "pending";
      e.state = "fetched";
      const batch = this.batches.get(e.batch);
      if (!batch) continue;
      if (wasPending) batch.lastProgressAt = now;
      touched.add(batch);
    }
    const out: Release[] = [];
    for (const batch of touched) out.push(...this.evaluate(batch, now));
    return out;
  }

  /** The turn `exec` of `chat` is taken up again after it ended (Stop, an error): it is the chat's live turn once
   *  more. Nothing it registered before is brought back: that was dropped when it ended. */
  resumeTurn(chat: ChatKey, exec: number): void {
    this.live.set(chatId(chat), exec);
  }

  /** The turn `exec` of `chat` ended. A normal end seals its batch; any other end drops it. */
  endTurn(chat: ChatKey, exec: number, how: TurnEnd, now: number): Release[] {
    const c = chatId(chat);
    if (this.live.get(c) === exec) this.live.delete(c);
    const batch = this.batches.get(`${c}${SEP}${exec}`);
    if (!batch || batch.phase !== "open") return [];
    if (how !== "done") {
      this.drop(batch);
      return [];
    }
    batch.phase = "sealed";
    batch.lastProgressAt = now;
    return this.evaluate(batch, now);
  }

  /** The clock: a sealed batch with a file that never settled is released once 30 minutes have passed
   *  without new words. */
  tick(now: number): Release[] {
    const out: Release[] = [];
    for (const batch of [...this.batches.values()]) out.push(...this.evaluate(batch, now));
    return out;
  }

  /** The chat (or every chat of the project) is gone: switched, closed, restarted. Returns the files dropped. */
  dropChat(dir: string, session?: string): number {
    const key = dirKey(dir);
    let dropped = 0;
    for (const batch of [...this.batches.values()]) {
      if (batch.dirKey !== key || (session !== undefined && batch.session !== session)) continue;
      dropped += batch.members.filter((m) => this.entries.has(m)).length;
      this.drop(batch);
    }
    for (const c of [...this.live.keys()]) {
      const [d, s] = c.split(SEP);
      if (d === key && (session === undefined || s === session)) this.live.delete(c);
    }
    return dropped;
  }

  /** Is the file behind `key` still waited for in this chat: asked of a watcher, which stops when it is not. */
  isPending(chat: ChatKey, key: string): boolean {
    return this.entries.get(`${chatId(chat)}${SEP}${key}`)?.state === "pending";
  }

  /** The host is done with a released batch (woke, or decided not to): forget it. */
  resolve(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (batch) this.drop(batch);
  }

  /** The words landed and not yet read in one batch, in order: what a wake would still be about. */
  unread(batchId: string): readonly Entry[] {
    const batch = this.batches.get(batchId);
    if (!batch) return [];
    return batch.members
      .map((m) => this.entries.get(m))
      .filter((e): e is EntryRec => e !== undefined && e.state === "landed")
      .map(snapshot);
  }

  /** What the card shows for one chat. Files are counted, not entries: a file read in several stretches is one
   *  file, and it is done only when every stretch of it is. */
  view(chat: ChatKey): RegistryView {
    const c = chatId(chat);
    const files = new Map<string, boolean>(); // source -> some stretch of it is still pending
    const unread = new Set<string>();
    const pending: Entry[] = [];
    for (const e of this.entries.values()) {
      if (e.chat !== c) continue;
      const batch = this.batches.get(e.batch);
      if (!batch) continue;
      if (batch.phase === "released") {
        if (e.state === "landed") unread.add(e.source);
        continue;
      }
      if (e.state === "pending") {
        pending.push(snapshot(e));
        files.set(e.source, true);
      } else if (e.state === "landed" || e.state === "fetched") {
        if (!files.has(e.source)) files.set(e.source, false);
      }
    }
    return {
      total: files.size,
      done: [...files.values()].filter((stillPending) => !stillPending).length,
      pending,
      readyUnread: unread.size,
    };
  }

  /** Files held, in every phase (for tests and diagnostics). */
  size(): number {
    return this.entries.size;
  }

  private remove(e: EntryRec, now: number): Release[] {
    this.entries.delete(e.id);
    const batch = this.batches.get(e.batch);
    if (!batch) return [];
    batch.members = batch.members.filter((m) => m !== e.id);
    if (batch.members.length === 0 && batch.phase !== "released") {
      this.batches.delete(batch.id);
      return [];
    }
    return this.evaluate(batch, now);
  }

  private drop(batch: BatchRec): void {
    for (const m of batch.members) this.entries.delete(m);
    this.batches.delete(batch.id);
  }

  /** Release a sealed batch when nothing in it is pending, or when its wait has run out. Once only: a
   *  released batch stays until the host resolves it, and is never released again. */
  private evaluate(batch: BatchRec, now: number): Release[] {
    if (batch.phase !== "sealed") return [];
    const members = batch.members
      .map((m) => this.entries.get(m))
      .filter((e): e is EntryRec => e !== undefined);
    if (members.length === 0) {
      this.batches.delete(batch.id);
      return [];
    }
    const pending = members.filter((e) => e.state === "pending");
    if (pending.length > 0) {
      if (now - batch.lastProgressAt < this.deadlineMs) return [];
      for (const e of pending) e.state = "expired";
    }
    batch.phase = "released";
    const failed = new Map<WakeFailureReason, number>();
    for (const e of members) {
      if (e.state === "failed" && e.failure)
        failed.set(e.failure, (failed.get(e.failure) ?? 0) + 1);
    }
    return [
      {
        batchId: batch.id,
        dir: batch.dir,
        session: batch.session,
        exec: batch.exec,
        landed: members.filter((e) => e.state === "landed").map(snapshot),
        failed: [...failed].map(([reason, count]) => ({ reason, count })),
        expired: members.filter((e) => e.state === "expired").length,
        cancelled: members.filter((e) => e.state === "cancelled").length,
        size: members.length,
      },
    ];
  }
}
