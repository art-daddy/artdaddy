// Signing in and out, the way a person does it: the sign-in screen, the browser hand-off and its way back, a saved
// session, sign-out from the account menu and from the profile page, a session the server no longer accepts, and a
// server that cannot be reached. Judged on what the screen shows, what the app saved in the OS keychain (the shell's)
// and what it sent to the server. The real browser and Clerk are outside this lane: the hand-off is cut where the app
// opens the browser (the shell records the address) and resumes where the browser's link comes back (raised as the
// OS raises it). The round trip with a real account is the by-hand script e2e/byhand/auth-and-accounts/sign-in.md.
//
//   npm run e2e:ui -- e2e/ui/auth-and-accounts
import { createHash } from "node:crypto";

import { startTimer } from "../../lib/timing";
import { APP_VERSION, expect, knownBug, Rig, test } from "./lib/rig";

const browserName = () => test.info().project.name;

/** An access token shaped like the server's (the app reads `sub`, the lifetime and the e-mail claim from it). */
function accessToken(): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `ad_at_${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "qa_user", iat: now, exp: now + 1800 })}.qa`;
}

/** The sign-in screen's own heading and button. */
const signInHeading = (qa: Rig) => qa.page.getByRole("heading", { name: "Sign in to continue" });
const logIn = (qa: Rig) => qa.page.getByRole("button", { name: "Log in or sign up" });

/** Start signed out, press "Log in or sign up", and return the address the app opened in the browser. The OS takes a
 *  moment to open a browser; the shell holds that moment open until `opened` is called, so the busy state is seen. */
async function startSignIn(qa: Rig, signedOutApp: string, timeScreen?: string): Promise<URL> {
  qa.shell.refreshToken = null;
  let opened!: () => void;
  const browserOpen = new Promise<void>((resolve) => (opened = resolve));
  qa.native("open_desktop_auth", async () => {
    await browserOpen;
    return null;
  });
  const shown = timeScreen ? startTimer(timeScreen) : null;
  await qa.open(signedOutApp);
  await expect(signInHeading(qa)).toBeVisible({ timeout: 90_000 });
  shown?.stop();
  await logIn(qa).click();
  await expect(qa.page.getByRole("button", { name: "Opening your browser…" })).toBeVisible();
  await expect(
    qa.page.getByRole("button", { name: "Already finished in the browser? Check again" }),
  ).toBeVisible();
  opened();
  await expect.poll(() => qa.callsOf("open_desktop_auth").length).toBe(1);
  return new URL(String(qa.callsOf("open_desktop_auth")[0].url));
}

