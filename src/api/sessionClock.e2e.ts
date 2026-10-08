// The whole renewal path against a server that keeps its OWN clock (UJ-010), over real HTTP.
//
// The unit tests drive desktopAuth with a mocked fetch; this drives the real modules - the token
// provider, the authenticated door and the renewal - against an in-process server that mints
// tokens on its clock, refuses one past `exp` by its clock (as desktop_auth.py does), rotates the
// refresh token once and treats reuse as theft. This PC's clocks are skewed against it by hours.
//
// Witnesses: a PC two hours slow got "session expired" every 30 minutes of use; a Mac woke a
// sleeping server whose 45 s start outlasted the 15 s renewal, and its round was dropped.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const realNow = Date.now.bind(Date);
const realPerf = performance.now.bind(performance);
const TTL_S = 1800;

const keychain = vi.hoisted(() => ({ token: null as string | null }));
const base = vi.hoisted(() => ({ url: "" }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { token?: string }) => {
    if (cmd === "load_refresh_token") return keychain.token;
    if (cmd === "store_refresh_token") keychain.token = args?.token ?? null;
    if (cmd === "clear_refresh_token") keychain.token = null;
    return undefined;
  },
}));
vi.mock("../platform", () => ({ platform: { name: "tauri" } }));
vi.mock("./config", () => ({ apiBase: () => base.url, onApiBaseChange: () => () => undefined }));

/** The server: its clock, the one live refresh token, what it refused and how often it rotated. */
const server = {
  ahead: 0, // ms the server's clock has moved in this test
  refreshDelayMs: 0,
  liveRefresh: "rt-0",
  revoked: new Set<string>(),
  refused: 0,
  rotations: 0,
  now: () => realNow() + server.ahead,
};

function mint(): string {
  const iat = Math.floor(server.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: "user_1", iat, exp: iat + TTL_S, n: server.rotations }),
  ).toString("base64url");
  return `ad_h.${payload}.s`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.url === "/auth/desktop/refresh") {
    const { refresh_token } = await body(req);
    await new Promise((r) => setTimeout(r, server.refreshDelayMs));
    if (refresh_token !== server.liveRefresh) return send(401, { detail: "refresh-token reuse" });
    server.rotations += 1;
    server.liveRefresh = `rt-${server.rotations}`;
    return send(200, {
      access_token: mint(),
      refresh_token: server.liveRefresh,
      expires_in: TTL_S,
    });
  }
  if (req.url === "/protected") {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const exp = Number(
      (
        JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}") as {
          exp?: number;
        }
      ).exp,
    );
    if (!(exp * 1000 > server.now()) || server.revoked.has(token)) {
      server.refused += 1;
      return send(401, { detail: "invalid or expired session" });
    }
    return send(200, { ok: true });
  }
  send(404, {});
}

let http: Server;
beforeAll(async () => {
  http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((r) => {
      http.closeAllConnections();
      http.close(() => r());
    }),
);

let skewMs = 0; // this PC's wall clock minus the server's
let lived = 0; // ms both clocks have advanced together
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(async () => {
  Object.assign(server, {
    ahead: 0,
    refreshDelayMs: 0,
    liveRefresh: "rt-0",
    refused: 0,
    rotations: 0,
  });
  server.revoked.clear();
  keychain.token = "rt-0";
  lived = 0;
  spies = [
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs + lived),
    vi.spyOn(performance, "now").mockImplementation(() => realPerf() + lived),
  ];
  vi.resetModules();
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

/** Time passing for both machines at once. */
function live(ms: number): void {
  lived += ms;
  server.ahead += ms;
}

/** The app as AuthProvider wires it: the token provider and the renewal behind the door. */
async function app() {
  const desktop = await import("./desktopAuth");
  const auth = await import("./auth");
  auth.setClerkTokenProvider(() => desktop.ensureFreshAccessToken());
  auth.setSessionRenewer((refused) => desktop.renewAfterRejection(refused));
  await desktop.refreshDesktopSession();
  return { request: () => auth.authedFetch(`${base.url}/protected`), desktop };
}

const MIN = 60_000;

describe("a session timed on this PC's own clock", () => {
  for (const [label, skew] of [
    ["two hours SLOW", -2 * 3600 * 1000],
    ["two hours FAST", 2 * 3600 * 1000],
    ["right", 0],
  ] as const) {
    it(`a PC ${label}: an hour of requests, none refused, renewed about once per token`, async () => {
      skewMs = skew;
      const { request } = await app();
      const statuses: number[] = [];
      for (let t = 0; t <= 65; t += 5) {
        statuses.push((await request()).status);
        live(5 * MIN);
      }
      expect(
        statuses.every((s) => s === 200),
        `statuses ${statuses.join(",")}`,
      ).toBe(true);
      expect(server.refused, "the server never saw a spent token").toBe(0);
      // 1 at sign-in + one per 30-minute life over 70 minutes; never one per request.
      expect(server.rotations).toBeGreaterThanOrEqual(3);
      expect(server.rotations).toBeLessThanOrEqual(4);
    });
  }
});

describe("a server waking from zero", () => {
  it("the request waiting on a renewal outlasts a 45 s start, and goes through", async () => {
    skewMs = 0;
    const { request } = await app();
    live(31 * MIN);
    server.refreshDelayMs = 45_000;

    const res = await request();

    expect(res.status).toBe(200);
    expect(server.refused, "the expired token was never sent").toBe(0);
  }, 120_000);
});

describe("a token the server refuses while this PC still trusts it", () => {
  it("is renewed and the request sent once more", async () => {
    skewMs = 0;
    const { request, desktop } = await app();
    server.revoked.add(String(desktop.getAccessToken()));

    const res = await request();

    expect(res.status).toBe(200);
    expect(server.refused).toBe(1);
  });
});
