// One export across attempts. When the app starts an export again by itself, or the person switches a running one to
// another setting, the new attempt is a new job (its own native job, delivery intent, staging file and ledger entry), but
// to the person and to the assistant it is the same export: one id (the first attempt's, the one the assistant was given),
// one row, an attempt number. This is the thin layer that says which job is the live one for any id of the chain, and the
// one place that counts automatic restarts. Pure: an instance holds the state; nothing here reads a clock, starts a timer
// or touches the app, the disk or the network.
//
// A chain is the attempts of one export in order; its first id is the public one. A link joins an attempt to its successor
// and says who asked for it: `auto`, the app (a stop for lack of memory, a failed graphics-chip encode), or `switch`, the
// person (Switch to Quick). A chain has at most ONE auto link, whatever the reason, and a switch neither uses nor resets
// that count.
//
// A chain also remembers who started the export, the in-app chat or somewhere else (the Export menu, an outside assistant). It is
// decided once, when the first attempt begins, and every attempt of the chain answers it: the in-app assistant is told how an
// export ended only when the chat started it, and a restart is part of the same export, so the attempt that ends it must not
// forget who started it. An attempt the app starts again does not carry the asking turn (the queue owns the export, see
// exportQueue.ts `registerExportInLibrary`), which is why this is kept here and not read from the turn.
//
// The gap between an attempt's end and its successor's admission is a pending restart. It is registered when the restart
// is decided, before anything is awaited, so that a Cancel in the gap finds it. `link` refuses while the pending restart
// is cancelled, and clears it when it succeeds, in the same call: the queue sets the successor's controller, links and
// retires the predecessor's row with nothing awaited in between.

import type { ExportStarter } from "../api/exportVocabulary";

export type LinkKind = "auto" | "switch";

/** What the restart did, as the card and the assistant say it. */
export type Restarted = "gentler_setting" | "memory_light_route" | "processor" | "quick";
const RESTARTED = new Set<string>(["gentler_setting", "memory_light_route", "processor", "quick"]);

/** What a link remembers about its restart. A key that is not one of these, or has another type, is dropped. */
export interface LinkMeta {
  /** The row of the reasons table that asked: a code, never a sentence. */
  reason?: string;
  restarted?: Restarted;
  /** The rung that failed, and the route the successor started on. */
  failedRung?: number;
  route?: number;
}

/** What an export's start says about the attempt it continues. The queue builds it when it decides a restart, and the
 *  retry closure carries it back into the queue with the new request, where the admission links the two attempts. */
export interface RestartLink {
  kind: LinkKind;
  /** The attempt it continues: the chain's current one when the restart was decided. */
  from: string;
  /** The project's fingerprint when the first attempt was admitted, for an automatic restart: a project edited since is
   *  not started again by itself (the person's own Try again starts from the project as it is now). */
  snapshot?: string;
  /** The reasons of the heads-up (a `notice` question) the person saw and continued past in the attempt this one continues,
   *  as the bits of the question's own band (`CONFIRM_REASON_BITS`): an automatic restart is not asked about what the person
   *  was already told, and is refused when its pre-start check has anything else to ask. */
  noticesAnswered?: number;
  meta: LinkMeta;
}

/** Attempts one chain may hold. A safety net: every switch needs a click on a running export and at most one link is
 *  automatic, so it takes six deliberate clicks to get here. */
export const MAX_ATTEMPTS = 8;

/** Why a link was refused, in the order the rules are checked, the first that applies being the one reported: the attempt
 *  to extend is in no chain; it already has a successor; the person cancelled while the restart waited; the successor is
 *  already an attempt of this chain (a cycle) or of another; the chain has used its one automatic restart; the chain
 *  already holds {@link MAX_ATTEMPTS}. */
export type LinkRefusal =
  | "unknown_prev"
  | "not_current"
  | "pending_cancelled"
  | "cycle"
  | "next_taken"
  | "second_auto"
  | "chain_too_long";

export type LinkResult = { ok: true } | { ok: false; why: LinkRefusal };

/** What the card and the assistant's list need to know about an id, from the registry alone. `attempt`, `restarted` and
 *  `superseded` are about `id` itself; a superseded attempt is the one the card never shows. */
export interface AttemptView {
  publicId: string;
  current: string;
  attempt: number;
  /** How this attempt came about, when it is a restart that said so. */
  restarted?: Restarted;
  superseded: boolean;
}

/** The link that made an attempt. */
export interface IncomingLink {
  from: string;
  kind: LinkKind;
  attempt: number;
  meta: LinkMeta;
}

/** The whole state as plain data, for tests and for a bug report. `links[i]` joins `ids[i]` to `ids[i + 1]`. */
export interface AttemptSnapshot {
  chains: Array<{
    ids: string[];
    startedBy: ExportStarter;
    links: Array<{ kind: LinkKind; meta: LinkMeta }>;
    pending: { kind: LinkKind; cancelled: boolean } | null;
  }>;
}

