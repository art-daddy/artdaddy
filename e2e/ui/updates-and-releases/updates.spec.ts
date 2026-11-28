// Updates, the way a person meets them: the box that offers a new version, Later, Restart & update (download, then the
// app leaves through its exit door and the installer runs), a download or an install that fails, a check that fails
// (silent), an update offered before signing in, and the screens of the build check ("Verifying ArtDaddy", not
// verified, update required). Judged on the screen and on what the desktop side was asked to do, in what order.
//
// The install itself (an installer replacing the app and the new version starting) is the update canary's
// (.github/workflows/updater-canary.yml): here the desktop side is the shell, so "the installer started" is the moment
// the app asks for it. Never a real download: the shell answers the update commands.
//
//   npm run e2e:ui -- e2e/ui/updates-and-releases
import { startTimer } from "../../lib/timing";
import { APP_VERSION, expect, knownBug, Rig, test } from "../auth-and-accounts/lib/rig";

const browserName = () => test.info().project.name;

const NOTES =
  "The notes of 9.9.9: captions keep their colours, and exports of long projects finish sooner.";
const OFFER = {
  version: "9.9.9",
  current_version: APP_VERSION,
  notes: NOTES,
  date: "2026-11-28T00:00:00Z",
};

const box = (qa: Rig) => qa.page.getByText(/Version 9\.9\.9 is available/);
const restartAndUpdate = (qa: Rig) => qa.page.getByRole("button", { name: "Restart & update" });

/** The window's close, as Rust raises it when the app asks to close: the app's exit guard runs on this event. */
function windowCloses(qa: Rig): void {
  qa.native("plugin:window|close", async () => {
    await qa.emit("tauri://close-requested", null);
    return null;
  });
}

/** Hold a native command open until the test lets it go. */
function held<T>(value: T): { answer: () => Promise<T>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { answer: async () => (await gate, value), release };
}

