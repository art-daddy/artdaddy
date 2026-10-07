import { describe, expect, it, vi } from "vitest";

import {
  ClientTurnRunner,
  CONTINUE_CAPS,
  needsApproval,
  type ApprovalMode,
  type LoopDeps,
} from "./loop";
import type { InferenceAttachment, RoundInput, RoundResultDTO } from "./types";

function rr(over: Partial<RoundResultDTO>): RoundResultDTO {
  return {
    kind: "text",
    pending_calls: [],
    final_text: "",
    error: "",
    finish_reason: "",
    usage: {},
    provider_snapshot: {},
    ...over,
  };
}

function toolCall(
  name: string,
  call_id = "c1",
  args: Record<string, unknown> = {},
): RoundResultDTO {
  return rr({ kind: "tool_calls", pending_calls: [{ call_id, name, arguments: args }] });
}

function harness(
  rounds: RoundResultDTO[],
  opts: { mode?: ApprovalMode; noteForRound?: LoopDeps["noteForRound"] } = {},
) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let mode: ApprovalMode = opts.mode ?? "default";
  let stopped = false;
  const infer = vi.fn(
    async (_ri: RoundInput, _atts?: InferenceAttachment[]) =>
      rounds.shift() ?? rr({ kind: "text", final_text: "done" }),
  );
  const runTool = vi.fn(async (name: string): Promise<Record<string, unknown>> => ({
    ok: true,
    ran: name,
  }));
  const collectAttachments = vi.fn(
    async () => [{ kind: "image", b64: "AA==" }] as InferenceAttachment[],
  );
  const deps: LoopDeps = {
    infer,
    runTool,
    collectAttachments,
    emit: (event, data) => events.push({ event, data }),
    mode: () => mode,
    stopped: () => stopped,
    onUsage: vi.fn(),
    session: () => ({ cost_usd: 0.01 }),
    noteForRound: opts.noteForRound,
  };
  return {
    runner: new ClientTurnRunner(deps),
    events,
    infer,
    runTool,
    names: () => events.map((e) => e.event),
    setMode: (m: ApprovalMode) => (mode = m),
    setStopped: (s: boolean) => (stopped = s),
  };
}