export interface AttemptRegistry {
  /** Registers the first attempt of an export, started by `startedBy`: the one time a chain is told. Anything but `"chat"` is
   *  read as `"elsewhere"`, the direction in which a mistake costs a missed message and not a wake nobody asked for. False, and
   *  nothing changes, when the id is already an attempt of a chain. */
  begin(id: string, startedBy: ExportStarter): boolean;
  /** Who started the export `id` is an attempt of, whichever attempt it is. `"elsewhere"` for an id in no chain: only an export
   *  whose start is on record is ever said to be the chat's. */
  startedBy(id: string): ExportStarter;
  /** Makes `nextId` the successor of `prevId`, which must be the LAST attempt of its chain, and clears the chain's pending
   *  restart. A refusal changes nothing. */
  link(prevId: string, nextId: string, kind: LinkKind, meta?: LinkMeta): LinkResult;
  /** The last attempt of the chain `id` belongs to, whichever of its ids it is; `id` itself when it is in no chain. */
  current(id: string): string;
  /** The chain's first id, which is the one the assistant holds. */
  publicId(id: string): string;
  /** The place of `id` in its chain, from 1. */
  attemptNumber(id: string): number;
  /** The ids of the chain in order; just `[id]` when it is in no chain. */
  chainOf(id: string): string[];
  /** `id` has a successor. */
  isSuperseded(id: string): boolean;
  /** Drops the whole chain `id` belongs to, with any pending restart: its ids resolve to themselves from then on. Called
   *  when the chain's last row is gone. */
  forget(id: string): boolean;
  /** How many automatic restarts the chain has used: 0 or 1. Switch links never count and nothing resets it. */
  autoRestartsUsed(id: string): 0 | 1;
  /** Notes that a restart of kind `kind` is about to be started for the chain whose CURRENT attempt is `id`. False, and
   *  nothing changes, when one is already pending, when `id` is not the chain's current attempt, when an automatic one
   *  would be a second, or when the chain has no room left for another attempt: nothing irreversible should be done for a
   *  restart this refuses. Anything that is not `"switch"` counts as automatic. */
  registerPending(id: string, kind: LinkKind): boolean;
  /** A Cancel reached the gap: the restart must not start. True when a restart was pending, for any id of the chain;
   *  asking again is still true. */
  cancelPending(id: string): boolean;
  /** The quit: cancels every pending restart of every chain. Returns how many there were. */
  cancelAllPending(): number;
  isPendingCancelled(id: string): boolean;
  hasPending(id: string): boolean;
  /** Drops the pending restart without linking: it was abandoned. True when there was one. */
  clearPending(id: string): boolean;
  /** A read-only view of `id` for the card and the assistant's list. */
  describe(id: string): AttemptView;
  /** The link that made `id`; null for a first attempt and for an id in no chain. */
  incomingLink(id: string): IncomingLink | null;
  snapshot(): AttemptSnapshot;
  /** Forgets everything. */
  reset(): void;
}

// A kind that is not a person's switch counts as an automatic restart, so a wrong value cannot get round the one restart.
const kindOf = (kind: unknown): LinkKind => (kind === "switch" ? "switch" : "auto");

function cleanMeta(meta: LinkMeta | undefined): LinkMeta {
  const clean: LinkMeta = {};
  if (typeof meta?.reason === "string") clean.reason = meta.reason;
  if (typeof meta?.restarted === "string" && RESTARTED.has(meta.restarted))
    clean.restarted = meta.restarted;
  if (typeof meta?.failedRung === "number" && Number.isFinite(meta.failedRung))
    clean.failedRung = meta.failedRung;
  if (typeof meta?.route === "number" && Number.isFinite(meta.route)) clean.route = meta.route;
  return clean;
}