test.describe("the update box", () => {
  test("a new version is offered: the box names it, with Restart & update and Later", async ({
    qa,
  }) => {
    qa.native("check_for_update", () => OFFER);
    const shown = startTimer(`updates: start to the update box [${browserName()}]`);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    shown.stop();
    await expect(restartAndUpdate(qa)).toBeEnabled();
    await expect(qa.page.getByRole("button", { name: "Later" })).toBeVisible();
    // The person keeps working while it is offered: nothing restarts by itself.
    await expect(qa.menu("File")).toBeVisible();
    expect(qa.callsOf("download_update")).toHaveLength(0);
  });

  test("the box says what the new version changes (its release notes)", async ({ qa }) => {
    knownBug("The update box never shows the release notes", /getByText\('The notes of 9\.9\.9/);
    qa.native("check_for_update", () => OFFER);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    await expect(qa.page.getByText(NOTES.slice(0, 40))).toBeVisible({ timeout: 3_000 });
  });

  test("Later puts the box away for now, and the next start offers it again", async ({ qa }) => {
    qa.native("check_for_update", () => OFFER);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    await qa.page.getByRole("button", { name: "Later" }).click();
    await expect(box(qa)).toHaveCount(0);
    expect(qa.callsOf("download_update")).toHaveLength(0);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    expect(qa.callsOf("check_for_update").length).toBeGreaterThanOrEqual(2);
  });

  test("Restart & update: the download first, while the person can keep working, then the app closes and the installer starts", async ({
    qa,
  }) => {
    qa.native("check_for_update", () => OFFER);
    const download = held("staged");
    qa.native("download_update", download.answer);
    qa.native("install_update", () => null);
    windowCloses(qa);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    await restartAndUpdate(qa).click();
    await expect(qa.page.getByRole("button", { name: "Downloading…" })).toBeDisabled();
    // Nothing closes while the download runs.
    expect(qa.callsOf("install_update")).toHaveLength(0);
    await expect(qa.menu("File")).toBeVisible();
    const toInstaller = startTimer(
      `updates: download done to the installer starting [${browserName()}]`,
    );
    download.release();
    await expect.poll(() => qa.callsOf("install_update").length, { timeout: 20_000 }).toBe(1);
    toInstaller.stop();
    // Downloaded once, installed once, in that order (the dev build checks for an update twice at start: React's
    // strict mode runs the check's effect twice, which a shipped build does not).
    const order = qa.nativeCalls
      .map((c) => c.cmd)
      .filter((c) => /^(download|install)_update$/.test(c));
    expect(order).toEqual(["download_update", "install_update"]);
  });

  test("the download fails: the box says why, nothing installs, and Restart & update can be pressed again", async ({
    qa,
  }) => {
    qa.native("check_for_update", () => OFFER);
    qa.native("download_update", () => {
      throw new Error("error sending request for url (https://github.com/...): connection reset");
    });
    qa.native("install_update", () => null);
    windowCloses(qa);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    await restartAndUpdate(qa).click();
    await expect(qa.page.getByText(/connection reset/)).toBeVisible();
    await expect(restartAndUpdate(qa)).toBeEnabled();
    expect(qa.callsOf("install_update")).toHaveLength(0);
    // The app is still the app.
    await qa.menu("File").click();
    await expect(qa.page.getByRole("button", { name: /New Project/ })).toBeVisible();
  });

  test("the installer cannot start: the box says why and the app stays open", async ({ qa }) => {
    qa.native("check_for_update", () => OFFER);
    qa.native("download_update", () => "staged");
    qa.native("install_update", () => {
      throw new Error("the installer could not be started");
    });
    windowCloses(qa);
    await qa.open();
    await expect(box(qa)).toBeVisible({ timeout: 90_000 });
    await restartAndUpdate(qa).click();
    await expect(qa.page.getByText(/the installer could not be started/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(qa.menu("File")).toBeVisible();
  });

  test("a failed update check stays silent: no box, no message, the app works", async ({ qa }) => {
    qa.native("check_for_update", () => {
      throw new Error("error sending request for url (https://artdaddy.app/updates/latest.json)");
    });
    await qa.open();
    await expect(qa.menu("File")).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => qa.callsOf("check_for_update").length).toBeGreaterThanOrEqual(1);
    // Two frames after the check answered, the screen has taken its answer.
    await qa.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
    );
    await expect(qa.page.getByText(/is available/)).toHaveCount(0);
    await expect(qa.page.getByText(/latest\.json|error sending request/)).toHaveCount(0);
    await qa.newProject("sweep_qa_update silent");
  });

  test("an update is offered on the sign-in screen too, before signing in", async ({
    qa,
    signedOutApp,
  }) => {
    qa.shell.refreshToken = null;
    qa.native("check_for_update", () => OFFER);
    await qa.open(signedOutApp);
    await expect(qa.page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(box(qa)).toBeVisible();
    await expect(restartAndUpdate(qa)).toBeEnabled();
  });
});

test.describe("the build check", () => {
  test("the service is slow to check the build: 'Verifying ArtDaddy', then the waking line, then the app", async ({
    qa,
  }) => {
    let answered!: () => void;
    const slow = new Promise<void>((resolve) => (answered = resolve));
    await qa.route("/client/compatibility", async (route) => {
      await slow;
      const id = (route.request().postDataJSON() as { catalog_id?: string }).catalog_id;
      await route.fulfill(
        Rig.json(200, { catalog_id: id, supported: true, required_update: false }),
      );
    });
    const wait = startTimer(
      `compatibility: a held build check to the app, after it answers [${browserName()}]`,
    );
    await qa.open();
    await expect(qa.page.getByRole("heading", { name: "Verifying ArtDaddy" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(qa.page.getByText("Checking this build with the service.")).toBeVisible();
    // From 3 s of waiting the screen says the server is waking, in the owner's words.
    await expect(qa.page.getByRole("status").filter({ hasText: "Waking the server" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(qa.page.getByText("Nothing is wrong.", { exact: false })).toBeVisible();
    answered();
    await expect(qa.menu("File")).toBeVisible({ timeout: 30_000 });
    wait.stop();
    await expect(qa.page.getByRole("heading", { name: "Verifying ArtDaddy" })).toHaveCount(0);
  });

  test("the first start of a build with no connection: not verified, and Retry Check opens the app once connected", async ({
    qa,
  }) => {
    let online = false;
    await qa.route("/client/compatibility", async (route) => {
      if (!online) return route.abort("internetdisconnected");
      const id = (route.request().postDataJSON() as { catalog_id?: string }).catalog_id;
      await route.fulfill(
        Rig.json(200, { catalog_id: id, supported: true, required_update: false }),
      );
    });
    await qa.open();
    await expect(
      qa.page.getByText("This build has not been verified. Connect and retry before continuing."),
    ).toBeVisible({ timeout: 90_000 });
    await expect(qa.menu("File")).toHaveCount(0);
    online = true;
    await qa.page.getByRole("button", { name: "Retry Check" }).click();
    await expect(qa.menu("File")).toBeVisible({ timeout: 30_000 });
  });

  test("the service no longer supports this build: 'update required', and Update downloads, closes and installs", async ({
    qa,
  }) => {
    qa.server.supported = false;
    qa.native("download_update", () => "staged");
    qa.native("install_update", () => null);
    windowCloses(qa);
    await qa.open();
    await expect(qa.page.getByRole("heading", { name: "ArtDaddy update required" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      qa.page.getByText("This build can no longer be used. Update ArtDaddy to continue."),
    ).toBeVisible();
    await expect(qa.page.getByRole("button", { name: "Quit" })).toBeVisible();
    await qa.page.getByRole("button", { name: "Update" }).click();
    await expect.poll(() => qa.callsOf("install_update").length, { timeout: 20_000 }).toBe(1);
    expect(qa.callsOf("download_update")).toHaveLength(1);
  });
});
