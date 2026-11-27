// A fake ArtDaddy server for the browser lane: a REAL HTTP server on 127.0.0.1 (a port the system
// picks) that answers the routes the app calls, and answers each model round (POST
// /inference/stream) with the next scripted reply (reply.ts). Nothing here reaches a vendor: there
// is no model behind it, so no test can spend money.
//
// What is real: the socket. The app's own fetch, its SSE reader, its abort on Stop, a connection
// cut mid-stream and a slow first byte are what a network does, not what a stub says. What is a
// stand-in: the answers. The app is pointed here by its own runtime server setting (localStorage
// `artdaddy.api_base`, src/api/config.ts), set by the shell before the page loads.
//
// Every request is kept in `seen`, in order, with what the app sent, so a test can check what the
// app ASKED (the model it chose, that a broken round was not sent twice, that a denied paid tool
// never reached the proxy) and not only what it showed.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { KEEPALIVE_MS, type ReplySource, type Round, type Step } from "./reply";

export interface Seen {
  method: string;
  path: string;
  /** The body as sent: parsed JSON when it was JSON. */
  body: unknown;
  /** performance.now() in the test process when the request arrived. */
  at: number;
  status?: number;
  /** The scripted reply that answered it (model rounds only). */
  reply?: string;
  /** The answer's text written so far (the `text` deltas since the last `reset`), so a test can wait
   *  for "the server has sent these words" as an event rather than for a time. */
  written?: string;
  /** The stream is held open (a `hold` or `hang` step) and waiting. */
  holding?: boolean;
  /** How the answer ended: written to the end, cut by the script, or the app hung up first. */
  end?: "complete" | "cut" | "left";
  endedAt?: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Request-ID, Retry-After",
};

