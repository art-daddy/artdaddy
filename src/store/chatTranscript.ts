// Chat transcript model + shaping: the client-owned `Turn` type and the pure
// turns<->transcript-requests transforms. Mirrors the backend turn/transcript.py
// (the transcript is the durable conversation; turns are its UI projection).
import type { Attachment, TranscriptPart, TranscriptRequest } from "../api/types";
import type { RoundInput, ToolResultItem } from "../agent/types";
import type { Mention } from "../timeline/mentions";
import type { Timeline } from "../timeline/model";

export type TurnStatus = "streaming" | "awaiting" | "done" | "error";

export interface Turn {
  id: string;
  userText: string;
  attachments: Attachment[];
  mentions?: Mention[];
  parts: TranscriptPart[];
  status: TurnStatus;
  /** The app wrote this prompt, not the user (a background job finishing). */
  system?: boolean;
  /** Timeline BEFORE this turn (client-owned undo restores it). */
  checkpoint?: Timeline | null;
  /** Timeline AFTER this turn (client-owned redo restores it). */
  timelineAfter?: Timeline | null;
  undone?: boolean;
}

/** Persisted transcript requests -> UI turns. */
export function mapRequests(reqs: TranscriptRequest[]): Turn[] {
  return reqs.map((r) => ({
    id: r.id,
    userText: r.message?.text ?? "",
    attachments: (r.message?.attachments ?? []).map((a) => ({
      path: a.path ?? "",
      kind: a.kind ?? null,
      caption: a.caption ?? a.name ?? null,
    })),
    parts: r.response ?? [],
    status: "done" as TurnStatus,
    checkpoint: (r.checkpoint?.timeline as Timeline | undefined) ?? null,
    timelineAfter: (r.checkpoint?.timeline_after as Timeline | undefined) ?? null,
    undone: r.undone ?? false,
  }));
}

/** Turns -> transcript requests for sending + persisting (inverse of mapRequests).
 *
 *  Streamed `partial` parts are dropped here, at the ONE boundary both the persisted
 *  transcript and the history sent back to the model pass through. They are live
 *  presentation that the round's authoritative part replaces; one that outlives its
 *  round (a tool-call round streams prose that never becomes a `text` part) would
 *  otherwise be written to disk AND re-sent as context the model never said. */
export function buildRequests(turns: Turn[]): TranscriptRequest[] {
  return turns.map((t) => ({
    id: t.id,
    message: {
      text: t.userText,
      attachments: t.attachments.map((a) => ({
        path: a.path,
        kind: a.kind ?? undefined,
        caption: a.caption ?? undefined,
      })),
    },
    response: t.parts.filter((p) => !p.partial),
    checkpoint: {
      timeline: t.checkpoint ?? undefined,
      timeline_after: t.timelineAfter ?? undefined,
    },
    undone: t.undone ?? false,
  }));
}

/** Tool calls in the LAST turn that never got a result.
 *
 *  The provider keeps the conversation on its side and refuses the next request until every
 *  call it issued has exactly one output. A turn stopped mid-batch hands its debt over in
 *  memory, but a session that is KILLED — which is how this app has been failing — loses that
 *  with the process, and the first message after the crash was refused. The transcript
 *  survives the crash, so the debt is recovered from it here.
 *
 *  Only the last turn: earlier ones completed, and answering a call the provider has long
 *  since forgotten would be a new error rather than a repair. */
export function unansweredCalls(turns: Turn[]): ToolResultItem[] {
  const last = turns.at(-1);
  if (!last) return [];
  const answered = new Set(
    last.parts.filter((p) => p.kind === "tool_result").map((p) => String(p.call_id ?? "")),
  );
  return last.parts
    .filter((p) => p.kind === "tool_call" && !answered.has(String(p.call_id ?? "")))
    .map((p) => ({
      call_id: String(p.call_id ?? ""),
      name: String(p.name ?? ""),
      result: { ok: false, error: "not run — the app closed before this tool call finished" },
    }))
    .filter((r) => r.call_id);
}

/** The transcript to send for a round: pre-turn history on the first (user)
 *  round; the full live history minus the current tool results on a follow-up
 *  round — so a provider without a server-side chain (Gemini) rebuilds mid-turn
 *  context without double-feeding the delta. Azure ignores it once its token is
 *  set; it only matters for the cold first round + Gemini. */
export function transcriptForRound(
  base: { requests: unknown[] },
  roundInput: RoundInput,
  turns: Turn[],
): { requests: unknown[] } {
  if (roundInput.user_text != null) return base;
  const exclude = new Set((roundInput.tool_results ?? []).map((t) => t.call_id));
  const requests = buildRequests(turns).map((r, i) => {
    if (i < turns.length - 1) return r;
    const parts = (r.response ?? []).filter(
      (p) =>
        !(
          (p as { kind?: string }).kind === "tool_result" &&
          exclude.has((p as { call_id?: string }).call_id ?? "")
        ),
    );
    return { ...r, response: parts };
  });
  return { requests };
}
