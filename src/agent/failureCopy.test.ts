import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setApiBase } from "../api/config";
import { setClerkTokenProvider, setSessionRenewer } from "../api/auth";
import { RateLimitError, SessionExpiredError } from "../api/http";
import { StreamStalledError } from "../api/sse";
import { CreditLimitError } from "../api/usage";
import { isExpected } from "../lib/errors";
import { clearRecentFailures } from "../observability/recentFailures";
import { ClientUpdateRequiredError } from "../update/updater";
import { inferRoundStreaming, RoundTimeoutError, type InferBody } from "./api";
import codes from "./failureCodes.json";
import {
  describeHttpFailure,
  describeTurnFailure,
  ROUND_SERVER_CODES,
  RoundHttpError,
  serverCodeOf,
  TYPED_ELSEWHERE,
} from "./failureCopy";
import { turnErrorCode } from "./turnError";

const NEXT_STEP =
  /try again|update artdaddy|start a new chat|remove some attachments|choose another|wait a moment|report this problem/i;
// Words a person should never be shown: a protocol, a status number, a stack, or an empty value.
const TECHNICAL =
  /\bhttp\b|\b[45]\d\d\b|exception|traceback|undefined|\bnull\b|\[object|status code|ECONN/i;

/** Every sentence the app can show for a failed round, with what produced it. */
function everySentence(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [code, d] of Object.entries(ROUND_SERVER_CODES)) out.push([`code ${code}`, d.message]);
  for (let status = 400; status <= 599; status++)
    out.push([`status ${status}`, describeHttpFailure(status, null).message]);
  const errors: Array<[string, unknown]> = [
    ["a round that timed out", new RoundTimeoutError(600_000)],
    ["a stream that went quiet", new StreamStalledError(90_000)],
    ["a dropped connection", new TypeError("Failed to fetch")],
    ["an error nobody typed", new Error("ECONNRESET at socket.js:41")],
    ["a thrown string", "boom"],
    ["nothing at all", undefined],
  ];
  for (const [name, error] of errors) out.push([name, describeTurnFailure(error).message]);
  return out;
}

describe("the app's words for a failed round and the shared list of server codes", () => {
  it("has words for exactly the codes listed as the agent's own (the server guard anchors the list to its source)", () => {
    expect(Object.keys(ROUND_SERVER_CODES).sort()).toEqual([...codes.agent_round].sort());
    expect([...TYPED_ELSEWHERE].sort()).toEqual([...codes.typed_elsewhere].sort());
  });

  it("lists every code in one place only", () => {
    const all = [...codes.agent_round, ...codes.typed_elsewhere, ...codes.not_on_this_route];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(30);
  });
});

describe("every sentence a person can be shown for a failed round", () => {
  const sentences = everySentence();

  it("walks every code, every error status from 400 to 599, and every kind of thrown failure", () => {
    expect(sentences.length).toBeGreaterThan(200);
  });

  it("is plain words with a next step: never a shrug, a status number, a protocol or a stack", () => {
    const bad = sentences.filter(([, text]) => {
      const t = text.trim();
      return (
        !t ||
        t.length > 300 ||
        !/[.!?]$/.test(t) ||
        /something went wrong/i.test(t) ||
        TECHNICAL.test(t) ||
        !NEXT_STEP.test(t)
      );
    });
    expect(bad).toEqual([]);
  });

  it("says nothing was charged only where the server refused before it dispatched anything", () => {
    const claims = sentences
      .filter(([, text]) => /nothing was charged/i.test(text))
      .map(([what]) => what);
    expect(claims).toEqual(["code metering_unavailable"]);
  });

  it("never shows the raw words of an error nobody typed", () => {
    for (const odd of [new Error("ECONNRESET at socket.js:41"), "boom", {}, null, undefined, 42])
      expect(describeTurnFailure(odd).message, String(odd)).not.toMatch(/ECONNRESET|socket|boom/);
  });
});

describe("whether trying again can help", () => {
  it("can for a restart, an overload or a server fault, and cannot for a request the service refused", () => {
    for (const status of [408, 500, 501, 502, 503, 504, 404, 405])
      expect(describeHttpFailure(status, null).retryable, String(status)).toBe(true);
    for (const status of [400, 401, 403, 409, 413, 422])
      expect(describeHttpFailure(status, null).retryable, String(status)).toBe(false);
  });

  it("follows the server's own code before the status", () => {
    expect(describeHttpFailure(503, "metering_unavailable").retryable).toBe(true);
    expect(describeHttpFailure(503, "missing_paid_request_context").retryable).toBe(false);
    expect(describeHttpFailure(400, "model_not_allowed").retryable).toBe(false);
    expect(describeHttpFailure(429, "account_busy").retryable).toBe(true);
  });

  it("is not fooled by a code an object would inherit", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(describeHttpFailure(502, code).message).toBe(describeHttpFailure(502, null).message);
  });

  it("is not offered when it would only fail the same way: no credits, an update needed, no session", () => {
    const credit = new CreditLimitError({ used: 99, limit: 100, remaining: 1, scope: "user" });
    for (const [error, retryable] of [
      [credit, false],
      [new ClientUpdateRequiredError(), false],
      [new SessionExpiredError(), false],
      [new RateLimitError(), true],
    ] as const) {
      const d = describeTurnFailure(error);
      expect(d.retryable, error.name).toBe(retryable);
      expect(d.message, error.name).toBe((error as { userMessage: string }).userMessage);
    }
  });

  it("is offered for a connection that dropped, a round that timed out and a stream that went quiet", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      new TypeError("Load failed"),
      new RoundTimeoutError(600_000),
      new StreamStalledError(90_000),
    ])
      expect(describeTurnFailure(error).retryable, String(error)).toBe(true);
  });
});

