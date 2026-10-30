// The app's side of the order desk (the server's orders.py).
//
// A generation is an ORDER with a number the app makes. The server keeps the order and, when it is made, the finished file, for
// seven days; the app asks whether it is ready and collects it. Closing the app, losing the connection or restarting the server
// in the middle therefore loses nothing, and sending the same order again is the same order, never a second charge.
//
//   POST /ai/{name} + order_id   202 {order}  accepted        (200 {order}: already known; 200 {result,...}: answered inline)
//   GET  /orders/{id}            {order}      where it stands  (404: the server has no such order)
//   POST /orders/{id}/ack        {order}      the app has the file: the server deletes it
//
// An order is never given up on the app's own authority. A dropped connection, an unreachable server, a lapsed sign-in all mean
// "ask again later", because the order goes on without us; only the server's verdict (failed, expired, not found) ends the wait.
import { ArtDaddyError } from "../lib/errors";
import { ClientUpdateRequiredError } from "../update/updater";
import { fetchCompatibleClient } from "../update/compatibility";
import { authedFetch, notifyAuthFailure } from "./auth";
import { apiBase } from "./config";
import { fetchWithRetry } from "./http";

/** The numbers the server accepts: the same rule as its `ORDER_ID`. */
export const ORDER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export type OrderState = "running" | "ready" | "failed" | "collected" | "expired";

export interface OrderResultLink {
  /** A private link to the result, good for a few minutes (ask again for a fresh one). */
  url: string;
  bytes: number;
  content_type: string;
  expires_at: number;
}

export interface OrderFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface OrderView {
  order_id: string;
  state: OrderState;
  created_at: number;
  updated_at: number;
  result?: OrderResultLink;
  charged_credits?: number;
  error?: OrderFailure;
}

export interface ReadyOrder extends OrderView {
  state: "ready";
  result: OrderResultLink;
  charged_credits: number;
}

/** A fresh order number. */
export function newOrderId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `${Date.now().toString(16).padStart(12, "0")}${hex()}${hex()}`.slice(0, 32);
}

// ── what can end an order, and what only means "ask again" ─────────────────────────────────────────────────────────────

/** The server's verdict: the order failed. Carries the server's own code, words and advice. */
export class OrderFailedError extends ArtDaddyError {
  readonly code: string;
  readonly expected = true;
  constructor(
    message: string,
    code = "generation_failed",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OrderFailedError";
    this.code = code;
  }
}

/** The server has no such order. */
export class OrderNotFoundError extends ArtDaddyError {
  readonly code = "order_not_found";
  readonly expected = true;
  constructor(readonly orderId: string) {
    super("The server has no record of this generation.");
    this.name = "OrderNotFoundError";
  }
}

/** The finished result was not collected in time (or the file is gone) and has been removed. It was charged. */
export class OrderExpiredError extends ArtDaddyError {
  readonly code = "order_expired";
  readonly expected = true;
  constructor() {
    super(
      "This finished while the app was away and was not collected within seven days, so it was removed. " +
        "The credits for it were charged.",
    );
    this.name = "OrderExpiredError";
  }
}

/** The result was already taken, by this project in another window or an earlier run. */
export class OrderCollectedError extends ArtDaddyError {
  readonly code = "order_collected";
  readonly expected = true;
  constructor() {
    super("This result was already received by the app, so there is nothing more to collect.");
    this.name = "OrderCollectedError";
  }
}

/** The app cannot ask the server about the order right now (this build must be updated), but the order itself is fine and will
 *  be picked up by the next run. The caller leaves it alone. */
export class OrderWaitSuspended extends ArtDaddyError {
  readonly code = "order_wait_suspended";
  readonly expected = true;
  constructor() {
    super("This build must be updated before it can ask about a generation that is still being made.");
    this.name = "OrderWaitSuspended";
  }
}

/** The server could not be reached or did not answer usefully: ask again later. Never the end of an order. */
export class OrderUnreachableError extends Error {
  constructor(
    message: string,
    readonly reason: "session" | "server" | "unreadable",
  ) {
    super(message);
    this.name = "OrderUnreachableError";
  }
}

// ── pacing (mutable so tests need not really wait) ─────────────────────────────────────────────────────────────────────

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const orderPolling = {
  sleep: abortableSleep as (ms: number, signal?: AbortSignal) => Promise<void>,
};

