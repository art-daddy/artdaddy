// The client-owned agent loop: one turn = rounds of /inference interleaved with
// tool execution, mirroring the server engine's approve / batch / continue state
// machine (turn/engine.py). Provider calls, prompt composition, and secret
// tools live server-side; this owns the LOOP: gating, parallel-call batching,
// the continue-cap, and emitting the same chat events the SSE path did.
//
// Self-contained + dependency-injected (infer / runTool / emit / mode / session)
// so it unit-tests without a store, a socket, or a real model.
import type {
  InferenceAttachment,
  PendingCall,
  RoundInput,
  RoundResultDTO,
  ToolResultItem,
  Usage,
} from "./types";
import { capToolResult } from "./truncate";
import { scrubAbsolutePaths } from "./scrubPaths";
import { MAX_CONCURRENT_READS, toolEffect } from "./toolEffect";
import { flushAgentEvents, recordAgentOutput, recordToolDenied } from "../api/agentEvents";
import type { ApprovalMode } from "../api/types";

// Re-exported so callers of the loop don't need to reach into the API types.
export type { ApprovalMode };

// APPROVAL POLICY — two modes, and BOTH auto-run ordinary tool calls. An agent
// that needs a click per edit is not usable, and every timeline edit is
// reversible through the shared undo stack. The modes differ only on the calls
// that are HARD TO TAKE BACK or that COST SOMETHING:
//   PAID        — bills the user's account on every call.
//   EXTERNAL    — pulls third-party content onto the user's machine.
//   DESTRUCTIVE — deletes the user's media, cascading across the timeline.
// "default" asks before those; "autopilot" runs them too.
export const PAID_TOOLS = new Set<string>([
  // Generation — real money per call, and NOT undoable.
  "generate_image",
  "generate_video",
  "generate_voiceover",
  "generate_music",
  // Paid vision / analysis reads — cheaper each, but they bill PER CALL and an
  // agent can fire a great many of them inside one turn.
  "video_ask",
  "video_find_moment",
  "image_ask",
  "vision_describe",
  "find_content",
  // Runs a paid analyze pass over every reference clip before it writes a style.
  "extract_style",
]);

/** Pulls third-party content onto the user's machine. */
export const EXTERNAL_FETCH_TOOLS = new Set<string>(["download_video", "get_page_image"]);

/** Costly server-side, but LOCAL compute on the user's own machine — no bill and
 *  no third-party fetch, so asking first would only be friction. Named explicitly
 *  so the conformance guard can tell "deliberately ungated" from "forgotten". */
export const LOCAL_COMPUTE_TOOLS = new Set<string>([
  "export",
  "get_transcript",
  "add_captions",
  "run_ffmpeg",
]);

/** True when THIS call deletes user data. `library_op` is the one tool whose
 *  destructiveness lives in an ARGUMENT rather than the name, so it is
 *  classified per call — a name-only allowlist would wave the delete through. */
export function isDestructive(name: string, args?: Record<string, unknown>): boolean {
  return name === "library_op" && args?.action === "delete";
}

/** The whole "default" gate in one place, so the policy is testable on its own
 *  and there is exactly one definition of "this needs a human". */
export function needsApproval(name: string, args?: Record<string, unknown>): boolean {
  return PAID_TOOLS.has(name) || EXTERNAL_FETCH_TOOLS.has(name) || isDestructive(name, args);
}

// After this many auto-approved steps in one drive, PAUSE and offer Continue.
// Autopilot is trusted to run longer before it checks in. Checked only BETWEEN batches
// (owner, 2026-10-02): a pause inside one left the rest of the batch unanswered, and the
// provider refused the next request for it (UJ-008, one model response issued 30 calls).
export const CONTINUE_CAPS: Record<ApprovalMode, number> = { default: 40, autopilot: 80 };

export interface LoopDeps {
  /** Run one model round (POST /inference), optionally with media the model
   *  should SEE this round. MUST persist the refreshed provider snapshot so the
   *  next round chains the conversation. */
  infer: (roundInput: RoundInput, attachments?: InferenceAttachment[]) => Promise<RoundResultDTO>;
  /** Execute one (client) tool and return its result object. */
  runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Read a tool result's `_attachments` (media the model should SEE) into
   *  inference attachments for the NEXT round. Optional. */
  collectAttachments?: (rawAttachments: unknown) => Promise<InferenceAttachment[]>;
  /** Emit a chat event (same shape the server streamed over SSE). */
  emit: (event: string, data: Record<string, unknown>) => void;
  /** Current approval mode (read live each step). */
  mode: () => ApprovalMode;
  /** User pressed Stop — force manual approval + halt the auto loop. */
  stopped: () => boolean;
  /** Fold one round's usage into the running session cost/tokens. */
  onUsage: (usage: Usage) => void;
  /** Build the SessionState payload for turn_paused / turn_done. */
  session: () => Record<string, unknown>;
  /** Report an unexpected tool exception (best-effort telemetry). Optional. */
  onToolError?: (name: string, args: Record<string, unknown>, err: unknown) => void;
  /** Fields the app adds to a round that returns tool outputs, e.g. that the timeline changed
   *  outside the chat (UJ-028). Asked once per such round, right before it is sent. Optional. */
  noteForRound?: () => Record<string, string> | null;
}

