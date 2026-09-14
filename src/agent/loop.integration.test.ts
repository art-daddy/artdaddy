// Integration test: the REAL ClientTurnRunner driving the REAL tool registry ->
// applyOp -> store, with only the provider (`infer`) mocked (canned rounds). This
// catches wiring bugs across loop <-> registry <-> applyOp <-> store that the
// per-module unit tests (loop.test.ts mocks runTool) can't see.
import { describe, expect, it, afterEach } from "vitest";

import { seededCtx, videoRunner } from "../test/timelineKit";
import { loadTimeline } from "../timeline/engine";
import { __resetExportQueue, whenExportsSettle } from "../timeline/exportQueue";
import type { CommandRunner } from "../tools/command";
import { createToolRegistry } from "../tools";
import { ClientTurnRunner, type ApprovalMode, type LoopDeps } from "./loop";
import type { PendingCall, RoundInput, RoundResultDTO } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ── canned-round builders (the MockProvider vocabulary) ─────────────────────
function toolsRound(pending: PendingCall[]): RoundResultDTO {
  return {
    kind: "tool_calls",
    pending_calls: pending,
    final_text: "",
    error: "",
    finish_reason: "tool_calls",
    usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
    provider_snapshot: {},
  };
}
function textRound(t: string): RoundResultDTO {
  return {
    kind: "text",
    pending_calls: [],
    final_text: t,
    error: "",
    finish_reason: "stop",
    usage: { input_tokens: 3, output_tokens: 2, cost_usd: 0.0002 },
    provider_snapshot: {},
  };
}
function call(name: string, args: Record<string, unknown>, id = name): PendingCall {
  return { call_id: id, name, arguments: args };
}

type Infer = (input: RoundInput) => RoundResultDTO | Promise<RoundResultDTO>;

async function harness(
  mode: ApprovalMode = "autopilot",
  makeCtxRunner?: (store: Any) => CommandRunner,
): Promise<Any> {
  const { store } = await seededCtx(videoRunner);
  const ctxRunner = makeCtxRunner ? makeCtxRunner(store) : videoRunner;
  const registry = createToolRegistry(() => ({ store, runner: ctxRunner }));
  const events: Array<{ event: string; data: Any }> = [];
  const toolErrors: Array<{ name: string; err: unknown }> = [];
  let rounds = 0;
  let cost = 0;
  let infer: Infer = () => textRound("");
  const deps: LoopDeps = {
    infer: (i) => {
      rounds += 1;
      return Promise.resolve(infer(i));
    },
    runTool: (name, args) => registry.run(name, args),
    emit: (event, data) => events.push({ event, data }),
    mode: () => mode,
    stopped: () => false,
    onUsage: (u) => {
      cost += u.cost_usd ?? 0;
    },
    session: () => ({ ok: true }),
    onToolError: (name, _args, err) => toolErrors.push({ name, err }),
  };
  return {
    store,
    events,
    toolErrors,
    runner: new ClientTurnRunner(deps),
    setInfer: (f: Infer) => {
      infer = f;
    },
    ev: (name: string) => events.filter((e) => e.event === name),
    get rounds() {
      return rounds;
    },
    get cost() {
      return cost;
    },
  };
}