describe("ClientTurnRunner", () => {
  it("default auto-runs an ordinary (reversible) tool then finishes", async () => {
    const h = harness([toolCall("get_timeline"), rr({ kind: "text", final_text: "done" })]);
    await h.runner.start("hi");
    expect(h.names()).toEqual(["turn_start", "tool_call", "tool_result", "text", "turn_done"]);
    expect(h.runTool).toHaveBeenCalledWith("get_timeline", {});
    expect(h.infer).toHaveBeenCalledTimes(2);
  });

  it("scrubs an absolute path out of a tool result before the model sees it (Step 9)", async () => {
    const h = harness([toolCall("get_timeline"), rr({ kind: "text", final_text: "done" })]);
    // The tool returns a linked clip whose `path` is the user's ABSOLUTE source path.
    h.runTool.mockResolvedValueOnce({
      ok: true,
      media_ref: "media_abc",
      path: "D:/private/footage/hero.mp4",
    });
    await h.runner.start("go");
    const res = h.events.find((e) => e.event === "tool_result");
    expect(res?.data.path).toBe("hero.mp4"); // absolute path scrubbed to its basename
    expect(res?.data.media_ref).toBe("media_abc"); // the ref the model actually uses is untouched
  });

  it("default gates a PAID call; approve resumes to final", async () => {
    const h = harness([toolCall("generate_image"), rr({ kind: "text", final_text: "ok" })], {
      mode: "default",
    });
    await h.runner.start("hi");
    expect(h.names()).toEqual(["turn_start", "awaiting_approval", "turn_paused"]);
    expect(h.runner.pending?.name).toBe("generate_image");
    await h.runner.approve();
    expect(h.names().slice(3)).toEqual(["tool_call", "tool_result", "text", "turn_done"]);
  });

  it("default gates every paid / external / destructive call, and NOTHING else", async () => {
    // Table-driven over the real policy so adding a tool to a gated set can't
    // silently skip its test, and a free read can't drift into the gate.
    const gated = [
      "generate_image",
      "generate_video",
      "generate_voiceover",
      "generate_music",
      "video_ask",
      "video_find_moment",
      "image_ask",
      "vision_describe",
      "find_content",
      "download_video",
    ];
    for (const name of gated) expect(needsApproval(name)).toBe(true);
    expect(needsApproval("library_op", { action: "delete" })).toBe(true);

    // The failure direction: free reads and reversible edits must NOT be gated,
    // or default mode turns into a click-fest.
    const free = [
      "get_timeline",
      "get_transcript",
      "inspect_media",
      "probe_media",
      "add_clips",
      "split_clips",
      "remove_clips",
      "ripple_delete",
      "undo",
      "export",
    ];
    for (const name of free) expect(needsApproval(name)).toBe(false);
    expect(needsApproval("library_op", { action: "update" })).toBe(false);
  });

  it("default pauses on a paid vision read; autopilot runs it", async () => {
    const gatedRun = harness([toolCall("video_find_moment")]);
    await gatedRun.runner.start("find the sunset");
    expect(gatedRun.names()).toEqual(["turn_start", "awaiting_approval", "turn_paused"]);
    expect(gatedRun.runTool).not.toHaveBeenCalled();

    const autoRun = harness(
      [toolCall("video_find_moment"), rr({ kind: "text", final_text: "ok" })],
      {
        mode: "autopilot",
      },
    );
    await autoRun.runner.start("find the sunset");
    expect(autoRun.names()).not.toContain("awaiting_approval");
    expect(autoRun.runTool).toHaveBeenCalledWith("video_find_moment", {});
  });

  it("default gates a DESTRUCTIVE library delete", async () => {
    const h = harness([toolCall("library_op", "c1", { action: "delete", id: "media_1" })]);
    await h.runner.start("drop that clip");
    expect(h.names()).toEqual(["turn_start", "awaiting_approval", "turn_paused"]);
    expect(h.runTool).not.toHaveBeenCalled();
  });

  it("default AUTO-RUNS a non-delete library_op (the gate is per-ARGUMENT, not per-tool)", async () => {
    // The failure direction: gating `library_op` by NAME would wrongly stop an
    // ordinary rename/update and make default mode unusable.
    const h = harness([
      toolCall("library_op", "c1", { action: "update", id: "media_1", notes: "hero" }),
      rr({ kind: "text", final_text: "renamed" }),
    ]);
    await h.runner.start("rename it");
    expect(h.names()).toEqual(["turn_start", "tool_call", "tool_result", "text", "turn_done"]);
  });

  it("autopilot runs paid and destructive calls without asking", async () => {
    const h = harness(
      [
        toolCall("generate_image", "a"),
        toolCall("library_op", "b", { action: "delete", id: "media_1" }),
        rr({ kind: "text", final_text: "done" }),
      ],
      { mode: "autopilot" },
    );
    await h.runner.start("go wild");
    expect(h.names()).not.toContain("awaiting_approval");
    expect(h.runTool).toHaveBeenCalledTimes(2);
  });

  it("deny records the denial then continues to final", async () => {
    const h = harness([toolCall("generate_image"), rr({ kind: "text", final_text: "ok fine" })], {
      mode: "default",
    });
    await h.runner.start("x");
    await h.runner.deny("no");
    const results = h.events.filter((e) => e.event === "tool_result");
    expect(results[0].data.ok).toBe(false);
    expect(results[0].data.error).toBe("no");
    expect(h.names().slice(-1)).toEqual(["turn_done"]);
    expect(h.runTool).not.toHaveBeenCalled();
  });

  // A tool result is recorded under an ENVELOPE that says which call it answers. Spread the wrong
  // way round, a result carrying its own `name`/`kind` overwrote that envelope: `get_project_state`
  // was recorded as `name: "Odyssey II"`, and every inspect_media / generate_video result stopped
  // being a tool_result at all — 49 of one session's 164 calls had no recorded result, which is
  // also what made the eval judge score truthful messages as fabrications.
  it("a result carrying its own name/kind cannot overwrite the call it answers", async () => {
    const h = harness([toolCall("get_project_state"), rr({ kind: "text", final_text: "done" })], {
      mode: "autopilot",
    });
    h.runTool.mockResolvedValue({ ok: true, name: "Odyssey II", kind: "video", id: "p1" });
    await h.runner.start("x");
    const tr = h.events.find((e) => e.event === "tool_result")!;
    expect(tr.data.name).toBe("get_project_state"); // the CALL, not the project
    expect(tr.data.kind).toBe("video"); // the payload still travels
    expect(tr.data.id).toBe("p1");
  });

  it("runs a parallel batch, flushing all results in one round", async () => {
    const h = harness([
      rr({
        kind: "tool_calls",
        pending_calls: [
          { call_id: "a", name: "get_timeline", arguments: {} },
          { call_id: "b", name: "inspect_media", arguments: {} },
        ],
      }),
      rr({ kind: "text", final_text: "done" }),
    ]);
    await h.runner.start("hi");
    expect(h.runTool).toHaveBeenCalledTimes(2);
    const flush = h.infer.mock.calls[1][0];
    expect((flush.tool_results ?? []).map((t) => t.call_id)).toEqual(["a", "b"]);
  });

  // Sentry, /inference 400: "No tool output found for function call call_Aebtku…".
  // The provider keeps the conversation on ITS side and refuses the next request until
  // every function_call it issued has exactly one output. Stop abandons the batch, so the
  // next message used to arrive with the call still unanswered and the chat was stuck.
  it("carries the outputs owed by a stopped turn into the next message", async () => {
    const h = harness([
      rr({
        kind: "tool_calls",
        pending_calls: [
          { call_id: "call_A", name: "get_timeline", arguments: {} },
          { call_id: "call_B", name: "add_track", arguments: {} },
        ],
      }),
    ]);
    h.setStopped(true);
    await h.runner.start("do a thing");

    // Nothing ran, and the turn ended — but the provider is still owed two outputs.
    const owed = h.runner.takeUnsentResults();
    expect(owed.map((o) => o.call_id)).toEqual(["call_A", "call_B"]);
    expect(owed.every((o) => (o.result as { ok?: boolean }).ok === false)).toBe(true);

    // The next turn must answer them, and carry the user's message alongside.
    const next = harness([rr({ kind: "text", final_text: "ok" })]);
    await next.runner.start("never mind, do this instead", owed);
    const sent = next.infer.mock.calls[0][0];
    expect((sent.tool_results ?? []).map((t) => t.call_id)).toEqual(["call_A", "call_B"]);
    // user_text is ignored by a round that carries tool results, so it rides as an extra.
    expect(sent.extra_texts).toEqual(["never mind, do this instead"]);
    expect(sent.user_text).toBeUndefined();
  });

  it("takes the debt once — a second take is empty, so nothing is answered twice", async () => {
    const h = harness([toolCall("delete_project", "call_C")]);
    h.setStopped(true);
    await h.runner.start("go");
    expect(h.runner.takeUnsentResults()).toHaveLength(1);
    expect(h.runner.takeUnsentResults()).toEqual([]);
  });

  // The failure direction: an ordinary turn owes nothing, and must not have its shape
  // changed — carrying phantom results would break the normal path.
  it("owes nothing when every call was answered", async () => {
    const h = harness([toolCall("get_timeline", "c1"), rr({ kind: "text", final_text: "done" })]);
    await h.runner.start("hi");
    expect(h.runner.takeUnsentResults()).toEqual([]);
    expect(h.infer.mock.calls[0][0]).toEqual({ user_text: "hi" });
  });

  it("a denied call is already answered, so it is not owed again", async () => {
    const h = harness([toolCall("delete_project", "call_D")]);
    await h.runner.start("delete it");
    await h.runner.deny();
    expect(h.runner.takeUnsentResults()).toEqual([]);
  });

  it("pauses at the continue-cap and resumes on continueRun", async () => {
    const cap = CONTINUE_CAPS.autopilot;
    const rounds = Array.from({ length: cap + 5 }, () => toolCall("get_timeline", "c"));
    const h = harness(rounds, { mode: "autopilot" });
    await h.runner.start("go");
    const paused = h.events.filter((e) => e.event === "turn_paused");
    expect(paused.at(-1)?.data.can_continue).toBe(true);
    expect(h.runTool).toHaveBeenCalledTimes(cap);
    await h.runner.continueRun();
    expect(h.runTool.mock.calls.length).toBeGreaterThan(cap);
  });

  it("default checks in EARLIER than autopilot (its cap is lower)", async () => {
    expect(CONTINUE_CAPS.default).toBeLessThan(CONTINUE_CAPS.autopilot);
    const cap = CONTINUE_CAPS.default;
    const rounds = Array.from({ length: cap + 5 }, () => toolCall("get_timeline", "c"));
    const h = harness(rounds, { mode: "default" });
    await h.runner.start("go");
    expect(h.runTool).toHaveBeenCalledTimes(cap);
    expect(h.events.filter((e) => e.event === "turn_paused").at(-1)?.data.can_continue).toBe(true);
  });

  it("checks in after 40 steps (80 on autopilot) -- the owner's 2026-10-02 decision", () => {
    expect(CONTINUE_CAPS).toEqual({ default: 40, autopilot: 80 });
  });

  it("never pauses inside a batch: one that crosses the cap finishes, then the pause comes before the next round", async () => {
    // UJ-008: the pause fell inside a 30-call batch, the unrun calls were never answered,
    // and the next request was refused. Now every call of a batch runs and is answered.
    const batch = (n: number, tag: string) =>
      rr({
        kind: "tool_calls",
        pending_calls: Array.from({ length: n }, (_, i) => ({
          call_id: `${tag}${i}`,
          name: "set_transition",
          arguments: {},
        })),
      });
    const h = harness([batch(30, "a"), batch(15, "b"), rr({ kind: "text", final_text: "done" })]);
    await h.runner.start("crossfade everything");
    expect(h.runTool).toHaveBeenCalledTimes(45); // the batch that crossed 40 ran to the end
    expect(h.events.filter((e) => e.event === "turn_paused").at(-1)?.data.can_continue).toBe(true);
    expect(h.infer).toHaveBeenCalledTimes(2); // ...and the next round waits for Continue
    expect(h.runner.takeUnsentResults().map((r) => r.call_id)).toHaveLength(15); // all answered, none "not run"
  });

  it("Continue sends the paused batch's results", async () => {
    const batch = rr({
      kind: "tool_calls",
      pending_calls: Array.from({ length: CONTINUE_CAPS.default }, (_, i) => ({
        call_id: `a${i}`,
        name: "get_timeline",
        arguments: {},
      })),
    });
    const h = harness([batch, rr({ kind: "text", final_text: "done" })]);
    await h.runner.start("go");
    expect(h.infer).toHaveBeenCalledTimes(1);
    await h.runner.continueRun();
    expect(h.infer).toHaveBeenCalledTimes(2);
    expect((h.infer.mock.calls[1][0] as RoundInput).tool_results).toHaveLength(
      CONTINUE_CAPS.default,
    );
    expect(h.names().at(-1)).toBe("turn_done");
  });

  it("a round the server refused still owes its results", async () => {
    // UJ-008: a 413 or a network error dropped the results it carried; the chained path then
    // had nothing to answer those calls with on the next message.
    const h = harness([toolCall("get_timeline", "c1")]);
    h.infer.mockImplementationOnce(async () => toolCall("get_timeline", "c1"));
    h.infer.mockImplementationOnce(async () => {
      throw new Error("413: request too large");
    });
    await expect(h.runner.start("go")).rejects.toThrow("413");
    expect(h.runner.takeUnsentResults().map((r) => r.call_id)).toEqual(["c1"]);
  });

  it("emits an error round", async () => {
    const h = harness([rr({ kind: "error", error: "boom" })]);
    await h.runner.start("x");
    expect(h.names()).toEqual(["turn_start", "error"]);
    expect(h.events[1].data.error).toBe("boom");
  });

  it("stop ends the turn cleanly (no approval gate) even when auto-approving", async () => {
    const h = harness([toolCall("get_timeline")]);
    h.setStopped(true);
    await h.runner.start("hi");
    expect(h.names()).toEqual(["turn_start", "turn_done"]);
  });

  it("a thrown tool becomes a clean error result", async () => {
    const h = harness([toolCall("get_timeline"), rr({ kind: "text", final_text: "recovered" })]);
    h.runTool.mockRejectedValueOnce(new Error("ffmpeg missing"));
    await h.runner.start("hi");
    const tr = h.events.find((e) => e.event === "tool_result");
    expect(tr?.data.ok).toBe(false);
    expect(String(tr?.data.error)).toContain("ffmpeg missing");
    expect(h.names().at(-1)).toBe("turn_done");
  });

  it("drains a tool's _attachments into the next round", async () => {
    const h = harness([toolCall("inspect_media"), rr({ kind: "text", final_text: "seen" })]);
    h.runTool.mockResolvedValueOnce({
      ok: true,
      _attachments: [{ path: "library/x.png", kind: "image" }],
    });
    await h.runner.start("look at this");
    const tr = h.events.find((e) => e.event === "tool_result");
    expect(tr?.data._attachments).toBeUndefined(); // stripped before the model sees it
    expect(h.infer.mock.calls[1][1]).toEqual([{ kind: "image", b64: "AA==" }]); // rode the next round
  });
});

