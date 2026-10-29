// A failed round must be reportable BY the call that failed: the server stamps every response with an X-Request-ID and
// types the failure it ends a round with (error_code). Both travel on the round result, on BOTH routes, and an answer
// the server sent without an id is passed on exactly as sent (nothing is invented).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setApiBase } from "../api/config";
import { setClerkTokenProvider, setSessionRenewer } from "../api/auth";
import { rateLimitConfig, RateLimitError, SessionExpiredError } from "../api/http";
import { CreditLimitError } from "../api/usage";
import { ClientUpdateRequiredError } from "../update/updater";
import { inferRound, inferRoundStreaming, type InferBody } from "./api";

const body: InferBody = { round_input: { user_text: "hi" } };
const ERROR_ROUND = {
  kind: "error",
  error: "The AI provider's safety filter blocked an image in this conversation, so it could not answer. Nothing was charged.",
  error_code: "content_policy",
  pending_calls: [],
  final_text: "",
  finish_reason: "",
  usage: {},
  provider_snapshot: {},
};

function plain(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}

function streamed(data: unknown, headers: Record<string, string> = {}): Response {
  const frames = `event: delta\ndata: ${JSON.stringify({ kind: "text", text: "x" })}\n\nevent: result\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(new TextEncoder().encode(frames), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

const ROUTES = {
  plain: { answer: plain, send: () => inferRound(body) },
  stream: { answer: streamed, send: () => inferRoundStreaming(body, () => undefined) },
} as const;

afterEach(() => {
  setClerkTokenProvider(null);
  setSessionRenewer(null);
  setApiBase(null);
  vi.unstubAllGlobals();
});

describe.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])("the %s route", (route) => {
  const { answer, send } = ROUTES[route];

  it("carries the typed code and the request id of a failed round", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(ERROR_ROUND, { "x-request-id": "3f9c1a2b7d4e5f60" })));
    const out = await send();
    expect(out).toMatchObject({ kind: "error", error_code: "content_policy", request_id: "3f9c1a2b7d4e5f60" });
  });

  it("passes on an answer with no id exactly as the server sent it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(ERROR_ROUND)));
    const out = await send();
    expect(out).toEqual(ERROR_ROUND);
    expect("request_id" in out).toBe(false);
  });

  it("carries the id of a round that worked too (a later failure may need to point at it)", async () => {
    const ok = { kind: "text", final_text: "done", pending_calls: [], finish_reason: "stop", usage: {}, provider_snapshot: {} };
    vi.stubGlobal("fetch", vi.fn(async () => answer(ok, { "x-request-id": "okid" })));
    expect(await send()).toEqual({ ...ok, request_id: "okid" });
  });
});

describe("both routes describe the same answer the same way", () => {
  it("returns the same result for the same server answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => plain(ERROR_ROUND, { "x-request-id": "same" })));
    const viaPlain = await inferRound(body);
    vi.stubGlobal("fetch", vi.fn(async () => streamed(ERROR_ROUND, { "x-request-id": "same" })));
    const viaStream = await inferRoundStreaming(body, () => undefined);
    expect(viaStream).toEqual(viaPlain);
  });
});

// A failure that THROWS (the call never produced a round) names the call that failed, so the turn's error report can.
describe.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])("a refused call on the %s route", (route) => {
  const send = ROUTES[route].send;
  const refuse = (status: number, text: string) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status, headers: { "x-request-id": "failed-call-1" } })));
  };
  beforeEach(() => {
    // The plain route waits out a 429 by retrying; nothing to wait for here.
    Object.assign(rateLimitConfig, { retries: 0 });
  });

  it.each([
    [402, JSON.stringify({ detail: { error: "credit_limit_reached" } }), CreditLimitError],
    [429, "busy", RateLimitError],
    [401, "nope", SessionExpiredError],
    [426, JSON.stringify({ detail: { error: "client_update_required" } }), ClientUpdateRequiredError],
    [503, "upstream down", Error],
  ])("%s carries the id of the call that failed", async (status, text, kind) => {
    refuse(status, text);
    const error = await send().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(kind);
    expect((error as { requestId?: string }).requestId).toBe("failed-call-1");
  });

  it("carries no id when the server stamped none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream down", { status: 503 })));
    const error = (await send().catch((e: unknown) => e)) as { requestId?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.requestId).toBeUndefined();
  });
});
