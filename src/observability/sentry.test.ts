import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// Stable mock fns (the `mock` prefix lets the hoisted factory reference them and
// keeps the same instances across vi.resetModules()).
const mockInit = vi.fn();
const mockSetTag = vi.fn();
const mockCapture = vi.fn();
const mockSetUser = vi.fn();
vi.mock("@sentry/react", () => ({
  init: mockInit,
  setTag: mockSetTag,
  setUser: mockSetUser,
  captureException: mockCapture,
  ErrorBoundary: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Re-import the module fresh so `enabled`/`ids` reset between tests. */
let lastModule: typeof import("./sentry") | undefined;
async function fresh() {
  lastModule?.__resetSentry();
  vi.resetModules();
  lastModule = await import("./sentry");
  return lastModule;
}

afterEach(() => {
  lastModule?.__resetSentry();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  mockInit.mockClear();
  mockSetTag.mockClear();
  mockCapture.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("DEV", false); // the runner is a dev env; these cover the SHIPPED path
});

describe("initSentry", () => {
  it("is a no-op without a DSN", async () => {
    const s = await fresh();
    expect(s.initSentry()).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("initializes errors-only when a DSN is set", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    expect(s.initSentry()).toBe(true);
    const opts = mockInit.mock.calls[0][0] as Any;
    expect(opts.tracesSampleRate).toBe(0);
    // Breadcrumbs are ON now, but bounded and filtered: an error used to arrive with no idea
    // what the app had been doing. What keeps content out is `beforeBreadcrumb`, not a zero —
    // so both must be present, and breadcrumbs.test.ts pins what that filter actually allows.
    expect(opts.maxBreadcrumbs).toBeGreaterThan(0);
    expect(opts.maxBreadcrumbs).toBeLessThanOrEqual(50);
    expect(typeof opts.beforeBreadcrumb).toBe("function");
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.beforeSend).toBe("function");
  });

  // .env carries a real DSN and Vite loads it in dev, so the dev server was filing
  // HMR-only ReferenceErrors against the same project users report to.
  it("stays off on the dev server even with a DSN", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    vi.stubEnv("DEV", true);
    const s = await fresh();
    expect(s.initSentry()).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("tags the release with the version that shipped", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    vi.stubEnv("VITE_ARTDADDY_RELEASE", "");
    const s = await fresh();
    s.initSentry();
    expect((mockInit.mock.calls[0][0] as Any).release).toBe(__ARTDADDY_RELEASE__);
  });
});

describe("beforeSend", () => {
  it("fuzzes secret scrubbing without dropping legitimate metadata", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    sentry.initSentry();
    sentry.identifyUser("account_a");
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (cookie, authorization, metadata) => {
        const output = beforeSend({
          message: "scrubbing witness",
          request: {
            data: { prompt: authorization },
            cookies: { cookie },
            headers: { Cookie: cookie, Authorization: authorization, "User-Agent": metadata },
          },
          extra: { prompt: authorization, model_id: metadata },
        });
        expect(output.request.headers.Cookie).toBe("[scrubbed]");
        expect(output.request.headers.Authorization).toBe("[scrubbed]");
        expect(output.request.headers["User-Agent"]).toBe(metadata);
        expect(output.request).not.toHaveProperty("data");
        expect(output.request).not.toHaveProperty("cookies");
        expect(output.extra.prompt).toBe("[scrubbed]");
        expect(output.extra.model_id).toBe(metadata);
      }),
    );
  });

  it("keeps a known user's error when the SDK already attached the same identity", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    sentry.initSentry();
    sentry.identifyUser("account_a");
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    expect(
      await beforeSend({ message: "same-user error", user: { id: "account_a" } }),
    ).toMatchObject({ message: "same-user error", user: { id: "account_a" } });
    expect(
      await beforeSend({
        message: "no request headers",
        request: { url: "https://example.invalid/route" },
      }),
    ).toMatchObject({ message: "no request headers" });
  });

  it("waits using browser numeric timers and removes the deadline after identity arrives", async () => {
    vi.useFakeTimers();
    const schedule = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (handler: () => void, delay?: number) =>
      Number(schedule(handler, delay)),
    );
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    const { useAuth } = await import("../store/auth");
    useAuth.setState({ status: "checking", profile: null });
    sentry.initSentry();
    const pending = (mockInit.mock.calls[0][0] as Any).beforeSend({
      message: "browser timer witness",
    });
    sentry.identifyUser("account_a");
    expect(await pending).toMatchObject({ user: { id: "account_a" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["locked", true, false],
    ["offline", false, false],
    ["offline", true, true],
    ["unlocked", false, true],
  ] as const)(
    "keeps %s stored-session=%s SDK reporting within its session",
    async (status, hasStoredSession, allowed) => {
      vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
      const sentry = await fresh();
      const { useAuth } = await import("../store/auth");
      sentry.initSentry();
      sentry.identifyUser("account_a");
      useAuth.setState({ status, hasStoredSession });
      const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
      const output = await beforeSend({ message: "SDK witness" });
      expect(Boolean(output)).toBe(allowed);
      if (allowed) expect(output).toMatchObject({ user: { id: "account_a" } });
    },
  );

  it("holds a startup error until the user is known and attaches that identity", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    const { useAuth } = await import("../store/auth");
    useAuth.setState({ status: "checking", profile: null, hasStoredSession: false });
    sentry.initSentry();
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    let delivered = false;
    const waiting = Promise.resolve(beforeSend({ message: "startup native failure" })).then(
      (event) => {
        delivered = true;
        return event;
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toBe(false);
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    sentry.identifyUser("startup_account", "qa@example.invalid");
    expect(await waiting).toMatchObject({
      user: { id: "startup_account", email: "qa@example.invalid" },
    });
  });

  it("drops a waiting startup error on sign-out and never gives it to a later login", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    const { useAuth } = await import("../store/auth");
    useAuth.setState({ status: "checking", profile: null, hasStoredSession: false });
    sentry.initSentry();
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    const pending = Promise.resolve(beforeSend({ message: "previous startup" }));
    useAuth.getState().markLocked();
    expect(await pending).toBeNull();
    useAuth.setState({ status: "unlocked", hasStoredSession: true });
    sentry.identifyUser("later_account");
  });

  it("strips request body/cookies/auth headers and scrubs content in extra", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    s.identifyUser("qa_account");
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend as (e: Any) => Any;
    const out = beforeSend({
      // A real event always carries an exception; without one it is dropped as unactionable.
      exception: { values: [{ type: "TypeError", value: "boom" }] },
      request: {
        data: { prompt: "x" },
        cookies: { s: "1" },
        headers: {
          Authorization: "Bearer x",
          "X-Api-Key": "k",
          Cookie: "private-cookie",
          "User-Agent": "ua",
        },
      },
      extra: { prompt: "secret", model_id: "m" },
    });
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.headers.Authorization).toBe("[scrubbed]");
    expect(out.request.headers["X-Api-Key"]).toBe("[scrubbed]");
    expect(out.request.headers.Cookie).toBe("[scrubbed]");
    expect(out.request.headers["User-Agent"]).toBe("ua");
    expect(out.extra.prompt).toBe("[scrubbed]");
    expect(out.extra.model_id).toBe("m");
  });

  // Six of 21 client issues arrived as "<unknown>" with a blank location: a non-Error value
  // handed to captureException. They cost quota and triage and say nothing, so they are
  // dropped before they leave the process.
  it("drops an event with nothing to act on", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend as (e: Any) => Any;
    expect(beforeSend({ exception: { values: [{ type: "Error", value: "" }] } })).toBeNull();
    expect(beforeSend({ exception: { values: [] } })).toBeNull();
    expect(beforeSend({})).toBeNull();
  });

  // The failure direction: anything carrying a real signal must still get through, or the
  // filter has simply turned reporting off.
  it("keeps an event that names what happened", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    s.identifyUser("qa_account");
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend as (e: Any) => Any;
    expect(beforeSend({ message: "something broke" })).not.toBeNull();
    expect(
      beforeSend({ exception: { values: [{ type: "TypeError", value: "x" }] } }),
    ).not.toBeNull();
    // A bare Error with a message is still actionable...
    expect(
      beforeSend({ exception: { values: [{ type: "Error", value: "boom" }] } }),
    ).not.toBeNull();
    // ...and so is one with only a stack.
    expect(
      beforeSend({
        exception: { values: [{ type: "Error", value: "", stacktrace: { frames: [{}] } }] },
      }),
    ).not.toBeNull();
  });

  it("expires unresolved startup errors and bounds the waiting queue", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    const { useAuth } = await import("../store/auth");
    useAuth.setState({ status: "checking", profile: null });
    sentry.initSentry();
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    const events = Array.from({ length: 60 }, (_, index) =>
      Promise.resolve(beforeSend({ message: `startup ${index}` })),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await Promise.all(events)).toEqual(Array(60).fill(null));
    sentry.identifyUser("later_account");
  });

  it("keeps only the first fifty startup errors when identity arrives", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    const { useAuth } = await import("../store/auth");
    useAuth.setState({ status: "checking", profile: null });
    sentry.initSentry();
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    const pending = Array.from({ length: 60 }, (_, index) =>
      Promise.resolve(beforeSend({ message: `startup ${index}` })),
    );
    sentry.identifyUser("qa_account");
    const delivered = await Promise.all(pending);
    expect(delivered.filter(Boolean).map((event) => event!.message)).toEqual(
      Array.from({ length: 50 }, (_, index) => `startup ${index}`),
    );
    expect(delivered.slice(50)).toEqual(Array(10).fill(null));
  });

  it("never attaches an old SDK user's event to a different identity", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    sentry.initSentry();
    sentry.identifyUser("current_account");
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    expect(
      await beforeSend({ message: "late SDK event", user: { id: "previous_account" } }),
    ).toBeNull();
    expect(await beforeSend({ message: "current error" })).toMatchObject({
      user: { id: "current_account" },
    });
  });
});