// Client-owned history (Phase 1, option A): the server rebuilds the model's input from the
// transcript every round, so the transcript must carry exactly what the model saw.
describe("ClientTurnRunner records what the model saw", () => {
  it("keeps the exact result under model_result, even fields the envelope would overwrite", async () => {
    const h = harness([toolCall("get_project_state"), rr({ kind: "text", final_text: "ok" })]);
    h.runTool.mockResolvedValueOnce({ ok: true, name: "Odyssey II", kind: "image" });
    await h.runner.start("state?");
    const tr = h.events.find((e) => e.event === "tool_result")!;
    expect(tr.data.model_result).toEqual({ ok: true, name: "Odyssey II", kind: "image" });
    // The model was sent that same object.
    const sent = (h.infer.mock.calls[1][0] as RoundInput).tool_results![0].result;
    expect(sent).toEqual(tr.data.model_result);
  });

  it("keeps a reference to each image a result showed, in order, and nothing else", async () => {
    const h = harness([toolCall("inspect_media"), rr({ kind: "text", final_text: "seen" })]);
    h.runTool.mockResolvedValueOnce({
      ok: true,
      _attachments: [
        { path: "internals/cache/inspect/a.jpg", kind: "image", caption: "@1s" },
        { path: "internals/cache/inspect/clip.mp4", kind: "video" },
        { path: "internals/cache/inspect/b.jpg", kind: "image", caption: "@2s" },
      ],
    });
    await h.runner.start("look");
    const tr = h.events.find((e) => e.event === "tool_result")!;
    expect(tr.data.frame_refs).toEqual([
      { path: "internals/cache/inspect/a.jpg", caption: "@1s" },
      { path: "internals/cache/inspect/b.jpg", caption: "@2s" },
    ]);
    expect((tr.data.model_result as Record<string, unknown>)._attachments).toBeUndefined();
  });

  it("stores the round's encrypted reasoning BEFORE its calls, and marks every call with its round", async () => {
    const h = harness([
      rr({
        kind: "tool_calls",
        pending_calls: [
          { call_id: "a", name: "get_timeline", arguments: {}, rationale: "Let me look." },
          { call_id: "b", name: "get_project_state", arguments: {} },
        ],
        reasoning_items: [{ id: "rs_1", encrypted_content: "ENC" }],
      }),
      rr({
        kind: "text",
        final_text: "done",
        reasoning_items: [{ id: "rs_2", encrypted_content: "ENC2" }],
      }),
    ]);
    await h.runner.start("hi");
    const seq = h.events.filter((e) => e.event !== "turn_start" && e.event !== "turn_done");
    expect(seq.map((e) => e.event)).toEqual([
      "reasoning_item",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "reasoning_item",
      "text",
    ]);
    const [r1, ca, cb] = seq;
    expect(r1.data).toMatchObject({ id: "rs_1", encrypted_content: "ENC" });
    expect(ca.data.round).toBe(r1.data.round);
    expect(cb.data.round).toBe(r1.data.round);
    expect(ca.data.rationale).toBe("Let me look.");
    expect(cb.data.rationale).toBeUndefined();
    // The next round is a different round.
    expect(seq[5].data.round).not.toBe(r1.data.round);
  });

  it("a refused call is recorded like any other result", async () => {
    const h = harness([toolCall("generate_video", "g1"), rr({ kind: "text", final_text: "ok" })]);
    await h.runner.start("make a video");
    await h.runner.deny("too expensive", "g1");
    const tr = h.events.find((e) => e.event === "tool_result")!;
    expect(tr.data.model_result).toEqual({ ok: false, error: "too expensive" });
    expect(h.events.find((e) => e.event === "tool_call")!.data.round).toEqual(expect.any(Number));
  });
});

