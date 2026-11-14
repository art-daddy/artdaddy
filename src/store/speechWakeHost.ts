// What surrounds the wake registry: the one registry of the app, the guards at the moment a wake would start, the
// local record of what happened, and the view the card reads.
//
// The registry (speechWake.ts) is pure. It says WHEN a batch of "the words are not ready" answers has all settled.
// This file decides whether a wake may start THEN, and starts nothing itself: a released batch becomes one job in the
// project's completion queue (jobNotes.ts), and the queue asks `admitWordsWake` at the moment it would deliver it.
//
//   flag      speech_wake off: nothing is registered, and one released before it was turned off is dropped (0.27.0)
//   chat      only the chat that was told "not ready" is woken, not another, not a new one, not one reopened
//   unread    something must still be unread: the person's own turn, or a later look, may have fetched the words
//   credits   no wake while the account is out of credits (a wake is a billed round); held until they are back
//   cap       at most 5 wakes per chat in a rolling hour; past that the person is told to ask, and nothing starts
//   draft     never while the person has text in the box: held until it is sent or cleared
//   cool-down never within a minute of the last one: held
//
// Nothing here is sent anywhere. Facts of what happened are kept on this PC in closed words (lib/localFacts.ts).
import { create } from "zustand";

import { exportFlag } from "../api/exportFlags";
import { getUsage, subscribeUsage } from "../api/usage";
import { fileBand, recordFact, type WakeFact } from "../lib/localFacts";
import type { ClientToolContext } from "../tools/context";
import { classifyTranscriptFailure, isSpeechCancelled } from "../tools/speechFailure";
import type { CardNote, CardNoteKind, HeldBy } from "../tools/speechTimeLine";
import { isUnsafeAgentRef } from "../tools/store";
import { composerHasDraft, useComposer } from "./composer";
import { flushJobNotes, notifyJobSettled, type SettledJob } from "./jobNotes";
import {
  dirKey,
  WakeRegistry,
  type ChatKey,
  type Entry,
  type Release,
  type SettleOutcome,
  type SpanWindow,
  type TurnEnd,
} from "./speechWake";

/** At most this many wakes for words, per chat, in any rolling hour. */
export const WAKE_CAP_PER_HOUR = 5;
/** No two wakes for words of one chat closer than this. */
export const WAKE_COOL_DOWN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** How long a plain note stays on the card when nobody dismisses it. */
export const NOTE_SHOWN_MS = 10 * 60_000;
/** How often the clock looks at what is waiting, for the batch whose words never come. */
const TICK_MS = 60_000;
/** The most files a wake names; the rest are counted. */
const MAX_NAMED = 40;

/** What a tool says of a transcript that was waited for: its run ended, or it ended badly. */
export type Settled = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** Where "the words are not ready" may bring the assistant back: one file, as one chat's live turn asked for it. */
export interface WakeTarget extends ChatKey {
  /** The turn that was told. Only the chat's live turn registers. */
  readonly exec: number;
  /** The file as the other tools name it (its media_ref): what a later read of it is matched with. */
  readonly source: string;
  /** What the wake calls it to the assistant: a media_ref or a clip_id. Null when there is no safe name. */
  readonly ref: string | null;
  /** The stretch of the file whose words are not ready; null is the whole file. */
  readonly window: SpanWindow | null;
  /** The file's absolute path where the tool knows it, so that the card can match the file to the speech job that
   *  is transcribing it (jobs name files by path). Never shown and never sent. */
  readonly path: string | null;
}

/** What the card needs to know of one chat's waiting for words. */
export interface WakeChatView {
  /** Files still counted: pending, landed or read. */
  readonly total: number;
  readonly done: number;
  readonly pending: readonly Entry[];
  /** Words landed that the assistant has not read, and why it is not carrying on by itself (null: it is about to). */
  readonly ready: { readonly files: number; readonly held: HeldBy } | null;
  readonly notes: readonly CardNote[];
}

export type Verdict = "deliver" | "hold" | "drop";

interface WakeNote {
  readonly id: string;
  readonly kind: CardNoteKind;
  readonly count: number;
  readonly at: number;
}

let registry = new WakeRegistry();
/** Released batches whose wake has not been delivered or dropped: the card shows what they hold. */
const releases = new Map<string, Release>();
/** Released batches the hourly cap refused, and when: the card tells the person to ask, until the assistant speaks
 *  again or the note's time is up. */
