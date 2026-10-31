// The loop hands the store an error round's sentence, and now also its typed code and request id when it has them, so the
// store can report the turn by the failure's name. An error round without them emits exactly what it always did.
import { describe, expect, it, vi } from "vitest";

import { agentEventContext } from "../api/agentEvents";
import { ClientTurnRunner, type LoopDeps } from "./loop";
import type { RoundResultDTO } from "./types";

function round(over: Partial<RoundResultDTO>): RoundResultDTO {
  return {
    kind: "error",
    pending_calls: [],
    final_text: "",
    error: "boom",
    finish_reason: "",
    usage: {},
    provider_snapshot: {},
    ...over,
  };
}

async function runOnce(result: RoundResultDTO) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const deps: LoopDeps = {
    eventContext: agentEventContext,
    infer: vi.fn(async () => result),
    runTool: vi.fn(async () => ({ ok: true })),
    collectAttachments: vi.fn(async () => []),
    emit: (event, data) => events.push({ event, data }),
    mode: () => "default",
    stopped: () => false,
    onUsage: vi.fn(),
    session: () => ({ cost_usd: 0 }),
  };
  await new ClientTurnRunner(deps).start("hi");
  return events.filter((e) => e.event === "error");
}

describe("an error round", () => {
  it("emits the sentence with the typed code and the request id the round carried", async () => {
    const errors = await runOnce(
      round({
        error: "Our own sentence.",
        error_code: "content_policy",
        request_id: "3f9c1a2b7d4e5f60",
      }),
    );
    expect(errors).toEqual([
      {
        event: "error",
        data: {
          error: "Our own sentence.",
          error_code: "content_policy",
          request_id: "3f9c1a2b7d4e5f60",
        },
      },
    ]);
  });

  it("emits exactly what it always did when the round carried neither", async () => {
    const errors = await runOnce(round({ error: "boom" }));
    expect(errors).toEqual([{ event: "error", data: { error: "boom" } }]);
  });

  it("emits only the one it has", async () => {
    expect((await runOnce(round({ error_code: "provider_timeout" })))[0].data).toEqual({
      error: "boom",
      error_code: "provider_timeout",
    });
    expect((await runOnce(round({ request_id: "rid" })))[0].data).toEqual({
      error: "boom",
      request_id: "rid",
    });
  });

  it("still says something when the server gave no sentence", async () => {
    expect((await runOnce(round({ error: "" })))[0].data).toEqual({ error: "error" });
  });
});
