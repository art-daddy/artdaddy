// The guard exists so no test can file a row in production analytics. These tests prove the OUTCOME
// (the real reporter is stopped, other traffic and test stubs are untouched), not the wrapper's shape.
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClerkTokenProvider } from "../api/auth";
import { apiBase, setApiBase } from "../api/config";
import { reportExport } from "../api/exportEvents";
import {
  PRODUCTION_HOSTS,
  blockedProductionRequests,
  guardFetch,
  installNetworkGuard,
  isNetworkGuardInstalled,
  isProductionRequest,
} from "./networkGuard";

const PROD = [...PRODUCTION_HOSTS][0];

// Explicit, so a developer's .env (VITE_API_BASE_URL) cannot change what these tests exercise.
// Signed in, because a signed-out reporter sends nothing and the guard would never be exercised.
beforeEach(() => {
  setApiBase(`https://${PROD}`);
  setClerkTokenProvider(async () => "tok_test");
});

afterEach(() => {
  setApiBase(null);
  setClerkTokenProvider(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the guard installed by test setup", () => {
  it("is in place before any test code runs", () => {
    expect(isNetworkGuardInstalled()).toBe(true);
  });

  it("stops the real export reporter from filing a row in production", async () => {
    // A broken setup must fail HERE, before the request below could leave the machine.
    expect(isNetworkGuardInstalled()).toBe(true);
    expect(isProductionRequest(apiBase())).toBe(true);
    const before = blockedProductionRequests.length;
    await reportExport({ status: "done", elapsed_ms: 5 });
    const refused = blockedProductionRequests.slice(before);
    expect(refused.length).toBeGreaterThan(0);
    expect(new Set(refused)).toEqual(new Set(["POST /telemetry/export"]));
  });

  it("leaves a test's own fetch stub in charge, even for the production URL", async () => {
    const stub = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", stub);
    const before = blockedProductionRequests.length;
    await reportExport({ status: "done" });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(String(stub.mock.calls[0][0])).toBe(`${apiBase()}/telemetry/export`);
    expect(blockedProductionRequests.length).toBe(before);
  });
});

describe("guardFetch", () => {
  it("never calls the real fetch for production and always does for anything else", async () => {
    const real = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );
    const guarded = guardFetch(real as unknown as typeof fetch);
    await expect(
      guarded(`https://${PROD}/telemetry/export`, { method: "POST" }),
    ).rejects.toMatchObject({ name: "TypeError", message: "fetch failed" });
    expect(real).not.toHaveBeenCalled();
    const others = [
      "http://127.0.0.1:1/x",
      "https://example.com/",
      "/relative/path",
      `https://example.com/?next=https://${PROD}`,
    ];
    for (const url of others) await guarded(url);
    expect(real).toHaveBeenCalledTimes(others.length);
  });

  it("reports only the method and path of what it refused", async () => {
    const guarded = guardFetch((async () => new Response("ok")) as typeof fetch);
    await guarded(`https://${PROD}/telemetry/export?token=secret-token`, {
      method: "post",
      body: "private-body",
    }).catch(() => undefined);
    expect(blockedProductionRequests.at(-1)).toBe("POST /telemetry/export");
    expect(JSON.stringify(blockedProductionRequests)).not.toMatch(/secret-token|private-body/);
  });
});

describe("installNetworkGuard", () => {
  it("wraps a fetch once and not again", () => {
    const real = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", real);
    installNetworkGuard();
    const once = globalThis.fetch;
    expect(once).not.toBe(real);
    expect(isNetworkGuardInstalled()).toBe(true);
    installNetworkGuard();
    expect(globalThis.fetch).toBe(once);
  });

  it("can be switched off on purpose for a deliberate live check", () => {
    const real = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", real);
    vi.stubEnv("ARTDADDY_TESTS_ALLOW_PRODUCTION", "1");
    installNetworkGuard();
    expect(globalThis.fetch).toBe(real);
  });
});

describe("which requests count as production", () => {
  const mixedCase = fc
    .array(fc.boolean(), { minLength: PROD.length, maxLength: PROD.length })
    .map((flags) => [...PROD].map((char, i) => (flags[i] ? char.toUpperCase() : char)).join(""));

  it("recognises the production host however the URL around it is written", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("https", "http"),
        mixedCase,
        fc.boolean(),
        fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
        fc.webPath(),
        fc.webQueryParameters(),
        fc.webFragments(),
        (scheme, host, trailingDot, port, path, query, fragment) => {
          const url = `${scheme}://${host}${trailingDot ? "." : ""}${port ? `:${port}` : ""}${path}${
            query ? `?${query}` : ""
          }${fragment ? `#${fragment}` : ""}`;
          expect(isProductionRequest(url)).toBe(true);
          expect(isProductionRequest(new URL(url))).toBe(true);
          expect(isProductionRequest({ url } as unknown as Request)).toBe(true);
        },
      ),
    );
  });

  it("does not mistake other hosts for it, however the production host is smuggled in", () => {
    const other = fc.domain().filter((domain) => !PRODUCTION_HOSTS.has(domain.toLowerCase()));
    fc.assert(
      fc.property(other, fc.webPath(), (domain, path) => {
        expect(isProductionRequest(`https://${domain}${path}`)).toBe(false);
        expect(isProductionRequest(`https://${domain}/?next=https://${PROD}${path}`)).toBe(false);
        expect(isProductionRequest(`https://${PROD}@${domain}${path}`)).toBe(false);
        expect(isProductionRequest(`https://${PROD}.${domain}${path}`)).toBe(false);
        expect(isProductionRequest(`https://${domain}.${PROD}${path}`)).toBe(false);
      }),
    );
  });

  it("neither throws on nor blocks relative or malformed input", () => {
    for (const input of ["/api/x", "telemetry/export", "", "http://", "https://[::1"]) {
      expect(isProductionRequest(input)).toBe(false);
    }
  });

  it("names every production host the build ships", () => {
    const shipped = readFileSync(resolve(process.cwd(), "src/api/config.ts"), "utf8");
    const hosts = [...shipped.matchAll(/https:\/\/([a-z0-9.-]+\.azurecontainerapps\.io)/g)].map(
      (match) => match[1],
    );
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts)
      expect(PRODUCTION_HOSTS.has(host), `${host} is not guarded`).toBe(true);
  });
});