describe("the sentences that used to be thrown away", () => {
  it("tells a round that timed out how long it waited, and that nothing was changed", () => {
    const d = describeTurnFailure(new RoundTimeoutError(600_000));
    expect(d.message).toMatch(/10 minutes/);
    expect(d.message).toMatch(/Nothing was changed/);
    expect(describeTurnFailure(new RoundTimeoutError(60_000)).message).toMatch(/1 minute,/);
  });

  it("tells a stream that went quiet how long it was quiet", () => {
    expect(describeTurnFailure(new StreamStalledError(90_000)).message).toMatch(
      /nothing arrived for 90 seconds/,
    );
  });
});

describe("serverCodeOf", () => {
  it("reads the code the server sends, and nothing else", () => {
    expect(serverCodeOf('{"detail":{"error":"metering_unavailable"}}')).toBe(
      "metering_unavailable",
    );
    expect(serverCodeOf('{"detail":{"error":"account_busy","retry_after_s":2}}')).toBe(
      "account_busy",
    );
    for (const body of [
      "",
      "<html>502 Bad Gateway</html>",
      "null",
      "[]",
      '"text"',
      '{"detail":"invalid or expired session"}',
      '{"detail":{"error":42}}',
      '{"detail":{"error":"<script>alert(1)</script>"}}',
      '{"detail":{"error":"Has Spaces"}}',
      `{"detail":{"error":"${"a".repeat(80)}"}}`,
    ])
      expect(serverCodeOf(body), body.slice(0, 40)).toBeNull();
  });

  it("never throws, and only ever returns a plain lowercase code", () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const code = serverCodeOf(body);
        if (code !== null) expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      }),
    );
  });
});

describe("RoundHttpError", () => {
  it("keeps the message shape that crash grouping and the turn's code read, and shows the person its own words", () => {
    const e = new RoundHttpError(
      503,
      "metering_unavailable",
      '{"detail":{"error":"metering_unavailable"}}',
    );
    expect(e.message).toMatch(/^503: /);
    expect(e.userMessage).toBe(ROUND_SERVER_CODES.metering_unavailable.message);
    expect(turnErrorCode(e)).toBe("metering_unavailable");
    expect(isExpected(e)).toBe(true);
  });

  it("is a crash only when nobody expected it", () => {
    expect(isExpected(new RoundHttpError(500, null, "boom"))).toBe(false);
    expect(turnErrorCode(new RoundHttpError(500, null, "boom"))).toBe("http_500");
    expect(isExpected(new RoundHttpError(502, null, "<html>"))).toBe(true);
    expect(isExpected(new RoundHttpError(400, "invalid_request", "{}"))).toBe(true);
    expect(isExpected(new RoundHttpError(400, "some_new_code", "{}"))).toBe(false);
  });
});

// The sender itself, answered the way a real server and gateway answer: the person is told the words
// for what happened, whichever layer failed.
describe("the round sender, against the answers production gives", () => {
  const body: InferBody = { round_input: { user_text: "hi" } };

  beforeEach(() => {
    setClerkTokenProvider(async () => "tok");
    clearRecentFailures();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setClerkTokenProvider(null);
    setSessionRenewer(null);
    setApiBase(null);
    clearRecentFailures();
  });

  const answer = (status: number, text: string, type = "application/json") =>
    new Response(text, { status, headers: { "Content-Type": type, "x-request-id": "call-1" } });

  it.each([
    ["a restart behind the gateway", 502, "<html>502 Bad Gateway</html>", null, true],
    ["a gateway timeout", 504, "", null, true],
    [
      "the ledger unreachable",
      503,
      '{"detail":{"error":"metering_unavailable"}}',
      "metering_unavailable",
      true,
    ],
    [
      "no tool list",
      503,
      '{"detail":{"error":"catalog_unavailable"}}',
      "catalog_unavailable",
      true,
    ],
    [
      "an incomplete request",
      503,
      '{"detail":{"error":"missing_paid_request_context"}}',
      "missing_paid_request_context",
      false,
    ],
    [
      "a body that is too big",
      413,
      '{"detail":{"error":"request_too_large"}}',
      "request_too_large",
      false,
    ],
    [
      "a request the service could not read",
      400,
      '{"detail":{"error":"invalid_request","reason":"x"}}',
      "invalid_request",
      false,
    ],
    [
      "an unexpected server fault",
      500,
      '{"detail":{"error":"internal_error"}}',
      "internal_error",
      true,
    ],
  ])("%s", async (_name, status, text, serverCode, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(status, text)),
    );
    const caught = await inferRoundStreaming(body, () => undefined).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RoundHttpError);
    const error = caught as RoundHttpError & { requestId?: string };
    expect(error.status).toBe(status);
    expect(error.serverCode).toBe(serverCode);
    expect(error.requestId).toBe("call-1");
    const described = describeTurnFailure(error);
    expect(described.retryable).toBe(retryable);
    expect(described.message).toBe(describeHttpFailure(status, serverCode).message);
    expect(described.message).not.toMatch(/something went wrong/i);
  });

  it("tells a stream that stops sending data apart from a refusal, and says how long it was quiet", async () => {
    vi.useFakeTimers();
    try {
      const silent = new ReadableStream<Uint8Array>({ start() {} });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(silent, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        ),
      );
      const pending = inferRoundStreaming(body, () => undefined).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(91_000);
      const caught = await pending;
      expect(caught).toBeInstanceOf(StreamStalledError);
      expect(describeTurnFailure(caught).message).toMatch(/nothing arrived for 90 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });
});
