// The paid side of the fake ArtDaddy server, for the generation and billing lanes: the price quote
// (POST /ai/{name}/quote), the paid proxies (POST /ai/{name}), and the order desk the app collects a
// finished generation from (GET /orders/{id}, POST /orders/{id}/ack, and the private link to the
// result). Nothing here calls anything: every answer is scripted by the test, and a paid call that
// arrives with no answer scripted fails the test, so an extra paid request (a duplicate, a retry
// nobody asked for) cannot pass unnoticed.
//
// The quote and the paid calls ride the fake server's real socket (its `aiAnswer` hook). The order
// desk and the result link are answered inside the page's network layer (`page.route`) on the same
// origin, because the agent lane's fake server answers only the routes it knows: the shapes are the
// ones the app reads (src/api/orders.ts, src/api/quote.ts, src/api/ai.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Page, Route } from "@playwright/test";

import type { FakeArtDaddy } from "../../agent-and-models/lib/fakeServer";

const MEDIA = path.resolve("e2e/ui/agent-and-models/fixtures/media");

/** What the paid call answers with when it is done: the live call's `{result, media?}`. */
export interface Answer {
  result: Record<string, unknown>;
  media?: Array<{ b64: string; ext?: string; kind?: string; model?: string }>;
}

/** How the server takes the next paid call to one proxy. */
export type Outcome =
  /** Answered at once with the finished result (a server that keeps no orders). */
  | { kind: "inline"; answer: Answer }
  /** Taken as an order (202). It stays running until the test calls `finish` or `fail`, or is
   *  ready at once when `ready` is set. With `lostAnswer` the server makes the order and then
   *  fails to say so (it answers 503), as a server that dies after taking the call would. */
  | { kind: "order"; answer: Answer; ready?: boolean; charged?: number; lostAnswer?: boolean }
  /** A plain HTTP answer with the server's error shape, `{"detail": ...}` (a 402, a 429...). */
  | { kind: "http"; status: number; detail: unknown };

export interface PaidCall {
  proxy: string;
  body: Record<string, unknown>;
  orderId?: string;
  status: number;
  at: number;
  /** The same order number again: the server answers with the order it has, never a second one. */
  repeat?: boolean;
}

export interface QuoteAsk {
  proxy: string;
  args: Record<string, unknown>;
  status: number;
  at: number;
}

type OrderState = "running" | "ready" | "failed" | "collected" | "expired";

export interface Order {
  id: string;
  proxy: string;
  state: OrderState;
  answer: Answer;
  charged: number;
  error?: { code: string; message: string; retryable: boolean; detail?: unknown };
  createdAt: number;
  updatedAt: number;
  /** How often the app asked where it stands, fetched its result, and said it has the file. */
  polls: number;
  downloads: number;
  acks: number;
  /** When the app said it has the file (performance.now() in the test process). */
  ackedAt?: number;
  /** The private link is fetched with no account token: it carries its own permission. */
  linkSawToken: boolean;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Request-ID, Retry-After",
};

const nowS = (): number => Date.now() / 1000;

export class GenDesk {
  /** Every paid call (not the quote), in order. */
  readonly paid: PaidCall[] = [];
  /** Paid calls that arrived with no outcome scripted for their proxy. A test that leaves any fails. */
  readonly unscripted: PaidCall[] = [];
  /** Every price question, in order. */
  readonly quotes: QuoteAsk[] = [];
  readonly orders = new Map<string, Order>();
  /** What the quote answers, by proxy: credits, or an HTTP status to fail with. Unset: 404. */
  quote: Record<string, number | { status: number }> = {};

  /** Questions about orders the desk never had (answered "no such order"). */
  unknownAsks = 0;

  private readonly outcomes = new Map<string, Outcome[]>();

  constructor(
    private readonly server: FakeArtDaddy,
    private readonly origin = server.origin,
  ) {}

  /** Take over the fake server's paid routes, and answer the order desk inside `page`. Call before
   *  the app loads. */
  async install(page: Page): Promise<void> {
    this.server.aiAnswer = (name, body) => this.answerAi(name, body);
    await page.route(`${this.origin}/orders/**`, (route) => this.answerOrder(route));
    await page.route(`${this.origin}/qa-results/**`, (route) => this.answerLink(route));
  }