export function createAttemptRegistry(): AttemptRegistry {
  interface Chain {
    ids: string[];
    startedBy: ExportStarter;
    links: Array<{ kind: LinkKind; meta: LinkMeta }>;
    pending: { kind: LinkKind; cancelled: boolean } | null;
  }
  const chains = new Map<string, Chain>();
  const chainOfId = new Map<string, Chain>();

  const last = (chain: Chain): string => chain.ids[chain.ids.length - 1];
  const usedAuto = (chain: Chain): boolean => chain.links.some((link) => link.kind === "auto");
  const full = (chain: Chain): boolean => chain.ids.length >= MAX_ATTEMPTS;
  const refused = (why: LinkRefusal): LinkResult => ({ ok: false, why });

  return {
    begin(id, startedBy) {
      if (chainOfId.has(id)) return false;
      const chain: Chain = {
        ids: [id],
        startedBy: startedBy === "chat" ? "chat" : "elsewhere",
        links: [],
        pending: null,
      };
      chains.set(id, chain);
      chainOfId.set(id, chain);
      return true;
    },

    startedBy(id) {
      return chainOfId.get(id)?.startedBy ?? "elsewhere";
    },

    link(prevId, nextId, kind, meta) {
      const chain = chainOfId.get(prevId);
      if (!chain) return refused("unknown_prev");
      if (last(chain) !== prevId) return refused("not_current");
      if (chain.pending?.cancelled) return refused("pending_cancelled");
      const holder = chainOfId.get(nextId);
      if (holder) return refused(holder === chain ? "cycle" : "next_taken");
      const linkKind = kindOf(kind);
      if (linkKind === "auto" && usedAuto(chain)) return refused("second_auto");
      if (full(chain)) return refused("chain_too_long");
      chain.ids.push(nextId);
      chain.links.push({ kind: linkKind, meta: cleanMeta(meta) });
      chain.pending = null;
      chainOfId.set(nextId, chain);
      return { ok: true };
    },

    current(id) {
      const chain = chainOfId.get(id);
      return chain ? last(chain) : id;
    },

    publicId(id) {
      return chainOfId.get(id)?.ids[0] ?? id;
    },

    attemptNumber(id) {
      const chain = chainOfId.get(id);
      return chain ? chain.ids.indexOf(id) + 1 : 1;
    },

    chainOf(id) {
      const chain = chainOfId.get(id);
      return chain ? [...chain.ids] : [id];
    },

    isSuperseded(id) {
      const chain = chainOfId.get(id);
      return chain !== undefined && last(chain) !== id;
    },

    forget(id) {
      const chain = chainOfId.get(id);
      if (!chain) return false;
      for (const attempt of chain.ids) chainOfId.delete(attempt);
      chains.delete(chain.ids[0]);
      return true;
    },

    autoRestartsUsed(id) {
      const chain = chainOfId.get(id);
      return chain && usedAuto(chain) ? 1 : 0;
    },

    registerPending(id, kind) {
      const chain = chainOfId.get(id);
      if (!chain || last(chain) !== id || chain.pending || full(chain)) return false;
      const pendingKind = kindOf(kind);
      if (pendingKind === "auto" && usedAuto(chain)) return false;
      chain.pending = { kind: pendingKind, cancelled: false };
      return true;
    },

    cancelPending(id) {
      const pending = chainOfId.get(id)?.pending;
      if (!pending) return false;
      pending.cancelled = true;
      return true;
    },

    cancelAllPending() {
      let cancelled = 0;
      for (const chain of chains.values()) {
        if (!chain.pending) continue;
        chain.pending.cancelled = true;
        cancelled++;
      }
      return cancelled;
    },

    isPendingCancelled(id) {
      return chainOfId.get(id)?.pending?.cancelled === true;
    },

    hasPending(id) {
      return Boolean(chainOfId.get(id)?.pending);
    },

    clearPending(id) {
      const chain = chainOfId.get(id);
      if (!chain?.pending) return false;
      chain.pending = null;
      return true;
    },

    describe(id) {
      const chain = chainOfId.get(id);
      if (!chain) return { publicId: id, current: id, attempt: 1, superseded: false };
      const index = chain.ids.indexOf(id);
      const restarted = index > 0 ? chain.links[index - 1].meta.restarted : undefined;
      return {
        publicId: chain.ids[0],
        current: last(chain),
        attempt: index + 1,
        ...(restarted ? { restarted } : {}),
        superseded: last(chain) !== id,
      };
    },

    incomingLink(id) {
      const chain = chainOfId.get(id);
      const index = chain ? chain.ids.indexOf(id) : -1;
      if (!chain || index < 1) return null;
      const { kind, meta } = chain.links[index - 1];
      return { from: chain.ids[index - 1], kind, attempt: index + 1, meta: { ...meta } };
    },

    snapshot() {
      return {
        chains: [...chains.values()].map((chain) => ({
          ids: [...chain.ids],
          startedBy: chain.startedBy,
          links: chain.links.map((link) => ({ kind: link.kind, meta: { ...link.meta } })),
          pending: chain.pending ? { ...chain.pending } : null,
        })),
      };
    },

    reset() {
      chains.clear();
      chainOfId.clear();
    },
  };
}

/** The app's one registry: the queue, the card and the export dialog's feed all resolve ids through it. */
export const attempts: AttemptRegistry = createAttemptRegistry();

/** The functions that take a job id, or list exports under their ids, and so must pass what they are given through
 *  {@link AttemptRegistry.current} before they look anything up: the assistant holds the first attempt's id for the whole
 *  export while the card holds the live attempt's. They are exported functions of exportQueue.ts and the export dialog's
 *  `attach` action in the store (`useExportJob.attach`). exportAttempts.test.ts reads those two files and fails when an
 *  exported function that takes a job id is neither here nor on its short list of functions that act on one attempt's own
 *  resources and so deliberately do not resolve, so a new entry point cannot be forgotten. */
export const ID_ENTRY_POINTS = [
  "cancelExport",
  "whenExportEnds",
  "waitForExports",
  "dismissExport",
  "retryExport",
  "manageExportsTool",
  "listExportOutcomes",
  "listExportRecords",
  "useExportJob.attach",
] as const;
