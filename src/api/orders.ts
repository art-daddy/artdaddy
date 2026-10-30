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
import { RateLimitError } from "./http";
import { CreditLimitError } from "./usage";

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

/** What the server says about the balance when it refused an order for lack of credit: the credit amounts and which pool ran out,
 *  exactly as the live call's 402 carries them. Only finite, non-negative numbers and a known scope are ever kept. */
export interface CreditRefusalDetail {
  scope?: "user" | "global";
  used?: number;
  limit?: number;
  requested?: number;
  remaining?: number;
}

export interface OrderFailure {
  code: string;
  message: string;
  retryable: boolean;
  /** Only on a refusal for credit, and only when the server said something usable about the balance. */
  detail?: CreditRefusalDetail;
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
    readonly detail?: CreditRefusalDetail,
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

/** The finished result could not be read as a result: what the server holds is broken, so asking again cannot help. */
export class OrderResultUnreadableError extends ArtDaddyError {
  readonly code = "order_result_unreadable";
  readonly expected = true;
  constructor() {
    super("The finished result could not be read.");
    this.name = "OrderResultUnreadableError";
  }
}

/** The server says the result is ready, and has been charged for it, but the app has not been able to fetch it for a long time.
 *  Not a verdict, so not the end of the order: whoever waits leaves it as it is and the next run asks again. */
export class OrderResultUnavailableError extends Error {
  constructor() {
    super("The finished result could not be downloaded just now.");
    this.name = "OrderResultUnavailableError";
  }
}

/** The server's own word on an order: the only things that end a job once the server has taken the order. Anything else that goes
 *  wrong afterwards (a dropped connection, a link that ran out, a full disk) is the app's own trouble, and the result, which has
 *  been charged for, is still there to be collected. The rate and credit limits are verdicts too, as the tools translate them. */
export function isOrderVerdict(e: unknown): boolean {
  return (
    e instanceof OrderFailedError ||
    e instanceof OrderNotFoundError ||
    e instanceof OrderExpiredError ||
    e instanceof OrderCollectedError ||
    e instanceof OrderResultUnreadableError ||
    e instanceof RateLimitError ||
    e instanceof CreditLimitError
  );
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

const CREDIT_NUMBERS = ["used", "limit", "requested", "remaining"] as const;

/** The numbers of a credit refusal, or nothing when there is nothing usable in what the server sent. */
function parseCreditDetail(raw: unknown): CreditRefusalDetail | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const detail: CreditRefusalDetail = {};
  for (const key of CREDIT_NUMBERS) {
    const value = r[key];
    if (isNumber(value) && value >= 0) detail[key] = value;
  }
  if (r.scope === "user" || r.scope === "global") detail.scope = r.scope;
  return Object.keys(detail).length > 0 ? detail : undefined;
}

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
    const detail = parseCreditDetail(e.detail);
    view.error = {
      code: isString(e.code) ? e.code : "generation_failed",
      message: e.message,
      retryable: e.retryable === true,
      ...(detail ? { detail } : {}),
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
  if (res.status === 404) {
    // Only the server's own "no such order" is a verdict about the order. A 404 from anything else (a gateway, a deploy in progress,
    // the wrong server) says nothing about it, and an order is paid for: it is waited out, never written off.
    if (await isOrderNotFoundAnswer(res)) throw new OrderNotFoundError(orderId);
    throw new OrderUnreachableError("The server answered 404 without saying the order is gone.", "server");
  }
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

/** Whether a 404 is the server saying, in its own words, that it has no such order. */
async function isOrderNotFoundAnswer(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { detail?: { error?: unknown } } | null;
    return body?.detail?.error === "order_not_found";
  } catch {
    return false;
  }
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

/** How long a request whose answer was lost is given to reach the server before the order is called unknown: the request that made it
 *  may only have been slow, and an order that appears later would be paid for with nobody waiting for it. */
export const LOST_SUBMIT_GRACE_MS = 5000;

/** Whether the server has this order, asking until it can say. For a submit whose answer was lost: the order exists if the
 *  request got there, and sending it again would be a second attempt at something that may already be running. Not having it is
 *  said only after one more ask, a little later, because the request may still have been on its way. */
export async function orderKnownToServer(orderId: string, signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await askUntilAnswered(orderId, signal);
      return true;
    } catch (e) {
      if (!(e instanceof OrderNotFoundError)) throw e;
      if (attempt > 0) return false;
      await orderPolling.sleep(LOST_SUBMIT_GRACE_MS, signal);
    }
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
        throw new OrderFailedError(view.error!.message, view.error!.code, view.error!.retryable, view.error!.detail);
      case "expired":
        throw new OrderExpiredError();
      case "collected":
        throw new OrderCollectedError();
      case "running":
        await orderPolling.sleep(pollDelayMs(answers), signal);
    }
  }
}