export function __resetOrderPolling(): void {
  orderPolling.sleep = abortableSleep;
  accepted.clear();
}

/** How long to wait before asking about a still-running order again (``attempt`` counts the answers so far): quick at first,
 *  because a result usually lands within seconds, then every few seconds, and never slower than ten, so a finished result is
 *  never more than ten seconds late. */
export function pollDelayMs(attempt: number): number {
  if (attempt < 3) return 1500;
  if (attempt < 10) return 3000;
  if (attempt < 40) return 5000;
  return 10_000;
}

/** How long to wait after the server could not be reached ``failures`` times in a row. */
function retryDelayMs(failures: number): number {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, failures - 1));
}

/** How long to wait when the sign-in has lapsed: the app is already asking the person to sign in again. */
const SIGNED_OUT_DELAY_MS = 15_000;

// ── reading what the server says ──────────────────────────────────────────────────────────────────────────────────────

const STATES: readonly OrderState[] = ["running", "ready", "failed", "collected", "expired"];

function unreadable(): OrderUnreachableError {
  return new OrderUnreachableError("The server's answer about an order could not be understood.", "unreadable");
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === "string";

/** An order as the server says it, or an error when what came back is not one. */
export function parseOrderView(raw: unknown): OrderView {
  const o = (raw as { order?: unknown } | null)?.order as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object" || !isString(o.order_id) || !STATES.includes(o.state as OrderState)) throw unreadable();
  if (!isNumber(o.created_at) || !isNumber(o.updated_at)) throw unreadable();
  const view: OrderView = {
    order_id: o.order_id,
    state: o.state as OrderState,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
  if (view.state === "ready") {
    const r = o.result as Record<string, unknown> | undefined;
    if (!r || !isString(r.url) || !isNumber(r.bytes) || !isString(r.content_type) || !isNumber(r.expires_at)) throw unreadable();
    if (!isNumber(o.charged_credits)) throw unreadable();
    view.result = { url: r.url, bytes: r.bytes, content_type: r.content_type, expires_at: r.expires_at };
    view.charged_credits = o.charged_credits;
  } else if (view.state === "collected" || view.state === "expired") {
    if (!isNumber(o.charged_credits)) throw unreadable();
    view.charged_credits = o.charged_credits;
  } else if (view.state === "failed") {
    const e = o.error as Record<string, unknown> | undefined;
    if (!e || !isString(e.message)) throw unreadable();
    view.error = {
      code: isString(e.code) ? e.code : "generation_failed",
      message: e.message,
      retryable: e.retryable === true,
    };
  }
  return view;
}

function orderUrl(orderId: string, suffix = ""): string {
  return `${apiBase()}/orders/${encodeURIComponent(orderId)}${suffix}`;
}

/** Where an order stands, right now. */
export async function getOrder(orderId: string, signal?: AbortSignal): Promise<OrderView> {
  let res: Response;
  try {
    res = await authedFetch(orderUrl(orderId), { method: "GET" }, (u, i) => fetchCompatibleClient(u, { ...i, signal }));
  } catch (e) {
    if (e instanceof ClientUpdateRequiredError || signal?.aborted) throw e;
    throw new OrderUnreachableError(e instanceof Error ? e.message : String(e), "server");
  }
  if (res.status === 426) throw new ClientUpdateRequiredError();
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    throw new OrderUnreachableError("The session has lapsed.", "session");
  }
  if (res.status === 404) throw new OrderNotFoundError(orderId);
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel().catch(() => undefined);
    throw new OrderUnreachableError(`The server answered ${res.status}.`, "server");
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text().catch(() => "")) || res.statusText}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw unreadable();
  }
  return parseOrderView(body);
}

/** Ask about an order until the server answers, however long that takes: an unreachable server or a dropped connection is waited
 *  out with a growing pause, and a lapsed session asks the person to sign in once and is then asked again every so often. Throws
 *  only what means something about the order (`OrderNotFoundError`) or the build (`OrderWaitSuspended`). */