function pendingDict(c: PendingCall): Record<string, unknown> {
  return {
    call_id: c.call_id,
    name: c.name,
    arguments: c.arguments ?? {},
    rationale: c.rationale ?? "",
    reasoning_summary: c.reasoning_summary ?? [],
  };
}

function asResult(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { result: v };
}

/** A number unique to one model round, so the server can tell where a round's calls end
 *  (it shows a round's frames after ALL of that round's outputs). Monotonic for the app's
 *  lifetime; only equality within one turn is ever compared. */
let roundSeq = 0;

/** The images a result showed the model, in order: what the app re-sends in later rounds.
 *  References only (paths), never bytes; video/audio attachments are not history frames. */
function frameRefs(rawAtts: unknown): Array<{ path: string; caption?: string }> {
  if (!Array.isArray(rawAtts)) return [];
  const out: Array<{ path: string; caption?: string }> = [];
  for (const a of rawAtts) {
    if (!a || typeof a !== "object") continue;
    const { path, kind, caption } = a as { path?: unknown; kind?: unknown; caption?: unknown };
    if (typeof path !== "string" || !path) continue;
    if ((kind ?? "image") !== "image") continue;
    out.push(typeof caption === "string" && caption ? { path, caption } : { path });
  }
  return out;
}

/** Drives ONE agent turn client-side. Pauses at an approval gate or the
 *  continue-cap; `approve` / `deny` / `continueRun` resume the same runner. */
export class ClientTurnRunner {
  private batch: PendingCall[] = [];
  private results: ToolResultItem[] = [];
  private pendingAtts: InferenceAttachment[] = [];
  // Approval answers for THIS round, keyed by call_id. Cleared when the batch drains so a
  // later round never inherits a decision the user made about a different call.
  private decisions = new Map<string, { allowed: boolean; reason?: string }>();
  private autoSteps = 0;
  // Per call of the current round: its round marker, and the round's prose (first call only).
  private callRound = new Map<string, number>();
  private rationale = new Map<string, string>();

  constructor(private readonly d: LoopDeps) {}

  /** The tool call currently awaiting the user, if paused at an approval gate. */
  get pending(): PendingCall | null {
    return this.batch[0] ?? null;
  }

  private shouldAuto(call: PendingCall): boolean {
    if (this.d.stopped()) return false;
    if (this.d.mode() === "autopilot") return true;
    // "default": everything reversible and free runs; money, downloads and
    // deletion ask first.
    return !needsApproval(call.name, call.arguments);
  }

  /** Start a turn from a fresh user message. `carried` are outputs owed from a turn that
   *  ended with calls unanswered (see takeUnsentResults) — they must ride along or the
   *  provider rejects the whole request. The message travels as an extra text because a
   *  round carrying tool results ignores `user_text` (both providers append extras). */
  async start(userText: string, carried: ToolResultItem[] = []): Promise<void> {
    this.pendingAtts = [];
    this.d.emit("turn_start", {});
    const input: RoundInput = carried.length
      ? { tool_results: carried, extra_texts: userText ? [userText] : [] }
      : { user_text: userText };
    await this.handle(await this.d.infer(input, []));
  }

  /** Outputs owed for tool calls the model emitted that we never answered — Stop, or the
   *  user walking away from an approval gate and typing something else.
   *
   *  OpenAI keeps the conversation server-side and refuses the NEXT request until every
   *  function_call it issued has exactly one output ("No tool output found for function
   *  call ..."), so abandoning a call silently breaks the chat until it is reset. Taking
   *  these clears the debt; they are answered truthfully rather than fabricated, so the
   *  model can see the call did not run. */
  takeUnsentResults(): ToolResultItem[] {
    const owed: ToolResultItem[] = [
      ...this.results,
      ...this.batch.map((c) => ({
        call_id: c.call_id,
        name: c.name,
        result: { ok: false, error: "not run — the turn was stopped before this tool call" },
      })),
    ];
    this.results = [];
    this.batch = [];
    return owed;
  }

