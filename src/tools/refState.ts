// What to say when a `media_ref` does not resolve.
//
// A generation tool hands back a ref the instant the request is away, so for the length of the job
// the ref is REAL and RESOLVES TO NOTHING. Every resolver returns null for that, and each tool
// worded its own null branch — "media not found", "local file not found", "image not found". Only
// `add_clips` had been taught the difference, so in one real session the model was told "media not
// found: media_gen_eaaa6fd58bd8" twenty-one times, did what that implies (concluded its ref was
// wrong) and started inventing paths like `library/media_gen_cdf49e3204da.mp4`, which failed in
// turn. 28 of the session's 51 tool errors came from this one message.
//
// So the wording is not a per-tool decision. `pendingMedia` on the store answers the question and
// this answers what to say about it; `refState.conformance.test.ts` walks every contract tool that
// takes a `media_ref` and fails if one of them still says "not found" about media we are making.
// The same holds for a linked file the user moved (UJ-014): the ref is right and the file is offline. And for a file the person is still
// importing (UJ-088): the name is right and the file is on its way in; the conformance test walks that case too.
import { ArtDaddyError } from "../lib/errors";
import type { ClientToolContext } from "./context";
import { generationWait, type GenerationWait } from "./generationWait";
import { importingMatch, type ImportingRow } from "./importing";
import type { LibraryClip } from "./store";

/** What to say about a linked file that is no longer on disk: only the user can bring it back. Named
 *  as the library knows it, never by the user's own folders. */
export function offlineRefMessage(row: Pick<LibraryClip, "id" | "path" | "filename">): string {
  const name = row.filename || row.path.split(/[\\/]/).pop() || row.id;
  return `'${name}' is offline: its file was moved or deleted on the user's computer. Ask the user to relink it (right-click it in the library, then Relink…) or to choose other media. The ref '${row.id}' is correct; don't guess a file path.`;
}

/** A reader needed the bytes of a linked file that is offline. The user's to fix, not a crash. */
export class MediaOfflineError extends ArtDaddyError {
  readonly code = "media_offline";
  readonly expected = true;
  constructor(row: Pick<LibraryClip, "id" | "path" | "filename">) {
    super(offlineRefMessage(row));
    this.name = "MediaOfflineError";
  }
}

/** What a caller needs to act on a ref that is still being made. Only an MCP caller is given it:
 *  the in-app agent is told when the media lands, so it has nothing to schedule. */
export interface PendingStatus {
  pending: true;
  status: "generating";
  /** About how many seconds are left. */
  eta_s: number;
  /** The soonest it is worth asking again. */
  retry_after_s: number;
}

/** The part of the tool context this needs. The WHOLE context is asked for, not just its store, so
 *  a caller cannot report a pending ref without saying who is asking: the wording is a promise
 *  about the future, and the two kinds of caller are promised different things. */
export type RefReportContext = Pick<ClientToolContext, "store" | "surface">;

/** The message for a ref that did not resolve, plus a structured status when the caller is an MCP
 *  agent and the ref is still being generated. Pending/failed/offline if the catalog knows it,
 *  otherwise the caller's own "unknown ref" text (which is still the right answer for a typo).
 *
 *  `use` is what the caller wanted the file for ("read" unless it says otherwise: an export
 *  "deliver"s it). It only changes that one word; the rest of the sentence, and what the in-app
 *  agent is promised, is the same for every tool. */
export async function unresolvedRef(
  ctx: RefReportContext,
  ref: string,
  whenUnknown: string,
  nowMs: number = Date.now(),
  use: string = "read",
): Promise<{ error: string } & Partial<PendingStatus>> {
  // The importing list is read before the catalog and again after it: a file that lands between the two is then still reported as on its way in (the ref
  // is right, a retry finds it), never as unknown. The agent has no id for a file that is not in yet, so it asks by the name it was given.
  const importingEarly = importingMatch(ctx.store, ref, nowMs);
  const pending = await ctx.store.pendingMedia(ref).catch(() => null);
  if (!pending) {
    const offline = await ctx.store.offlineMedia(ref).catch(() => null);
    if (offline) return { error: offlineRefMessage(offline) };
    const importing = importingEarly ?? importingMatch(ctx.store, ref, nowMs);
    return { error: importing ? importingRefMessage(importing, use) : whenUnknown };
  }
  if (pending.status === "failed") {
    return {
      error: `'${ref}' failed to generate${failureReason(pending.error)}, so there is no file to ${use}. Generate it again or use different media — do not retry this ref.`,
    };
  }
  if (ctx.surface !== "mcp") {
    return {
      error: `'${ref}' is still being generated, so there is nothing to ${use} yet. The ref is correct; you will be told when it lands. Don't re-generate it and don't guess a file path.`,
    };
  }
  const wait = generationWait(pending, nowMs);
  return {
    error: `'${ref}' is still being generated (${timeLeft(wait)}), so there is nothing to ${use} yet. The ref is correct, but nothing will tell you when it lands: this connection cannot wake you. Do other work or end your turn, and ask again no sooner than ${wait.retry_after_s} s (library_op action='list' shows status:'generating' until it is ready). Don't poll, don't re-generate it and don't guess a file path.`,
    ...pendingStatus(wait),
  };
}