/** sse_starlette's framing (CRLF), which is what the app reads in production. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

const MODEL_ROUTES = new Set(["/inference/stream", "/inference"]);

export class FakeArtDaddy {
  /** Every request, in arrival order. */
  readonly seen: Seen[] = [];
  /** Model rounds that arrived with no reply scripted. A test that leaves any fails (qa.ts). */
  readonly unscripted: Seen[] = [];
  /** What POST /client/compatibility says about this build. */
  supported = true;
  /** What GET /usage reports. */
  usage: Record<string, unknown> = {
    metered: true,
    used: 12,
    limit: 500,
    remaining: 488,
    over: false,
  };
  /** How the paid proxy (/ai/<name>) answers. It never calls anything: the default refuses. */
  aiAnswer: (name: string, body: unknown) => { status: number; body: unknown } = () => ({
    status: 503,
    body: { detail: { error: "internal_error" } },
  });

  private readonly replies: ReplySource[] = [];
  private readonly sockets = new Set<Socket>();
  /** Held streams waiting for `release()`, oldest first; and releases given before any was held. */
  private readonly holds: Array<() => void> = [];
  private releasesAhead = 0;
  private rounds = 0;
  private requestSeq = 0;

  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {
    server.on("connection", (socket) => {
      socket.setNoDelay(true);
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("request", (req, res) => void this.answer(req, res));
  }

  static async start(): Promise<FakeArtDaddy> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return new FakeArtDaddy(server, `http://127.0.0.1:${port}`);
  }

  /** Queue the replies for the next model rounds, in order: one reply answers one round. */
  script(...replies: ReplySource[]): void {
    this.replies.push(...replies);
  }

  /** Scripted replies no round has used yet. */
  get unused(): number {
    return this.replies.length;
  }

  /** Let the oldest held stream (a `hold` step) go on to its next step. A release given before the
   *  stream reaches its hold is kept for it. */
  release(): void {
    const next = this.holds.shift();
    if (next) next();
    else this.releasesAhead += 1;
  }

  /** The model rounds the app sent, in order (both the streaming and the plain route). */
  modelRounds(): Seen[] {
    return this.seen.filter((s) => s.method === "POST" && MODEL_ROUTES.has(s.path));
  }

  /** Requests to one path (exact), or to every path under a prefix ending in "/". */
  requests(path: string): Seen[] {
    return this.seen.filter((s) =>
      path.endsWith("/") ? s.path.startsWith(path) : s.path === path,
    );
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...CORS,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "*",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    const raw = await readBody(req);
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON: kept as text */
    }
    const seen: Seen = {
      method: req.method ?? "GET",
      path: url.pathname,
      body,
      at: performance.now(),
    };
    this.seen.push(seen);

    if (seen.method === "POST" && MODEL_ROUTES.has(url.pathname)) {
      await this.modelRound(req, res, seen, url.pathname === "/inference/stream");
      return;
    }
    const json = (status: number, payload: unknown): void => {
      seen.status = status;
      res.writeHead(status, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const p = url.pathname;
    if (p === "/health") return json(200, { ok: true });
    if (p === "/auth/verify") return json(200, { ok: true });
    if (p === "/auth/desktop/refresh") {
      // The QA shell's keychain holds a `qa-refresh-` token, renewed here at start. Any other token
      // is a real person's session (a real dev build pointed here by mistake reads the PC's own
      // keychain): it is answered "unavailable", which never rotates or clears it, and it is never
      // kept in `seen`.
      const token = (body as { refresh_token?: unknown } | null)?.refresh_token;
      seen.body = "[refresh token not recorded]";
      if (typeof token !== "string" || !token.startsWith("qa-refresh-"))
        return json(503, { detail: "desktop authentication is unavailable" });
      return json(200, {
        access_token: fakeAccessToken(),
        refresh_token: `qa-refresh-${++this.requestSeq}`,
        expires_in: 3600,
      });
    }
    if (p === "/auth/desktop/revoke") {
      seen.body = "[refresh token not recorded]";
      return json(200, { ok: true });
    }
    if (p === "/me")
      return json(200, {
        user_id: "qa_user",
        email: "",
        display_name: "QA",
        image_url: "",
        metered: true,
      });
    if (p === "/usage") return json(200, this.usage);
    if (p === "/client/compatibility") {
      const id = (body as { catalog_id?: unknown } | null)?.catalog_id;
      return json(200, {
        catalog_id: id,
        supported: this.supported,
        required_update: !this.supported,
      });
    }
    if (p === "/client/export-flags") return json(200, {});
    if (p.startsWith("/telemetry/") || p === "/e") {
      seen.status = 204;
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (p.startsWith("/ai/")) {
      const a = this.aiAnswer(p.slice("/ai/".length), body);
      return json(a.status, a.body);
    }
    return json(404, { detail: "Not Found" });
  }

  private async modelRound(
    req: IncomingMessage,
    res: ServerResponse,
    seen: Seen,
    streamed: boolean,
  ): Promise<void> {
    const index = ++this.rounds;
    const source = this.replies.shift();
    if (!source) {
      this.unscripted.push(seen);
      seen.status = 500;
      res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: { error: "internal_error" } }));
      return;
    }
    const body = (seen.body ?? {}) as Record<string, unknown>;
    const reply = typeof source === "function" ? source(roundOf(body, index)) : source;
    seen.reply = reply.note;
    const requestId = `qa-${++this.requestSeq}`;

    if (reply.kind === "drop") {
      seen.end = "cut";
      seen.endedAt = performance.now();
      req.socket.destroy();
      return;
    }
    if (reply.kind === "http") {
      if (reply.delayMs) await sleep(reply.delayMs);
      seen.status = reply.status;
      res.writeHead(reply.status, {
        ...CORS,
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
      });
      res.end(JSON.stringify(reply.body));
      seen.end = "complete";
      seen.endedAt = performance.now();
      return;
    }
    const echoHistory = body.history_mode === "client";
    if (!streamed) {
      // The plain route: the same reply, answered once with its result (an older server's shape).
      const result = reply.steps.find(
        (s): s is Extract<Step, { result: unknown }> => "result" in s,
      );
      seen.status = 200;
      res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
      });
      res.end(JSON.stringify(result ? withHistory(result.result, echoHistory) : {}));
      seen.end = "complete";
      seen.endedAt = performance.now();
      return;
    }
    seen.status = 200;
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Request-ID": requestId,
    });
    res.flushHeaders();
    const left = new Promise<void>((resolve) =>
      res.on("close", () => {
        if (!seen.end) {
          seen.end = "left";
          seen.endedAt = performance.now();
        }
        resolve();
      }),
    );
    seen.written = "";
    for (const step of reply.steps) {
      if (seen.end) return;
      if ("wait" in step) await Promise.race([sleep(step.wait), left]);
      else if ("delta" in step) {
        const kind = step.kind ?? "text";
        res.write(frame("delta", { kind, text: step.delta }));
        if (kind === "text") seen.written += step.delta;
        else if (kind === "reset") seen.written = "";
      } else if ("ping" in step) res.write(": ping\r\n\r\n");
      else if ("result" in step) {
        seen.end = "complete";
        seen.endedAt = performance.now();
        res.end(frame("result", withHistory(step.result, echoHistory)));
        return;
      } else if ("cut" in step) {
        seen.end = "cut";
        seen.endedAt = performance.now();
        req.socket.destroy();
        return;
      } else if ("hold" in step) await this.holdOpen(res, seen, left, true);
      else if ("hang" in step) {
        await this.holdOpen(res, seen, left, false);
        return;
      }
    }
    if (!seen.end) {
      seen.end = "complete";
      seen.endedAt = performance.now();
      res.end();
    }
  }

  /** Keep a stream open, writing a keepalive comment every KEEPALIVE_MS, until `release()` lets it go
   *  on (when `releasable`) or the app hangs up. */
  private async holdOpen(
    res: ServerResponse,
    seen: Seen,
    left: Promise<void>,
    releasable: boolean,
  ): Promise<void> {
    const ping = () => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\r\n\r\n");
    };
    ping();
    const timer = setInterval(ping, KEEPALIVE_MS);
    seen.holding = true;
    let released: (() => void) | undefined;
    try {
      if (!releasable) await left;
      else if (this.releasesAhead > 0) this.releasesAhead -= 1;
      else
        await Promise.race([
          new Promise<void>((resolve) => {
            released = resolve;
            this.holds.push(resolve);
          }),
          left,
        ]);
    } finally {
      clearInterval(timer);
      seen.holding = false;
      // A stream the app left is no longer waiting: a later release belongs to the next hold.
      const waiting = released ? this.holds.indexOf(released) : -1;
      if (waiting >= 0) this.holds.splice(waiting, 1);
    }
  }
}

/** A token shaped like the real one (a JWT the app reads `sub` and the lifetime from). Unsigned: the
 *  app never verifies it, the server does, and this server accepts anything. */
function fakeAccessToken(): string {
  const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "qa_user", iat: now, exp: now + 3600 })}.qa`;
}

/** The real server echoes `history_mode` when it rebuilt the model's input from the app's transcript. */
function withHistory<T extends { kind: string }>(result: T, echo: boolean): T {
  return echo && result.kind !== "error" ? { ...result, history_mode: "client" as const } : result;
}

function roundOf(body: Record<string, unknown>, index: number): Round {
  const input = (body.round_input ?? {}) as {
    user_text?: unknown;
    extra_texts?: unknown;
    tool_results?: unknown;
  };
  const extras = Array.isArray(input.extra_texts) ? input.extra_texts.map(String) : [];
  const userText = typeof input.user_text === "string" ? input.user_text : extras.join("\n");
  const toolResults = Array.isArray(input.tool_results)
    ? (input.tool_results as Round["toolResults"])
    : [];
  return { body, userText, toolResults, index };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
