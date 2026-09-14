import { describe, expect, it, vi } from "vitest";

import { ClientTurnRunner, type LoopDeps } from "./loop";
import { MAX_CONCURRENT_READS } from "./toolEffect";
import type { RoundResultDTO } from "./types";

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  call_id: id,
  name,
  arguments: args,
  rationale: "",
  reasoning_summary: [],
});

const textRound: RoundResultDTO = { kind: "text", final_text: "done", usage: {} } as RoundResultDTO;

/** Records overlap: which calls were in flight when each one started. */
function harness(opts: { mode?: "default" | "autopilot"; delayMs?: number } = {}) {
  const started: string[] = [];
  const finished: string[] = [];
  const maxInFlight = { value: 0 };
  let inFlight = 0;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const rounds: RoundResultDTO[] = [];

  const deps: LoopDeps = {
    infer: vi.fn(async () => rounds.shift() ?? textRound),
    runTool: vi.fn(async (name: string) => {
      started.push(name);
      inFlight += 1;
      maxInFlight.value = Math.max(maxInFlight.value, inFlight);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      inFlight -= 1;
      finished.push(name);
      return { ok: true };
    }),
    emit: (event, data) => events.push({ event, data }),
    mode: () => opts.mode ?? "autopilot",
    stopped: () => false,
    session: () => ({}) as never,
    onUsage: () => {},
  };
  return { deps, started, finished, maxInFlight, events, rounds };
}

const toolCalls = (...calls: ReturnType<typeof call>[]): RoundResultDTO =>
  ({ kind: "tool_calls", pending_calls: calls, usage: {} }) as unknown as RoundResultDTO;

describe("a round with several tool calls", () => {
  it("runs consecutive READS at the same time", async () => {
    const h = harness({ delayMs: 20 });
    h.rounds.push(
      toolCalls(call("1", "get_timeline"), call("2", "get_transcript"), call("3", "probe_media")),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.maxInFlight.value).toBe(3);
    expect(h.finished).toHaveLength(3);
  });

  it("never runs two WRITES at the same time", async () => {
    // The rule the whole design rests on: two mutations must not interleave.
    const h = harness({ delayMs: 20 });
    h.rounds.push(
      toolCalls(call("1", "add_clips"), call("2", "split_clips"), call("3", "remove_clips")),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.maxInFlight.value).toBe(1);
    expect(h.started).toEqual(["add_clips", "split_clips", "remove_clips"]);
  });

  it("never overlaps a read with a write", async () => {
    // A read beside a mutation could observe a half-applied edit.
    const h = harness({ delayMs: 20 });
    h.rounds.push(toolCalls(call("1", "get_timeline"), call("2", "add_clips")), textRound);
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.maxInFlight.value).toBe(1);
  });

  it("keeps the order the model emitted", async () => {
    // We only overlap neighbours; we never reorder. A reordered batch would silently
    // rearrange the user's edits.
    const h = harness({ delayMs: 1 });
    h.rounds.push(
      toolCalls(
        call("1", "get_timeline"),
        call("2", "add_clips"),
        call("3", "get_transcript"),
        call("4", "split_clips"),
      ),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.started).toEqual(["get_timeline", "add_clips", "get_transcript", "split_clips"]);
  });

  it("does not overlap reads that a write sits between", async () => {
    // The two reads are not consecutive, so the second waits its turn rather than being
    // hoisted past the mutation.
    const h = harness({ delayMs: 20 });
    h.rounds.push(
      toolCalls(call("1", "get_timeline"), call("2", "add_clips"), call("3", "get_transcript")),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.maxInFlight.value).toBe(1);
  });

  it("caps how many reads are in flight at once", async () => {
    // Several of these spawn ffmpeg; unbounded fan-out competes with the render.
    const h = harness({ delayMs: 20 });
    const reads = Array.from({ length: MAX_CONCURRENT_READS + 3 }, (_, i) =>
      call(String(i), "get_timeline"),
    );
    h.rounds.push(toolCalls(...reads), textRound);
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.maxInFlight.value).toBeLessThanOrEqual(MAX_CONCURRENT_READS);
    expect(h.finished).toHaveLength(reads.length);
  });

  it("feeds every result back in ONE round", async () => {
    // The actual win: N edits used to cost N model round trips.
    const h = harness({ delayMs: 1 });
    h.rounds.push(
      toolCalls(call("1", "add_clips"), call("2", "add_clips"), call("3", "add_clips")),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    // round 1 = the user's message, round 2 = the batch's results. Not four.
    expect(h.deps.infer).toHaveBeenCalledTimes(2);
    const results = (h.deps.infer as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0];
    expect((results as { tool_results: unknown[] }).tool_results).toHaveLength(3);
  });

  it("treats an unknown tool as a write rather than overlapping it", async () => {
    const h = harness({ delayMs: 20 });
    h.rounds.push(toolCalls(call("1", "brand_new_tool"), call("2", "brand_new_tool")), textRound);
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.maxInFlight.value).toBe(1);
  });
});

describe("approvals across a batch", () => {
  it("asks for every gated call in the round at once", async () => {
    const h = harness({ mode: "default" });
    h.rounds.push(
      toolCalls(call("1", "video_ask"), call("2", "image_ask"), call("3", "get_timeline")),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    const asks = h.events.filter((e) => e.event === "awaiting_approval");
    expect(asks).toHaveLength(1);
    expect((asks[0].data.calls as { call_id: string }[]).map((c) => c.call_id)).toEqual(["1", "2"]);
  });

  it("waits for ALL of them before running anything", async () => {
    const h = harness({ mode: "default" });
    h.rounds.push(toolCalls(call("1", "video_ask"), call("2", "image_ask")), textRound);
    const r = new ClientTurnRunner(h.deps);
    await r.start("go");

    await r.approve("1");
    expect(h.started).toEqual([]); // still one undecided

    await r.approve("2");
    expect(h.started).toEqual(["video_ask", "image_ask"]);
  });

  it("answers a denied call truthfully instead of running it", async () => {
    const h = harness({ mode: "default" });
    h.rounds.push(toolCalls(call("1", "video_ask"), call("2", "image_ask")), textRound);
    const r = new ClientTurnRunner(h.deps);
    await r.start("go");

    await r.deny("no thanks", "1");
    await r.approve("2");

    expect(h.started).toEqual(["image_ask"]);
    const denied = h.events.find((e) => e.event === "tool_result" && e.data.call_id === "1");
    expect(denied?.data.ok).toBe(false);
    expect(denied?.data.error).toBe("no thanks");
  });

  it("does not gate anything in autopilot", async () => {
    const h = harness({ mode: "autopilot" });
    h.rounds.push(toolCalls(call("1", "video_ask"), call("2", "image_ask")), textRound);
    const r = new ClientTurnRunner(h.deps);

    await r.start("go");

    expect(h.events.some((e) => e.event === "awaiting_approval")).toBe(false);
    expect(h.finished).toHaveLength(2);
  });

  it("does not carry a decision into the next round", async () => {
    // call_ids are per-round; a stale "allowed" could wave through a later paid call.
    const h = harness({ mode: "default" });
    h.rounds.push(
      toolCalls(call("1", "video_ask")),
      toolCalls(call("1", "generate_video")),
      textRound,
    );
    const r = new ClientTurnRunner(h.deps);
    await r.start("go");
    await r.approve("1");

    const asks = h.events.filter((e) => e.event === "awaiting_approval");
    expect(asks).toHaveLength(2);
    expect((asks[1].data.calls as { name: string }[])[0].name).toBe("generate_video");
  });
});