/** What to say about a file the person is still importing: the name is right and it is on its way in. Nothing tells the agent when it lands, so it is not promised. */
export function importingRefMessage(row: ImportingRow, use: string): string {
  const done = row.fraction !== null ? ` (${Math.round(row.fraction * 100)}% done)` : "";
  return `'${row.name}' is still being imported${done}, so there is nothing to ${use} yet. The file is not missing: it appears in the library when the import finishes (library_op action='list' shows what is still importing). Nothing will tell you when that happens: work with what is already in the library, or end your turn and tell the person it can be done once the file is in. Don't import it again, don't poll and don't guess a file path.`;
}

/** The words for a name that did not resolve but is a file the person is still importing, or null when it is not. `early` is the caller's own reading, taken BEFORE it
 *  tried to resolve the name: a file that lands in between is still reported as on its way in (told once more than needed, harmless), never as unknown. For a caller that
 *  has its own error type and cannot go through {@link unresolvedRef} (a placement, an export item, a swap). */
export function importingRefError(
  ctx: RefReportContext,
  ref: string,
  use: string,
  early: ImportingRow | null = null,
): string | null {
  const row = early ?? importingMatch(ctx.store, ref);
  return row ? importingRefMessage(row, use) : null;
}

/** `: <reason>` when the provider gave one. */
const failureReason = (why?: string): string => (why ? `: ${why}` : "");

/** How long is left, in words an outside caller can plan around. */
const timeLeft = (wait: GenerationWait): string =>
  wait.slow
    ? `it is taking longer than usual; allow about ${wait.eta_s} s more`
    : `about ${wait.eta_s} s left`;

/** The typed half of the same answer. */
const pendingStatus = (wait: GenerationWait): PendingStatus => ({
  pending: true,
  status: "generating",
  eta_s: wait.eta_s,
  retry_after_s: wait.retry_after_s,
});

export async function unresolvedRefMessage(
  ctx: RefReportContext,
  ref: string,
  whenUnknown: string,
  nowMs?: number,
  use?: string,
): Promise<string> {
  return (await unresolvedRef(ctx, ref, whenUnknown, nowMs, use)).error;
}

/** What a placement needs to say about media that is still being made when the entry asks for
 *  something only the finished file can answer: a length nothing gave it, or a loop, a stretch or a
 *  source span, which all work from the source's real length. It used to say "give a length" or, for
 *  loop and stretch, probe the placeholder's file and report ffprobe's "No such file or directory"
 *  (8 of 20 failed calls in a month). The same promise as {@link unresolvedRef}: the in-app agent is
 *  told when the media lands; an outside caller is not, so it gets the time and a typed status.
 *
 *  `need` says why the finished file is wanted; `placeNow` says what to give instead to place it
 *  without waiting. A length given that way is kept as it is: it is never refitted when the media
 *  lands, and the wording says so. */
export async function pendingPlacementRefusal(
  ctx: RefReportContext,
  ref: string,
  pending: { kind?: string; added_at?: number },
  need: string,
  placeNow: string,
  nowMs: number = Date.now(),
): Promise<{ error: string } & Partial<PendingStatus>> {
  const how = `${placeNow}; that length is kept as given and is not refitted when the media lands`;
  if (ctx.surface !== "mcp") {
    return {
      error: `'${ref}' is still being generated, and ${need}. The ref is correct; you will be told when it lands, then place it. To place it now instead, give this entry ${how}. Don't re-generate it and don't guess a file path.`,
    };
  }
  const wait = generationWait(pending, nowMs);
  return {
    error: `'${ref}' is still being generated (${timeLeft(wait)}), and ${need}. The ref is correct, but nothing will tell you when it lands: this connection cannot wake you. Do other work or end your turn and place it no sooner than ${wait.retry_after_s} s from now (library_op action='list' shows status:'generating' until it is ready), or give this entry ${how}. Don't poll, don't re-generate it and don't guess a file path.`,
    ...pendingStatus(wait),
  };
}

/** The same for a generation that failed: there is nothing to wait for and the ref cannot be placed. */
export function failedPlacementMessage(ref: string, why?: string): string {
  return `'${ref}' failed to generate${failureReason(why)}, so it cannot be placed. Generate it again or use different media — do not retry this ref.`;
}

/** `{ok:false}` shape for the same, for the tools that return rather than throw. */
export async function unresolvedRefError(
  ctx: RefReportContext,
  ref: string,
  whenUnknown: string,
  nowMs?: number,
  use?: string,
): Promise<{ ok: false; error: string } & Partial<PendingStatus>> {
  return { ok: false, ...(await unresolvedRef(ctx, ref, whenUnknown, nowMs, use)) };
}
