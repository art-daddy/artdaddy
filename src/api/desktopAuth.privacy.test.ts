import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The claim that matters most about sign-in reporting, tested on the real thing: the real sign-in code and the
// real reporter, with only the network and the keychain faked. Whatever sequence of starts, hostile callbacks,
// refreshes and sign-outs happens, (1) nothing the sign-in handles in secret reaches the public beacon, in any
// body, address or header; (2) everything that does go is a word from the table, an id of the right shape, or a
// bounded number; and (3) the outcome of every step is the same whether the beacon works, fails or never answers,
// because reporting is something the sign-in never waits for and never depends on.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const platformMock = vi.hoisted(() => ({ name: "tauri" as "tauri" | "web" }));
vi.mock("../platform", () => ({ platform: platformMock }));
vi.mock("../platform/host", () => ({ hostInfo: () => ({ os: "windows", arch: "x86_64" }) }));
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  apiBase: () => "https://api.example.com",
}));
const fetchMock = vi.hoisted(() => vi.fn());

const ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
const secretText = (min: number, max: number) =>
  fc
    .array(fc.constantFrom(...ALPHABET), { minLength: min, maxLength: max })
    .map((chars) => chars.join(""));

// Chosen so that none of its ten-character runs occurs in the test's own addresses (api.example.com).
const EMAIL = "casey.painter@mail.invalid";
const ACCOUNT = "user_2abcDEFghiJKLmnoPQRstuVWXyz";
const jwt = (tail: string) =>
  `eyJhbGciOiJSUzI1NiJ9.${btoa(JSON.stringify({ sub: ACCOUNT, email: EMAIL, exp: 4_102_444_800 })).replace(/=+$/, "")}.${tail}`;

const ALLOWED_KEYS = new Set([
  "event",
  "source",
  "step",
  "install",
  "attempt",
  "ok",
  "reason",
  "ms",
  "app_version",
  "os",
  "arch",
]);
const ID = /^[A-Za-z0-9_-]{12}$/;

type Exchange = "ok" | "400" | "503" | "network" | "unreadable";
type Scenario =
  | { kind: "start"; openFails: boolean }
  | {
      kind: "callback";
      realState: boolean;
      code: string;
      state: string;
      attempt: "real" | "none" | "secret";
      attemptSecret: string;
      exchange: Exchange;
      storeFails: boolean;
    }
  | { kind: "refresh"; stored: boolean; server: Exchange }
  | { kind: "signout" };

const exchange = fc.constantFrom<Exchange>("ok", "400", "503", "network", "unreadable");
const scenario: fc.Arbitrary<Scenario> = fc.oneof(
  fc.record({ kind: fc.constant("start" as const), openFails: fc.boolean() }),
  fc.record({
    kind: fc.constant("callback" as const),
    realState: fc.boolean(),
    code: secretText(20, 48),
    state: secretText(32, 48),
    attempt: fc.constantFrom<"real" | "none" | "secret">("real", "none", "secret"),
    attemptSecret: secretText(20, 48),
    exchange,
    storeFails: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("refresh" as const), stored: fc.boolean(), server: exchange }),
  fc.record({ kind: fc.constant("signout" as const) }),
);

interface Run {
  outcomes: string[];
  beacon: { url: string; init: RequestInit }[];
  secrets: Set<string>;
}

/** Play a sequence against a fresh copy of the sign-in code. `beacon` decides what the public route does. */
async function play(steps: Scenario[], beacon: "ok" | "fails" | "hangs"): Promise<Run> {
  vi.resetModules();
  localStorage.clear();
  const secrets = new Set<string>([EMAIL, ACCOUNT]);
  const sent: Run["beacon"] = [];
  let tokenCounter = 0;
  let nextExchange: Exchange = "ok";
  let storeFails = false;
  let storedRefresh: string | null = null;
  let opened = null as { state: string; attempt: string } | null;

  const answer = (mode: Exchange) => {
    if (mode === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (mode === "unreadable") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => Promise.reject(new SyntaxError("bad")),
      });
    }
    if (mode === "ok") {
      const refresh = `refresh-token-${++tokenCounter}-${"r".repeat(40)}`;
      const access = jwt(`signature${tokenCounter}`);
      secrets.add(refresh);
      secrets.add(access);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: access, refresh_token: refresh, expires_in: 900 }),
      });
    }
    const status = Number(mode);
    return Promise.resolve({ ok: false, status, json: async () => ({}) });
  };

  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    if (url.endsWith("/e")) {
      sent.push({ url, init });
      if (beacon === "fails") return Promise.reject(new TypeError("Failed to fetch"));
      if (beacon === "hangs") return new Promise(() => undefined);
      return Promise.resolve({ ok: true });
    }
    if (url.endsWith("/auth/desktop/token")) {
      const body = JSON.parse(init.body as string) as { code: string; code_verifier: string };
      secrets.add(body.code_verifier);
      return answer(nextExchange);
    }
    if (url.endsWith("/auth/desktop/refresh")) return answer(nextExchange);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "open_desktop_auth") {
      const url = new URL(String(args?.url));
      opened = { state: url.searchParams.get("state")!, attempt: url.searchParams.get("attempt")! };
      secrets.add(opened.state);
      secrets.add(url.searchParams.get("code_challenge")!);
      return undefined;
    }
    if (command === "load_refresh_token") return storedRefresh;
    if (command === "store_refresh_token") {
      if (storeFails) throw new Error("keychain write failed");
      storedRefresh = String(args?.token);
      return undefined;
    }
    if (command === "clear_refresh_token") {
      storedRefresh = null;
      return undefined;
    }
    return undefined;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const desktop = await import("./desktopAuth");
  const outcomes: string[] = [];
  for (const step of steps) {
    if (step.kind === "start") {
      if (step.openFails) invoke.mockRejectedValueOnce(new Error("os refused"));
      const result = await desktop.startDesktopSignIn();
      outcomes.push(`start:${result.ok}`);
    } else if (step.kind === "callback") {
      nextExchange = step.exchange;
      storeFails = step.storeFails;
      secrets.add(step.code);
      secrets.add(step.state);
      secrets.add(step.attemptSecret);
      const state = step.realState && opened ? opened.state : step.state;
      const attempt =
        step.attempt === "real" && opened
          ? `&attempt=${opened.attempt}`
          : step.attempt === "secret"
            ? `&attempt=${step.attemptSecret}`
            : "";
      const result = await desktop.handleDeepLinkCallback(
        `artdaddy://auth/callback?code=${step.code}&state=${state}${attempt}`,
      );
      outcomes.push(`callback:${result.ok ? "ok" : (result as { message: string }).message}`);
      outcomes.push(`token:${desktop.getAccessToken() ? "held" : "none"}`);
    } else if (step.kind === "refresh") {
      nextExchange = step.server;
      storeFails = false;
      if (!step.stored) storedRefresh = null;
      else storedRefresh ??= "previously-stored-refresh-token-" + "s".repeat(30);
      if (storedRefresh) secrets.add(storedRefresh);
      const result = await desktop.refreshDesktopSession();
      outcomes.push(`refresh:${result.status}`);
    } else {
      await desktop.signOutDesktop();
      outcomes.push("signout");
    }
  }
  return { outcomes, beacon: sent, secrets };
}