const capped = new Map<string, number>();
const factNoted = new Set<string>();
const notes = new Map<string, WakeNote[]>();
const wakes = new Map<string, number[]>();
const askedThisTurn = new Map<string, number>();
const cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
let ticker: ReturnType<typeof setInterval> | null = null;
let unwire: (() => void) | null = null;

/** The wake's own clock. It runs on the wall clock but never takes a step longer than this: a PC that slept for
 *  hours, or a page that was frozen, must not count as hours of waiting for words that were not being made. */
const MAX_CLOCK_STEP_MS = 5 * 60_000;
let clockAt = 0;
let awakeMs = 0;
function wakeNow(): number {
  const real = Date.now();
  if (clockAt === 0) clockAt = real;
  awakeMs += Math.min(Math.max(real - clockAt, 0), MAX_CLOCK_STEP_MS);
  clockAt = real;
  return awakeMs + 1;
}

/** Moves when anything the card shows may have changed. */
export const useWakeView = create<{ version: number }>(() => ({ version: 0 }));
const bump = (): void => useWakeView.setState((s) => ({ version: s.version + 1 }));

const chatId = (chat: ChatKey): string => `${dirKey(chat.dir)}\u0000${chat.session}`;
const turnId = (chat: ChatKey, exec: number): string => `${chatId(chat)}\u0000${exec}`;

function note(event: WakeFact["event"], files?: number): void {
  recordFact("speech_wake", {
    event,
    ...(files === undefined ? {} : { files: fileBand(files) }),
    at: Date.now(),
  });
}
/** A fact said once for each (batch, reason): a hold that is asked again at every flush is one fact. */
function noteOnce(batchId: string, event: WakeFact["event"], files: number): void {
  const key = `${batchId}\u0000${event}`;
  if (factNoted.has(key)) return;
  factNoted.add(key);
  note(event, files);
}

/** What a wake may call a file: an id or a plain file name, short, with nothing in it that is not a letter, a digit,
 *  an underscore, a dot or a dash. A name with a space, a newline, a bracket or a path in it is not named at all (the
 *  file is still counted), so no name can carry anything into the assistant's prompt but itself. */
const SAFE_REF = /^[A-Za-z0-9][\w.-]{0,63}$/;
function safeRef(ref: string | null): string | null {
  const trimmed = ref?.trim() ?? "";
  return SAFE_REF.test(trimmed) && !isUnsafeAgentRef(trimmed) ? trimmed : null;
}

/** Where "the words are not ready" may bring the assistant back, or null where nobody can be promised one: an
 *  outside agent over MCP, the project's own indexer, an edit with no chat behind it, or the switch off. Every
 *  caller of `waitForRun` passes this, so a place that cannot be woken says so by its answer, in one place. */
export function wakeTargetOf(
  ctx: ClientToolContext,
  source: string,
  ref: string | null,
  window: SpanWindow | null = null,
  path: string | null = null,
): WakeTarget | null {
  if (ctx.background === true || ctx.surface === "mcp") return null;
  const origin = ctx.origin;
  if (!origin || !origin.chatSessionId) return null;
  if (!exportFlag("speech_wake")) return null;
  return {
    dir: ctx.store.projectDir,
    session: origin.chatSessionId,
    exec: origin.executionId,
    source,
    ref: safeRef(ref),
    window,
    path,
  };
}

function wire(): void {
  if (unwire) return;
  // A draft sent or cleared, or credits back: whatever was held for it may go now.
  const stopComposer = useComposer.subscribe((s, prev) => {
    if (prev.hasDraft && !s.hasDraft) flushHeld();
  });
  const stopUsage = subscribeUsage(() => {
    if (!getUsage().over) flushHeld();
  });
  unwire = () => {
    stopComposer();
    stopUsage();
  };
}

function flushHeld(): void {
  for (const dir of new Set([...releases.values()].map((r) => r.dir))) flushJobNotes(dir);
}

function ensureTicker(): void {
  if (ticker !== null) return;
  ticker = setInterval(tick, TICK_MS);
}

