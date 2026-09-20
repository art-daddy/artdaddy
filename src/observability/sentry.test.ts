import { beforeEach, describe, expect, it, vi } from "vitest";

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
async function fresh() {
  vi.resetModules();
  return import("./sentry");
}

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
  it("strips request body/cookies/auth headers and scrubs content in extra", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
    const s = await fresh();
    s.initSentry();
    const beforeSend = (mockInit.mock.calls[0][0] as Any).beforeSend as (e: Any) => Any;
    const out = beforeSend({
      // A real event always carries an exception; without one it is dropped as unactionable.
      exception: { values: [{ type: "TypeError", value: "boom" }] },
      request: {
        data: { prompt: "x" },
        cookies: { s: "1" },
        headers: { Authorization: "Bearer x", "X-Api-Key": "k", "User-Agent": "ua" },
      },
      extra: { prompt: "secret", model_id: "m" },
    });
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.headers.Authorization).toBe("[scrubbed]");
    expect(out.request.headers["X-Api-Key"]).toBe("[scrubbed]");
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