  /** Queue how the next paid calls to `proxy` are taken, in order. */
  next(proxy: string, ...outcomes: Outcome[]): void {
    const q = this.outcomes.get(proxy) ?? [];
    q.push(...outcomes);
    this.outcomes.set(proxy, q);
  }

  /** Paid calls to one proxy (`generate_image`, `generate_video`, `voiceover`, `music`). */
  calls(proxy?: string): PaidCall[] {
    return this.paid.filter((c) => !proxy || c.proxy === proxy);
  }

  /** The only order, or the one with this number. */
  order(id?: string): Order {
    const all = [...this.orders.values()];
    const found = id ? this.orders.get(id) : all.length === 1 ? all[0] : undefined;
    if (!found) throw new Error(`no such order (${id ?? `${all.length} orders`})`);
    return found;
  }

  /** The order is made: the next time the app asks, it is ready, and charged `charged` credits. */
  finish(id?: string, charged?: number): void {
    const o = this.order(id);
    o.state = "ready";
    if (charged !== undefined) o.charged = charged;
    o.updatedAt = nowS();
  }

  /** The order failed, in the server's words. A failed order is never charged. */
  fail(
    message: string,
    opts: { id?: string; code?: string; retryable?: boolean; detail?: unknown } = {},
  ): void {
    const o = this.order(opts.id);
    o.state = "failed";
    o.charged = 0;
    o.error = {
      code: opts.code ?? "generation_failed",
      message,
      retryable: opts.retryable ?? false,
      ...(opts.detail ? { detail: opts.detail } : {}),
    };
    o.updatedAt = nowS();
  }

  private answerAi(name: string, body: unknown): { status: number; body: unknown } {
    const b = (body ?? {}) as Record<string, unknown>;
    if (name.endsWith("/quote")) {
      const proxy = name.slice(0, -"/quote".length);
      const priced = this.quote[proxy];
      const status = priced === undefined ? 404 : typeof priced === "number" ? 200 : priced.status;
      this.quotes.push({
        proxy,
        args: (b.args ?? {}) as Record<string, unknown>,
        status,
        at: performance.now(),
      });
      if (typeof priced === "number") return { status, body: { priced: true, credits: priced } };
      return {
        status,
        body: { detail: { error: status === 404 ? "not_found" : "internal_error" } },
      };
    }
    const orderId = typeof b.order_id === "string" ? b.order_id : undefined;
    const call: PaidCall = { proxy: name, body: b, orderId, status: 0, at: performance.now() };
    this.paid.push(call);
    const known = orderId ? this.orders.get(orderId) : undefined;
    if (known) {
      // The same order number again is the same order: answered with what the server holds.
      call.repeat = true;
      call.status = 200;
      return { status: 200, body: { order: this.view(known) } };
    }
    const outcome = this.outcomes.get(name)?.shift();
    if (!outcome) {
      this.unscripted.push(call);
      call.status = 500;
      return { status: 500, body: { detail: { error: "internal_error" } } };
    }
    if (outcome.kind === "http") {
      call.status = outcome.status;
      return { status: outcome.status, body: { detail: outcome.detail } };
    }
    if (outcome.kind === "inline" || !orderId) {
      call.status = 200;
      return { status: 200, body: outcome.answer };
    }
    const t = nowS();
    const order: Order = {
      id: orderId,
      proxy: name,
      state: outcome.ready ? "ready" : "running",
      answer: outcome.answer,
      charged: outcome.charged ?? 10,
      createdAt: t,
      updatedAt: t,
      polls: 0,
      downloads: 0,
      acks: 0,
      linkSawToken: false,
    };
    this.orders.set(orderId, order);
    if (outcome.lostAnswer) {
      call.status = 503;
      return { status: 503, body: { detail: { error: "internal_error" } } };
    }
    call.status = 202;
    return { status: 202, body: { order: this.view(order) } };
  }