async function askUntilAnswered(orderId: string, signal?: AbortSignal): Promise<OrderView> {
  let failures = 0;
  let toldToSignIn = false;
  for (;;) {
    try {
      return await getOrder(orderId, signal);
    } catch (e) {
      if (e instanceof ClientUpdateRequiredError) throw new OrderWaitSuspended();
      if (!(e instanceof OrderUnreachableError)) throw e;
      if (e.reason === "session") {
        if (!toldToSignIn) {
          toldToSignIn = true;
          notifyAuthFailure();
        }
        await orderPolling.sleep(SIGNED_OUT_DELAY_MS, signal);
      } else {
        failures += 1;
        await orderPolling.sleep(retryDelayMs(failures), signal);
      }
    }
  }
}

/** Whether the server has this order, asking until it can say. For a submit whose answer was lost: the order exists if the
 *  request got there, and sending it again would be a second attempt at something that may already be running. */
export async function orderKnownToServer(orderId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await askUntilAnswered(orderId, signal);
    return true;
  } catch (e) {
    if (e instanceof OrderNotFoundError) return false;
    throw e;
  }
}

/** Wait for an order to be ready and give it back. Throws the server's verdict if it failed, expired or was already collected,
 *  or `OrderNotFoundError`; throws `OrderWaitSuspended` when this build may no longer ask. Otherwise it keeps asking: nothing
 *  that only means the server is out of reach ends it. */
export async function waitForOrder(orderId: string, opts: { signal?: AbortSignal } = {}): Promise<ReadyOrder> {
  const { signal } = opts;
  for (let answers = 0; ; answers += 1) {
    const view = await askUntilAnswered(orderId, signal);
    switch (view.state) {
      case "ready":
        return view as ReadyOrder;
      case "failed":
        throw new OrderFailedError(view.error!.message, view.error!.code, view.error!.retryable);
      case "expired":
        throw new OrderExpiredError();
      case "collected":
        throw new OrderCollectedError();
      case "running":
        await orderPolling.sleep(pollDelayMs(answers), signal);
    }
  }
}

/** The finished result, exactly as the live call would have returned it (`{result, media?, metrics?}`). Fetches the private link,
 *  asking for a fresh one if it has expired. The link carries its own permission, so the account's token is NOT sent to it. */
export async function downloadOrderResult(ready: ReadyOrder, signal?: AbortSignal): Promise<unknown> {
  let view = ready;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetchWithRetry(view.result.url, { method: "GET" }, signal, { transientRetries: 3 });
    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const result = (body as { result?: unknown } | null)?.result;
      if (!body || typeof body !== "object" || Array.isArray(body) || !result || typeof result !== "object")
        throw new Error("The finished result could not be read.");
      return body;
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 403 && res.status !== 404)
      throw new Error(`The finished result could not be downloaded (${res.status}).`);
    // The link has expired, or the file is gone: only the server can say which.
    const fresh = await getOrder(view.order_id, signal).catch((e: unknown) => {
      if (e instanceof OrderUnreachableError) throw new Error("The finished result could not be downloaded.");
      throw e;
    });
    if (fresh.state === "collected") throw new OrderCollectedError();
    if (fresh.state !== "ready") throw new OrderExpiredError();
    view = fresh as ReadyOrder;
  }
  throw new Error("The finished result could not be downloaded.");
}

/** Tell the server the app has the file, so it can delete it. Never throws: the file is simply kept until it expires if this
 *  cannot be said. An order the server never had has nothing to confirm. */
export async function ackOrder(orderId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await authedFetch(orderUrl(orderId, "/ack"), { method: "POST" }, (u, i) => fetchCompatibleClient(u, i));
      await res.body?.cancel().catch(() => undefined);
      if (res.ok || res.status === 404) return true;
    } catch {
      /* a dropped connection: try again */
    }
    await orderPolling.sleep(1000 * (attempt + 1)).catch(() => undefined);
  }
  return false;
}

// ── which orders the server took ──────────────────────────────────────────────────────────────────────────────────────

/** Orders the server answered with an order for. A call it answered inline (an older server, or one with nowhere to keep results)
 *  was never an order, so there is nothing to confirm for it. */
const accepted = new Set<string>();

export function markOrderAccepted(orderId: string): void {
  accepted.add(orderId);
}

export function isAcceptedOrder(orderId: string): boolean {
  return accepted.has(orderId);
}

/** Confirm receipt of an order this process submitted, if the server took it as one. */
export async function acknowledgeAcceptedOrder(orderId: string): Promise<void> {
  if (!accepted.has(orderId)) return;
  if (await ackOrder(orderId)) accepted.delete(orderId);
}
