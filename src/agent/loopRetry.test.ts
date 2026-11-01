import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { agentEventContext } from "../api/agentEvents";
import { ClientTurnRunner, type LoopDeps } from "./loop";
import type { InferenceAttachment, RoundInput, RoundResultDTO } from "./types";

const dto = (over: Partial<RoundResultDTO>): RoundResultDTO =>
  ({
    kind: "text",
    pending_calls: [],
    final_text: "",
    finish_reason: "stop",
    usage: {},
    provider_snapshot: {},
    ...over,
  }) as RoundResultDTO;
const toolRound = (): RoundResultDTO =>
  dto({
    kind: "tool_calls",
    pending_calls: [{ call_id: "c1", name: "inspect_media", arguments: { media_ref: "a" } }],
  });
const reply = (text = "done"): RoundResultDTO => dto({ kind: "text", final_text: text });
const errorRound = (): RoundResultDTO =>
  dto({
    kind: "error",
    error: "The AI provider had a problem and did not finish.",
    error_code: "provider_unavailable",
  });

type Outcome = RoundResultDTO | Error;

/** A runner whose model rounds follow a script, recording exactly what each was sent. */
function harness(script: Outcome[]) {
  const sent: Array<{ input: RoundInput; atts: InferenceAttachment[] | undefined }> = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const remaining = [...script];
  const deps: LoopDeps = {
    eventContext: agentEventContext,
    infer: vi.fn(async (input: RoundInput, atts?: InferenceAttachment[]) => {
      sent.push({ input: structuredClone(input), atts: structuredClone(atts) });
      const next = remaining.shift();
      if (!next) throw new Error("the script ran out");
      if (next instanceof Error) throw next;
      return next;
    }),
    // The look shows the model a picture, as inspect_media does.
    runTool: vi.fn(async () => ({
      ok: true,
      _attachments: [{ path: "library/a.png", kind: "image", caption: "a" }],
    })),
    collectAttachments: vi.fn(async () => [
      { kind: "image", b64: "AA==", ext: ".png" } as InferenceAttachment,
    ]),
    emit: (event, data) => events.push({ event, data }),
    mode: () => "default",
    stopped: () => false,
    onUsage: vi.fn(),
    session: () => ({ cost_usd: 0 }),
  };
  const runner = new ClientTurnRunner(deps);
  const ended = (): string[] =>
    events.filter((e) => e.event === "turn_done" || e.event === "error").map((e) => e.event);
  return { runner, sent, events, deps, ended };
}

const networkDrop = () => new TypeError("Failed to fetch");

describe("sending a failed round again", () => {
  it("offers nothing before anything has failed, and nothing after a round that answered", async () => {
    const h = harness([reply()]);
    expect(h.runner.canRetry).toBe(false);
    await h.runner.start("brief");
    expect(h.runner.canRetry).toBe(false);
    await h.runner.retry();
    expect(h.sent).toHaveLength(1); // retry with nothing to retry sends nothing
  });

  it("re-sends the first round exactly as it was when the connection dropped before any answer", async () => {
    const h = harness([networkDrop(), reply("here you go")]);
    await expect(h.runner.start("make a reel")).rejects.toThrow("Failed to fetch");
    expect(h.runner.canRetry).toBe(true);

    await h.runner.retry();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual(h.sent[0]);
    expect(h.sent[1].input).toEqual({ user_text: "make a reel" });
    expect(h.events.find((e) => e.event === "text")?.data).toEqual({ text: "here you go" });
    expect(h.ended()).toEqual(["turn_done"]);
    expect(h.runner.canRetry).toBe(false);
  });

  it("re-sends a later round with the same tool outputs AND the same pictures the tool showed", async () => {
    const h = harness([toolRound(), networkDrop(), reply()]);
    await expect(h.runner.start("look at it")).rejects.toThrow();
    expect(h.sent).toHaveLength(2);
    const failed = h.sent[1];
    expect(failed.input.tool_results).toHaveLength(1);
    expect(failed.atts).toHaveLength(1);

    await h.runner.retry();

    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]).toEqual(failed); // identical input and pictures, nothing retyped
    expect(h.ended()).toEqual(["turn_done"]);
  });

  it("re-sends the round after a round that came back as an error", async () => {
    const h = harness([errorRound(), reply()]);
    await h.runner.start("hi");
    expect(h.ended()).toEqual(["error"]);
    expect(h.runner.canRetry).toBe(true);

    await h.runner.retry();

    expect(h.sent[1]).toEqual(h.sent[0]);
    expect(h.ended()).toEqual(["error", "turn_done"]);
    expect(h.runner.canRetry).toBe(false);
  });

  it("keeps the tool outputs owed to a message typed instead, and counts them once when sent again", async () => {
    const h = harness([toolRound(), networkDrop(), networkDrop(), reply()]);
    await expect(h.runner.start("look")).rejects.toThrow();
    // The person types something else instead of retrying: the outputs are still owed, once.
    const debt = h.runner.takeUnsentResults();
    expect(debt).toHaveLength(1);

    // Another runner state: this one retries. The outputs ride the retry and are not a debt as well.
    const g = harness([toolRound(), networkDrop(), networkDrop(), reply()]);
    await expect(g.runner.start("look")).rejects.toThrow();
    await expect(g.runner.retry()).rejects.toThrow();
    expect(g.runner.canRetry).toBe(true);
    await g.runner.retry();
    expect(g.runner.takeUnsentResults()).toEqual([]);
    expect(g.sent).toHaveLength(4);
    expect(g.ended()).toEqual(["turn_done"]);
  });

  it("can be asked again after it fails again, any number of times, and then answers once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        async (failures, afterTools) => {
          const script: Outcome[] = [
            ...(afterTools ? [toolRound()] : []),
            ...Array.from({ length: failures + 1 }, (): Outcome => networkDrop()),
            reply(),
          ];
          const h = harness(script);
          await expect(h.runner.start("brief")).rejects.toThrow();
          for (let i = 0; i < failures; i++) await expect(h.runner.retry()).rejects.toThrow();
          await h.runner.retry();
          const first = h.sent[afterTools ? 1 : 0];
          for (const round of h.sent.slice(afterTools ? 1 : 0)) expect(round).toEqual(first);
          expect(h.sent).toHaveLength((afterTools ? 1 : 0) + failures + 2);
          expect(h.ended()).toEqual(["turn_done"]);
          expect(h.runner.takeUnsentResults()).toEqual([]);
          expect(h.runner.canRetry).toBe(false);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("does not run a tool twice: the retry sends the round again, not the calls before it", async () => {
    const h = harness([toolRound(), networkDrop(), reply()]);
    await expect(h.runner.start("look")).rejects.toThrow();
    await h.runner.retry();
    expect(h.deps.runTool).toHaveBeenCalledTimes(1);
  });
});
