// Scripted model replies: what the fake server (fakeServer.ts) does with ONE model round, i.e. one
// POST /inference/stream from the app. A reply is either a stream of steps (the real route's
// `delta` frames, keepalive comments, pauses, then one `result` frame) or a plain HTTP answer
// (a 402, a 426, a 500). The wire format is the server's own (server/app.py,
// post_inference_stream): `event: delta` with {kind, text}, then `event: result` with the
// round's whole RoundResult, written with sse_starlette's CRLF line ends.
//
// A new scripted reply is one small file in ../fixtures/replies/ that exports a function returning
// a `Reply` built with the helpers below. See ../README.md.
import type { RoundResultDTO } from "../../../../src/agent/types";

/** The round's record, as the server's `result` frame carries it: the app's own type
 *  (src/agent/types.ts), so a reply cannot drift from the shape the app reads. */
export type RoundResult = RoundResultDTO;

export type Step =
  /** Nothing is written for this long (milliseconds). A client that leaves meanwhile is noticed. */
  | { wait: number }
  /** One `delta` frame: live presentation of the answer forming. */
  | { delta: string; kind?: "text" | "reasoning" | "reset" }
  /** A keepalive comment, as the real server sends every 15 s. */
  | { ping: true }
  /** The terminal `result` frame. The stream ends after it. */
  | { result: RoundResult }
  /** The connection drops now, with no result: a network that died mid-reply. */
  | { cut: true }
  /** The line stays open, carrying only keepalive comments, until the test calls
   *  `server.release()` (then the next step runs) or the app hangs up (Stop). */
  | { hold: true }
  /** The same, but never released: only the app hanging up (Stop) or the test ending closes it. */
  | { hang: true };

/** How often a held line carries a keepalive comment. The real server sends one every 15 s; a held
 *  line sends them sooner because an engine may keep the last bytes of a quiet stream back until
 *  more arrive (in CI, Linux WebKit showed two words of seven, then nothing for 15 s), and a test
 *  must never depend on when an engine hands over bytes it already has. */
export const KEEPALIVE_MS = 200;

export type Reply =
  | { kind: "stream"; steps: Step[]; note: string }
  | { kind: "http"; status: number; body: unknown; delayMs?: number; note: string }
  /** The connection is closed before any answer at all (what a dead server looks like). */
  | { kind: "drop"; note: string };

/** What a reply may read from the round it answers. */
export interface Round {
  /** The parsed request body the app sent. */
  body: Record<string, unknown>;
  /** The person's text this round carried (round_input.user_text or its extra_texts), or "". */
  userText: string;
  /** Tool outputs this round carried back to the model. */
  toolResults: Array<{ call_id: string; name: string; result: Record<string, unknown> }>;
  /** 1 for the first round the server saw in this test, 2 for the next... */
  index: number;
}

/** A reply fixed in advance, or one built from the round it answers (e.g. to echo a call id). */
export type ReplySource = Reply | ((round: Round) => Reply);

const USAGE = { input_tokens: 1200, output_tokens: 40, reasoning_tokens: 0, cost_usd: 0 };

/** The `result` of a round that ends in words. */
export function textResult(text: string): RoundResult {
  return {
    kind: "text",
    pending_calls: [],
    final_text: text,
    error: "",
    finish_reason: "stop",
    usage: { ...USAGE },
    provider_snapshot: {},
  };
}

let callSeq = 0;
/** The `result` of a round that asks the app to run tools. Call ids are unique per test run. */
export function toolCallsResult(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  rationale = "",
): RoundResult {
  return {
    kind: "tool_calls",
    pending_calls: calls.map((c, i) => ({
      call_id: `call_qa_${++callSeq}`,
      name: c.name,
      arguments: c.arguments,
      ...(i === 0 && rationale ? { rationale } : {}),
    })),
    final_text: "",
    error: "",
    finish_reason: "tool_calls",
    usage: { ...USAGE },
    provider_snapshot: {},
  };
}

/** The `result` of a round the provider failed (a refusal, a timeout), as the server reports it. */
export function errorResult(error: string, errorCode?: string): RoundResult {
  return {
    kind: "error",
    pending_calls: [],
    final_text: "",
    error,
    ...(errorCode ? { error_code: errorCode } : {}),
    finish_reason: "error",
    usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    provider_snapshot: {},
  };
}

/** Words as the model streams them: one delta per word (with its trailing space). */
export function wordsOf(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** A streamed answer in words: a delta per word, `gapMs` apart, then the result. `usage` is what the
 *  round reports (the context meter reads `input_tokens`); `refusedFrames` names pictures the
 *  provider refused, as the server reports them after it searched (UJ-046). */
export function say(
  text: string,
  opts: {
    gapMs?: number;
    firstTokenMs?: number;
    usage?: RoundResult["usage"];
    refusedFrames?: RoundResult["refused_frames"];
  } = {},
): Reply {
  const steps: Step[] = [];
  if (opts.firstTokenMs) steps.push({ wait: opts.firstTokenMs });
  for (const w of wordsOf(text)) {
    steps.push({ delta: w });
    if (opts.gapMs) steps.push({ wait: opts.gapMs });
  }
  const result: RoundResult = { ...textResult(text) };
  if (opts.usage) result.usage = { ...result.usage, ...opts.usage };
  if (opts.refusedFrames) result.refused_frames = opts.refusedFrames;
  steps.push({ result });
  return { kind: "stream", steps, note: `says ${JSON.stringify(text.slice(0, 40))}` };
}

/** The call ids a scripted tool-call reply will hand the app, in order. */
export function callIdsOf(reply: Reply): string[] {
  if (reply.kind !== "stream") return [];
  const last = reply.steps.find((s): s is Extract<Step, { result: unknown }> => "result" in s);
  return (last?.result.pending_calls ?? []).map((c) => c.call_id);
}

/** A round that streams a little prose (optional), then asks for these tool calls. */
export function callTools(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  prose = "",
): Reply {
  const steps: Step[] = wordsOf(prose).map((w) => ({ delta: w }));
  steps.push({ result: toolCallsResult(calls, prose) });
  return { kind: "stream", steps, note: `calls ${calls.map((c) => c.name).join(", ")}` };
}

/** A plain HTTP answer with the server's error shape, `{"detail": ...}`. */
export function httpAnswer(status: number, detail: unknown, delayMs?: number): Reply {
  return {
    kind: "http",
    status,
    body: { detail },
    ...(delayMs ? { delayMs } : {}),
    note: `answers HTTP ${status}`,
  };
}

/** Any stream, step by step. */
export function stream(note: string, ...steps: Step[]): Reply {
  return { kind: "stream", steps, note };
}
