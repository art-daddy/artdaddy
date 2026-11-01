// What the person is told when a turn fails, and whether trying again can help. Pure.
//
// A failure that ends a turn used to be shown by `toUserMessage`, which knows only the errors we typed:
// a round that timed out, a stream that went quiet and any HTTP status we had not typed all read
// "Something went wrong. Please try again.", the careful sentence thrown away. People re-sent the same brief
// three to five times (UJ-053). Every failure now says what happened in plain words, whether the project
// is safe, and what to do next.
//
// A sentence never claims "nothing was charged" unless it is true: it is said only where the server refused
// before it dispatched anything.
import { ArtDaddyError } from "../lib/errors";
import { CREDIT_LIMIT } from "../lib/outOfCredits";

export interface Described {
  message: string;
  /** Whether sending the same round again can help. It decides whether "Try again" is offered. */
  retryable: boolean;
}

const REPORT = 'use "Report this problem" below';

/** What the server's own answers mean on the agent's route, by the `detail.error` it sends. The codes are
 *  checked against the server's source (tests/unit/server/test_client_failure_copy.py). */
export const ROUND_SERVER_CODES: Readonly<Record<string, Described>> = {
  metering_unavailable: {
    message:
      "ArtDaddy couldn't check your credit balance just now, so the request was not sent and nothing was charged. Try again in a moment.",
    retryable: true,
  },
  catalog_unavailable: {
    message:
      "ArtDaddy's tool list couldn't be loaded just now. Your project is safe. Try again in a moment.",
    retryable: true,
  },
  missing_paid_request_context: {
    message: "This version of the app sent an incomplete request. Update ArtDaddy and try again.",
    retryable: false,
  },
  account_busy: {
    message: "ArtDaddy is still finishing your previous request. Wait a moment, then try again.",
    retryable: true,
  },
  server_busy: {
    message: "ArtDaddy is very busy right now. Wait a moment, then try again.",
    retryable: true,
  },
  model_not_allowed: {
    message:
      "The AI model you picked isn't available right now. Choose another one in the model menu and send your message again.",
    retryable: false,
  },
  invalid_request: {
    message: `The app sent a request the service couldn't read. Update ArtDaddy, and if you are up to date ${REPORT}.`,
    retryable: false,
  },
  request_too_large: {
    message: "That request was too big to send. Remove some attachments, or start a new chat.",
    retryable: false,
  },
  internal_error: {
    message: `The service ran into a problem. Your project is safe. Try again in a moment, and if it keeps happening ${REPORT}.`,
    retryable: true,
  },
};

/** The server's codes with their own typed error on the client (a credit limit, an update, a session), which
 *  never reach {@link describeHttpFailure} because the sender throws that error instead. Listed so the
 *  conformance test can tell "handled elsewhere" from "forgotten". */
export const TYPED_ELSEWHERE: readonly string[] = [
  "credit_limit_reached",
  "client_update_required",
];

const STATUS_RESTARTING: Described = {
  message:
    "ArtDaddy's service is restarting or overloaded. Your project is safe. Try again in a moment.",
  retryable: true,
};

/** The sentence for an HTTP answer: by the server's own code when it sent one we know, else by what the
 *  status says. Every status has one, so no answer reads as a shrug. */
export function describeHttpFailure(status: number, serverCode: string | null): Described {
  if (serverCode !== null && Object.prototype.hasOwnProperty.call(ROUND_SERVER_CODES, serverCode))
    return ROUND_SERVER_CODES[serverCode];
  if (status === 404 || status === 405)
    return {
      message: "ArtDaddy's service is being updated. Try again in a minute.",
      retryable: true,
    };
  if (status === 408 || status === 502 || status === 503 || status === 504)
    return STATUS_RESTARTING;
  if (status === 413)
    return {
      message: "That request was too big to send. Remove some attachments, or start a new chat.",
      retryable: false,
    };
  if (status >= 400 && status < 500)
    return {
      message: `The service refused the request. Update ArtDaddy, and if you are up to date ${REPORT}.`,
      retryable: false,
    };
  return ROUND_SERVER_CODES.internal_error;
}

/** The server's code from a failed answer's body: `{"detail": {"error": "<code>"}}`, else null. */
export function serverCodeOf(body: string): string | null {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
    const code =
      detail && typeof detail === "object" ? (detail as { error?: unknown }).error : null;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** An HTTP answer that ended a round without a typed error of its own. The message keeps the shape
 *  `<status>: <body>` that crash grouping and `turnErrorCode` read; the person is shown `userMessage`. */
export class RoundHttpError extends ArtDaddyError {
  readonly code: string;
  /** A refusal the server chose (a code it sends) or an overloaded gateway is not a crash. */
  readonly expected: boolean;

  constructor(
    readonly status: number,
    readonly serverCode: string | null,
    body: string,
  ) {
    super(`${status}: ${body}`);
    this.name = "RoundHttpError";
    this.code = serverCode ?? `http_${status}`;
    this.expected =
      (serverCode !== null &&
        Object.prototype.hasOwnProperty.call(ROUND_SERVER_CODES, serverCode)) ||
      [408, 502, 503, 504].includes(status);
  }

  get userMessage(): string {
    return describeHttpFailure(this.status, this.serverCode).message;
  }
}

/** Errors that already carry their own sentence but should not be offered "Try again": it would only
 *  fail the same way (no credits, an update is needed, the session is gone). */
const NOT_RETRYABLE = new Set([
  CREDIT_LIMIT,
  "credit_request_unaffordable",
  "client_update_required",
  "session_expired",
]);

const FALLBACK: Described = {
  message: `That didn't work, and we couldn't tell why. Your project is safe. Try again, and if it keeps happening ${REPORT}.`,
  retryable: true,
};

/** What to tell the person about a failure that ended a turn, and whether to offer "Try again". The
 *  classes are told apart by name where their module cannot be imported here without a cycle. */
export function describeTurnFailure(error: unknown): Described {
  if (error instanceof RoundHttpError) return describeHttpFailure(error.status, error.serverCode);
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "RoundTimeoutError") {
    const minutes = Math.max(1, Math.round(Number((error as { ms?: unknown }).ms) / 60_000) || 10);
    return {
      message: `The AI didn't answer within ${minutes} minute${minutes === 1 ? "" : "s"}, so the request was stopped. Nothing was changed. Try again.`,
      retryable: true,
    };
  }
  if (name === "StreamStalledError") {
    const idle = Math.round(Number((error as { idleMs?: unknown }).idleMs) / 1000);
    const how =
      Number.isFinite(idle) && idle > 0 ? `nothing arrived for ${idle} seconds` : "nothing arrived";
    return {
      message: `The connection to the AI was lost: ${how}. Nothing was changed. Try again.`,
      retryable: true,
    };
  }
  if (error instanceof ArtDaddyError)
    return { message: error.userMessage, retryable: !NOT_RETRYABLE.has(error.code) };
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message))
    return {
      message: "Couldn't reach the server. Check your connection and try again.",
      retryable: true,
    };
  return FALLBACK;
}