  private async handle(rr: RoundResultDTO): Promise<void> {
    this.d.onUsage(rr.usage ?? {});
    if (rr.kind === "error") {
      this.d.emit("error", { error: rr.error || "error" });
      return;
    }
    // The round's encrypted reasoning goes into the transcript BEFORE anything the round
    // produced: the server rebuilds the model's input from the transcript in this order.
    const round = ++roundSeq;
    for (const ri of rr.reasoning_items ?? []) {
      if (ri?.id && ri?.encrypted_content)
        this.d.emit("reasoning_item", {
          id: ri.id,
          encrypted_content: ri.encrypted_content,
          round,
        });
    }
    if (rr.kind === "text") {
      if (rr.final_text) {
        this.d.emit("text", { text: rr.final_text });
        recordAgentOutput(rr.final_text);
      }
      this.d.emit("turn_done", this.d.session());
      void flushAgentEvents();
      return;
    }
    // tool_calls: surface any reasoning, then run the batch (N=1 for single-call
    // vendors; N>1 for parallel calls, surfaced one at a time).
    const reasoning = (rr.pending_calls ?? []).flatMap((c) => c.reasoning_summary ?? []);
    if (reasoning.length) this.d.emit("reasoning", { text: reasoning.join("\n") });
    this.batch = (rr.pending_calls ?? []).slice();
    this.callRound.clear();
    this.rationale.clear();
    for (const c of this.batch) this.callRound.set(c.call_id, round);
    const first = this.batch[0];
    if (first?.rationale) this.rationale.set(first.call_id, first.rationale);
    this.results = [];
    await this.driveBatch();
  }

  private async driveBatch(): Promise<void> {
    for (;;) {
      // Stop pressed: end the turn now (don't pause at an approval gate, don't
      // start another round). The in-flight round is aborted separately.
      if (this.d.stopped()) return this.endTurn();
      if (this.batch.length === 0) break;

      // Ask for EVERY approval this round needs in one go. A round with three paid reads
      // used to interrupt the user three times; now it asks once and each call still
      // carries its own Allow/Deny.
      const undecided = this.batch.filter(
        (c) => !this.shouldAuto(c) && !this.decisions.has(c.call_id),
      );
      if (undecided.length > 0) {
        this.d.emit("awaiting_approval", { calls: undecided.map(pendingDict) });
        this.d.emit("turn_paused", this.d.session());
        return; // paused for approval — approve()/deny() resume
      }

      const next = this.batch[0];
      const decided = this.decisions.get(next.call_id);
      if (decided && !decided.allowed) {
        this.recordDenial(next, decided.reason);
        continue;
      }

      // Consecutive READS overlap; a mutation always runs alone, so two writes can never
      // interleave and no read can observe a half-applied edit.
      const group = toolEffect(next.name) === "read" ? this.leadingReads() : [next];

      this.autoSteps += group.length;
      if (group.length === 1) {
        await this.runCall(group[0]);
      } else {
        await Promise.all(group.map((c) => this.runCall(c)));
      }
      this.batch.splice(0, group.length);
    }
    if (this.d.stopped()) return this.endTurn();
    // Batch drained, every call answered. Check in BEFORE the next round, never inside a
    // batch; Continue sends these results.
    if (this.autoSteps >= CONTINUE_CAPS[this.d.mode()]) {
      this.d.emit("turn_paused", { ...this.d.session(), can_continue: true });
      return; // paused at the cap -- continueRun() resumes
    }
    // Feed all results back for the next round, along with any media a tool exposed for the
    // model to SEE (inspect_media pixels). They are taken off the runner BEFORE the round, so
    // the round that follows (handled inside this call) cannot have its own results wiped on
    // the way back out; and a round the server refuses hands them back, still owed.
    const atts = this.pendingAtts;
    this.pendingAtts = [];
    this.decisions.clear();
    const sent = this.results;
    this.results = [];
    this.addRoundNote(sent);
    let next: RoundResultDTO;
    try {
      next = await this.d.infer({ tool_results: sent }, atts);
    } catch (e) {
      this.results = [...sent, ...this.results];
      throw e;
    }
    await this.handle(next);
  }

  /** Merge the app's note for this round into its LAST output. A note rides inside a tool output,
   *  never as a user message: a user message after a tool output costs the model its reasoning
   *  (see the server's responses_history). The transcript gets the same bytes the round sends. */
  private addRoundNote(sent: ToolResultItem[]): void {
    const note = this.d.noteForRound?.();
    if (!note || !sent.length) return;
    const last = sent[sent.length - 1];
    const result = { ...last.result, ...note };
    sent[sent.length - 1] = { ...last, result };
    this.d.emit("tool_result_note", { call_id: last.call_id, model_result: result });
  }

  /** The run of reads at the head of the batch, capped so a fan-out of ffmpeg-backed reads
   *  cannot take the machine the render also needs. Stops at the first mutation, which is
   *  what keeps the emitted order meaningful. */
  private leadingReads(): PendingCall[] {
    const out: PendingCall[] = [];
    for (const call of this.batch) {
      if (out.length >= MAX_CONCURRENT_READS) break;
      if (toolEffect(call.name) !== "read") break;
      const decided = this.decisions.get(call.call_id);
      if (decided && !decided.allowed) break; // a denial is recorded, not run
      out.push(call);
    }
    return out;
  }