describe("agent loop integration (real registry + applyOp + store)", () => {
  // The export queue is module-level: a reserved destination would refuse the next test's export.
  afterEach(__resetExportQueue);
  it("drives a real multi-round build (add_track -> add_clips -> split) end to end", async () => {
    const h = await harness("autopilot");
    h.setInfer((input: RoundInput) => {
      if (input.user_text) return toolsRound([call("add_track", { id: "v1", kind: "video" })]);
      const res = input.tool_results![0];
      if (res.name === "add_track")
        return toolsRound([
          call("add_clips", {
            entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v1" }],
          }),
        ]);
      if (res.name === "add_clips") {
        const id = (res.result.created as Any[])[0].clip_id as string; // the model uses the result
        return toolsRound([call("split_clips", { splits: [{ clip_id: id, at: 15 }] })]);
      }
      return textRound("done");
    });
    await h.runner.start("build me a timeline");
    const tl = await loadTimeline(h.store);
    const clips = (tl.tracks.find((t: Any) => t.id === "v1") as Any).clips as Any[];
    expect(clips.map((c: Any) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 15],
      [15, 30],
    ]); // the real split landed
    expect(h.rounds).toBe(4); // 3 tool rounds + 1 final text
    expect(h.ev("tool_result").map((e: Any) => e.data.name)).toEqual([
      "add_track",
      "add_clips",
      "split_clips",
    ]);
    expect(h.ev("turn_done").length).toBe(1);
    expect(h.cost).toBeGreaterThan(0); // usage folded every round
  });

  it("a hallucinated param is rejected by the registry and surfaced as ok:false (ties param validation)", async () => {
    const h = await harness();
    h.setInfer((input: RoundInput) =>
      input.user_text
        ? toolsRound([call("add_track", { id: "v1", kind: "video", bogus: 1 })])
        : textRound("ok"),
    );
    await h.runner.start("go");
    const tr = h.ev("tool_result")[0].data as Any;
    expect(tr.ok).toBe(false);
    expect(String(tr.error)).toMatch(/unknown param/i);
    expect((await loadTimeline(h.store)).tracks.length).toBe(0); // nothing created
  });

  it("a rejected op is surfaced ok:false, stays atomic, and the turn recovers", async () => {
    const h = await harness();
    h.setInfer((input: RoundInput) =>
      input.user_text
        ? toolsRound([call("split_clips", { splits: [{ clip_id: "nope", at: 5 }] })])
        : textRound("recovered"),
    );
    await h.runner.start("split a missing clip");
    expect((h.ev("tool_result")[0].data as Any).ok).toBe(false);
    expect((await loadTimeline(h.store)).tracks.length).toBe(0); // atomic: nothing changed
    expect(h.ev("text")[0].data.text).toBe("recovered"); // the loop fed the error back and finished
  });

  it("undo flows through the real chain and reverts the store", async () => {
    const h = await harness();
    h.setInfer((input: RoundInput) => {
      if (input.user_text) return toolsRound([call("add_track", { id: "v1", kind: "video" })]);
      return input.tool_results![0].name === "add_track"
        ? toolsRound([call("undo", {})])
        : textRound("undone");
    });
    await h.runner.start("add then undo");
    expect((await loadTimeline(h.store)).tracks.length).toBe(0); // undo reverted the add
  });

  it("default mode does NOT gate a plain project mutation — it applies straight through", async () => {
    // The gate is money / network / data-loss, not "any edit" (see needsApproval).
    // Asking a human to confirm every add_track would make default mode unusable,
    // so this pins the policy that actually ships.
    const h = await harness("default");
    h.setInfer((input: RoundInput) =>
      input.user_text
        ? toolsRound([call("add_track", { id: "v1", kind: "video" })])
        : textRound("done"),
    );
    await h.runner.start("add a track");
    expect(h.ev("awaiting_approval").length).toBe(0);
    expect((await loadTimeline(h.store)).tracks.length).toBe(1);
    expect(h.ev("turn_done").length).toBe(1);
  });

  it("default mode pauses a DESTRUCTIVE call; approve() releases it through the real chain", async () => {
    // library_op is the one tool whose destructiveness lives in an ARGUMENT, so it
    // is the sharpest test of the gate: the same tool name must pass ungated for a
    // read and pause for a delete.
    const h = await harness("default");
    h.setInfer((input: RoundInput) =>
      input.user_text
        ? toolsRound([call("library_op", { action: "delete", id: "media_missing" })])
        : textRound("done"),
    );
    await h.runner.start("delete that asset");

    expect(h.ev("awaiting_approval").length).toBe(1);
    expect(h.ev("tool_result").length).toBe(0); // held, not executed

    await h.runner.approve();
    expect(h.ev("tool_result").length).toBe(1); // released and run
    expect(h.ev("turn_done").length).toBe(1);
  });

  it("the same tool passes UNGATED when the argument isn't destructive", async () => {
    const h = await harness("default");
    h.setInfer((input: RoundInput) =>
      input.user_text ? toolsRound([call("library_op", { action: "list" })]) : textRound("done"),
    );
    await h.runner.start("what's in my library");
    expect(h.ev("awaiting_approval").length).toBe(0);
    expect(h.ev("tool_result").length).toBe(1);
  });

  it("a hallucinated (unregistered) tool name is caught: onToolError + ok:false, turn continues", async () => {
    const h = await harness();
    h.setInfer((input: RoundInput) =>
      input.user_text ? toolsRound([call("make_coffee", {})]) : textRound("no coffee"),
    );
    await h.runner.start("make coffee");
    expect(h.toolErrors.map((e: Any) => e.name)).toContain("make_coffee");
    expect((h.ev("tool_result")[0].data as Any).ok).toBe(false);
    expect(h.ev("text")[0].data.text).toBe("no coffee");
  });

  it("pauses at the continue-cap during a runaway autonomous run", async () => {
    const h = await harness("autopilot");
    h.setInfer(() => toolsRound([call("get_timeline", {}, "loop")])); // never finishes on its own
    await h.runner.start("loop");
    expect(h.ev("turn_paused").some((e: Any) => e.data.can_continue)).toBe(true);
  });

  it("drives a real add_clips -> export DELIVERABLE end to end (renders to Downloads)", async () => {
    // A ctx runner that mimics videoRunner's ffprobe (video-only source) AND writes
    // the ffmpeg output file, so the real export path (render -> exists check) succeeds.
    const h = await harness("autopilot", (store) => ({
      run: async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          await store.writeText(args[args.length - 1], "video"); // the rendered mp4
          return { code: 0, stdout: "", stderr: "" };
        }
        if (program === "ffprobe" && args.includes("-select_streams")) {
          return {
            code: 0,
            stdout: args[args.indexOf("-select_streams") + 1] === "v" ? "1" : "",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    }));
    let exportResult: Any = null;
    h.setInfer((input: RoundInput) => {
      if (input.user_text)
        return toolsRound([
          call("add_clips", {
            entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30 }],
          }),
        ]);
      const res = input.tool_results![0];
      // NOTE: export advertises output_path/resolution/quality/fps and nothing else, so a
      // `name`/`filename` would be rejected by the registry as an unknown param. The model can
      // only export with the default (project) name.
      if (res.name === "add_clips") return toolsRound([call("export", {})]);
      if (res.name === "export") {
        exportResult = res.result; // the model receives the export result back
        return textRound("exported");
      }
      return textRound("done");
    });
    await h.runner.start("build and export");
    await whenExportsSettle();
    expect(exportResult.ok).toBe(true);
    expect(exportResult.saved_to).toBe("proj.mp4"); // default deliverable name = project basename
    expect(h.ev("text")[0].data.text).toBe("exported");
  });

  it("joins the lanes: a caption the AGENT adds is burned into the real export command", async () => {
    // Integration proves the agent can export; pixel-smoke proves captions burn to pixels. Neither proved
    // the AGENT-added caption reaches the file. This joins them: the agent drives add_clips ->
    // add_text_clips -> export, and the REAL exporter (buildRenderCommand) must emit a libass caption burn
    // (`ass=f=cap_bandN.ass`) into the ffmpeg command for the caption the agent added. Only ffmpeg
    // EXECUTION is faked; the render command + the .ass are produced for real. (Actual caption PIXELS are
    // covered by caption.smoke.e2e.ts — this closes the agent -> export -> caption-in-command link.)
    let ffmpegArgs: string[] | null = null;
    const h = await harness("autopilot", (store) => ({
      run: async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          ffmpegArgs = args;
          await store.writeText(args[args.length - 1], "video"); // the rendered mp4
          return { code: 0, stdout: "", stderr: "" };
        }
        if (program === "ffprobe" && args.includes("-select_streams")) {
          return {
            code: 0,
            stdout: args[args.indexOf("-select_streams") + 1] === "v" ? "1" : "",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    }));
    let exportResult: Any = null;
    h.setInfer((input: RoundInput) => {
      if (input.user_text)
        return toolsRound([
          call("add_clips", {
            entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30 }],
          }),
        ]);
      const res = input.tool_results![0];
      if (res.name === "add_clips")
        return toolsRound([
          call("add_text_clips", {
            entries: [{ content: "HELLOWORLD", timeline_in: 0, timeline_out: 30 }],
          }),
        ]);
      if (res.name === "add_text_clips") return toolsRound([call("export", {})]);
      if (res.name === "export") {
        exportResult = res.result;
        return textRound("exported");
      }
      return textRound("done");
    });
    await h.runner.start("caption it and export");
    // The export is queued, so the encode outlives the turn — the join is only observable
    // once it has actually run.
    await whenExportsSettle();

    expect(exportResult.ok).toBe(true); // the agent reached a real export
    // The agent USED the caption capability: a text clip is committed to the timeline.
    const finalTl = await loadTimeline(h.store);
    const textClips = (finalTl.tracks ?? []).flatMap((t: Any) =>
      (t.clips ?? []).filter((c: Any) => c.kind === "text"),
    );
    expect(textClips.length).toBeGreaterThan(0);
    // The JOIN: that caption reached the real ffmpeg render command as a libass burn.
    expect(ffmpegArgs).not.toBeNull();
    expect((ffmpegArgs as unknown as string[]).some((a) => a.includes("ass=f=cap_band"))).toBe(
      true,
    );
  });
});
