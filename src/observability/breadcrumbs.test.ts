// The HTTP trail, and nothing else.
//
// Breadcrumbs were off entirely, so an error arrived with no idea what the app had been doing:
// a round that opened a request and never got an answer looked exactly like one that was never
// sent. What makes turning them on safe is the allowlist — console crumbs carry whatever we
// ever log, and ui.input carries what the user typed. A filter that stopped filtering would
// leak both silently, so these tests exist to fail loudly if it does.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInit = vi.fn();
vi.mock("@sentry/react", () => ({
  init: mockInit,
  setUser: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));

async function fresh() {
  vi.resetModules();
  mockInit.mockClear();
  vi.stubEnv("VITE_SENTRY_DSN", "https://k@example.com/1");
  vi.stubEnv("DEV", false);
  const mod = await import("./sentry");
  mod.initSentry();
  return mockInit.mock.calls.at(-1)?.[0] as {
    maxBreadcrumbs?: number;
    beforeBreadcrumb?: (c: Record<string, unknown>) => Record<string, unknown> | null;
  };
}

beforeEach(() => vi.unstubAllEnvs());

describe("breadcrumbs", () => {
  it("keeps a trail at all", async () => {
    // The regression this catches: back to 0 and every error is contextless again.
    const opts = await fresh();
    expect(opts.maxBreadcrumbs).toBeGreaterThan(0);
  });

  it("keeps http crumbs, with status and timing intact", async () => {
    const opts = await fresh();
    const kept = opts.beforeBreadcrumb?.({
      category: "fetch",
      data: { url: "https://api.example.com/inference/stream", method: "POST", status_code: 200 },
    });
    expect(kept).toBeTruthy();
    expect((kept as { data: Record<string, unknown> }).data.status_code).toBe(200);
    expect((kept as { data: Record<string, unknown> }).data.method).toBe("POST");
  });

  it.each(["console", "ui.click", "ui.input", "navigation", "sentry.event", "custom"])(
    "drops a %s crumb",
    async (category) => {
      // An allowlist, not a denylist: a category nobody anticipated must be dropped, not kept.
      const opts = await fresh();
      expect(opts.beforeBreadcrumb?.({ category })).toBeNull();
    },
  );

  it("never carries a query string", async () => {
    // Nothing of ours puts a secret in one today. This is so nothing can start to.
    const opts = await fresh();
    const kept = opts.beforeBreadcrumb?.({
      category: "xhr",
      data: { url: "https://api.example.com/thing?token=supersecret&x=1" },
    }) as { data: { url: string } };
    expect(kept.data.url).not.toContain("supersecret");
    expect(kept.data.url).not.toContain("token=");
    expect(kept.data.url).toContain("https://api.example.com/thing");
  });

  it("survives a crumb with no data", async () => {
    const opts = await fresh();
    expect(opts.beforeBreadcrumb?.({ category: "fetch" })).toBeTruthy();
  });
});