const everythingSent = (run: Run) =>
  run.beacon.map(({ url, init }) => `${url}\n${JSON.stringify(init)}`).join("\n");

/** A secret appears in `wire` whole, or in any run of this many characters: a prefix of a token, or an id derived
 *  from one, is a leak too. Ten random URL-safe characters never occur by chance. */
const WINDOW = 10;
function leaks(secret: string, wire: string): boolean {
  if (wire.includes(secret)) return true;
  for (let at = 0; at + WINDOW <= secret.length; at++) {
    if (wire.includes(secret.slice(at, at + WINDOW))) return true;
  }
  return false;
}

beforeEach(() => {
  platformMock.name = "tauri";
});

describe("sign-in reporting, on the real sign-in code", () => {
  it("never lets a secret, an account or an e-mail reach the public beacon", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(scenario, { minLength: 1, maxLength: 8 }), async (steps) => {
        const run = await play(steps, "ok");
        const wire = everythingSent(run);
        for (const secret of run.secrets) {
          if (leaks(secret, wire)) return false;
        }
        return true;
      }),
      { numRuns: 80 },
    );
  }, 120_000);

  it("sends only words of the table, ids of the right shape and bounded numbers", async () => {
    const { AUTH_APP_STEPS, MAX_AUTH_MS } = await import("./authEvents");
    await fc.assert(
      fc.asyncProperty(fc.array(scenario, { minLength: 1, maxLength: 8 }), async (steps) => {
        const run = await play(steps, "ok");
        for (const { url, init } of run.beacon) {
          if (url !== "https://api.example.com/e" || init.method !== "POST") return false;
          if (init.headers !== undefined || init.credentials !== undefined) return false;
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          if (Object.keys(body).some((key) => !ALLOWED_KEYS.has(key))) return false;
          if (body.event !== "auth" || body.source !== "app") return false;
          const reasons = (AUTH_APP_STEPS as Record<string, readonly string[]>)[String(body.step)];
          if (!reasons) return false;
          if ("reason" in body && !reasons.includes(String(body.reason))) return false;
          if (!ID.test(String(body.install))) return false;
          if ("attempt" in body && !ID.test(String(body.attempt))) return false;
          if ("ok" in body && typeof body.ok !== "boolean") return false;
          if (
            "ms" in body &&
            !(typeof body.ms === "number" && body.ms >= 0 && body.ms <= MAX_AUTH_MS)
          )
            return false;
          if (body.app_version !== __ARTDADDY_RELEASE__) return false;
        }
        return true;
      }),
      { numRuns: 80 },
    );
  }, 120_000);

  it("gives every step the same outcome whether the beacon works, refuses or never answers", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(scenario, { minLength: 1, maxLength: 8 }), async (steps) => {
        const works = await play(steps, "ok");
        const refuses = await play(steps, "fails");
        const hangs = await play(steps, "hangs");
        expect(refuses.outcomes).toEqual(works.outcomes);
        expect(hangs.outcomes).toEqual(works.outcomes);
        return true;
      }),
      { numRuns: 40 },
    );
  }, 180_000);

  it("reports a whole failed sign-in as the funnel it is, in order, under one attempt and one install", async () => {
    const run = await play(
      [
        { kind: "start", openFails: false },
        {
          kind: "callback",
          realState: true,
          code: "one-time-code-123456",
          state: "unused-state-value-0123456789abcdef",
          attempt: "real",
          attemptSecret: "unused-attempt-secret-0123456",
          exchange: "400",
          storeFails: false,
        },
      ],
      "ok",
    );
    const bodies = run.beacon.map(({ init }) => JSON.parse(init.body as string));
    expect(bodies.map((body) => [body.step, body.ok, body.reason])).toEqual([
      ["start", true, undefined],
      ["callback", false, "exchange_rejected"],
    ]);
    expect(new Set(bodies.map((body) => body.attempt)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.install)).size).toBe(1);
    expect(bodies[1].ms).toEqual(expect.any(Number));
  });
});