/** After this many answers in a row that the link does not work, while the server still says the order is ready, the app stops
 *  trying for now and the next run tries again. A ready order whose file is really gone is ended by the server's own verdict long
 *  before this. */
const LINK_REFRESHES = 10;
/** The same for a download that keeps failing in transit: about ten minutes of trying at the longest pause. */
const TRANSIT_FAILURES = 20;

type Attempt =
  | { kind: "done"; body: unknown }
  | { kind: "retry" } // the network, or a server that is busy
  | { kind: "refresh" } // the link does not (or no longer) work: ask for a fresh one
  | { kind: "refused"; status: number };

/** One try at the private link. The link carries its own permission, so no account token goes to it; and the build compatibility
 *  gate, which guards calls to our own server, does not apply to reading a file that has already been paid for. */
async function attemptDownload(url: string, signal?: AbortSignal): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { kind: "retry" };
  }
  if (res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      return { kind: "retry" }; // the connection died before the end of the answer
    }
    const result = (body as { result?: unknown } | null)?.result;
    if (!body || typeof body !== "object" || Array.isArray(body) || !result || typeof result !== "object")
      throw new OrderResultUnreadableError();
    return { kind: "done", body };
  }
  await res.body?.cancel().catch(() => undefined);
  // Google answers 400 for a link that ran out and 403 for one that does not fit the file; 404 for a file that is not there (yet).
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) return { kind: "refresh" };
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry" };
  return { kind: "refused", status: res.status };
}

/** The finished result, exactly as the live call would have returned it (`{result, media?, metrics?}`). The order is ready, so it
 *  has been charged for: this is as patient as the wait for it was. A dropped connection, a busy server, an answer cut off and a
 *  link that ran out are all waited out (asking the server for a fresh link as often as it takes), and only the server's own
 *  verdict, or a result that cannot be read as one, ends it. If it still cannot be fetched after a long time the order is left as
 *  it is (`OrderResultUnavailableError`) for the next run, never given up on. */
export async function downloadOrderResult(ready: ReadyOrder, signal?: AbortSignal): Promise<unknown> {
  let view = ready;
  let failures = 0;
  let refreshes = 0;
  for (;;) {
    const attempt = await attemptDownload(view.result.url, signal);
    if (attempt.kind === "done") return attempt.body;
    if (attempt.kind === "refused") throw new Error(`The finished result could not be downloaded (${attempt.status}).`);
    if (attempt.kind === "retry") {
      refreshes = 0;
      failures += 1;
      if (failures > TRANSIT_FAILURES) throw new OrderResultUnavailableError();
      await orderPolling.sleep(retryDelayMs(failures), signal);
      if (failures % 3 !== 0) continue; // every third failure, also ask whether the link needs replacing
    } else {
      refreshes += 1;
      if (refreshes > LINK_REFRESHES) throw new OrderResultUnavailableError();
      if (refreshes > 1) await orderPolling.sleep(1000, signal);
    }
    // The server's answer decides whether this is still worth trying (a fresh link) or over (it says so).
    const fresh = await askUntilAnswered(view.order_id, signal);
    if (fresh.state === "ready") view = fresh as ReadyOrder;
    else if (fresh.state === "collected") throw new OrderCollectedError();
    else if (fresh.state === "expired") throw new OrderExpiredError();
    else if (fresh.state === "failed")
      throw new OrderFailedError(fresh.error!.message, fresh.error!.code, fresh.error!.retryable, fresh.error!.detail);
    // "running" cannot follow "ready"; were it to, the old link is simply tried again
  }
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