// Five testers were using the app while every issue read "0 users affected", because
// nothing identified anyone — a live bug was indistinguishable from local noise. The id was
// then a HASH, which counted people correctly but could not name one: the first real crash
// sat in the dashboard for three days as an anonymous string. It is now the account itself.
describe("identifyUser", () => {
  it("attributes events to the account, so a report can be answered", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    s.identifyUser("user_3JQ", "hamza@example.com");
    expect(mockSetUser).toHaveBeenLastCalledWith({
      id: "user_3JQ",
      email: "hamza@example.com",
    });

    // Same tester, same id — otherwise every launch looks like a new person.
    mockSetUser.mockClear();
    s.identifyUser("user_3JQ", "hamza@example.com");
    expect((mockSetUser.mock.calls.at(-1)?.[0] as { id?: string }).id).toBe("user_3JQ");
    // ...and a different tester is a different person.
    s.identifyUser("user_OTHER", "other@example.com");
    expect((mockSetUser.mock.calls.at(-1)?.[0] as { id?: string }).id).not.toBe("user_3JQ");
  });

  it("never carries the access token", async () => {
    // The failure direction: the identity is taken from the JWT's claims, and handing the
    // whole credential to a third party instead would be a real leak.
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    s.identifyUser("user_3JQ", "hamza@example.com");
    expect(JSON.stringify(mockSetUser.mock.calls.at(-1))).not.toMatch(/eyJ|Bearer|token/i);
  });

  it("clears the user on sign-out and stays silent when reporting is off", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const on = await fresh();
    on.initSentry();
    on.identifyUser(null);
    expect(mockSetUser).toHaveBeenLastCalledWith(null);

    mockSetUser.mockClear();
    const off = await fresh();
    off.identifyUser("user_x", "a@b.co");
    expect(mockSetUser).not.toHaveBeenCalled();
  });
});