// UJ-028: the app's note about an outside timeline change rides INSIDE a tool output (a user
// message there would cost the model its reasoning), in the round about to be sent.
describe("ClientTurnRunner round notes", () => {
  const NOTE = { timeline_note: "changed outside" };
  const twoCalls = rr({
    kind: "tool_calls",
    pending_calls: [
      { call_id: "a", name: "get_timeline", arguments: {} },
      { call_id: "b", name: "add_track", arguments: {} },
    ],
  });

  it("merges the note into the LAST output of the round it sends, and records the same bytes", async () => {
    const noteForRound = vi.fn((): Record<string, string> | null => NOTE);
    const h = harness([twoCalls, rr({ kind: "text", final_text: "done" })], { noteForRound });
    await h.runner.start("go");
    expect(noteForRound).toHaveBeenCalledTimes(1); // asked for the tool round, not the first one
    const sent = h.infer.mock.calls[1][0].tool_results ?? [];
    expect(sent.map((t) => t.call_id)).toEqual(["a", "b"]);
    expect(sent[0].result).not.toHaveProperty("timeline_note");
    expect(sent[1].result).toMatchObject({ ok: true, ran: "add_track", ...NOTE });
    const recorded = h.events.find((e) => e.event === "tool_result_note")!;
    expect(recorded.data).toEqual({ call_id: "b", model_result: sent[1].result });
  });

  it("leaves a round alone when there is nothing to say", async () => {
    const h = harness([twoCalls, rr({ kind: "text", final_text: "done" })], {
      noteForRound: () => null,
    });
    await h.runner.start("go");
    const sent = h.infer.mock.calls[1][0].tool_results ?? [];
    expect(sent.every((t) => !("timeline_note" in t.result))).toBe(true);
    expect(h.names()).not.toContain("tool_result_note");
  });

  it("asks when a paused round is finally sent, so an edit made during the pause reaches it", async () => {
    let edited = false;
    const cap = CONTINUE_CAPS.default;
    const rounds = Array.from({ length: cap + 1 }, () => toolCall("get_timeline", "c"));
    const h = harness(rounds, { noteForRound: () => (edited ? NOTE : null) });
    await h.runner.start("go");
    const before = h.infer.mock.calls.length;
    edited = true; // the user edits the timeline while "Continue?" is up
    await h.runner.continueRun();
    const resumed = h.infer.mock.calls[before][0].tool_results ?? [];
    expect(resumed.at(-1)?.result).toMatchObject(NOTE);
  });
});
