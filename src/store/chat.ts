import { useStore, type StateCreator } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { inferRoundStreaming } from "../agent/api";
import { ClientTurnRunner, type LoopDeps } from "../agent/loop";
import { composeModelText } from "../agent/compose";
import { collectInferenceAttachments } from "../agent/attachments";
import type { InferenceAttachment, RoundInput, Usage } from "../agent/types";
import { captureError, setCorrelation } from "../observability/sentry";
import { isExpected, toUserMessage } from "../lib/errors";
import { submitFeedback, type FeedbackKind } from "../api/feedback";
import type { SSEMessage } from "../api/sse";
import type { ApprovalMode, Attachment, PendingApproval, SessionState } from "../api/types";
import { useEditor } from "./editor";
import { replaceTimeline } from "../timeline/engine";
import { withProjectLock } from "../tools/coordinator";
import { mentionKey, type Mention } from "../timeline/mentions";
import {
  loadClientSession,
  persistSession,
  persistSessionNow,
  persistSessionSoon,
} from "./transcriptFile";
import { buildFeedbackBundle } from "./feedbackBundle";
import { openToolHost, type ToolHost } from "../tools/host";
import type { MutationOrigin } from "../project/MutationGate";
import {
  type Turn,
  mapRequests,
  buildRequests,
  transcriptForRound,
  unansweredCalls,
} from "./chatTranscript";
import { undoFlags, localSession } from "./chatSession";
import { projectConfig } from "./projectConfig";
import { registerJobSink, unregisterJobSink, type SettledJob } from "./jobNotes";

export interface RestoredPrompt {
  text: string;
  attachments: Attachment[];
}

