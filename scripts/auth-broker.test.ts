import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APPROVED_API =
  "https://artdaddy-server.ambitioustree-4d826744.centralindia.azurecontainerapps.io";
const html = readFileSync(resolve(process.cwd(), "auth-broker/index.html"), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

if (!source) throw new Error("auth broker inline script is missing");

type Mount = {
  kind: "sign-in" | "sign-up";
  options: Record<string, string>;
};

async function runBroker(href: string, signedIn = false) {
  const mounts: Mount[] = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const elements = new Map<string, { hidden: boolean; textContent: string; classList: { toggle(): void } }>();
  const element = () => ({
    hidden: false,
    textContent: "",
    classList: { toggle() {} },
  });
  elements.set("message", element());
  elements.set("sign-in", element());

  const session = signedIn ? { getToken: async () => "clerk-token" } : null;
  const clerk = {
    session,
    load: async () => {},
    mountSignIn: (_element: unknown, options: Record<string, string>) => {
      mounts.push({ kind: "sign-in", options });
    },
    mountSignUp: (_element: unknown, options: Record<string, string>) => {
      mounts.push({ kind: "sign-up", options });
    },
    addListener: () => {},
  };
  const location = { href, search: new URL(href).search };
  const document = {
    title: "Sign in — ArtDaddy",
    getElementById: (id: string) => elements.get(id),
    createElement: () => ({
      async: false,
      crossOrigin: "",
      src: "",
      onload: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      setAttribute() {},
    }),
    head: {
      appendChild(script: { onload?: () => void }) {
        queueMicrotask(() => script.onload?.());
      },
    },
  };

  vm.runInNewContext(source, {
    window: { Clerk: clerk, __internal_ClerkUICtor: {}, location },
    document,
    URL,
    URLSearchParams,
    atob,
    queueMicrotask,
    setTimeout: () => 0,
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ code: "desktop-code" }) };
    },
  });

  for (let attempt = 0; attempt < 20 && mounts.length + fetches.length === 0; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  return { mounts, fetches, location, title: document.title };
}

describe("production desktop auth broker", () => {
  it("keeps sign-up on the broker and preserves the desktop PKCE request", async () => {
    const result = await runBroker(
      "https://artdaddy.app/auth?code_challenge=challenge_123&code_challenge_method=S256&state=state_456&mode=sign-up#/verify-email",
    );

    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0].kind).toBe("sign-up");
    expect(result.title).toBe("Sign up — ArtDaddy");

    const options = result.mounts[0].options;
    expect(options.routing).toBe("hash");
    expect(options.forceRedirectUrl).toBe(
      "https://artdaddy.app/auth?code_challenge=challenge_123&code_challenge_method=S256&state=state_456",
    );
    expect(options.fallbackRedirectUrl).toBe(options.forceRedirectUrl);

    const signInUrl = new URL(options.signInUrl);
    expect(signInUrl.origin + signInUrl.pathname).toBe("https://artdaddy.app/auth");
    expect(Object.fromEntries(signInUrl.searchParams)).toEqual({
      code_challenge: "challenge_123",
      code_challenge_method: "S256",
      state: "state_456",
      mode: "sign-in",
    });
    expect(signInUrl.hash).toBe("");
  });

  it("mounts sign-in with a symmetric broker-local sign-up route", async () => {
    const result = await runBroker(
      "https://artdaddy.app/auth?code_challenge=challenge_123&code_challenge_method=S256&state=state_456",
    );

    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0].kind).toBe("sign-in");
    const options = result.mounts[0].options;
    expect(options.fallbackRedirectUrl).toBe(options.forceRedirectUrl);

    const signUpUrl = new URL(options.signUpUrl);
    expect(signUpUrl.origin + signUpUrl.pathname).toBe("https://artdaddy.app/auth");
    expect(Object.fromEntries(signUpUrl.searchParams)).toEqual({
      code_challenge: "challenge_123",
      code_challenge_method: "S256",
      state: "state_456",
      mode: "sign-up",
    });
  });

  it("authorizes an existing session only through the approved production API", async () => {
    const result = await runBroker(
      "https://artdaddy.app/auth?code_challenge=challenge_123&code_challenge_method=S256&state=state_456",
      true,
    );

    expect(result.fetches).toHaveLength(1);
    expect(result.fetches[0].url).toBe(`${APPROVED_API}/auth/desktop/authorize`);
    expect(new URL(result.fetches[0].url).origin).toBe(APPROVED_API);
    expect(result.fetches[0].url).not.toContain("trycloudflare");
    expect(result.location.href).toBe("artdaddy://auth/callback?code=desktop-code&state=state_456");
  });
});
