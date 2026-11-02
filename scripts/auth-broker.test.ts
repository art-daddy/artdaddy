import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APPROVED_API =
  "https://akaru-server.ambitioustree-4d826744.centralindia.azurecontainerapps.io";
const html = readFileSync(resolve(process.cwd(), "auth-broker/index.html"), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

if (!source) throw new Error("auth broker inline script is missing");

type Mount = {
  kind: "sign-in" | "sign-up";
  options: Record<string, string>;
};

type Server = "ok" | "503" | "401" | "network" | "unreadable";
interface Browser {
  /** What the authorize call does. */
  authorize?: Server;
  /** The signed-in session cannot produce a token. */
  tokenFails?: boolean;
  doNotTrack?: boolean;
  /** `sendBeacon` is refused (returns false) or throws. */
  beacon?: "works" | "refused" | "throws";
  /** The code the server hands out. */
  code?: string;
  /** Clerk's scripts fail to load. */
  scripts?: "fail";
}

async function runBroker(href: string, signedIn = false, browser: Browser = {}) {
  const { authorize = "ok", tokenFails = false, doNotTrack = false, beacon = "works" } = browser;
  const mounts: Mount[] = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const beacons: Array<{ url: string; body: Record<string, unknown>; type: string }> = [];
  const classes = new Set<string>();
  const message = {
    hidden: false,
    textContent: "",
    classList: {
      toggle(name: string, on: boolean) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  const listeners: Record<string, () => void> = {};
  const open = {
    hidden: false,
    href: "",
    addEventListener(type: string, fn: () => void) {
      listeners[type] = fn;
    },
    removeAttribute(name: string) {
      if (name === "href") this.href = "";
    },
  };
  const handoff = { hidden: true };
  const elements = new Map<string, unknown>([
    ["message", message],
    ["sign-in", { hidden: false, textContent: "", classList: { toggle() {} } }],
    ["handoff", handoff],
    ["open", open],
  ]);

  const session = signedIn
    ? {
        getToken: async () => {
          if (tokenFails) throw new Error("no token");
          return "clerk-token";
        },
      }
    : null;
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
      appendChild(script: { onload?: () => void; onerror?: () => void }) {
        queueMicrotask(() => (browser.scripts === "fail" ? script.onerror?.() : script.onload?.()));
      },
    },
  };

  // Time the page waits on is the test's to move: nothing fires until `advance` says so.
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
      await settle();
    }
    now = target;
  };

  class FakeBlob {
    constructor(
      readonly parts: string[],
      readonly options: { type: string },
    ) {}
  }
  const navigator = {
    doNotTrack: doNotTrack ? "1" : null,
    sendBeacon: (url: string, blob: FakeBlob) => {
      if (beacon === "throws") throw new Error("beacon blew up");
      if (beacon === "refused") return false;
      beacons.push({ url, body: JSON.parse(blob.parts.join("")), type: blob.options.type });
      return true;
    },
  };

  const replyForAuthorize = async () => {
    if (authorize === "network") throw new TypeError("Failed to fetch");
    if (authorize === "unreadable") {
      return { ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("bad")) };
    }
    if (authorize === "ok") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: browser.code ?? "desktop-code" }),
      };
    }
    return { ok: false, status: Number(authorize), json: async () => ({}) };
  };

  const context = {
    window: { Clerk: clerk, __internal_ClerkUICtor: {}, location, doNotTrack: undefined },
    document,
    navigator,
    Blob: FakeBlob,
    URL,
    URLSearchParams,
    atob,
    queueMicrotask,
    setTimeout: (fn: () => void, ms = 0) => {
      timers.push({ at: now + ms, fn });
      return timers.length;
    },
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (url.endsWith("/e")) return { ok: true, status: 204, json: async () => ({}) };
      return replyForAuthorize();
    },
  };
  // The page's own step table, read from the page itself: `PAGE_STEPS` is a top-level constant of that script.
  const steps = vm.runInNewContext(`${source}\n;PAGE_STEPS`, context) as Record<string, string[]>;

  async function settle() {
    for (let turn = 0; turn < 25; turn += 1)
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  await settle();
  return {
    mounts,
    fetches,
    beacons,
    location,
    message,
    classes,
    open,
    handoff,
    steps,
    advance,
    press: () => listeners.click?.(),
    title: document.title,
  };
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

// The page cannot know whether the browser handed the link to the app. It used to say "You can close this window"
// 1.5 s later whatever happened, which left 18% of finished sign-ins (from the access log) looking done while the
// app never learned of them. It must never claim what it cannot know, and it must give the person a way forward.
const BASE =
  "https://artdaddy.app/auth?code_challenge=challenge_123&code_challenge_method=S256&state=state_456";
const ATTEMPT = "a1B2c3D4e5F6";
const LINK = "artdaddy://auth/callback?code=desktop-code&state=state_456";

describe("the hand-off to the app", () => {
  it("never tells the person they can close the window, which it cannot know", async () => {
    const page = await runBroker(BASE, true);
    await page.advance(1500);
    expect(page.message.textContent).not.toMatch(/close this window/i);
    await page.advance(60_000);
    expect(page.message.textContent).not.toMatch(/close this window/i);
  });

  it("opens the app by itself at once, and says nothing about trouble until the link has had time", async () => {
    const page = await runBroker(BASE, true);
    expect(page.location.href).toBe(LINK);
    expect(page.message.textContent).toMatch(/returning you to ArtDaddy/);
    expect(page.handoff.hidden).toBe(true);
    await page.advance(1499);
    expect(page.handoff.hidden).toBe(true);
  });

  it("then offers a button that carries the same link, and says what to do", async () => {
    const page = await runBroker(BASE, true);
    await page.advance(1500);
    expect(page.handoff.hidden).toBe(false);
    expect(page.open.href).toBe(LINK);
    expect(page.message.textContent).toMatch(/If it didn't, press the button/);
    expect(page.classes.has("error")).toBe(false);
  });

  it("takes the offer back when the server's one-time code would no longer be honoured", async () => {
    const page = await runBroker(BASE, true);
    await page.advance(1500);
    await page.advance(100_000); // t = 101.5 s: inside the server's 120 s
    expect(page.handoff.hidden).toBe(false);
    await page.advance(10_000); // t = 111.5 s: past the window the page offers
    expect(page.handoff.hidden).toBe(true);
    expect(page.open.href).toBe("");
    expect(page.message.textContent).toMatch(/expired/);
    expect(page.message.textContent).toMatch(/Log in or sign up/);
    expect(page.classes.has("error")).toBe(true);
  });

  it("offers the code for a little less time than the server honours it", async () => {
    // The server's AUTH_CODE_TTL_SECONDS is the truth. A button offered the moment the code stopped working is
    // worse than none, so the page stops sooner; but stopping long before it throws away time the person has.
    // Both numbers are read from their sources, so neither can drift away from the other unseen.
    const serverFile = resolve(process.cwd(), "../Akaru/src/akaru/server/desktop_auth.py");
    if (!existsSync(serverFile)) return; // the server checkout is not beside this one (CI)
    const ttl = Number(
      readFileSync(serverFile, "utf8").match(/^AUTH_CODE_TTL_SECONDS\s*=\s*(\d+)/m)?.[1],
    );
    const offered = Number(source!.match(/const CODE_WINDOW_MS = (\d+);/)?.[1]);
    expect(
      Number.isFinite(ttl) && Number.isFinite(offered),
      "a constant moved or was renamed",
    ).toBe(true);
    expect(offered / 1000).toBeLessThan(ttl);
    expect(offered / 1000).toBeGreaterThanOrEqual(ttl - 30);
    const page = await runBroker(BASE, true);
    await page.advance(1500);
    await page.advance(offered - 1500 - 1);
    expect(page.handoff.hidden, "taken back too early").toBe(false);
    await page.advance(1);
    expect(page.handoff.hidden, "not taken back at the window").toBe(true);
  });

  it("is pressed as a real click: it is a link, so the browser treats it as the person's own action", async () => {
    const page = await runBroker(BASE, true);
    await page.advance(1500);
    page.press();
    expect(page.beacons.map(({ body }) => body.step)).toContain("reopen");
    // Nothing in the page navigates on the press; the link's own default action does, which is what a browser
    // that refused the script's navigation will accept.
    expect(page.location.href).toBe(LINK);
  });

  it("passes the try's name back in the link when the app gave one, and only then", async () => {
    const named = await runBroker(`${BASE}&attempt=${ATTEMPT}`, true);
    expect(named.location.href).toBe(`${LINK}&attempt=${ATTEMPT}`);
    await named.advance(1500);
    expect(named.open.href).toBe(`${LINK}&attempt=${ATTEMPT}`);
    for (const bad of [
      "short",
      "x".repeat(13),
      "state_456state_456",
      "<script>alert(1)</script>",
    ]) {
      const page = await runBroker(`${BASE}&attempt=${encodeURIComponent(bad)}`, true);
      expect(page.location.href, bad).toBe(LINK);
    }
  });

  it("does nothing to the app's link when the address carries no name, exactly as before", async () => {
    const page = await runBroker(BASE, true);
    expect(page.location.href).toBe("artdaddy://auth/callback?code=desktop-code&state=state_456");
  });
});

describe("what the sign-in page reports", () => {
  const steps = (page: Awaited<ReturnType<typeof runBroker>>) =>
    page.beacons.map(({ body }) => [body.step, body.ok, body.reason, body.mode]);

  it("reports a finished sign-in as the funnel it is, in order, to the public beacon, under the try's name", async () => {
    const page = await runBroker(`${BASE}&attempt=${ATTEMPT}`, true);
    expect(steps(page)).toEqual([
      ["page", true, undefined, "sign_in"],
      ["authorize", true, undefined, undefined],
      ["handoff", undefined, undefined, undefined],
    ]);
    for (const beacon of page.beacons) {
      expect(beacon.url).toBe(`${APPROVED_API}/e`);
      expect(beacon.type).toBe("text/plain;charset=UTF-8");
      expect(beacon.body).toMatchObject({ event: "auth", source: "page", attempt: ATTEMPT });
    }
  });

  it("says whether it was sign-up or sign-in the person was shown", async () => {
    const page = await runBroker(`${BASE}&mode=sign-up`);
    expect(steps(page)).toEqual([["page", true, undefined, "sign_up"]]);
  });

  it("names no try when the address has none, rather than inventing one", async () => {
    const page = await runBroker(BASE, true);
    for (const { body } of page.beacons) expect(body).not.toHaveProperty("attempt");
  });

  it.each([
    ["503", "unavailable", /temporarily unavailable/],
    ["401", "rejected", /could not be completed/],
    ["network", "network", /Couldn't reach the server/],
  ] as const)(
    "reports a refused or failed authorize (%s) with its reason, and keeps its message",
    async (server, reason, text) => {
      const page = await runBroker(BASE, true, { authorize: server });
      expect(steps(page)).toEqual([
        ["page", true, undefined, "sign_in"],
        ["authorize", false, reason, undefined],
      ]);
      expect(page.message.textContent).toMatch(text);
      expect(page.classes.has("error")).toBe(true);
      expect(page.location.href).toBe(BASE);
      expect(page.handoff.hidden).toBe(true);
    },
  );

  it("reports a session that cannot produce a token, and keeps its message", async () => {
    const page = await runBroker(BASE, true, { tokenFails: true });
    expect(steps(page)).toEqual([
      ["page", true, undefined, "sign_in"],
      ["authorize", false, "token", undefined],
    ]);
    expect(page.message.textContent).toMatch(/could not be completed/);
  });

  it("reports a link with no challenge or state, and keeps its message", async () => {
    const page = await runBroker("https://artdaddy.app/auth?state=only");
    expect(steps(page)).toEqual([["page", false, "bad_link", undefined]]);
    expect(page.message.textContent).toMatch(/missing required information/);
  });

  it("reports the sign-in page failing to load, and keeps its message", async () => {
    const page = await runBroker(BASE, false, { scripts: "fail" });
    expect(steps(page)).toEqual([
      ["page", true, undefined, "sign_in"],
      ["clerk", false, "load_failed", undefined],
    ]);
    expect(page.message.textContent).toMatch(/Something went wrong loading sign-in/);
  });

  it("sends nothing at all when the browser says Do Not Track, and the sign-in is unchanged", async () => {
    const page = await runBroker(BASE, true, { doNotTrack: true });
    expect(page.beacons).toEqual([]);
    expect(page.fetches.map(({ url }) => url)).toEqual([`${APPROVED_API}/auth/desktop/authorize`]);
    expect(page.location.href).toBe(LINK);
  });

  it.each(["refused", "throws"] as const)(
    "hands off to the app all the same when the beacon is %s",
    async (beacon) => {
      const page = await runBroker(BASE, true, { beacon });
      expect(page.location.href).toBe(LINK);
      await page.advance(1500);
      expect(page.handoff.hidden).toBe(false);
      expect(page.open.href).toBe(LINK);
    },
  );

  it("falls back to a plain POST when the beacon is refused, and still sends only the same steps", async () => {
    const page = await runBroker(`${BASE}&attempt=${ATTEMPT}`, true, { beacon: "refused" });
    const posted = page.fetches.filter(({ url }) => url.endsWith("/e"));
    expect(posted.map(({ init }) => JSON.parse(init.body as string).step)).toEqual([
      "page",
      "authorize",
      "handoff",
    ]);
    for (const { init } of posted)
      expect(init).toMatchObject({ method: "POST", mode: "no-cors", keepalive: true });
  });

  it("reports only steps and reasons from its own table, and every one it can send is in it", async () => {
    const seen: Array<[string, unknown]> = [];
    for (const [server, scripts] of [
      ["ok", undefined],
      ["503", undefined],
      ["401", undefined],
      ["network", undefined],
      ["ok", "fail"],
    ] as const) {
      const page = await runBroker(BASE, true, { authorize: server, scripts });
      for (const { body } of page.beacons) seen.push([String(body.step), body.reason]);
      await page.advance(2000);
      page.press();
      for (const { body } of page.beacons) seen.push([String(body.step), body.reason]);
    }
    const page = await runBroker("https://artdaddy.app/auth");
    for (const { body } of page.beacons) seen.push([String(body.step), body.reason]);
    const { steps: table } = page;
    expect(Object.keys(table).sort()).toEqual(["authorize", "clerk", "handoff", "page", "reopen"]);
    for (const [step, reason] of seen) {
      expect(Object.keys(table), step).toContain(step);
      if (reason !== undefined) expect(table[step], `${step}/${reason}`).toContain(reason);
    }
  });

  it("never puts the code, the state, the challenge or a token in anything it reports", async () => {
    const secrets = {
      code: "SECRET-CODE-0123456789abcdef",
      state: "SECRETSTATE0123456789abcdefghijklmnop",
      challenge: "SECRETCHALLENGE0123456789abcdefghijklmnopqrstuv",
    };
    const href =
      `https://artdaddy.app/auth?code_challenge=${secrets.challenge}&code_challenge_method=S256` +
      `&state=${secrets.state}&attempt=${ATTEMPT}`;
    for (const beacon of ["works", "refused"] as const) {
      const page = await runBroker(href, true, { code: secrets.code, beacon });
      await page.advance(2000);
      page.press();
      const wire = JSON.stringify([
        page.beacons,
        page.fetches.filter(({ url }) => url.endsWith("/e")),
      ]);
      for (const [name, secret] of Object.entries(secrets))
        expect(wire, `${name} leaked`).not.toContain(secret);
      expect(wire).not.toContain("clerk-token");
      // The one thing that does carry the code is the link to the app, and that is not a report.
      expect(page.location.href).toContain(secrets.code);
    }
  });
});