interface ChatState {
  projectId: string | null;
  transcriptId: string | null;
  /** The current agent execution's monotonic token (TurnExecution.token), or null when no turn is
   *  running. Surfaced from the closure so the document's origin fence (isChatExecutionCurrent) can
   *  reject a commit from a superseded execution at the mutation gate. */
  execToken: number | null;
  turns: Turn[];
  session: SessionState | null;
  /** Provider continuity (Azure previous_response_id) the client owns + passes. */
  providerSnapshot: Record<string, unknown> | null;
  streaming: boolean;
  /** Every gated call in the CURRENT round, surfaced together. `null` and `[]` both mean
   *  nothing is waiting; each entry is allowed or denied on its own. */
  pending: PendingApproval[] | null;
  /** True when an autonomous run paused at the loop cap (Cursor-style) and the
   *  user can resume it with the Continue button. */
  canContinue: boolean;
  /** Admission fence: true while the project is CLOSING (final-save/close-failed). Every mutating chat
   *  action (send/approve/deny/continue/undo/redo/restore) refuses while set, so no NEW turn or
   *  transcript write can race the close's final snapshot. Cleared by resume() on "Keep editing". */
  closing: boolean;
  error: string | null;
  model: string;
  effort: string;
  mode: ApprovalMode;
  /** Explicit chat context refs (playhead/range/clip/media) staged by @-mention
   *  or right-click "Add to chat", sent with the next message then cleared. */
  pendingMentions: Mention[];
  addMention: (m: Mention) => void;
  removeMention: (key: string) => void;
  clearMentions: () => void;
  setControls: (p: Partial<{ model: string; effort: string; mode: ApprovalMode }>) => void;
  load: (projectId: string) => Promise<void>;
  /** Retire the active turn + reset to idle WITHOUT loading another project (route
   *  teardown): stops the old hidden turn's paid calls/tools when leaving (R7-3). */
  deactivate: () => void;
  /** Stop transcript producers (retire the in-flight turn) WITHOUT resetting state, so the close
   *  SAVE phase can read the LATEST transcript for the final snapshot with nothing racing it. Also
   *  raises the admission fence (closing=true) so no new turn can start after this point. */
  quiesce: () => void;
  /** Lower the admission fence (return to editing after a cancelled close) so send()/undo/etc. work
   *  again. The in-flight turn stays retired (it was aborted by the close); the transcript is kept. */
  resume: () => void;
  /** Resolve once every already-admitted non-turn op (undo/redo/restore) has completed. The close SAVE
   *  awaits this after raising the fence, so an in-flight op lands IN FULL before the final snapshot. */
  whenQuiescent: () => Promise<void>;
  send: (text: string, attachments?: Attachment[], opts?: { system?: boolean }) => Promise<void>;
  /** Wake the agent for background work that finished while it was idle. */
  resumeForJobs: (jobs: SettledJob[]) => Promise<void>;
  approve: (callId?: string) => Promise<void>;
  deny: (reason?: string, callId?: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Resolves the prompt that was rolled back, so the composer can offer it again. */
  restoreTo: (turnId: string) => Promise<RestoredPrompt | null>;
  stop: () => Promise<void>;
  continueRun: () => Promise<void>;
  refreshState: () => Promise<void>;
  sendFeedback: (
    kind: FeedbackKind,
    opts?: { note?: string; requestId?: string },
  ) => Promise<boolean>;
}

function withLast(turns: Turn[], fn: (t: Turn) => Turn): Turn[] {
  if (turns.length === 0) return turns;
  const i = turns.length - 1;
  const next = turns.slice();
  next[i] = fn(next[i]);
  return next;
}

/** What the model is told when background work lands. It names the ids so the next round can
 *  use them without a lookup, and reports failures plainly so the agent corrects its own earlier
 *  "generating it now" rather than leaving that as the last word. */
export function jobWakePrompt(jobs: readonly SettledJob[]): string {
  const lines = jobs.map((j) => {
    if (j.status === "failed") return `- ${j.label} FAILED: ${j.error ?? "unknown error"}`;
    const refs = (j.media_refs ?? []).join(", ");
    const suffix = refs ? ` (${refs})` : j.detail ? ` — ${j.detail}` : "";
    return `- ${j.label} is ready${suffix}`;
  });
  return [
    "Background work you started earlier has finished:",
    ...lines,
    "",
    "Continue what you were doing if there is more to do. If a job failed, say so and offer a",
    "way forward instead of silently retrying anything that costs money.",
  ].join("\n");
}

const chatCreator: StateCreator<ChatState> = (set, get) => {
  // Client-owned agent loop (Cursor pattern): the runner drives one turn locally
  // and persists across approve/deny/continue. Each turn owns an immutable
  // TurnExecution (its abort controller + stop flag + tool host + identity), so a
  // superseded/stopped turn reads ITS OWN cancellation state and can never revive
  // off the NEXT turn's -- the fix for a stale runner making hidden edits.
  interface TurnExecution {
    readonly token: number;
    controller: AbortController;
    readonly host: ToolHost;
    stopped: boolean;
  }
  let currentRunner: ClientTurnRunner | null = null;
  let currentExec: TurnExecution | null = null;
  let execSeq = 0;
  // Monotonic load generation: a slower load() (even for the SAME project id -- an
  // A->B->A re-activation) sees a newer one took over and bails before committing
  // its stale session. A bare projectId check can't tell two same-id loads apart (R6-3).
  let loadSeq = 0;

  /** Begin a fresh execution for a NEW turn (a new user message). */
  function newExec(host: ToolHost): TurnExecution {
    currentExec = { token: ++execSeq, controller: new AbortController(), host, stopped: false };
    set({ execToken: currentExec.token }); // surface the live execution for the origin fence
    return currentExec;
  }
  /** Re-arm the CURRENT turn for a resume (approve/deny/continue, or after Stop):
   *  a fresh controller + cleared stop flag, SAME identity. */
  function rearm(exec: TurnExecution): void {
    exec.controller = new AbortController();
    exec.stopped = false;
  }
  /** Hard-abort + retire the current turn (project switch, or a new message sent
   *  before approving): its in-flight call + sidecar die and it can run nothing
   *  more. The retired exec stays referenced by its orphaned runner's deps, which
   *  now see `exec !== currentExec` and halt. */
  function supersede(): void {
    if (currentExec) {
      currentExec.stopped = true;
      currentExec.controller.abort();
    }
    currentExec = null;
    currentRunner = null;
    set({ execToken: null }); // no live execution -> its origin is no longer current
  }
  /** Quiesce transcript producers: retire the in-flight turn (its `emit()` halts, so no more
   *  persistSessionSoon fires) AND retire any pending load (so a stale loadClientSession can't
   *  repopulate). Does NOT reset state — the caller (close SAVE, or deactivate) decides that. */
  function quiesceTurn(): void {
    loadSeq++;
    supersede();
    detachJobSink();
  }

  // The project whose completion queue this chat is currently attached to. Keyed by DIRECTORY
  // because that is what a background job knows about itself; the chat is keyed by project id.
  let boundJobDir: string | null = null;

  function detachJobSink(): void {
    if (!boundJobDir) return;
    unregisterJobSink(boundJobDir);
    boundJobDir = null;
  }

  /** Attach (or re-attach) this chat to its project's completion queue. Idempotent, and
   *  registering delivers anything that landed while nothing was listening — which is how a
   *  completion survives a switch, a close and a reopen without its own recovery path. */
  function syncJobSink(): void {
    const ed = useEditor.getState();
    const dir = ed.store?.projectDir ?? null;
    if (!dir || ed.projectId !== get().projectId) return detachJobSink();
    if (boundJobDir && boundJobDir !== dir) detachJobSink();
    boundJobDir = dir;
    registerJobSink(dir, {
      isIdle: () => {
        const s = get();
        return !s.streaming && !s.closing && !s.pending?.length;
      },
      deliver: (jobs) => {
        // The catalog changed under the editor (a placeholder filled in, or failed), so the
        // timeline can drop its "Generating…" without waiting for a reload.
        useEditor.getState().refreshMedia();
        void get().resumeForJobs(jobs);
      },
    });
  }

  // In-flight NON-turn producer ops (undo/redo/restore) that write the transcript/timeline OUTSIDE the
  // turn mechanism. The close SAVE awaits these (whenOpsIdle) so an op admitted just BEFORE the fence
  // completes IN FULL before the final snapshot — never a half-applied write landing after it (finding
  // #2). The op is tracked SYNCHRONOUSLY the instant its entry guard passes (no await in between), so a
  // concurrent quiesce either sees it in flight or blocks it at the guard.
  let inflightOps = 0;
  const opsIdleWaiters: Array<() => void> = [];
  async function trackOp<T>(body: () => Promise<T>): Promise<T> {
    inflightOps++;
    try {
      return await body();
    } finally {
      if (--inflightOps === 0) for (const resolve of opsIdleWaiters.splice(0)) resolve();
    }
  }
  function whenOpsIdle(): Promise<void> {
    return inflightOps === 0
      ? Promise.resolve()
      : new Promise((resolve) => opsIdleWaiters.push(resolve));
  }

  function apply(msg: SSEMessage) {
    const { event, data } = msg;
    switch (event) {
      // ── streamed output ────────────────────────────────────────────────────
      // Deltas are LIVE PRESENTATION. They grow a provisional part so the user sees
      // the answer forming; the authoritative whole-part event below replaces it.
      // Deliberately NOT persisted: the transcript writer runs per event, and a disk
      // write per token would be thousands of writes a turn. Nothing is lost — the
      // whole part is persisted the moment it lands.
      case "delta_text":
      case "delta_reasoning": {
        const kind = event === "delta_text" ? "text" : "reasoning";
        const chunk = String(data?.text ?? "");
        if (!chunk) break;
        set((s) => ({
          turns: withLast(s.turns, (t) => {
            const last = t.parts[t.parts.length - 1];
            if (last && last.kind === kind && last.partial) {
              const parts = t.parts.slice(0, -1);
              parts.push({ ...last, text: String(last.text ?? "") + chunk });
              return { ...t, parts };
            }
            return { ...t, parts: [...t.parts, { kind, text: chunk, partial: true }] };
          }),
        }));
        break;
      }
      // The attempt that produced the text so far was retried or chain-reset upstream,
      // so it is not the answer. Drop it rather than letting the next attempt append
      // to prose the model already abandoned.
      case "delta_reset":
        set((s) => ({
          turns: withLast(s.turns, (t) => ({ ...t, parts: t.parts.filter((p) => !p.partial) })),
        }));
        break;
      case "reasoning":
      case "tool_call":
      case "tool_result":
      case "text":
        set((s) => ({
          turns: withLast(s.turns, (t) => ({
            ...t,
            // Authoritative parts supersede everything streamed for this round: the round
            // result is the record, the deltas were a preview of it. ALL partials go, not
            // just this kind -- a tool-call round streams prose that never becomes a part.
            // `kind` is written AFTER the payload: a tool result reporting its own `kind`
            // (inspect_media, generate_video) otherwise renamed the part and it stopped being
            // a tool_result in the transcript.
            parts: [...t.parts.filter((p) => !p.partial), { ...data, kind: event }],
          })),
        }));
        // A crash mid-turn used to leave only the user's message on disk: the transcript
        // was written when the turn STARTED and again when it ENDED, so every reasoning
        // block and tool call in between died with the process. Each event carries a whole
        // part (never a token delta) and the writer coalesces, so this is cheap.
        persistCurrentSession();
        break;
      case "final":
        // The server synthesizes `final` from `last_final_text` — it repeats the
        // assistant message already delivered as a `text` part. Ignoring it keeps
        // the response from rendering twice.
        break;
      case "awaiting_approval":
        set((s) => ({
          pending: ((data as { calls?: PendingApproval[] })?.calls ?? [
            data as PendingApproval,
          ]) as PendingApproval[],
          turns: withLast(s.turns, (t) => ({ ...t, status: "awaiting" })),
        }));
        break;
      case "turn_paused":
        set({
          session: data as SessionState,
          canContinue: Boolean((data as Record<string, unknown>)?.can_continue),
        });
        break;
      case "turn_done": {
        const providerSnapshot =
          ((data as Record<string, unknown>)?.provider_snapshot as
            Record<string, unknown> | undefined) ?? get().providerSnapshot;
        finishTurn((s) => ({
          session: data as SessionState,
          pending: null,
          streaming: false,
          canContinue: false,
          providerSnapshot,
          turns: withLast(s.turns, (t) => ({ ...t, status: "done" })),
        }));
        // The agent edits timeline.json (server- or client-side); reload the
        // editor so its edits/renders show without a manual refresh.
        void useEditor.getState().reload();
        break;
      }
      case "error":
        finishTurn((s) => ({
          error: String(data?.error ?? "error"),
          turns: withLast(s.turns, (t) => ({
            ...t,
            status: "error",
            parts: [...t.parts, { kind: "error", ...data }],
          })),
        }));
        break;
      default:
        break; // turn_start — no-op
    }
  }

  // ── client-owned loop (behind the flag) ──────────────────────────
  function accumulateUsage(u: Usage): void {
    set((s) => {
      const b = s.session ?? localSession(s.turns, s.mode);
      return {
        session: {
          ...b,
          input_tokens: (b.input_tokens ?? 0) + (u.input_tokens ?? 0),
          output_tokens: (b.output_tokens ?? 0) + (u.output_tokens ?? 0),
          reasoning_tokens: (b.reasoning_tokens ?? 0) + (u.reasoning_tokens ?? 0),
          context_tokens: u.input_tokens ?? b.context_tokens,
          cost_usd: (b.cost_usd ?? 0) + (u.cost_usd ?? 0),
        },
      };
    });
  }

  /** The live SessionState the runner attaches to turn_paused / turn_done. */
  function liveSession(): Record<string, unknown> {
    const s = get();
    const b = s.session ?? localSession(s.turns, s.mode);
    return {
      ...b,
      ...undoFlags(s.turns),
      approval_mode: s.mode,
      pending: Boolean(currentRunner?.pending),
      finished: !currentRunner?.pending,
    };
  }

  /** Loop deps bound to this store + the pre-turn transcript base + the tool host
   *  captured for THIS turn's project (so a later project switch can't retarget it). */
  function buildLoopDeps(base: { requests: unknown[] }, exec: TurnExecution): LoopDeps {
    // This turn is live only while it is the current, non-stopped exec. A superseded
    // (project switch / new message) turn is not `current`; a stopped one has the
    // flag set. Either way it reads ITS OWN exec, never the next turn's.
    const superseded = () => exec !== currentExec;
    const halted = () => exec.stopped || exec !== currentExec;
    return {
      infer: async (roundInput: RoundInput, attachments?: InferenceAttachment[]) => {
        const { model, effort, providerSnapshot, projectId, transcriptId } = get();
        const ed = useEditor.getState();
        const cfg = ed.store ? await projectConfig(ed.store) : undefined;
        setCorrelation({ project_id: projectId, transcript_id: transcriptId, model_id: model });
        const dto = await inferRoundStreaming(
          {
            round_input: roundInput,
            attachments,
            model,
            effort,
            project_id: projectId ?? undefined,
            transcript_id: transcriptId ?? undefined,
            transcript: transcriptForRound(base, roundInput, get().turns),
            provider_snapshot: providerSnapshot,
            project: cfg ?? null,
          },
          // Deltas are live presentation only. They go through the SAME supersede
          // guard as every other event, so a stale turn cannot paint into the new one.
          (d) => {
            if (!superseded()) apply({ event: `delta_${d.kind}`, data: { text: d.text } });
          },
          exec.controller.signal,
        );
        if (!superseded()) set({ providerSnapshot: dto.provider_snapshot ?? providerSnapshot });
        return dto;
      },
      runTool: async (name, args) => {
        // Core fix: a superseded/stopped turn NEVER runs a tool -> no hidden edits on
        // its old project after a switch. Bound to THIS turn's host + abort signal.
        if (halted()) return { ok: false, error: "turn cancelled" };
        if (!exec.host.has(name)) return { ok: false, error: `unknown tool: ${name}` };
        // Carry THIS execution's origin so a commit that lands after a supersede/restore is rejected
        // at the mutation gate (the mandatory backstop under the halted() guard above).
        return exec.host.run(name, args, exec.controller.signal, {
          chatSessionId: get().transcriptId ?? "",
          branchId: 0,
          executionId: exec.token,
        });
      },
      collectAttachments: (raw) => collectInferenceAttachments(raw, exec.host.store()),
      emit: (event, data) => {
        if (!superseded()) apply({ event, data });
      },
      mode: () => get().mode,
      stopped: () => halted(),
      onUsage: (u) => {
        // A superseded turn's usage must not accumulate onto the NEXT turn's session.
        if (!superseded()) accumulateUsage(u);
      },
      session: liveSession,
      onToolError: (name, _args, err) => captureError(err, { tool: name }),
    };
  }

  async function runTurn(exec: TurnExecution, action: () => Promise<void>): Promise<void> {
    set({ streaming: true, error: null, canContinue: false });
    try {
      await action();
    } catch (e) {
      // A superseded turn (a project switch / new message retired it) must NOT write
      // its completion onto the CURRENT turn's shared state (streaming flag, last-turn
      // status, error, pending). Stop keeps the turn current + resumable, so only a
      // truly superseded exec bails here.
      if (exec !== currentExec) return;
      // A Stop/supersede-triggered abort is a clean end, not an error.
      const aborted =
        exec.controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      if (aborted) {
        finishTurn((s) => ({
          streaming: false,
          pending: null,
          canContinue: false,
          turns: withLast(s.turns, (t) =>
            t.status === "streaming" || t.status === "awaiting" ? { ...t, status: "done" } : t,
          ),
        }));
      } else {
        if (!isExpected(e)) captureError(e, { phase: "turn" });
        finishTurn((s) => ({
          streaming: false,
          error: toUserMessage(e),
          turns: withLast(s.turns, (t) => ({
            ...t,
            status: "error",
            parts: isExpected(e)
              ? [...t.parts, { kind: "error", error: toUserMessage(e) }]
              : t.parts,
          })),
        }));
      }
      return;
    }
    // Only the still-current turn owns the streaming flag (a superseded one must not).
    if (get().streaming && exec === currentExec) set({ streaming: false });
  }

  /** Persist the client-owned session (transcript + provider snapshot) to
   *  `internals/` after a turn completes. Best-effort; skipped if the project
   *  switched underneath us. */
  function persistCurrentSession(): void {
    const { projectId } = get();
    const ed = useEditor.getState();
    if (!projectId || !ed.store || ed.projectId !== projectId) return;
    // Non-blocking, coalesced, serialized (R10): the latest snapshot wins and a
    // burst of turn-completions can't land out of order. Failures are swallowed
    // inside the scheduler, so this never breaks the chat.
    persistSessionSoon(ed.store, {
      requests: buildRequests(get().turns),
      providerSnapshot: get().providerSnapshot,
      transcriptId: get().transcriptId ?? undefined,
      session: get().session,
    });
  }

  /** The timeline as it stands at the turn's terminal moment — the redo target.
   *  `redo` only calls replaceTimeline when this is set, so without it the turn
   *  flips back to not-undone while the timeline stays reverted: the UI claims
   *  the edits are back and they are not. Overwrites, because Continue -> Stop
   *  ends the same turn again with more edits than the first stop captured. */
  function stampTimelineAfter(): void {
    const { projectId } = get();
    const ed = useEditor.getState();
    if (!projectId || !ed.store || ed.projectId !== projectId) return;
    const after = ed.timeline ?? null;
    if (!after) return;
    set((s) => ({ turns: withLast(s.turns, (t) => ({ ...t, timelineAfter: after })) }));
  }

  /** EVERY terminal transition of a turn goes through here, not just `turn_done`.
   *  A turn's timeline edits are already durable via a separate path (applyOp ->
   *  saveTimeline), so a turn that ends without persisting leaves those edits with
   *  no transcript entry and no checkpoint to revert — which is exactly what a
   *  Stop, then a project switch, did: `load()` clears `turns` and refills from
   *  disk, so the unpersisted turn is gone while its 25 clips remain. */
  function finishTurn(updater: (s: ChatState) => Partial<ChatState>): void {
    // Only a turn that was actually in flight is ending; a stray Stop after one
    // finished must not re-stamp its redo target with the user's later edits.
    const last = get().turns.at(-1);
    const wasInFlight = last?.status === "streaming" || last?.status === "awaiting";
    set(updater);
    // A turn can end with nothing authoritative behind it (Stop mid-stream), which would
    // leave half a sentence on screen claiming to be the answer.
    set((s) => ({
      turns: withLast(s.turns, (t) => ({ ...t, parts: t.parts.filter((p) => !p.partial) })),
    }));
    if (wasInFlight) stampTimelineAfter();
    persistCurrentSession();
    // A background job that landed mid-turn waited for this moment. Deferred a tick because
    // delivering it starts a NEW turn, and doing that inside a set() would re-enter the store.
    queueMicrotask(syncJobSink);
  }

  return {
    projectId: null,
    transcriptId: null,
    execToken: null,
    turns: [],
    session: null,
    providerSnapshot: null,
    streaming: false,
    pending: null,
    canContinue: false,
    closing: false,
    error: null,
    model: "gpt-5.4-mini",
    effort: "high",
    mode: "default",
    pendingMentions: [],

    addMention: (m) =>
      set((s) =>
        s.pendingMentions.some((x) => mentionKey(x) === mentionKey(m))
          ? s
          : { pendingMentions: [...s.pendingMentions, m] },
      ),
    removeMention: (key) =>
      set((s) => ({ pendingMentions: s.pendingMentions.filter((m) => mentionKey(m) !== key) })),
    clearMentions: () => set({ pendingMentions: [] }),

    setControls: (p) => set(p),

    deactivate: () => {
      // Retire the active turn + reset to idle WITHOUT opening another project.
      // loadChat's supersede() only fires once a NEW project opens, so leaving to no
      // project (or to one whose open stalls/fails) would otherwise leave the old
      // hidden turn running paid calls + tools against its old host (R7-3).
      quiesceTurn(); // retire the turn (+ pending load) so it can't repopulate after we reset (R8-7).
      set({
        projectId: null,
        transcriptId: null,
        turns: [],
        session: null,
        pending: null,
        canContinue: false,
        streaming: false,
        closing: false,
        error: null,
        providerSnapshot: null,
        pendingMentions: [],
      });
    },

    quiesce: () => {
      // Retire the in-flight turn AND raise the admission fence, then NORMALIZE the aborted turn exactly
      // as Stop does — mark the streaming/awaiting turn done + reset provider continuity — so there's no
      // stuck spinner AND the next message rebuilds context from the transcript instead of the mid-turn
      // response chain the abort invalidated (findings #2/#4). No new turn can start after this point.
      quiesceTurn();
      finishTurn((s) => ({
        closing: true,
        streaming: false,
        pending: null,
        canContinue: false,
        providerSnapshot: null,
        turns: withLast(s.turns, (t) =>
          t.status === "streaming" || t.status === "awaiting" ? { ...t, status: "done" } : t,
        ),
      }));
    },

    resume: () => set({ closing: false }), // "Keep editing" lowers the fence; the retired turn stays gone
    whenQuiescent: () => whenOpsIdle(), // close SAVE awaits already-admitted undo/redo/restore (finding #2)

    load: async (projectId) => {
      const seq = ++loadSeq; // this activation's generation (distinguishes A->B->A)
      // Switching projects HARD-ABORTS any in-flight turn from the project we're
      // leaving (Copilot/Cursor-style): its exec is retired, so the stale runner
      // can't keep working and its late events/edits can't land here.
      supersede();
      set({
        projectId,
        transcriptId: null,
        turns: [],
        session: null,
        pending: null,
        canContinue: false,
        streaming: false,
        closing: false,
        error: null,
        providerSnapshot: null,
        pendingMentions: [],
      });
      const sess = await loadClientSession(projectId);
      if (loadSeq !== seq) return; // a newer switch superseded this load (even a same-id A->B->A, R6-3)
      const turns = mapRequests(sess.requests);
      set({
        turns,
        transcriptId: sess.transcriptId ?? crypto.randomUUID(),
        session: localSession(turns, get().mode, sess.session),
        providerSnapshot: sess.providerSnapshot,
      });
      // Deferred a tick: attaching delivers anything that finished while this project was
      // closed, and that starts a turn — which must not run inside load().
      queueMicrotask(syncJobSink);
    },

    send: async (text, attachments = [], opts) => {
      const { projectId, streaming, closing, turns, pendingMentions } = get();
      if (!projectId || streaming || closing || !text.trim()) return; // closing = admission fence (finding #2)
      const ed = useEditor.getState();
      const clientOwned = Boolean(ed.store) && ed.projectId === projectId;
      const mentions = pendingMentions;
      const turn: Turn = {
        id: crypto.randomUUID(),
        userText: text,
        attachments,
        ...(mentions.length ? { mentions } : {}),
        ...(opts?.system ? { system: true as const } : {}),
        parts: [],
        status: "streaming",
        checkpoint: clientOwned ? (ed.timeline ?? null) : null,
        undone: false,
      };
      set((s) => ({
        turns: [...s.turns, turn],
        pending: null,
        pendingMentions: [],
        streaming: true,
        error: null,
      }));
      // Persist BEFORE any tool can run. `checkpoint` is the timeline as it stands
      // right now, and it is the only way to revert what this turn is about to do —
      // waiting until the turn ends means a Stop or a project switch destroys the
      // record while the edits it made are already on disk.
      persistCurrentSession();
      // Client-owned loop: run the turn locally (rounds of /inference + local
      // tools), reusing `apply` for the UI. Abandon any awaiting/paused prior turn
      // first (a new message sent before approving supersedes it). NOTE: streaming
      // is set TRUE synchronously above so a SECOND send during the host warm-up
      // below is rejected by the guard at the top of send() -- otherwise it would
      // slip through (streaming was previously only set inside runTurn) and orphan
      // THIS turn as an eternal "streaming" spinner (RF8).
      supersede();
      const host = openToolHost(projectId);
      // Publish THIS turn's execution BEFORE awaiting the host warm-up, so a project
      // switch or a new message during the wait supersedes IT (retiring exec). If the
      // exec were created AFTER the await, a switch mid-warm-up would go unnoticed and
      // the turn would run against the abandoned project's still-bound host.
      const exec = newExec(host);
      try {
        await host.ready;
      } catch (e) {
        // The tool host failed to build (bad fs / context). openToolHost evicts the
        // broken host so a retry rebuilds it (not a permanently-rejected `ready`);
        // here we finish THIS turn as errored instead of leaving it streaming
        // forever (RF8). Only the still-current turn owns the shared UI state.
        if (exec === currentExec) {
          captureError(e, { phase: "host" });
          const msg = toUserMessage(e);
          finishTurn((s) => ({
            streaming: false,
            error: msg,
            turns: withLast(s.turns, (t) =>
              t.status === "streaming"
                ? { ...t, status: "error", parts: [...t.parts, { kind: "error", error: msg }] }
                : t,
            ),
          }));
        }
        return;
      }
      if (exec !== currentExec) return; // superseded during warm-up -> run nothing
      const base = { requests: buildRequests(turns) as unknown[] };
      // A previous turn that was stopped mid-batch still owes the provider an output for
      // every call it issued; hand that debt to this turn or the request is refused. The
      // runner only knows about THIS session, so the transcript covers the crash case.
      const owed = currentRunner?.takeUnsentResults() ?? [];
      const seen = new Set(owed.map((o) => o.call_id));
      const carried = [...owed, ...unansweredCalls(turns).filter((o) => !seen.has(o.call_id))];
      currentRunner = new ClientTurnRunner(buildLoopDeps(base, exec));
      await runTurn(exec, () =>
        currentRunner!.start(composeModelText(text, attachments, mentions), carried),
      );
    },

    resumeForJobs: async (jobs) => {
      const { projectId, streaming, closing } = get();
      if (!projectId || streaming || closing || !jobs.length) return;
      await get().send(jobWakePrompt(jobs), [], { system: true });
    },

    approve: async (callId) => {
      const { projectId, pending, closing } = get();
      if (!projectId || !pending?.length || closing || !currentRunner || !currentExec) return;
      const id = callId ?? pending[0].call_id;
      // Only THIS call leaves the bar; the rest stay up until they are answered too.
      const rest = pending.filter((p) => p.call_id !== id);
      set((s) => ({
        pending: rest,
        turns: rest.length ? s.turns : withLast(s.turns, (t) => ({ ...t, status: "streaming" })),
      }));
      rearm(currentExec);
      await runTurn(currentExec, () => currentRunner!.approve(id));
    },

    deny: async (reason = "user denied this tool call", callId) => {
      const { projectId, pending, closing } = get();
      if (!projectId || !pending?.length || closing || !currentRunner || !currentExec) return;
      const id = callId ?? pending[0].call_id;
      const rest = pending.filter((p) => p.call_id !== id);
      set((s) => ({
        pending: rest,
        turns: rest.length ? s.turns : withLast(s.turns, (t) => ({ ...t, status: "streaming" })),
      }));
      rearm(currentExec);
      await runTurn(currentExec, () => currentRunner!.deny(reason, id));
    },

    undo: async () => {
      if (get().closing) return; // admission fence: no new op once close begins
      return trackOp(async () => {
        const { projectId, turns } = get();
        if (!projectId) return;
        const ed = useEditor.getState();
        if (!ed.store || ed.projectId !== projectId) return; // no client store -> nothing to undo
        let i = -1;
        for (let k = turns.length - 1; k >= 0; k--)
          if (!turns[k].undone) {
            i = k;
            break;
          }
        if (i < 0) return;
        const next = turns.map((t, k) => (k === i ? { ...t, undone: true } : t));
        const cp = next[i].checkpoint;
        if (cp) {
          if (!(await replaceTimeline(ed.store, cp))) return; // project closed mid-restore: leave chat state untouched
          await ed.reload();
        }
        // Reset provider continuity so the next turn rebuilds context from the
        // (now shorter) transcript instead of the stale response chain.
        set((s) => ({
          turns: next,
          providerSnapshot: null,
          session: s.session ? { ...s.session, ...undoFlags(next) } : s.session,
        }));
        const store = ed.store;
        await withProjectLock(store.projectDir, () =>
          persistSession(store, { requests: buildRequests(next), providerSnapshot: null }),
        );
      });
    },

    redo: async () => {
      if (get().closing) return; // admission fence
      return trackOp(async () => {
        const { projectId, turns } = get();
        if (!projectId) return;
        const ed = useEditor.getState();
        if (!ed.store || ed.projectId !== projectId) return; // no client store -> nothing to redo
        let i = -1;
        for (let k = turns.length - 1; k >= 0; k--) {
          if (turns[k].undone) i = k;
          else break;
        }
        if (i < 0) return;
        const next = turns.map((t, k) => (k === i ? { ...t, undone: false } : t));
        const ta = next[i].timelineAfter;
        if (ta) {
          if (!(await replaceTimeline(ed.store, ta))) return; // project closed mid-restore: leave chat state untouched
          await ed.reload();
        }
        set((s) => ({
          turns: next,
          session: s.session ? { ...s.session, ...undoFlags(next) } : s.session,
        }));
        const store = ed.store;
        await withProjectLock(store.projectDir, () =>
          persistSession(store, {
            requests: buildRequests(next),
            providerSnapshot: get().providerSnapshot,
          }),
        );
      });
    },

    // Copilot-style "Restore Checkpoint": roll the timeline back to BEFORE this
    // turn, mark it + every later turn undone (a suffix, matching the linear undo
    // model) so the view drops them, and hand the prompt back to the composer.
    // Resets provider continuity so the next message rebuilds from the shortened
    // transcript instead of a stale response chain.
    restoreTo: async (turnId) => {
      if (get().streaming || get().closing) return null; // admission fence + no restore mid-stream
      return trackOp(async () => {
        const { projectId, turns } = get();
        if (!projectId) return null;
        const ed = useEditor.getState();
        if (!ed.store || ed.projectId !== projectId) return null; // no client store -> nothing to restore
        const i = turns.findIndex((t) => t.id === turnId);
        if (i < 0) return null;
        const next = turns.map((t, k) => (k >= i ? { ...t, undone: true } : t));
        const cp = turns[i].checkpoint;
        if (cp) {
          if (!(await replaceTimeline(ed.store, cp))) return null; // project closed mid-restore: leave chat state untouched
          await ed.reload();
        }
        set((s) => ({
          turns: next,
          providerSnapshot: null,
          session: s.session ? { ...s.session, ...undoFlags(next) } : s.session,
        }));
        const store = ed.store;
        await withProjectLock(store.projectDir, () =>
          persistSession(store, { requests: buildRequests(next), providerSnapshot: null }),
        );
        return { text: turns[i].userText, attachments: turns[i].attachments };
      });
    },

    stop: async () => {
      if (!currentRunner || !currentExec) return;
      currentExec.stopped = true; // end the auto loop at the next gate (a client tool finishes first)
      currentExec.controller.abort(); // cancel the in-flight /inference or server tool NOW
      // Reflect the stop immediately — don't wait for the aborted fetch to unwind.
      // Reset provider continuity: a mid-turn abort leaves the response chain
      // (Azure previous_response_id) expecting tool outputs, so the NEXT message
      // must rebuild context from the transcript instead of resuming a broken
      // chain (otherwise the model restarts and loses the conversation).
      finishTurn((s) => ({
        streaming: false,
        pending: null,
        canContinue: false,
        providerSnapshot: null,
        turns: withLast(s.turns, (t) =>
          t.status === "streaming" || t.status === "awaiting" ? { ...t, status: "done" } : t,
        ),
      }));
    },

    continueRun: async () => {
      const { projectId, streaming, closing } = get();
      if (!projectId || streaming || closing || !currentRunner || !currentExec) return;
      set((s) => ({
        canContinue: false,
        turns: withLast(s.turns, (t) => ({ ...t, status: "streaming" })),
      }));
      rearm(currentExec);
      await runTurn(currentExec, () => currentRunner!.continueRun());
    },

    refreshState: async () => {
      const { projectId } = get();
      if (!projectId) return;
      set((s) => ({ session: localSession(s.turns, s.mode, s.session) }));
    },

    // Opt-in diagnostic feedback (thumbs up/down or "report a problem"): bundle
    // the transcript + live timeline + project manifests (no media) and upload
    // it keyed by transcript_id. Best-effort — returns whether it was stored.
    sendFeedback: async (kind, opts = {}) => {
      const { projectId, transcriptId, turns } = get();
      if (!projectId) return false;
      const ed = useEditor.getState();
      const store = ed.store && ed.projectId === projectId ? ed.store : null;
      const bundle = await buildFeedbackBundle(store, buildRequests(turns), ed.timeline ?? null);
      return submitFeedback({
        kind,
        transcript_id: transcriptId ?? undefined,
        project_id: projectId,
        note: opts.note,
        request_id: opts.requestId,
        bundle,
      });
    },
  };
};

// ---- Per-project instance registry + active-project view (see editor.ts) ----
// One chat store instance per open project. Each instance owns its own set/get (and
// its own turn runner + loadSeq), so an undo/redo/restore whose awaits span a project
// switch lands on the project it STARTED in -- never the now-active one. That is the
// cross-project chat corruption this refactor closes structurally: the stale op's
// set() reaches its own (now-background) instance, not the foreground project. A
// stable switchboard mirrors the active instance so the UI tracks the frontmost
// project; with none bound (unit tests) it is a standalone store = the old singleton.
const chatStores = new Map<string, StoreApi<ChatState>>();

/** Get (or lazily create) the chat store instance bound to `projectId`. */
export function getChatStore(projectId: string): StoreApi<ChatState> {
  let s = chatStores.get(projectId);
  if (!s) {
    s = createStore<ChatState>(chatCreator);
    chatStores.set(projectId, s);
  }
  return s;
}

/** Drop a project's chat store instance: retire its turn (stops any in-flight
 *  paid calls + tools) and remove it from the registry. */
export function disposeChatStore(projectId: string): void {
  const s = chatStores.get(projectId);
  if (!s) return;
  s.getState().deactivate();
  chatStores.delete(projectId);
}

/** Is `origin` the CURRENT chat execution for `projectId`? The document's mutation-gate origin fence
 *  uses this: a commit carrying a superseded/retired execution's origin is rejected. Matches BOTH the
 *  transcript id (chatSessionId) and the live execution token; an unknown project (no chat instance)
 *  is not current. Manual editor edits carry no origin, so they are never subject to this check. */
export function isChatExecutionCurrent(projectId: string, origin: MutationOrigin): boolean {
  const s = chatStores.get(projectId)?.getState();
  if (!s) return false;
  return origin.chatSessionId === s.transcriptId && origin.executionId === s.execToken;
}

// ---- The active-project pointer ("frontmost document") — see editor.ts -------
// Holds ONLY the active project id; the UI resolves the ACTUAL chat instance from the
// registry (getChatStore) and reads it directly, so there is no writable state mirror.
// The tiny id store makes the resolution reactive; with no project active (unit tests)
// reads fall back to a standalone empty store.
const activeChatId = createStore<{ id: string | null }>(() => ({ id: null }));
const defaultChatStore = createStore<ChatState>(chatCreator);

function activeChatStore(): StoreApi<ChatState> {
  const id = activeChatId.getState().id;
  return id ? getChatStore(id) : defaultChatStore;
}

/** Point the UI at project `id`'s chat instance (or clear it). */
function setActiveChat(id: string | null): void {
  activeChatId.setState({ id });
}

interface ChatHook {
  (): ChatState;
  <T>(selector: (s: ChatState) => T): T;
  getState: () => ChatState;
  setState: StoreApi<ChatState>["setState"];
}
function chatHookImpl<T>(selector?: (s: ChatState) => T): T | ChatState {
  const id = useStore(activeChatId, (s) => s.id);
  return useStore(
    id ? getChatStore(id) : defaultChatStore,
    (selector ?? ((s: ChatState) => s)) as (s: ChatState) => T,
  );
}
/** The active-project chat view: `useChat(sel)` subscribes reactively;
 *  `useChat.getState()/.setState()` read/write the ACTUAL active instance (not a mirror). */
export const useChat = Object.assign(chatHookImpl, {
  getState: (): ChatState => activeChatStore().getState(),
  setState: ((...args: Parameters<StoreApi<ChatState>["setState"]>) =>
    (activeChatStore().setState as (...a: Parameters<StoreApi<ChatState>["setState"]>) => void)(
      ...args,
    )) as StoreApi<ChatState>["setState"],
}) as unknown as ChatHook;

/** Make `projectId` the active project: point the view at its instance and load its
 *  client-owned session (transcript + provider snapshot). */
export function activateChatProject(projectId: string): Promise<void> {
  setActiveChat(projectId);
  return getChatStore(projectId).getState().load(projectId);
}

/** Leave `projectId`: clear the active-project pointer and dispose its instance
 *  (retiring any in-flight turn so it can't keep running paid calls + tools). */
export function deactivateChatProject(projectId: string | null): void {
  setActiveChat(null);
  if (projectId) disposeChatStore(projectId);
}

/** Stop project `projectId`'s transcript producers (retire the in-flight turn) WITHOUT resetting its
 *  chat state — the close SAVE phase calls this BEFORE {@link saveProjectSessionNow} so the final
 *  snapshot is written with no turn still able to enqueue a newer/older one (finding #1). No-op if the
 *  project has no live chat instance. */
export function quiesceChatProject(projectId: string): void {
  chatStores.get(projectId)?.getState().quiesce();
}

/** Lower project `projectId`'s admission fence (return to editing after a CANCELLED close) so chat
 *  mutations are admitted again. Called from the document's cancelClose. No-op if there's no instance. */
export function resumeChatProject(projectId: string): void {
  chatStores.get(projectId)?.getState().resume();
}

/** Resolve once project `projectId`'s already-admitted non-turn ops (undo/redo/restore) have completed.
 *  The document close SAVE awaits this AFTER the fence is raised, so an in-flight op lands IN FULL
 *  before the final transcript snapshot (finding #2). Immediate when there's no instance / nothing in
 *  flight. */
export function whenChatQuiescent(projectId: string): Promise<void> {
  return chatStores.get(projectId)?.getState().whenQuiescent() ?? Promise.resolve();
}

/** Persist project `projectId`'s chat transcript NOW through the ordered, failure-reporting queue and
 *  report success — the document close SAVE phase uses this so a transcript write failure is SURFACED,
 *  not swallowed. Reads the CURRENT chat state (a retry re-persists the latest). Callers MUST
 *  {@link quiesceChatProject} first so no producer can enqueue a snapshot after this one. Returns true
 *  when there is nothing to persist (no chat instance, or the editor already switched away). */
export async function saveProjectSessionNow(projectId: string): Promise<boolean> {
  const s = chatStores.get(projectId)?.getState();
  const ed = useEditor.getState();
  if (!s || !ed.store || ed.projectId !== projectId) return true;
  const session = {
    requests: buildRequests(s.turns),
    providerSnapshot: s.providerSnapshot,
    transcriptId: s.transcriptId ?? undefined,
    session: s.session,
  };
  // Route through the SAME ordered queue as fire-and-forget writes (latest-wins), so a still-pending
  // older snapshot can't clobber this final one; the returned boolean reports real disk durability.
  return persistSessionNow(ed.store, session);
}
