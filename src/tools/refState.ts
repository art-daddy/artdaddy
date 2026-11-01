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
// The same holds for a linked file the user moved (UJ-014): the ref is right and the file is offline.
import { ArtDaddyError } from "../lib/errors";
import type { ClientToolContext } from "./context";
import { generationWait } from "./generationWait";
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
 *  otherwise the caller's own "unknown ref" text (which is still the right answer for a typo). */
export async function unresolvedRef(
  ctx: RefReportContext,
  ref: string,
  whenUnknown: string,
  nowMs: number = Date.now(),
): Promise<{ error: string } & Partial<PendingStatus>> {
  const pending = await ctx.store.pendingMedia(ref).catch(() => null);
  if (!pending) {
    const offline = await ctx.store.offlineMedia(ref).catch(() => null);
    return { error: offline ? offlineRefMessage(offline) : whenUnknown };
  }
  if (pending.status === "failed") {
    const why = pending.error ? `: ${pending.error}` : "";
    return {
      error: `'${ref}' failed to generate${why}, so there is no file to read. Generate it again or use different media — do not retry this ref.`,
    };
  }
  if (ctx.surface !== "mcp") {
    return {
      error: `'${ref}' is still being generated, so there is nothing to read yet. The ref is correct; you will be told when it lands. Don't re-generate it and don't guess a file path.`,
    };
  }
  const wait = generationWait(pending, nowMs);
  const left = wait.slow
    ? `it is taking longer than usual; allow about ${wait.eta_s} s more`
    : `about ${wait.eta_s} s left`;
  return {
    error: `'${ref}' is still being generated (${left}), so there is nothing to read yet. The ref is correct, but nothing will tell you when it lands: this connection cannot wake you. Do other work or end your turn, and ask again no sooner than ${wait.retry_after_s} s (library_op action='list' shows status:'generating' until it is ready). Don't poll, don't re-generate it and don't guess a file path.`,
    pending: true,
    status: "generating",
    eta_s: wait.eta_s,
    retry_after_s: wait.retry_after_s,
  };
}

export async function unresolvedRefMessage(
  ctx: RefReportContext,
  ref: string,
  whenUnknown: string,
  nowMs?: number,
): Promise<string> {
  return (await unresolvedRef(ctx, ref, whenUnknown, nowMs)).error;
}

/** `{ok:false}` shape for the same, for the tools that return rather than throw. */
export async function unresolvedRefError(
  ctx: RefReportContext,
  ref: string,
  whenUnknown: string,
  nowMs?: number,
): Promise<{ ok: false; error: string } & Partial<PendingStatus>> {
  return { ok: false, ...(await unresolvedRef(ctx, ref, whenUnknown, nowMs)) };
}