  /** Answer a call the user refused, truthfully, without running it. */
  private recordDenial(call: PendingCall, reason?: string): void {
    const result = { ok: false, error: reason || "user denied this tool call" };
    this.emitCall(call);
    this.d.emit("tool_result", {
      ...result,
      call_id: call.call_id,
      name: call.name,
      model_result: result,
    });
    // A refusal never reaches the dispatch boundary, so this is the only place it can be
    // counted -- and "the user said no" is a different signal from "the tool failed".
    recordToolDenied(call.name, call.call_id, result.error);
    this.results.push({ call_id: call.call_id, name: call.name, result });
    this.batch.shift();
  }

  /** The tool_call part: the call, its round, and (first call only) the round's prose. */
  private emitCall(call: PendingCall): void {
    const part: Record<string, unknown> = {
      call_id: call.call_id,
      name: call.name,
      args: call.arguments,
    };
    const round = this.callRound.get(call.call_id);
    if (round !== undefined) part.round = round;
    const prose = this.rationale.get(call.call_id);
    if (prose) part.rationale = prose;
    this.d.emit("tool_call", part);
  }

  /** Stop pressed: end the turn cleanly (no more rounds, no approval gate). */
  private endTurn(): void {
    this.d.emit("turn_done", this.d.session());
    void flushAgentEvents();
  }

  private async runCall(call: PendingCall): Promise<void> {
    this.emitCall(call);
    let result: Record<string, unknown>;
    try {
      result = asResult(await this.d.runTool(call.name, call.arguments));
    } catch (e) {
      this.d.onToolError?.(call.name, call.arguments, e);
      result = { ok: false, error: String(e) };
    }
    // Drain any media the tool exposed for the model to SEE into the next round
    // (other NLEs attach-transport), and strip it before the model sees the result.
    const rawAtts = result._attachments;
    const frames = frameRefs(rawAtts);
    if (rawAtts !== undefined) {
      delete result._attachments;
      if (this.d.collectAttachments) {
        try {
          this.pendingAtts.push(...(await this.d.collectAttachments(rawAtts)));
        } catch {
          /* unreadable attachment — skip */
        }
      }
    }
    // Scrub absolute filesystem paths (linked local media records the user's ABSOLUTE source path;
    // owned files resolve under the absolute project dir) to their basename BEFORE the model sees the
    // result — the model addresses media by media_ref, never a raw path, and the user's directory
    // structure is private. THEN cap an oversized result before it re-enters the model context (cost/cache).
    result = capToolResult(scrubAbsolutePaths(result));
    // The ENVELOPE goes last. Spread the other way, a result carrying its own `name` or `kind`
    // overwrote the fields that say which call this is: `get_project_state` was recorded under
    // `name: "Odyssey II"`, and every inspect_media/generate_video result (which report
    // `kind: "image"|"video"`) stopped being a tool_result at all. 49 of one session's 164 calls
    // had no recorded result as a direct consequence.
    //
    // The spread is for the chat UI. What the MODEL saw travels whole under `model_result`
    // (the envelope renames a result's own `name`), with references to the frames it was
    // shown: the server rebuilds every later round's input from exactly these.
    const part: Record<string, unknown> = {
      ...result,
      call_id: call.call_id,
      name: call.name,
      model_result: result,
    };
    if (frames.length) part.frame_refs = frames;
    this.d.emit("tool_result", part);
    this.results.push({ call_id: call.call_id, name: call.name, result });
  }

  /** User allowed a pending call. Resumes once every gated call this round has an answer,
   *  so the batch runs in one pass rather than stopping again at the next one. */
  async approve(callId?: string): Promise<void> {
    const id = callId ?? this.batch.find((c) => !this.shouldAuto(c))?.call_id;
    if (!id) return;
    this.decisions.set(id, { allowed: true });
    if (this.batch.some((c) => !this.shouldAuto(c) && !this.decisions.has(c.call_id))) return;
    await this.driveBatch();
  }

  /** User refused a pending call: it is answered truthfully rather than run. */
  async deny(reason = "user denied this tool call", callId?: string): Promise<void> {
    const id = callId ?? this.batch.find((c) => !this.shouldAuto(c))?.call_id;
    if (!id) return;
    this.decisions.set(id, { allowed: false, reason });
    if (this.batch.some((c) => !this.shouldAuto(c) && !this.decisions.has(c.call_id))) return;
    await this.driveBatch();
  }

  /** Resume an autonomous run paused at the continue-cap. */
  async continueRun(): Promise<void> {
    this.autoSteps = 0;
    await this.driveBatch();
  }
}