describe("setCorrelation / correlationBody", () => {
  it("keeps project+transcript ids and drops empty values", async () => {
    const s = await fresh();
    s.setCorrelation({ project_id: "p", transcript_id: "t", model_id: "m" });
    expect(s.correlationBody()).toEqual({ project_id: "p", transcript_id: "t" });
    s.setCorrelation({ project_id: "p2", transcript_id: null, model_id: "" });
    expect(s.correlationBody()).toEqual({ project_id: "p2" });
  });

  it("tags Sentry with the ids only when enabled", async () => {
    const off = await fresh();
    off.setCorrelation({ project_id: "p" });
    expect(mockSetTag).not.toHaveBeenCalled();

    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const on = await fresh();
    on.initSentry();
    mockSetTag.mockClear();
    on.setCorrelation({ project_id: "p", transcript_id: "t", model_id: "m" });
    expect(mockSetTag.mock.calls.map((c) => c[0])).toEqual([
      "project_id",
      "transcript_id",
      "model_id",
    ]);
  });
});

describe("captureError", () => {
  it("does not let an explicitly owned native report become another user's SDK event", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const sentry = await fresh();
    sentry.initSentry();
    sentry.identifyUser("current_account");
    sentry.captureError(
      new Error("native failure"),
      { native_failure: "renderer_exited" },
      "previous_account",
    );
    const captured = mockCapture.mock.calls[0][1] as Any;
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend;
    expect(await beforeSend({ message: "native failure", user: captured.user })).toBeNull();
  });

  it("is a no-op when disabled", async () => {
    const s = await fresh();
    s.captureError(new Error("x"), { tool: "t" });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("captures with a scrubbed context when enabled", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    const err = new Error("boom");
    s.captureError(err, { tool: "generate_video", prompt: "secret" });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const [passedErr, ctx] = mockCapture.mock.calls[0] as Any;
    expect(passedErr).toBe(err);
    expect(ctx.extra.tool).toBe("generate_video");
    expect(ctx.extra.prompt).toBe("[scrubbed]");
  });
});
