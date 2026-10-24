// A test must never reach the production API. The build default IS the production server, so a test that
// runs the real export reporter files a row in production analytics: 7,300 such rows landed in four days.
// Installed by the setup files. A test that stubs fetch replaces this wrapper and stays in charge.

/** A copy by necessity: importing config.ts from setup would evaluate it before the tests do.
 *  networkGuard.test.ts fails if this drifts from the host config.ts ships. */
export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  "akaru-server.ambitioustree-4d826744.centralindia.azurecontainerapps.io",
]);

/** What was refused, as "METHOD /path" only, so no query string or body can leak into a report. */
export const blockedProductionRequests: string[] = [];

const GUARDED = Symbol.for("artdaddy.networkGuard");

type Input = RequestInfo | URL;

function parse(input: Input): URL | null {
  const raw = typeof input === "string" ? input : "href" in input ? input.href : input.url;
  try {
    return new URL(raw);
  } catch {
    return null; // relative or malformed: it cannot name another host
  }
}

function isProductionUrl(url: URL | null): url is URL {
  return url !== null && PRODUCTION_HOSTS.has(url.hostname.replace(/\.$/, "").toLowerCase());
}

export function isProductionRequest(input: Input): boolean {
  return isProductionUrl(parse(input));
}

/** `real` for everything except the production host, which fails the way an offline machine does. */
export function guardFetch(real: typeof fetch): typeof fetch {
  const guarded = ((input: Input, init?: RequestInit) => {
    const url = parse(input);
    if (isProductionUrl(url)) {
      const method =
        init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
      blockedProductionRequests.push(`${method.toUpperCase()} ${url.pathname}`);
      return Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("blocked by the test network guard: tests must not reach production"),
        }),
      );
    }
    return real(input, init);
  }) as typeof fetch;
  Object.defineProperty(guarded, GUARDED, { value: true });
  return guarded;
}

export function isNetworkGuardInstalled(): boolean {
  return Boolean((globalThis.fetch as unknown as Record<symbol, unknown> | undefined)?.[GUARDED]);
}

/** Wraps global fetch once. ARTDADDY_TESTS_ALLOW_PRODUCTION=1 leaves it alone, for a deliberate live check. */
export function installNetworkGuard(): void {
  if (process.env.ARTDADDY_TESTS_ALLOW_PRODUCTION === "1") return;
  if (typeof globalThis.fetch !== "function" || isNetworkGuardInstalled()) return;
  Object.defineProperty(globalThis, "fetch", {
    value: guardFetch(globalThis.fetch),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