/** What the browser hands back once the person finished signing in there. */
const callback = (state: string, code = "qa-code-1") =>
  `artdaddy://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

test.describe("signing in", () => {
  test("a person who never signed in sees only the sign-in screen, and Log in opens the sign-in page in the browser", async ({
    qa,
    signedOutApp,
  }) => {
    const url = await startSignIn(
      qa,
      signedOutApp,
      `auth: start, signed out, to the sign-in screen [${browserName()}]`,
    );
    // Nothing of the editor can be reached from here.
    await expect(qa.menu("File")).toHaveCount(0);
    await expect(qa.page.getByText("Signing in opens your browser.")).toBeVisible();
    expect(`${url.origin}${url.pathname}`).toBe("https://artdaddy.app/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")?.length).toBeGreaterThanOrEqual(16);
    // The browser owns the attempt now; the screen offers the way to try again.
    await expect(logIn(qa)).toBeEnabled();
    // Nothing reached the server's token route: only the browser can produce a code.
    expect(qa.requests("/auth/desktop/token")).toHaveLength(0);
  });

  test("the browser hands the session back: the app spends the code once with its own verifier, keeps the session and opens", async ({
    qa,
    signedOutApp,
  }) => {
    const url = await startSignIn(qa, signedOutApp);
    const sent: Array<Record<string, unknown>> = [];
    await qa.route("/auth/desktop/token", async (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill(
        Rig.json(200, {
          access_token: accessToken(),
          refresh_token: "qa-refresh-signed-in",
          expires_in: 1800,
        }),
      );
    });
    const back = startTimer(`auth: browser link back to the signed-in app [${browserName()}]`);
    await qa.emit("deep-link://new-url", [callback(url.searchParams.get("state")!)]);
    await expect(qa.menu("File")).toBeVisible({ timeout: 30_000 });
    back.stop();
    await expect(signInHeading(qa)).toHaveCount(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].code).toBe("qa-code-1");
    // The verifier the app kept is the one whose S256 the browser was given: a stolen link alone cannot be spent.
    const verifier = String(sent[0].code_verifier);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    // Kept in the OS keychain, so the next start needs no browser.
    expect(qa.shell.refreshToken).toBe("qa-refresh-signed-in");

    // The same link delivered again (Windows can hand it over twice) spends nothing and says nothing.
    await qa.emit("deep-link://new-url", [callback(url.searchParams.get("state")!)]);
    await expect(qa.menu("File")).toBeVisible();
    expect(sent).toHaveLength(1);
  });

  test("a link from an earlier browser tab is refused before anything is spent, and the screen says what to do", async ({
    qa,
    signedOutApp,
  }) => {
    await startSignIn(qa, signedOutApp);
    await qa.emit("deep-link://new-url", [callback("a-tab-from-an-earlier-try")]);
    await expect(
      qa.page
        .getByRole("status")
        .filter({ hasText: "that browser tab belonged to an earlier try" }),
    ).toBeVisible();
    expect(qa.requests("/auth/desktop/token")).toHaveLength(0);
    expect(qa.shell.refreshToken).toBeNull();
    await expect(logIn(qa)).toBeEnabled();
  });

  test("the server refuses the code (expired or used): the screen says so, and Log in starts a fresh try", async ({
    qa,
    signedOutApp,
  }) => {
    const url = await startSignIn(qa, signedOutApp);
    await qa.route("/auth/desktop/token", (route) =>
      route.fulfill(Rig.json(400, { detail: "invalid_grant" })),
    );
    await qa.emit("deep-link://new-url", [callback(url.searchParams.get("state")!)]);
    await expect(
      qa.page.getByRole("status").filter({ hasText: "the link had expired or was already used" }),
    ).toBeVisible();
    expect(qa.shell.refreshToken).toBeNull();
    // A new try clears the sentence and opens the browser with a new state.
    await logIn(qa).click();
    await expect.poll(() => qa.callsOf("open_desktop_auth").length).toBe(2);
    const second = new URL(String(qa.callsOf("open_desktop_auth")[1].url));
    expect(second.searchParams.get("state")).not.toBe(url.searchParams.get("state"));
    await expect(qa.page.getByRole("status")).toHaveCount(0);
  });

  test("the server cannot be reached when the link comes back: the screen says to check the connection", async ({
    qa,
    signedOutApp,
  }) => {
    const url = await startSignIn(qa, signedOutApp);
    await qa.route("/auth/desktop/token", (route) => route.abort("connectionrefused"));
    await qa.emit("deep-link://new-url", [callback(url.searchParams.get("state")!)]);
    await expect(
      qa.page.getByRole("status").filter({ hasText: "couldn't reach the server" }),
    ).toBeVisible();
    await expect(signInHeading(qa)).toBeVisible();
  });
});

test.describe("a saved session", () => {
  test("opens straight into the app with no browser", async ({ qa, signedOutApp }) => {
    const open = startTimer(`auth: start with a saved session to the menu [${browserName()}]`);
    await qa.open(signedOutApp);
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    open.stop();
    expect(qa.callsOf("open_desktop_auth")).toHaveLength(0);
    // The session was renewed at start (one renewal), and the keychain holds the renewed one, not the spent one.
    expect(qa.requests("/auth/desktop/refresh").filter((r) => r.status === 200)).toHaveLength(1);
    expect(qa.shell.refreshToken).not.toBe("qa-refresh-0");
  });

  test("the server no longer accepts it (expired, revoked or used elsewhere): the sign-in screen, and the keychain is cleared", async ({
    qa,
    signedOutApp,
  }) => {
    await qa.route("/auth/desktop/refresh", (route) =>
      route.fulfill(Rig.json(401, { detail: "invalid refresh token" })),
    );
    await qa.open(signedOutApp);
    await expect(signInHeading(qa)).toBeVisible({ timeout: 90_000 });
    await expect(qa.menu("File")).toHaveCount(0);
    expect(qa.shell.refreshToken).toBeNull();
  });

  test("the server cannot be reached: the app opens offline on this computer, and the account says Offline", async ({
    qa,
    signedOutApp,
  }) => {
    // A build this computer has already verified (its first start was online), opened again with no connection.
    await qa.open(signedOutApp);
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    const saved = qa.shell.refreshToken;
    await qa.route("/auth/desktop/refresh", (route) => route.abort("internetdisconnected"));
    await qa.route("/me", (route) => route.abort("internetdisconnected"));
    await qa.route("/client/compatibility", (route) => route.abort("internetdisconnected"));
    const open = startTimer(
      `auth: start offline with a saved session to the menu [${browserName()}]`,
    );
    await qa.open(signedOutApp);
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    open.stop();
    await expect(
      qa.page.locator('button[aria-haspopup="menu"]').filter({ hasText: "Offline" }),
    ).toBeVisible();
    // The saved session is kept for when the server is back.
    expect(qa.shell.refreshToken).toBe(saved);
    // Local work goes on: a project can be made.
    await qa.newProject("sweep_qa_auth offline");
  });

  test("the session is revoked while the person works: their next action that needs the server brings the sign-in screen back", async ({
    qa,
    signedOutApp,
  }) => {
    await qa.open(signedOutApp);
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    await qa.newProject("sweep_qa_auth revoked");
    // Signed out from another device, or the account disabled: every token this app holds is refused now.
    await qa.route("/telemetry/feedback", (route) =>
      route.fulfill(Rig.json(401, { detail: "unauthorized" })),
    );
    await qa.route("/auth/desktop/refresh", (route) =>
      route.fulfill(Rig.json(401, { detail: "invalid refresh token" })),
    );
    // Something the person asks the server for: here, sending a problem report.
    await qa.choose("Help", "Report a Problem…");
    await qa.page.getByRole("textbox", { name: "What went wrong?" }).fill("It stopped working.");
    await qa.page.getByRole("button", { name: "Send report" }).click();
    await expect(signInHeading(qa)).toBeVisible({ timeout: 30_000 });
    expect(qa.shell.refreshToken).toBeNull();
  });
});

test.describe("signing out", () => {
  test("from the account menu: the session ends on the server and on this computer, and the sign-in screen returns", async ({
    qa,
    signedOutApp,
  }) => {
    await qa.open(signedOutApp);
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    const account = qa.page.locator('button[aria-haspopup="menu"]');
    await expect(account).toContainText("QA");
    await account.click();
    const out = startTimer(`auth: sign out to the sign-in screen [${browserName()}]`);
    await qa.page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(signInHeading(qa)).toBeVisible({ timeout: 30_000 });
    out.stop();
    expect(qa.requests("/auth/desktop/revoke")).toHaveLength(1);
    expect(qa.shell.refreshToken).toBeNull();
    await expect(qa.menu("File")).toHaveCount(0);
  });

  test("from the profile page: the same, and the page showed the account and the version first", async ({
    qa,
    signedOutApp,
  }) => {
    await qa.open(signedOutApp);
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    await qa.page.locator('button[aria-haspopup="menu"]').click();
    await qa.page.getByRole("menuitem", { name: "Profile" }).click();
    await expect(qa.page.getByRole("heading", { name: "QA", exact: true })).toBeVisible();
    await expect(qa.page.getByText(`artdaddy@${APP_VERSION}`)).toBeVisible();
    await qa.page.getByRole("button", { name: "Sign out" }).click();
    await expect(signInHeading(qa)).toBeVisible({ timeout: 30_000 });
    expect(qa.requests("/auth/desktop/revoke")).toHaveLength(1);
    expect(qa.shell.refreshToken).toBeNull();
  });
});

test.describe("the test sign-in bypass (CI's real-app lanes)", () => {
  test("with the bypass and no saved sign-in, the app still opens", async ({ qa }) => {
    knownBug(
      'art-daddy/backlog#102: Under the test sign-in bypass with no saved sign-in, the app stays on "Verifying ArtDaddy"',
      /getByRole\('button', \{ name: 'File', exact: true \}\)/,
    );
    qa.shell.refreshToken = null;
    await qa.open();
    await expect(qa.page.getByRole("heading", { name: "Verifying ArtDaddy" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(qa.menu("File")).toBeVisible({ timeout: 20_000 });
  });
});
