// UJ-046: when the server found the pictures the provider refused, the round says so (`refused_frames`) whatever the round became:
// the answer, the next tool calls, or an error. The loop passes what it can trust to the store FIRST, so the pictures are marked
// before anything else the round produced, and the very same round's failure is told after the marking.
import { describe, expect, it, vi } from "vitest";

import fixture from "../api/__fixtures__/refusedFrames.json";
import { agentEventContext } from "../api/agentEvents";
import { ClientTurnRunner, type LoopDeps } from "./loop";
import type { RoundResultDTO } from "./types";

type Ev = { event: string; data: Record<string, unknown> };

function round(over: Partial<RoundResultDTO>): RoundResultDTO {
  return {
    kind: "text",
    pending_calls: [],
    final_text: "done",
    error: "",
    finish_reason: "",
    usage: {},
    provider_snapshot: {},
    ...over,
  };
}

async function run(results: RoundResultDTO[]): Promise<Ev[]> {
  const events: Ev[] = [];
  const queue = results.slice();
  const deps: LoopDeps = {
    eventContext: agentEventContext,
    infer: vi.fn(async () => queue.shift() ?? round({})),
    runTool: vi.fn(async () => ({ ok: true })),
    collectAttachments: vi.fn(async () => []),
    emit: (event, data) => events.push({ event, data }),
    mode: () => "autopilot",
    stopped: () => false,
    onUsage: vi.fn(),
    session: () => ({ cost_usd: 0 }),
  };
  await new ClientTurnRunner(deps).start("hi");
  return events;
}

const NAMES = [
  { call_id: "call_9", index: 2 },
  { call_id: "call_11", index: 0 },
];

const refusedEvents = (events: Ev[]) => events.filter((e) => e.event === "frames_refused");

describe("a round that names refused pictures", () => {
  it("tells the store before the failure, when the round failed", async () => {
    const events = await run([
      round({
        kind: "error",
        error: "Our own sentence.",
        error_code: "content_policy",
        refused_frames: NAMES,
      }),
    ]);
    expect(events.map((e) => e.event)).toEqual(["turn_start", "frames_refused", "error"]);
    expect(refusedEvents(events)[0].data).toEqual({ frames: NAMES });
  });

  it("tells the store before the answer, when the round answered", async () => {
    const events = await run([round({ final_text: "Here you go.", refused_frames: NAMES })]);
    expect(events.map((e) => e.event)).toEqual([
      "turn_start",
      "frames_refused",
      "text",
      "turn_done",
    ]);
  });

  it("tells the store before anything the round produced, even its reasoning, when it went on to call tools", async () => {
    const events = await run([
      round({
        kind: "tool_calls",
        final_text: "",
        reasoning_items: [{ id: "rs_1", encrypted_content: "enc" }],
        pending_calls: [
          { call_id: "c1", name: "get_timeline", arguments: {}, reasoning_summary: ["thinking"] },
        ],
        refused_frames: NAMES,
      }),
      round({}),
    ]);
    const order = events.map((e) => e.event);
    expect(order.indexOf("frames_refused")).toBe(1); // straight after turn_start
    expect(order.indexOf("frames_refused")).toBeLessThan(order.indexOf("reasoning_item"));
    expect(order.indexOf("frames_refused")).toBeLessThan(order.indexOf("reasoning"));
    expect(refusedEvents(events)).toHaveLength(1);
  });

  it("says it once for the round, with every picture it names", async () => {
    const events = await run([
      round({ refused_frames: [...NAMES, { call_id: "call_12", index: 1 }] }),
    ]);
    expect(refusedEvents(events)).toHaveLength(1);
    expect((refusedEvents(events)[0].data.frames as unknown[]).length).toBe(3);
  });

  it("passes on only the names that can be trusted", async () => {
    const events = await run([
      round({
        refused_frames: [
          { call_id: "", index: 0 },
          { call_id: "a", index: -1 },
          { call_id: "a", index: 1.5 },
          null,
          "x",
          { call_id: "ok", index: 3 },
          { call_id: "ok", index: 3 },
        ] as never,
      }),
    ]);
    expect(refusedEvents(events)[0].data).toEqual({ frames: [{ call_id: "ok", index: 3 }] });
  });

  it("passes on the names exactly as the server's own tests write them (shared fixture)", async () => {
    const events = await run([
      round({ ...(fixture.round_result as Partial<RoundResultDTO>), kind: "error", error: "x" }),
    ]);
    expect(refusedEvents(events)[0].data).toEqual({ frames: fixture.round_result.refused_frames });
  });
});

describe("a round that names none", () => {
  it.each([
    ["no field", undefined],
    ["an empty list", []],
    ["text", "call_9"],
    ["a list of nothing usable", [{ call_id: 4, index: "x" }, null]],
  ])(
    "emits nothing for %s, and the rest of the round is as it always was",
    async (_what, refused) => {
      const events = await run([
        round({
          final_text: "ok",
          ...(refused === undefined ? {} : { refused_frames: refused as never }),
        }),
      ]);
      expect(events.map((e) => e.event)).toEqual(["turn_start", "text", "turn_done"]);
    },
  );
});
