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

function harness(rounds: RoundResultDTO[], opts: { mode?: ApprovalMode } = {}) {
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