  /** An order as the server reports it (`{order: {...}}`), by its state. */
  private view(o: Order): Record<string, unknown> {
    const base = {
      order_id: o.id,
      state: o.state,
      created_at: o.createdAt,
      updated_at: o.updatedAt,
    };
    if (o.state === "ready")
      return {
        ...base,
        charged_credits: o.charged,
        result: {
          url: `${this.origin}/qa-results/${encodeURIComponent(o.id)}`,
          bytes: JSON.stringify(o.answer).length,
          content_type: "application/json",
          expires_at: nowS() + 900,
        },
      };
    if (o.state === "collected" || o.state === "expired")
      return { ...base, charged_credits: o.charged };
    if (o.state === "failed") return { ...base, error: o.error };
    return base;
  }

  private async answerOrder(route: Route): Promise<void> {
    const req = route.request();
    const m = /\/orders\/([^/?#]+)(\/ack)?$/.exec(new URL(req.url()).pathname);
    const id = m ? decodeURIComponent(m[1]) : "";
    const o = this.orders.get(id);
    if (!o) {
      this.unknownAsks += 1;
      return route.fulfill({
        status: 404,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify({ detail: { error: "order_not_found" } }),
      });
    }
    if (m?.[2] && req.method() === "POST") {
      o.acks += 1;
      o.ackedAt ??= performance.now();
      if (o.state === "ready") o.state = "collected";
    } else o.polls += 1;
    await route.fulfill({
      status: 200,
      headers: CORS,
      contentType: "application/json",
      body: JSON.stringify({ order: this.view(o) }),
    });
  }

  private async answerLink(route: Route): Promise<void> {
    const req = route.request();
    const id = decodeURIComponent(new URL(req.url()).pathname.split("/").pop() ?? "");
    const o = this.orders.get(id);
    if (!o || o.state !== "ready") return route.fulfill({ status: 404, headers: CORS, body: "" });
    o.downloads += 1;
    if (req.headers().authorization) o.linkSawToken = true;
    await route.fulfill({
      status: 200,
      headers: CORS,
      contentType: "application/json",
      body: JSON.stringify(o.answer),
    });
  }
}

// ── finished results, built from real media ──────────────────────────────────────────────────

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A real 64x64 PNG (the agent lane's fixture) and its bytes. */
export const STILL_PNG = readFileSync(path.join(MEDIA, "still.png"));
/** A real two-second MP4 with its index (moov), as a finished render would be. */
export const TWO_SECOND_MP4 = readFileSync(path.join(MEDIA, "two_seconds.mp4"));

/** The image proxy's answer: `count` pictures. */
export function imageAnswer(count = 1, png: Uint8Array = STILL_PNG): Answer {
  return {
    result: { ok: true },
    media: Array.from({ length: count }, () => ({ b64: b64(png), ext: ".png", kind: "image" })),
  };
}

/** The video proxy's answer: one MP4. */
export function videoAnswer(mp4: Uint8Array = TWO_SECOND_MP4): Answer {
  return { result: { ok: true }, media: [{ b64: b64(mp4), ext: ".mp4", kind: "video" }] };
}

/** 16-bit mono PCM: a quiet 440 Hz tone, `seconds` long. */
export function pcmTone(seconds: number, rate = 24_000): Buffer {
  const n = Math.round(seconds * rate);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1)
    out.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return out;
}

/** The voice-over proxy's answer: raw PCM and its mime, as the vendor returns it. */
export function voiceAnswer(seconds = 1.5, rate = 24_000): Answer {
  return {
    result: {
      ok: true,
      pcm_b64: b64(pcmTone(seconds, rate)),
      mime: `audio/L16;codec=pcm;rate=${rate}`,
    },
  };
}

/** A WAV file of the tone, as Lyria 2 returns music. */
export function wavTone(seconds: number, rate = 48_000): Buffer {
  const pcm = pcmTone(seconds, rate);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** The music proxy's answer: a WAV of `seconds`. */
export function musicAnswer(seconds = 2): Answer {
  return { result: { ok: true, audio_b64: b64(wavTone(seconds)), format: "wav", lyrics: "" } };
}
