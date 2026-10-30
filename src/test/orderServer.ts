// A stand-in for the server's order desk, for tests of the app's side of it.
//
// Every view it answers with is built from the SAME fixture the server's own tests are held to
// (src/api/__fixtures__/orderViews.json), so it cannot drift from what the real server says; what it adds is the
// behaviour: submit makes an order, polling moves it along, the signed link serves the result, confirming collects it.
// Install it with `vi.stubGlobal("fetch", server.fetch)`.
import orderViews from "../api/__fixtures__/orderViews.json";
import { apiBase } from "../api/config";

type View = Record<string, unknown>;
type Template = (typeof orderViews)["views"];

export interface FakeOrder {
  id: string;
  proxy: string;
  body: Record<string, unknown>;
  state: "running" | "ready" | "failed" | "collected" | "expired";
  /** Polls answered so far (the order moves on when it has been asked about this many times). */
  polls: number;
  /** What the order answers with once it is ready (the legacy `{result, media}` response). */
  response: unknown;
  failure?: { code: string; message: string; retryable?: boolean };
}

export interface ServerBehaviour {
  /** False: orders are not offered (no result store), so an order number is ignored and the call answers inline. */
  orders: boolean;
  /** How many times an order is asked about before it is no longer running. */
  pollsUntilDone: number;
  /** What every order ends up as. */
  outcome: "ready" | "failed";
  failure: { code: string; message: string; retryable?: boolean };
  /** The result a ready order holds, by proxy. */
  response: (proxy: string, body: Record<string, unknown>) => unknown;
}

export const STORAGE = "https://storage.test";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeOrderServer {
  readonly orders = new Map<string, FakeOrder>();
  /** Every request seen, in order: `METHOD path`. */
  readonly calls: string[] = [];
  /** Called when the app confirms an order, just before the server collects it. */
  onAck: ((order: FakeOrder) => void) | null = null;
  behaviour: ServerBehaviour = {
    orders: true,
    pollsUntilDone: 1,
    outcome: "ready",
    failure: { code: "generation_failed", message: "The generation did not complete. Nothing was charged to you." },
    response: () => ({ result: { ok: true, count: 1 }, media: [{ b64: "aGVsbG8=", ext: ".png", kind: "image" }] }),
  };
  /** The next requests whose path matches get this instead of a real answer. `lose-answer`: the server handles the request (an
   *  order is made, a result is collected) but the answer never reaches the app. */
  private faults: { match: RegExp; left: number; kind: "drop" | "lose-answer" | "hang" | "hang-after" | number }[] = [];
  /** Links that have been used once and now answer 403, as an expired signed link does. */
  expireLinksOnce = false;
  private expiredLinks = new Set<string>();

  /** Answer the next `times` requests whose "METHOD path" matches with a network drop or a given status. `lose-answer`: the server
   *  handles the request (an order is made, a result is collected) but the answer never reaches the app. `hang`: the request never
   *  gets anywhere and never answers. `hang-after`: the server handles it, and the answer never comes. */
  fault(match: RegExp, times: number, kind: "drop" | "lose-answer" | "hang" | "hang-after" | number): void {
    this.faults.push({ match, left: times, kind });
  }

  private view(order: FakeOrder): View {
    const t = orderViews.views as Template;
    const base = (state: keyof Template): View => {
      const v = clone(t[state]) as View;
      v.order_id = order.id;
      return v;
    };
    switch (order.state) {
      case "running":
        return base("running");
      case "ready": {
        const v = base("ready");
        (v.result as View).url = `${STORAGE}/results/${order.id}.json`;
        return v;
      }
      case "failed": {
        const v = base("failed");
        v.error = { retryable: false, ...order.failure };
        return v;
      }
      case "collected":
        return base("collected");
      case "expired":
        return base("expired");
    }
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  /** `fetch`, as the app calls it. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const base = new URL(apiBase());
    const path = url.origin === base.origin ? url.pathname.slice(base.pathname.replace(/\/$/, "").length) : url.href;
    const line = `${method} ${path}`;
    this.calls.push(line);
    const fault = this.faults.find((f) => f.left > 0 && f.match.test(line));
    if (fault) {
      fault.left -= 1;
      if (fault.kind === "drop") throw new TypeError("Failed to fetch");
      if (typeof fault.kind === "number") return new Response("{}", { status: fault.kind });
      if (fault.kind === "hang") return new Promise<Response>(() => undefined);
      await this.handle(method, path, url, init); // lose-answer / hang-after: it happened, but the app never hears
      if (fault.kind === "hang-after") return new Promise<Response>(() => undefined);
      throw new TypeError("Failed to fetch");
    }
    return this.handle(method, path, url, init);
  };

  private async handle(method: string, path: string, url: URL, init?: RequestInit): Promise<Response> {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";

    if (method === "POST" && /^\/ai\/[^/]+$/.test(path)) return this.submit(path.slice(4), JSON.parse(bodyText));
    const found = /^\/orders\/([^/]+)(\/ack)?$/.exec(path);
    if (found) {
      const order = this.orders.get(decodeURIComponent(found[1]));
      if (!order) return this.json({ detail: { error: "order_not_found" } }, 404);
      if (method === "GET" && !found[2]) return this.poll(order);
      if (method === "POST" && found[2]) return this.collect(order);
    }
    if (method === "GET" && url.origin === STORAGE) return this.download(url);
    return new Response("not found", { status: 404 });
  }

  private submit(proxy: string, body: Record<string, unknown>): Response {
    const id = body.order_id;
    if (!this.behaviour.orders || typeof id !== "string") return this.json(this.behaviour.response(proxy, body));
    const existing = this.orders.get(id);
    if (existing) {
      const same = JSON.stringify(existing.body.args) === JSON.stringify(body.args);
      return same ? this.json({ order: this.view(existing) }) : this.json({ detail: { error: "order_id_reused" } }, 409);
    }
    const order: FakeOrder = {
      id,
      proxy,
      body,
      state: "running",
      polls: 0,
      response: this.behaviour.response(proxy, body),
    };
    this.orders.set(id, order);
    return this.json({ order: this.view(order) }, 202);
  }

  private poll(order: FakeOrder): Response {
    if (order.state === "running") {
      order.polls += 1;
      if (order.polls >= this.behaviour.pollsUntilDone) {
        order.state = this.behaviour.outcome;
        order.failure = this.behaviour.failure;
      }
    }
    return this.json({ order: this.view(order) });
  }

  private collect(order: FakeOrder): Response {
    if (order.state === "running") return this.json({ detail: { error: "order_not_ready" } }, 409);
    this.onAck?.(order);
    if (order.state === "ready") order.state = "collected";
    return this.json({ order: this.view(order) });
  }

  private download(url: URL): Response {
    const id = /\/results\/([^/.]+)\.json$/.exec(url.pathname)?.[1];
    const order = id ? this.orders.get(id) : undefined;
    if (this.expireLinksOnce && !this.expiredLinks.has(url.href)) {
      this.expiredLinks.add(url.href);
      return new Response("expired", { status: 403 });
    }
    if (!order || order.state !== "ready") return new Response("gone", { status: 404 });
    return this.json(order.response);
  }

  /** Make an order exist already, as if the app had submitted it before it was closed. */
  seed(id: string, proxy: string, state: FakeOrder["state"], response?: unknown, args: unknown = {}): FakeOrder {
    const order: FakeOrder = {
      id,
      proxy,
      body: { order_id: id, args },
      state,
      polls: 0,
      response: response ?? this.behaviour.response(proxy, {}),
      failure: this.behaviour.failure,
    };
    this.orders.set(id, order);
    return order;
  }
}