function tick(): void {
  apply(registry.tick(wakeNow()));
  const now = Date.now();
  let pruned = false;
  for (const [chat, list] of notes) {
    const live = list.filter((n) => now - n.at < NOTE_SHOWN_MS);
    if (live.length === list.length) continue;
    pruned = true;
    if (live.length) notes.set(chat, live);
    else notes.delete(chat);
  }
  // The person was told to ask the assistant, and has not: that note is done with once its time is up.
  for (const [batchId, at] of capped)
    if (now - at >= NOTE_SHOWN_MS) {
      finish(batchId);
      pruned = true;
    }
  if (registry.size() === 0 && releases.size === 0 && notes.size === 0 && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
  if (pruned) bump();
}

function addNote(chat: ChatKey, id: string, kind: CardNoteKind, count: number): void {
  if (count <= 0) return;
  const key = chatId(chat);
  const list = notes.get(key) ?? [];
  if (list.some((n) => n.id === id)) return;
  notes.set(key, [...list, { id, kind, count, at: Date.now() }]);
}

/** A batch has nothing more to wake for: forget it. */
function finish(batchId: string): void {
  registry.resolve(batchId);
  releases.delete(batchId);
  capped.delete(batchId);
}

/** How a batch of words is told to the assistant: how many files, and which references it knows them by. A file read
 *  in several stretches is one file, and every name the assistant used for its stretches is given, so that it reads
 *  each of them. A file with no safe name is counted and not named. */
function wordsText(landed: readonly Entry[]): { label: string; media_refs?: string[] } {
  const files = new Set(landed.map((e) => e.source)).size;
  const names = [...new Set(landed.map((e) => e.ref).filter((v): v is string => v !== null))];
  const shown = names.slice(0, MAX_NAMED);
  if (names.length > MAX_NAMED) shown.push(`and ${names.length - MAX_NAMED} more`);
  return {
    label: `the words of ${files} file${files === 1 ? "" : "s"}`,
    ...(shown.length ? { media_refs: shown } : {}),
  };
}

/** What the registry released: the plain notes for what could not be made, and one job in the completion queue for
 *  the words that can be read. A release with no words is only notes: failures never wake. */
function apply(out: readonly Release[]): void {
  for (const r of out) {
    releases.set(r.batchId, r);
    note("released", r.size);
    if (r.expired > 0) note("expired", r.expired);
    const chat: ChatKey = { dir: r.dir, session: r.session };
    for (const f of r.failed)
      if (f.reason !== "model_unavailable")
        addNote(chat, `${r.batchId}:${f.reason}`, f.reason, f.count);
    addNote(chat, `${r.batchId}:expired`, "expired", r.expired);
    if (r.landed.length === 0) {
      finish(r.batchId);
      continue;
    }
    note("landed", r.landed.length);
    notifyJobSettled(r.dir, {
      id: r.batchId,
      tool: "inspect_media",
      kind: "words",
      startedBy: "chat",
      status: "done",
      ...wordsText(r.landed),
    });
  }
  if (out.length) bump();
}

/** The assistant was told the words of a file are not ready. The file joins the batch of the chat's live turn, and
 *  its run's end (`settled`, which never rejects) is what lands it. A turn that is not the chat's live one, and a
 *  switch that is off, register nothing. */
export function registerPendingWords(
  target: WakeTarget,
  key: string,
  audioSeconds: number | null,
  settled: Promise<Settled>,
): void {
  wire();
  const chat: ChatKey = { dir: target.dir, session: target.session };
  const turn = turnId(chat, target.exec);
  askedThisTurn.set(turn, (askedThisTurn.get(turn) ?? 0) + 1);
  apply(
    registry.register(
      {
        ...chat,
        exec: target.exec,
        key,
        source: target.source,
        ref: target.ref,
        audioS: audioSeconds,
        window: target.window,
        path: target.path,
      },
      wakeNow(),
    ),
  );
  ensureTicker();
  bump();
  void settled.then(
    (s) => landed(chat, key, s),
    () => undefined,
  );
}

/** For words that arrive without a run to wait for (the project's indexer was handed the file): `probe` says,
 *  every few seconds, whether the words are in the cache yet, until they are or the file is no longer waited for. */
export function registerCachedWords(
  target: WakeTarget,
  key: string,
  audioSeconds: number | null,
  probe: () => Promise<boolean>,
  everyMs = 5_000,
): void {
  const chat: ChatKey = { dir: target.dir, session: target.session };
  const settled = new Promise<Settled>((resolve) => {
    const look = (): void => {
      if (!registry.isPending(chat, key))
        return resolve({ ok: false, error: "no longer waited for" });
      probe().then(
        (ready) => (ready ? resolve({ ok: true }) : void setTimeout(look, everyMs)),
        () => void setTimeout(look, everyMs),
      );
    };
    setTimeout(look, everyMs);
  });
  registerPendingWords(target, key, audioSeconds, settled);
}

function landed(chat: ChatKey, key: string, s: Settled): void {
  const outcome: SettleOutcome = s.ok
    ? { kind: "landed" }
    : isSpeechCancelled(s.error)
      ? { kind: "cancelled" }
      : { kind: "failed", reason: classifyTranscriptFailure(s.error).reason };
  apply(registry.settle(chat, key, outcome, wakeNow()));
  bump();
}

/** A tool gave the assistant the words of `source`, of the stretch `window` of it (null: the whole file): whatever
 *  this chat was waiting to tell it about words that stretch holds is read. Only a chat's own reads count; this
 *  can only make a wake rarer. */
export function noteWordsFetched(
  ctx: ClientToolContext,
  source: string,
  window: SpanWindow | null = null,
): void {
  const origin = ctx.origin;
  if (!origin || !origin.chatSessionId) return;
  apply(
    registry.fetched(
      { dir: ctx.store.projectDir, session: origin.chatSessionId },
      source,
      wakeNow(),
      window,
    ),
  );
  bump();
}

/** A turn of a chat begins. The person's own turn also ends the plain notes of the last one. */
export function wakeBeginTurn(chat: ChatKey | null, exec: number, system: boolean): void {
  if (!chat) return;
  registry.beginTurn(chat, exec);
  if (!system) notes.delete(chatId(chat));
  bump();
}

/** A turn that ended (Stop, an error) is taken up again by the person (Continue, Try again): it is the chat's live
 *  turn once more, so what it is told from here on is waited for. What it had registered before is not brought back. */
export function wakeResumeTurn(chat: ChatKey | null, exec: number): void {
  if (!chat) return;
  registry.resumeTurn(chat, exec);
}

/** A turn ended. A normal end seals what it was told was not ready; any other end (Stop, an error, a new message
 *  that took over) drops it: the person took over, and nothing must come back behind his back. */
export function wakeEndTurn(chat: ChatKey | null, exec: number, how: TurnEnd): void {
  if (!chat) return;
  const turn = turnId(chat, exec);
  const asked = askedThisTurn.get(turn) ?? 0;
  askedThisTurn.delete(turn);
  if (asked > 0) note(how === "done" ? "registered" : "dropped", asked);
  apply(registry.endTurn(chat, exec, how, wakeNow()));
  // The person was told to ask the assistant, and the assistant has spoken since: that is done with.
  if (how === "done")
    for (const r of [...releases.values()])
      if (chatId({ dir: r.dir, session: r.session }) === chatId(chat) && capped.has(r.batchId))
        finish(r.batchId);
  bump();
}

/** The chat is gone (the project closed, switched or was disposed; or `session` ended): nothing it was waiting for
 *  may wake anything. */
export function wakeDropChat(dir: string, session?: string): void {
  const dropped = registry.dropChat(dir, session);
  for (const r of [...releases.values()]) {
    if (dirKey(r.dir) !== dirKey(dir) || (session !== undefined && r.session !== session)) continue;
    releases.delete(r.batchId);
    capped.delete(r.batchId);
  }
  for (const key of [...notes.keys()]) {
    const [d, s] = key.split("\u0000");
    if (d === dirKey(dir) && (session === undefined || s === session)) notes.delete(key);
  }
  if (dropped > 0) note("dropped", dropped);
  bump();
}

/** Asked by the completion queue at the moment it would deliver a job for words: the guards, in order. */
export function admitWordsWake(dir: string, session: string | null, job: SettledJob): Verdict {
  const rel = releases.get(job.id);
  if (!rel) return "drop";
  const chat: ChatKey = { dir: rel.dir, session: rel.session };
  const key = chatId(chat);
  const files = registry.unread(rel.batchId).length;
  if (!exportFlag("speech_wake")) {
    note("flag_off", rel.landed.length);
    finish(rel.batchId);
    return "drop";
  }
  if (session === null || rel.session !== session || dirKey(rel.dir) !== dirKey(dir)) {
    note("dropped", rel.landed.length);
    finish(rel.batchId);
    bump();
    return "drop";
  }
  if (files === 0) {
    note("skipped_fetched", rel.landed.length);
    finish(rel.batchId);
    bump();
    return "drop";
  }
  const now = Date.now();
  if (getUsage().over) {
    noteOnce(rel.batchId, "no_credits", files);
    return "hold";
  }
  const recent = (wakes.get(key) ?? []).filter((at) => now - at < HOUR_MS);
  wakes.set(key, recent);
  if (recent.length >= WAKE_CAP_PER_HOUR) {
    // Told on the card, once, and not tried again: the person asks when he wants it.
    capped.set(rel.batchId, now);
    note("capped", files);
    bump();
    return "drop";
  }
  if (composerHasDraft()) {
    noteOnce(rel.batchId, "held_typing", files);
    return "hold";
  }
  const last = recent[recent.length - 1];
  if (last !== undefined && now - last < WAKE_COOL_DOWN_MS) {
    const wait = WAKE_COOL_DOWN_MS - (now - last) + 25;
    if (!cooldownTimers.has(rel.dir))
      cooldownTimers.set(
        rel.dir,
        setTimeout(() => {
          cooldownTimers.delete(rel.dir);
          flushJobNotes(rel.dir);
        }, wait),
      );
    return "hold";
  }
  // What the assistant is told is what is still unread NOW: the person's own turn may have read some of it since
  // the batch was released. The queue holds this very job, and delivers it right after this answer.
  Object.assign(job, wordsText(registry.unread(rel.batchId)));
  note("woke", files);
  finish(rel.batchId);
  bump();
  return "deliver";
}

/** The chat took the wake and began its turn. Counted here, once per wake turn, not per batch: two batches that
 *  were asked for in one flush are ONE wake, and the cap and the cool-down are about wakes. */
export function noteWakeSent(
  dir: string,
  session: string | null,
  jobs: readonly SettledJob[],
): void {
  if (session === null || !jobs.some((j) => j.kind === "words")) return;
  const key = chatId({ dir, session });
  wakes.set(key, [...(wakes.get(key) ?? []), Date.now()]);
}

/** What the card shows of one chat's waiting for words. Why the assistant is not carrying on is read now, from
 *  the stores that decide it, so that it changes the moment the draft is sent or the credits are back. */
export function wakeViewOf(chat: ChatKey): WakeChatView {
  const v = registry.view(chat);
  const mine = [...releases.values()].filter(
    (r) => chatId({ dir: r.dir, session: r.session }) === chatId(chat),
  );
  const held: HeldBy = mine.some((r) => capped.has(r.batchId))
    ? "capped"
    : getUsage().over
      ? "credits"
      : composerHasDraft()
        ? "typing"
        : null;
  const now = Date.now();
  return {
    total: v.total,
    done: v.done,
    pending: v.pending,
    ready: v.readyUnread > 0 ? { files: v.readyUnread, held } : null,
    notes: (notes.get(chatId(chat)) ?? [])
      .filter((n) => now - n.at < NOTE_SHOWN_MS)
      .map(({ id, kind, count }) => ({ id, kind, count })),
  };
}

/** The person dismissed one plain note. */
export function dismissWakeNote(chat: ChatKey, id: string): void {
  const key = chatId(chat);
  const list = notes.get(key);
  if (!list) return;
  const rest = list.filter((n) => n.id !== id);
  if (rest.length) notes.set(key, rest);
  else notes.delete(key);
  bump();
}

/** Tests only: an app that has just started. */
export function __resetWakeHost(): void {
  registry = new WakeRegistry();
  releases.clear();
  capped.clear();
  factNoted.clear();
  notes.clear();
  wakes.clear();
  askedThisTurn.clear();
  clockAt = 0;
  awakeMs = 0;
  for (const t of cooldownTimers.values()) clearTimeout(t);
  cooldownTimers.clear();
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  unwire?.();
  unwire = null;
  useWakeView.setState({ version: 0 });
}
